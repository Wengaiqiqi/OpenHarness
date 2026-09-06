/**
 * 统一流式对话服务
 * 支持 openai-compatible（含火山方舟 Ark）、openai-responses 与 anthropic 协议
 */
export function createChatService() {
  const controllers = new Map() // sessionId -> AbortController

  async function send(win, { sessionId, provider, model, messages, thinkingLevel = 'medium' }) {
    if (!provider || !provider.baseUrl || !provider.apiKey) {
      return { ok: false, message: '请先在「模型服务」中配置 Provider 与 API Key' }
    }

    let type = provider.type || 'openai-compatible'

    if (type === 'bedrock') {
      const msg = 'Amazon Bedrock 暂未支持：需要 AWS SigV4 签名，请通过 OpenAI Compatible 网关接入'
      pushChunk(win, sessionId, { type: 'error', message: msg })
      return { ok: false, message: msg }
    }

    if (controllers.has(sessionId)) {
      return { ok: false, message: '该对话正在生成，请先停止或等待完成' }
    }

    let url = buildUrl(provider, type)
    let headers = buildHeaders(provider, type)
    let baseBody = buildBody(type, provider, model, messages)

    // 思考等级候选链：首选参数 → 逐级降级；HTTP 400/422 时沿链重试
    let candidates = thinkingCandidates(type, model, thinkingLevel || 'medium')
    let usedIdx = 0

    const controller = new AbortController()
    controllers.set(sessionId, controller)
    let reader = null
    let watchdog = null
    let timedOut = false

    const runFetch = () => {
      const body = { ...baseBody, ...candidates[usedIdx] }
      return fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
    }

    try {
      // 看门狗：连接后 90 秒内没有任何数据则主动中止，把"永远卡住"变成可见报错
      const armWatchdog = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, 90000)
      }
      armWatchdog()
      const resetWatchdog = () => {
        timedOut = false
        armWatchdog()
      }

      let res = await runFetch()
      // /responses 端点不存在（404，如智普只支持 chat/completions）→
      // 自动把协议降级为 OpenAI Compatible 重试（流式解析/思考链同步切换）
      if (type === 'openai-responses' && res.status === 404) {
        console.warn('[chat] /responses 404，降级为 chat/completions 协议重试')
        await res.body?.cancel().catch(() => {})
        type = 'openai-compatible'
        url = buildUrl(provider, type)
        headers = buildHeaders(provider, type)
        baseBody = buildBody(type, provider, model, messages)
        candidates = thinkingCandidates(type, model, thinkingLevel || 'medium')
        usedIdx = 0
        res = await runFetch()
      }
      // 思考参数不被接受（HTTP 400/422）时沿候选链降级重试
      while ((res.status === 400 || res.status === 422) && usedIdx < candidates.length - 1) {
        const bad = await res.text().catch(() => '')
        console.warn(`[chat] 思考参数被拒，降级到候选 ${usedIdx + 1}/${candidates.length}：`, bad.slice(0, 160))
        usedIdx++
        res = await runFetch()
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        pushChunk(win, sessionId, { type: 'error', message: `HTTP ${res.status}: ${text.slice(0, 500)}` })
        return { ok: false, message: `HTTP ${res.status}` }
      }

      if (!res.body) {
        return { ok: false, message: '响应无 body' }
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        resetWatchdog()
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            pushChunk(win, sessionId, { type: 'done' })
            return { ok: true }
          }
          try {
            const json = JSON.parse(payload)
            if (json.error) {
              const msg = json.error.message || JSON.stringify(json.error)
              pushChunk(win, sessionId, { type: 'error', message: msg })
              return { ok: false, message: msg }
            }
            const delta = extractDelta(type, json)
            if (delta) pushChunk(win, sessionId, delta)
          } catch {
            /* 忽略无法解析的行 */
          }
        }
      }

      pushChunk(win, sessionId, { type: 'done' })
      return { ok: true }
    } catch (err) {
      if (timedOut) {
        const msg = '上游 90 秒未返回任何数据，已中止（请检查网络或系统代理）'
        pushChunk(win, sessionId, { type: 'error', message: msg })
        return { ok: false, message: msg }
      }
      if (err.name === 'AbortError') {
        pushChunk(win, sessionId, { type: 'done', aborted: true })
        return { ok: true, aborted: true }
      }
      pushChunk(win, sessionId, { type: 'error', message: String(err) })
      return { ok: false, message: String(err) }
    } finally {
      clearTimeout(watchdog)
      if (reader) {
        await reader.cancel().catch(() => {})
        try { reader.releaseLock() } catch {}
      }
      if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
    }
  }

  function abort(sessionId) {
    const c = controllers.get(sessionId)
    if (c) c.abort()
  }

  return { send, abort }
}

function pushChunk(win, sessionId, chunk) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('chat:chunk', { sessionId, ...chunk })
  }
}

function buildUrl(provider, type) {
  const base = provider.baseUrl.replace(/\/+$/, '')
  if (type === 'anthropic') {
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  }
  if (type === 'openai-responses') {
    return base.endsWith('/responses') ? base : `${base}/responses`
  }
  // openai-compatible / ark / gemini-openai 网关
  if (base.includes('/chat/completions')) return base
  return `${base}/chat/completions`
}

function buildHeaders(provider, type) {
  if (type === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01'
    }
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`
  }
}

function buildBody(type, provider, model, messages) {
  if (type === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    return {
      model,
      max_tokens: 4096,
      stream: true,
      ...(system ? { system } : {}),
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
    }
  }
  if (type === 'openai-responses') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    return {
      model,
      stream: true,
      ...(system ? { instructions: system } : {}),
      input: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
    }
  }
  return { model, messages, stream: true, temperature: provider.temperature ?? 0.7 }
}

function extractDelta(type, json) {
  if (type === 'anthropic') {
    if (json.type === 'content_block_delta') return { type: 'delta', delta: json.delta?.text || '' }
    return null
  }
  if (type === 'openai-responses') {
    if (json.type === 'response.output_text.delta') return { type: 'delta', delta: json.delta || '' }
    return null
  }
  // openai-compatible：GLM / DeepSeek 等思考型模型会先推 reasoning_content
  const d = json.choices?.[0]?.delta || {}
  if (d.content) return { type: 'delta', delta: d.content }
  if (d.reasoning_content) return { type: 'reasoning', delta: d.reasoning_content }
  return null
}

// 按模型族生成思考参数候选链（首选 → 逐级降级），HTTP 400/422 时沿链重试
function thinkingCandidates(type, model, level) {
  const m = (model || '').toLowerCase()
  // Anthropic：thinking.budget_tokens（最低 1024，且必须小于 max_tokens）
  if (type === 'anthropic') {
    if (level === 'off') {
      // 必须开启思考而用户关闭 → 按最低思考适配
      return [{}, { thinking: { type: 'enabled', budget_tokens: 1024 }, max_tokens: 9216 }]
    }
    const budget = level === 'low' ? 2048 : level === 'high' ? 16384 : 8192
    return [{ thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: budget + 8192 }, {}]
  }
  // OpenAI Responses：reasoning.effort
  if (type === 'openai-responses') {
    if (level === 'off') return [{}, { reasoning: { effort: 'low' } }]
    return [{ reasoning: { effort: level } }, {}]
  }
  // GLM / 豆包系：thinking.type 开关（GLM-5.3 等强制开启，off 被拒时回退 enabled）
  if (/glm|doubao/.test(m)) {
    if (level === 'off') return [{ thinking: { type: 'disabled' } }, { thinking: { type: 'enabled' } }]
    return [{ thinking: { type: 'enabled' } }, { thinking: { type: 'disabled' } }]
  }
  // Qwen：enable_thinking + thinking_budget
  if (/qwen/.test(m)) {
    if (level === 'off') return [{ enable_thinking: false }, {}]
    const budget = level === 'low' ? 1024 : level === 'high' ? 24576 : 8192
    return [{ enable_thinking: true, thinking_budget: budget }, { enable_thinking: true }, {}]
  }
  // DeepSeek reasoner：思考不可控，原样发送
  if (/deepseek/.test(m)) return [{}]
  // 默认 OpenAI 系：reasoning_effort（off 时不带参数，被拒则按最低档重试）
  if (level === 'off') return [{}, { reasoning_effort: 'low' }]
  return [{ reasoning_effort: level }, {}]
}
