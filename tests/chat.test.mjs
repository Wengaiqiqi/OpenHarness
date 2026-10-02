import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatService } from '../src/main/chat.js'

const provider = { type: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: 'key' }
const payload = { sessionId: 's1', provider, model: 'demo', messages: [{ role: 'user', content: 'hi' }] }

function windowMock() {
  const chunks = []
  return { chunks, isDestroyed: () => false, webContents: { send: (_channel, chunk) => chunks.push(chunk) } }
}

test('thinking uses native effort and server defaults without fixed token budgets', async () => {
  for (const [type, model, level, expected, rejected = 0, info = null] of [
    ['openai-compatible', 'qwen-plus', 'low', { enable_thinking: true }],
    ['openai-compatible', 'qwen-plus', 'medium', { enable_thinking: true }],
    ['openai-compatible', 'qwen-plus', 'high', { enable_thinking: true }],
    ['openai-compatible', 'qwen-plus', 'off', { enable_thinking: false }],
    ['openai-compatible', 'qwen-plus', 'medium', {}, 1],
    ['openai-compatible', 'qwen3.8-omni-flash', 'high', { reasoning_effort: 'high' }],
    ['openai-compatible', 'qwen3.8-omni-flash', 'off', { reasoning_effort: 'none' }],
    ['openai-compatible', 'glm-unknown', 'medium', {}, 2],
    ['openai-compatible', 'deepseek-reasoner', 'high', {}],
    ['openai-responses', 'gpt-demo', 'medium', { reasoning: { effort: 'medium' } }],
    ['anthropic', 'vendor/claude-adaptive', 'high', {
      max_tokens: 64000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }
    }, 0, { max_tokens: 64000 }],
    ['anthropic', 'claude-adaptive', 'medium', {
      max_tokens: 96000, thinking: { type: 'adaptive' }
    }, 1, { max_tokens: 96000 }],
    ['anthropic', 'claude-effort-only', 'low', {
      max_tokens: 128000, output_config: { effort: 'low' }
    }, 2, { max_tokens: 128000 }],
    ['anthropic', 'claude-legacy', 'medium', { max_tokens: 64000 }, 3, { max_tokens: 64000 }],
    ['anthropic', 'claude-no-thinking', 'high', { max_tokens: 64000 }, 0, {
      max_tokens: 64000, capabilities: { thinking: { supported: false } }
    }],
    ['anthropic', 'claude-gateway-defaults', 'medium', {
      thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }
    }],
    ['anthropic', 'claude-adaptive', 'off', { max_tokens: 64000, thinking: { type: 'disabled' } }, 0, { max_tokens: 64000 }]
  ]) {
    const bodies = []
    const lookups = []
    globalThis.fetch = async (url, options) => {
      if (options.method !== 'POST') {
        lookups.push(url)
        assert.equal(options.headers['x-api-key'], provider.apiKey)
        return info ? Response.json(info) : new Response('not found', { status: 404 })
      }
      const body = JSON.parse(options.body)
      bodies.push(body)
      assert.equal('thinking_budget' in body, false)
      assert.equal('budget_tokens' in (body.thinking || {}), false)
      if (bodies.length <= rejected) return new Response('unsupported parameter', { status: bodies.length % 2 ? 400 : 422 })
      return new Response('data: [DONE]\n\n')
    }
    assert.deepEqual(await createChatService().send(windowMock(), {
      ...payload, provider: { ...provider, type }, model, thinkingLevel: level
    }), { ok: true })
    assert.equal(bodies.length, rejected + 1)
    const { model: sentModel, messages, input, stream, temperature, ...extras } = bodies.at(-1)
    assert.equal(sentModel, model)
    assert.deepEqual(extras, expected)
    assert.deepEqual(lookups, type === 'anthropic' ? [`${provider.baseUrl}/models/${encodeURIComponent(model)}`] : [])
  }
})

test('truncated streams and Responses failures are errors, not successful completions', async () => {
  for (const body of ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"type":"response.failed","response":{"error":{"message":"failed upstream"}}}\n\n',
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n']) {
    globalThis.fetch = async () => new Response(body)
    const win = windowMock()
    assert.equal((await createChatService().send(win, payload)).ok, false)
    assert.equal(win.chunks.at(-1).type, 'error')
  }
})

test('protocol terminal events complete even when the connection remains open', async () => {
  for (const type of ['message_stop', 'response.completed']) {
    let cancelled = false
    globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type })}\n\n`))
        signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
      },
      cancel() { cancelled = true }
    }))
    const chat = createChatService()
    const timer = setTimeout(() => chat.abort(payload.sessionId), 100)
    try {
      assert.deepEqual(await chat.send(windowMock(), payload), { ok: true })
      assert.equal(cancelled, true)
    } finally { clearTimeout(timer) }
  }
})

test('fetch failures keep their original error and release the session lock', async () => {
  const win = windowMock()
  const chat = createChatService()
  globalThis.fetch = async () => { throw new Error('upstream down') }

  const result = await chat.send(win, payload)
  assert.deepEqual(result, { ok: false, message: 'Error: upstream down' })
  assert.match(win.chunks.at(-1).message, /upstream down/)

  globalThis.fetch = async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  assert.deepEqual(await chat.send(win, payload), { ok: true })
})

test('one session rejects overlap until the aborted request has fully unwound', async () => {
  const win = windowMock()
  const chat = createChatService()
  let resolveFetch
  let aborted = false
  globalThis.fetch = (_url, options) => new Promise((resolve) => {
    resolveFetch = () => {
      const stream = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => {
            aborted = true
            controller.error(new DOMException('aborted', 'AbortError'))
          })
        }
      })
      resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
  })

  const first = chat.send(win, payload)
  await new Promise((resolve) => setImmediate(resolve))
  resolveFetch()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await chat.send(win, payload), {
    ok: false,
    message: '该对话正在生成，请先停止或等待完成'
  })

  chat.abort(payload.sessionId)
  assert.equal((await first).aborted, true)
  assert.equal(aborted, true)

  globalThis.fetch = async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  assert.deepEqual(await chat.send(win, payload), { ok: true })
})

test('one session can stream separate model requests and abort only one', async () => {
  const streams = new Map()
  globalThis.fetch = async (_url, { body, signal }) => new Response(new ReadableStream({
    start(controller) {
      streams.set(JSON.parse(body).model, controller)
      signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
    }
  }))
  const chat = createChatService()
  const win = windowMock()
  const first = chat.send(win, { ...payload, requestId: 'r1', model: 'first' })
  const second = chat.send(win, { ...payload, requestId: 'r2', model: 'second' })
  await new Promise(setImmediate)
  assert.equal(streams.size, 2)
  chat.abort('r1')
  streams.get('second').enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'))
  assert.equal((await first).aborted, true)
  assert.deepEqual(await second, { ok: true })
  assert.deepEqual(win.chunks.filter((chunk) => chunk.type === 'delta').map((chunk) => chunk.requestId), ['r2'])
  assert.equal(win.chunks.find((chunk) => chunk.requestId === 'r1' && chunk.type === 'done')?.aborted, true)
})

test('invalid URL construction does not leave a controller behind', async () => {
  const chat = createChatService()
  await assert.rejects(chat.send({ isDestroyed: () => false, webContents: { send() {} } }, {
    ...payload,
    provider: { ...provider, baseUrl: {} }
  }))
  globalThis.fetch = async () => new Response('data: [DONE]\n\n')
  assert.deepEqual(await chat.send({ isDestroyed: () => false, webContents: { send() {} } }, payload), { ok: true })
})
