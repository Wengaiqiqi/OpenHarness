import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatService } from '../src/main/chat.js'

const provider = { type: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: 'key' }
const payload = { sessionId: 's1', provider, model: 'demo', messages: [{ role: 'user', content: 'hi' }] }

function windowMock() {
  const chunks = []
  return { chunks, isDestroyed: () => false, webContents: { send: (_channel, chunk) => chunks.push(chunk) } }
}

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

test('invalid URL construction does not leave a controller behind', async () => {
  const chat = createChatService()
  await assert.rejects(chat.send({ isDestroyed: () => false, webContents: { send() {} } }, {
    ...payload,
    provider: { ...provider, baseUrl: {} }
  }))
  globalThis.fetch = async () => new Response('data: [DONE]\n\n')
  assert.deepEqual(await chat.send({ isDestroyed: () => false, webContents: { send() {} } }, payload), { ok: true })
})
