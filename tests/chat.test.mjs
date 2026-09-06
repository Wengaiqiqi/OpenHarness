import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatService } from '../src/main/chat.js'

const provider = { type: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: 'key' }
const payload = { sessionId: 's1', provider, model: 'demo', messages: [{ role: 'user', content: 'hi' }] }

function windowMock() {
  const chunks = []
  return { chunks, isDestroyed: () => false, webContents: { send: (_channel, chunk) => chunks.push(chunk) } }
}

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
