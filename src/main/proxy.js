import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

const DEFAULT_PORT = 18200
const BODY_LIMIT = 1024 * 1024
const TIMEOUT_MS = 120_000
const SUPPORTED_PROVIDERS = new Set(['openai-compatible', 'gemini', 'anthropic'])

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

class ClientAbortError extends Error {}

/**
 * 仅绑定 127.0.0.1 的模型代理。
 *
 * 入站接口：
 *   POST /v1/chat/completions  OpenAI Chat Completions
 *   POST /v1/messages          Anthropic Messages
 *   GET  /v1/models            setRoutes() 注册的模型
 *
 * 所有请求必须携带 createModelProxy() 收到的 token：
 *   Authorization: Bearer <token>，或 x-api-key: <token>
 */
export function createModelProxy({ port = DEFAULT_PORT, log = () => {}, token } = {}) {
  let provider = null
  let defaultModel = ''
  let routes = new Map()
  let server = null
  const activeControllers = new Set()

  function setTarget(nextProvider, model = '') {
    provider = nextProvider ? copyProvider(nextProvider) : null
    defaultModel = typeof model === 'string' ? model : ''
  }

  /** 完整替换路由；验证失败时保留旧集合。 */
  function setRoutes(selection = []) {
    const validated = validateRoutes(selection)
    const next = new Map()
    for (const item of validated) next.set(item.model, item.provider)
    routes = next
    return [...routes.keys()]
  }

  /** 纯校验并返回规范化集合；失败不影响当前路由。 */
  function validateRoutes(selection = []) {
    if (!Array.isArray(selection)) throw new TypeError('routes 必须是数组')
    const validated = new Map()
    for (const item of selection) {
      if (!item || typeof item.model !== 'string' || !item.model.trim()) {
        throw new TypeError('每条 route 都必须包含非空 model')
      }
      const model = item.model
      const nextProvider = copyProvider(item.provider)
      const previous = validated.get(model)
      if (previous && providerIdentity(previous) !== providerIdentity(nextProvider)) {
        throw new Error(`模型 ${model} 不能同时路由到多个 Provider`)
      }
      validated.set(model, nextProvider)
    }
    return [...validated].map(([model, provider]) => ({ model, provider }))
  }

  function status() {
    return {
      running: !!server,
      port: server ? server.address()?.port ?? null : null,
      provider: provider?.name || null,
      model: defaultModel
    }
  }

  async function start() {
    if (!token || typeof token !== 'string') throw new Error('代理 token 缺失，拒绝启动')
    if (server) return status()
    await new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          log('proxy error:', error?.stack || String(error))
          if (error instanceof ClientAbortError || res.destroyed) return
          if (res.headersSent) return res.destroy(error)
          sendJson(res, error.status || 502, { error: { message: error.message || String(error) } })
        })
      })
      server.requestTimeout = TIMEOUT_MS
      server.headersTimeout = Math.min(TIMEOUT_MS, 60_000)
      server.once('error', (error) => {
        server = null
        reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        log(`proxy listening on 127.0.0.1:${server.address().port}`)
        resolve()
      })
    })
    return status()
  }

  function stop() {
    if (!server) return Promise.resolve(status())
    for (const controller of activeControllers) controller.abort(new Error('proxy stopped'))
    const closing = server
    return new Promise((resolve) => {
      closing.close(() => {
        if (server === closing) server = null
        resolve(status())
      })
      closing.closeAllConnections?.()
    })
  }

  async function handle(req, res) {
    if (req.headers.origin !== undefined) {
      return sendJson(res, 403, { error: { message: '浏览器 Origin 请求被拒绝' } })
    }
    if (!isAuthorized(req, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      return sendJson(res, 401, { error: { message: '未授权' } })
    }

    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && path === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [...routes.keys()].map((id) => ({ id, object: 'model', owned_by: 'openharness' }))
      })
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/messages'].includes(path)) {
      return sendJson(res, 404, { error: { message: 'Not found' } })
    }

    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      throw new HttpError(400, '请求体不是有效 JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, '请求体必须是 JSON 对象')
    }

    const target = resolveTarget(body)
    if (path === '/v1/chat/completions') return handleChat(req, res, body, target)
    return handleMessages(req, res, body, target)
  }

  function resolveTarget(body) {
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
      throw new HttpError(400, 'model 必须是非空字符串')
    }
    if (body.model) {
      const target = routes.get(body.model)
      if (!target) throw new HttpError(400, `未知模型：${body.model}`)
      return target
    }
    if (!provider || !defaultModel) throw new HttpError(400, '请求未提供 model，且未配置默认模型')
    body.model = defaultModel
    return provider
  }

  async function handleChat(req, res, body, target) {
    const stream = body.stream === true
    if (target.type !== 'anthropic') {
      return proxyRaw(req, res, buildOpenAiUrl(target.baseUrl), openAiHeaders(target), body)
    }

    const anthBody = openAiToAnthropic(body)
    // ponytail: 跨协议流先取完整非流响应再编码 SSE；需要真增量时再加状态机。
    anthBody.stream = false
    return withUpstream(req, res, buildAnthropicUrl(target.baseUrl), anthropicHeaders(target), anthBody, async (up) => {
      if (!up.ok) return forwardResponse(res, up)
      const converted = anthropicResponseToOpenAi(await responseJson(up), body.model)
      if (stream) return writeOpenAiSse(res, converted, body.stream_options?.include_usage === true)
      sendJson(res, 200, converted)
    })
  }

  async function handleMessages(req, res, body, target) {
    const stream = body.stream === true
    if (target.type === 'anthropic') {
      return proxyRaw(req, res, buildAnthropicUrl(target.baseUrl), anthropicHeaders(target), body)
    }

    const openAiBody = anthropicToOpenAi(body)
    // ponytail: 跨协议流先取完整非流响应再编码 SSE；工具块仍完整保留。
    openAiBody.stream = false
    return withUpstream(req, res, buildOpenAiUrl(target.baseUrl), openAiHeaders(target), openAiBody, async (up) => {
      if (!up.ok) return forwardResponse(res, up)
      const converted = openAiResponseToAnthropic(await responseJson(up), body.model)
      if (stream) return writeAnthropicSse(res, converted)
      sendJson(res, 200, converted)
    })
  }

  function proxyRaw(req, res, url, headers, body) {
    return withUpstream(req, res, url, headers, body, (up, armTimeout) => forwardResponse(res, up, armTimeout))
  }

  async function withUpstream(req, res, url, headers, body, consume) {
    const controller = new AbortController()
    let timer
    let timedOut = false
    const armTimeout = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('upstream timeout'))
      }, TIMEOUT_MS)
    }
    const disconnect = () => controller.abort(new Error('client disconnected'))
    req.once('aborted', disconnect)
    res.once('close', disconnect)
    activeControllers.add(controller)
    armTimeout()
    try {
      const up = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
      armTimeout()
      return await consume(up, armTimeout)
    } catch (error) {
      if (timedOut) throw new HttpError(504, '上游请求超时')
      if (req.aborted || (res.destroyed && !res.writableEnded)) throw new ClientAbortError('客户端已断开')
      throw error
    } finally {
      clearTimeout(timer)
      activeControllers.delete(controller)
      req.off('aborted', disconnect)
      res.off('close', disconnect)
    }
  }

  return { start, stop, status, setTarget, validateRoutes, setRoutes }
}

function copyProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('route 必须包含 provider')
  const type = provider.type === 'ark' ? 'openai-compatible' : provider.type || 'openai-compatible'
  if (!SUPPORTED_PROVIDERS.has(type)) throw new TypeError(`不支持的 Provider 协议：${provider.type || '(空)'}`)
  if (typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) throw new TypeError('Provider baseUrl 不能为空')
  let parsed
  try { parsed = new URL(provider.baseUrl) } catch { throw new TypeError('Provider baseUrl 无效') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Provider baseUrl 只支持 http/https')
  return { ...provider, type, baseUrl: provider.baseUrl.trim() }
}

function providerIdentity(provider) {
  return provider.id ? `id:${provider.id}` : `${provider.type}:${provider.baseUrl}`
}

function isAuthorized(req, token) {
  if (!token || typeof token !== 'string') return false
  const auth = typeof req.headers.authorization === 'string'
    ? req.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    : null
  const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null
  return [auth, apiKey].some((candidate) => candidate && safeEqual(candidate, token))
}

function safeEqual(left, right) {
  const digest = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(left), digest(right))
}

function sendJson(res, status, body) {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      req.resume()
      reject(error)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) return fail(new HttpError(413, `请求体超过 ${BODY_LIMIT} 字节`))
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onError = (error) => fail(error)
    const onAborted = () => fail(new ClientAbortError('客户端已断开'))
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}

function buildOpenAiUrl(base) {
  const value = base.replace(/\/+$/, '')
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`
}

function buildAnthropicUrl(base) {
  const value = base.replace(/\/+$/, '')
  return value.endsWith('/v1') ? `${value}/messages` : value.endsWith('/messages') ? value : `${value}/v1/messages`
}

function openAiHeaders(provider) {
  return {
    'Content-Type': 'application/json',
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
  }
}

function anthropicHeaders(provider) {
  return {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {})
  }
}

async function responseJson(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { throw new HttpError(502, '上游返回无效 JSON') }
}

async function forwardResponse(res, upstream, armTimeout = () => {}) {
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': upstream.headers.get('cache-control') || 'no-cache'
  })
  if (!upstream.body) return res.end()
  const reader = upstream.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    armTimeout()
    res.write(Buffer.from(value))
  }
  res.end()
}

function openAiToAnthropic(body) {
  if (!Array.isArray(body.messages)) throw new HttpError(400, 'messages 必须是数组')
  const messages = []
  const system = []
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') throw new HttpError(400, 'message 必须是对象')
    if (message.role === 'system' || message.role === 'developer') {
      system.push(textContent(message.content, 400))
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new HttpError(400, 'tool message 缺少 tool_call_id')
      pushAnthropicMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: openAiContentToAnthropic(message.content, 400)
      }])
    } else if (message.role === 'assistant') {
      const content = openAiContentToAnthropic(message.content, 400)
      for (const call of message.tool_calls || []) {
        if (call?.type !== 'function' || !call.id || !call.function?.name) throw new HttpError(400, '仅支持带 id 的 function tool_call')
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments, 400)
        })
      }
      pushAnthropicMessage(messages, 'assistant', content)
    } else if (message.role === 'user') {
      pushAnthropicMessage(messages, 'user', openAiContentToAnthropic(message.content, 400))
    } else {
      throw new HttpError(400, `不支持的 message role：${message.role}`)
    }
  }

  const converted = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
    messages,
    stream: false
  }
  if (system.length) converted.system = system.join('\n')
  if (body.temperature !== undefined) converted.temperature = body.temperature
  if (body.top_p !== undefined) converted.top_p = body.top_p
  if (body.stop !== undefined) converted.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (Array.isArray(body.tools)) converted.tools = body.tools.map(openAiToolToAnthropic)
  if (body.tool_choice !== undefined) Object.assign(converted, openAiToolChoiceToAnthropic(body.tool_choice))
  if (body.parallel_tool_calls === false && Array.isArray(converted.tools) && !converted.tool_choice) {
    converted.tool_choice = { type: 'auto' }
  }
  if (body.parallel_tool_calls !== undefined && converted.tool_choice) {
    converted.tool_choice.disable_parallel_tool_use = !body.parallel_tool_calls
  }
  return converted
}

function anthropicToOpenAi(body) {
  if (!Array.isArray(body.messages)) throw new HttpError(400, 'messages 必须是数组')
  const messages = []
  const system = anthropicSystemText(body.system)
  if (system) messages.push({ role: 'system', content: system })

  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) throw new HttpError(400, 'Anthropic message role 必须是 user/assistant')
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(blocks)) throw new HttpError(400, 'Anthropic message content 无效')
    if (message.role === 'assistant') {
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('')
      const calls = blocks.filter((block) => block?.type === 'tool_use').map((block) => {
        if (!block.id || !block.name) throw new HttpError(400, 'tool_use 缺少 id 或 name')
        return {
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
        }
      })
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }

    let pending = []
    const flushUser = () => {
      if (!pending.length) return
      messages.push({ role: 'user', content: anthropicBlocksToOpenAi(pending) })
      pending = []
    }
    for (const block of blocks) {
      if (block?.type !== 'tool_result') {
        pending.push(block)
        continue
      }
      flushUser()
      if (!block.tool_use_id) throw new HttpError(400, 'tool_result 缺少 tool_use_id')
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: anthropicBlocksToOpenAi(normalizeAnthropicContent(block.content))
      })
    }
    flushUser()
  }

  const converted = {
    model: body.model,
    messages,
    stream: false
  }
  if (body.max_tokens !== undefined) converted.max_tokens = body.max_tokens
  if (body.temperature !== undefined) converted.temperature = body.temperature
  if (body.top_p !== undefined) converted.top_p = body.top_p
  if (body.stop_sequences !== undefined) converted.stop = body.stop_sequences
  if (Array.isArray(body.tools)) converted.tools = body.tools.map(anthropicToolToOpenAi)
  if (body.tool_choice !== undefined) converted.tool_choice = anthropicToolChoiceToOpenAi(body.tool_choice)
  if (body.tool_choice?.disable_parallel_tool_use !== undefined) {
    converted.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use
  }
  return converted
}

function pushAnthropicMessage(messages, role, content) {
  if (!content.length) return
  const previous = messages.at(-1)
  if (previous?.role === role) previous.content.push(...content)
  else messages.push({ role, content })
}

function openAiContentToAnthropic(content, status) {
  if (content === null || content === undefined || content === '') return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw new HttpError(status, 'OpenAI message content 无效')
  return content.map((block) => {
    if (block?.type === 'text' || block?.type === 'input_text') return { type: 'text', text: block.text || '' }
    if (block?.type === 'image_url' && block.image_url?.url) {
      const match = block.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      return match
        ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
        : { type: 'image', source: { type: 'url', url: block.image_url.url } }
    }
    throw new HttpError(status, `不支持的 OpenAI content block：${block?.type}`)
  })
}

function normalizeAnthropicContent(content) {
  if (content === null || content === undefined) return []
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function anthropicBlocksToOpenAi(blocks) {
  if (!Array.isArray(blocks)) throw new HttpError(400, 'Anthropic content block 无效')
  const converted = blocks.map((block) => {
    if (block?.type === 'text') return { type: 'text', text: block.text || '' }
    if (block?.type === 'image' && block.source?.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
    }
    if (block?.type === 'image' && block.source?.type === 'url') {
      return { type: 'image_url', image_url: { url: block.source.url } }
    }
    throw new HttpError(400, `不支持的 Anthropic content block：${block?.type}`)
  })
  if (converted.every((block) => block.type === 'text')) return converted.map((block) => block.text).join('')
  return converted
}

function textContent(content, status) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new HttpError(status, 'system content 无效')
  return content.map((block) => {
    if (block?.type === 'text' || block?.type === 'input_text') return block.text || ''
    throw new HttpError(status, `system 不支持 content block：${block?.type}`)
  }).join('')
}

function anthropicSystemText(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) throw new HttpError(400, 'system 必须是字符串或数组')
  return system.map((block) => {
    if (block?.type !== 'text') throw new HttpError(400, `system 不支持 content block：${block?.type}`)
    return block.text || ''
  }).join('\n')
}

function parseToolInput(value, status) {
  if (value === undefined || value === '') return {}
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new HttpError(status, '工具参数不是有效 JSON 对象')
  }
}

function openAiToolToAnthropic(tool) {
  if (tool?.type !== 'function' || !tool.function?.name) throw new HttpError(400, '仅支持 function 工具定义')
  return {
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters || { type: 'object', properties: {} }
  }
}

function anthropicToolToOpenAi(tool) {
  if (!tool?.name) throw new HttpError(400, 'Anthropic 工具定义缺少 name')
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }
}

function openAiToolChoiceToAnthropic(choice) {
  if (choice === 'none') return { tools: [] }
  if (choice === 'required') return { tool_choice: { type: 'any' } }
  if (choice === 'auto') return { tool_choice: { type: 'auto' } }
  if (choice?.type === 'function' && choice.function?.name) {
    return { tool_choice: { type: 'tool', name: choice.function.name } }
  }
  throw new HttpError(400, '不支持的 OpenAI tool_choice')
}

function anthropicToolChoiceToOpenAi(choice) {
  if (choice?.type === 'auto') return 'auto'
  if (choice?.type === 'none') return 'none'
  if (choice?.type === 'any') return 'required'
  if (choice?.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } }
  throw new HttpError(400, '不支持的 Anthropic tool_choice')
}

function anthropicResponseToOpenAi(message, model) {
  if (!Array.isArray(message?.content)) throw new HttpError(502, 'Anthropic 上游响应缺少 content')
  const text = message.content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('')
  const calls = message.content.filter((block) => block?.type === 'tool_use').map((block) => {
    if (!block.id || !block.name) throw new HttpError(502, 'Anthropic 上游返回无效 tool_use')
    return {
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
    }
  })
  return {
    id: message.id || 'chatcmpl-proxy',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: message.model || model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: message.stop_reason === 'tool_use' ? 'tool_calls' : message.stop_reason === 'max_tokens' ? 'length' : 'stop'
    }],
    usage: {
      prompt_tokens: message.usage?.input_tokens || 0,
      completion_tokens: message.usage?.output_tokens || 0,
      total_tokens: (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0)
    }
  }
}

function openAiResponseToAnthropic(response, model) {
  const choice = response?.choices?.[0]
  if (!choice?.message) throw new HttpError(502, 'OpenAI 上游响应缺少 choices[0].message')
  const message = choice.message
  const content = []
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content })
  for (const call of message.tool_calls || []) {
    if (call?.type !== 'function' || !call.function?.name) throw new HttpError(502, 'OpenAI 上游返回无效 tool_call')
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments, 502)
    })
  }
  return {
    id: response.id || 'msg_proxy',
    type: 'message',
    role: 'assistant',
    model: response.model || model,
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0
    }
  }
}

function writeOpenAiSse(res, response, includeUsage) {
  res.writeHead(200, sseHeaders())
  const choice = response.choices[0]
  const base = { id: response.id, object: 'chat.completion.chunk', created: response.created, model: response.model }
  writeSseData(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  if (choice.message.content) {
    writeSseData(res, { ...base, choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }] })
  }
  for (const [index, call] of (choice.message.tool_calls || []).entries()) {
    writeSseData(res, {
      ...base,
      choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }]
    })
  }
  writeSseData(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })
  if (includeUsage) writeSseData(res, { ...base, choices: [], usage: response.usage })
  res.end('data: [DONE]\n\n')
}

function writeAnthropicSse(res, message) {
  res.writeHead(200, sseHeaders())
  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...message.usage, output_tokens: 0 } }
  })
  message.content.forEach((block, index) => {
    const start = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' }
    writeSseEvent(res, 'content_block_start', { type: 'content_block_start', index, content_block: start })
    if (block.type === 'tool_use') {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }
      })
    } else if (block.text) {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text }
      })
    }
    writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  })
  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: { output_tokens: message.usage.output_tokens }
  })
  writeSseEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

function sseHeaders() {
  return { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
}

function writeSseData(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function writeSseEvent(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
}
