import http from 'node:http'

/**
 * 内置本地模型代理（仅绑定 127.0.0.1）
 *
 * 暴露端点（供各 Harness 指向）：
 *   POST /v1/chat/completions  OpenAI 格式
 *   POST /v1/messages          Anthropic 格式
 *   GET  /v1/models            当前 Provider 模型列表
 *
 * 按「模型服务」里配置的 Provider 转发并做必要的协议翻译：
 *   provider.type = openai-compatible / gemini → 直通 chat/completions
 *   provider.type = anthropic → OpenAI 入站翻译为 /v1/messages，SSE 双向翻译
 */

const DEFAULT_PORT = 18200

export function createModelProxy({ port = DEFAULT_PORT, log = () => {} } = {}) {
  let provider = null // 默认 Provider { id, name, type, baseUrl, apiKey }
  let defaultModel = ''
  let routes = {} // model -> Provider（配置模型时按选择注册，实现多 Provider 按模型路由）
  let server = null

  function setTarget(p, model) {
    if (p) provider = { ...p }
    if (model) defaultModel = model
  }

  /** 注册模型路由：selection = [{ providerId, model, provider? }] */
  function setRoutes(selection = []) {
    for (const item of selection) {
      if (item?.provider && item?.model) routes[item.model] = { ...item.provider }
    }
  }

  /** 按请求的模型名解析目标 Provider（未注册的走默认） */
  function resolveProvider(model) {
    return (model && routes[model]) || provider
  }

  function status() {
    return { running: !!server, port: server ? server.address()?.port : null, provider: provider?.name || null, model: defaultModel }
  }

  function start() {
    if (server) return status()
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          log('proxy error:', String(e))
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
          }
          res.end(JSON.stringify({ error: { message: String(e) } }))
        })
      })
      server.on('error', (e) => {
        server = null
        reject(e)
      })
      server.listen(port, '127.0.0.1', () => {
        log(`proxy listening on 127.0.0.1:${port}`)
        resolve(status())
      })
    })
  }

  function stop() {
    if (!server) return Promise.resolve(status())
    return new Promise((r) => server.close(() => { server = null; r(status()) }))
  }

  async function handle(req, res) {
    if (!provider && Object.keys(routes).length === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: '未配置模型 Provider，请先在「模型服务」中添加并通过 Harness 页完成模型配置' } }))
    }
    const url = (req.url || '').split('?')[0]
    if (req.method === 'GET' && url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: (provider.models || []).map((id) => ({ id, object: 'model' })) }))
    }
    if (req.method !== 'POST') {
      res.writeHead(404)
      return res.end()
    }

    const raw = await readBody(req)
    if (url === '/v1/chat/completions') return handleChat(req, res, raw)
    if (url === '/v1/messages') return handleMessages(req, res, raw)
    res.writeHead(404)
    res.end()
  }

  /* ---------- OpenAI 入站 ---------- */

  async function handleChat(req, res, raw) {
    let body
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const stream = body.stream === true
    const target = resolveProvider(body.model) || provider
    if (defaultModel && !routes[body.model]) body.model = defaultModel

    if (target.type === 'anthropic') {
      const anth = openAiToAnthropic(body)
      return proxyAnthropic(res, anth, { openaiIn: true, stream, target })
    }
    // openai-compatible / gemini 网关：直通转发
    const upstream = buildOpenAiUrl(target.baseUrl)
    return pipeStream(res, upstream, openAiHeaders(target), body, stream)
  }

  /* ---------- Anthropic 入站 ---------- */

  async function handleMessages(req, res, raw) {
    let body
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    const target = resolveProvider(body.model) || provider
    if (defaultModel && !routes[body.model]) body.model = defaultModel
    if (target.type === 'anthropic') {
      return proxyAnthropic(res, body, { openaiIn: false, stream: body.stream === true, target })
    }
    // Anthropic 入站 → OpenAI 出站：非流式转换（流式 v1 暂不支持，返回整段）
    const upstream = buildOpenAiUrl(target.baseUrl)
    const bodyOpenAi = anthropicToOpenAi(body)
    const out = await fetchJson(upstream, openAiHeaders(target), bodyOpenAi)
    const text = out?.choices?.map((c) => c.message?.content || '').join('') || ''
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: out?.id || 'msg_proxy',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: out?.usage?.prompt_tokens || 0, output_tokens: out?.usage?.completion_tokens || 0 }
    }))
  }

  /* ---------- Anthropic 上游转发 / SSE 翻译 ---------- */

  async function proxyAnthropic(res, anthBody, { openaiIn, stream, target }) {
    const p = target || provider
    const base = p.baseUrl.replace(/\/+$/, '')
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': p.apiKey,
      'anthropic-version': '2023-06-01'
    }
    anthBody.stream = stream

    const up = await fetch(url, { method: 'POST', headers, body: JSON.stringify(anthBody) })
    if (!up.ok) {
      const t = await up.text().catch(() => '')
      res.writeHead(up.status, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: `HTTP ${up.status}: ${t.slice(0, 300)}` } }))
    }

    // 非流式：Anthropic 响应 → 按入站格式回写
    if (!stream) {
      const j = await up.json().catch(() => ({}))
      const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      if (openaiIn) {
        return res.end(JSON.stringify({
          id: j.id || 'chatcmpl-proxy', object: 'chat.completion', model: anthBody.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: j.usage?.input_tokens || 0, completion_tokens: j.usage?.output_tokens || 0 }
        }))
      }
      return res.end(JSON.stringify(j))
    }

    // 流式：SSE 翻译
    res.writeHead(200, {
      'Content-Type': openaiIn ? 'text/event-stream' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const reader = up.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    if (openaiIn) {
      sse({ id: 'chatcmpl-proxy', object: 'chat.completion.chunk', model: anthBody.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    }
    const finish = () => {
      if (openaiIn) sse({ id: 'chatcmpl-proxy', object: 'chat.completion.chunk', model: anthBody.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      res.end()
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload)
            if (j.type === 'content_block_delta' && j.delta?.text) {
              if (openaiIn) {
                sse({ id: 'chatcmpl-proxy', object: 'chat.completion.chunk', model: anthBody.model, choices: [{ index: 0, delta: { content: j.delta.text }, finish_reason: null }] })
              } else {
                sse(j)
              }
            } else if (j.type === 'content_block_delta' && j.delta?.thinking) {
              // extended thinking 增量透传给 Anthropic 入站
              if (!openaiIn) sse(j)
            } else if (j.type === 'message_stop') {
              finish()
              return
            } else if (!openaiIn) {
              sse(j)
            }
          } catch {}
        }
      }
      finish()
    } catch (e) {
      try { res.end() } catch {}
    }
  }

  /* ---------- 小工具 ---------- */

  function readBody(req) {
    return new Promise((resolve) => {
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => resolve(buf))
      req.on('error', () => resolve(''))
    })
  }

  function buildOpenAiUrl(base) {
    const b = base.replace(/\/+$/, '')
    if (b.includes('/chat/completions')) return b
    return `${b}/chat/completions`
  }

  function openAiHeaders(p) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` }
  }

  function openAiToAnthropic(body) {
    const system = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    return {
      model: body.model,
      max_tokens: body.max_tokens || 4096,
      stream: body.stream === true,
      ...(system ? { system } : {}),
      messages: (body.messages || [])
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
    }
  }

  function anthropicToOpenAi(body) {
    const system = Array.isArray(body.system) ? body.system.map((s) => s.text || '').join('\n') : body.system || ''
    return {
      model: body.model,
      stream: false,
      ...(system ? { messages: [{ role: 'system', content: system }] } : {}),
      messages: (body.messages || [])
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join('') }))
    }
  }

  async function fetchJson(url, headers, body) {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(`上游 HTTP ${r.status}`)
    return r.json()
  }

  async function pipeStream(res, url, headers, body, stream) {
    const up = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!up.ok) {
      const t = await up.text().catch(() => '')
      res.writeHead(up.status, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: `HTTP ${up.status}: ${t.slice(0, 300)}` } }))
    }
    const ct = up.headers.get('content-type') || ''
    res.writeHead(up.status, { 'Content-Type': ct || 'application/json' })
    if (!stream || !ct.includes('event-stream') || !up.body) {
      const text = await up.text()
      return res.end(text)
    }
    const reader = up.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    } catch {}
    res.end()
  }

  return { start, stop, status, setTarget, setRoutes }
}
