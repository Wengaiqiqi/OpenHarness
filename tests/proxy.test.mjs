import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createModelProxy } from '../src/main/proxy.js'

const token = 'test-proxy-token'
const provider = (type, baseUrl, id = type) => ({ id, name: id, type, baseUrl, apiKey: 'upstream-key' })

async function mockServer(handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

async function readRequest(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

async function proxyRequest(proxy, path, body, headers = {}) {
  const port = proxy.status().port
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

test('token, Origin, body validation, route replacement, unknown model and target clearing', async (t) => {
  await assert.rejects(createModelProxy({ port: 0 }).start(), /token/)

  let calls = 0
  const upstream = await mockServer(async (req, res) => {
    calls++
    const body = await readRequest(req)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'ok', model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
  })
  t.after(() => closeServer(upstream.server))

  const proxy = createModelProxy({ port: 0, token })
  proxy.setRoutes([{ model: 'm-one', provider: provider('openai-compatible', upstream.baseUrl, 'p1') }])
  const normalized = proxy.validateRoutes([{ model: 'm-default', provider: { id: 'p-default', baseUrl: upstream.baseUrl } }])
  assert.equal(normalized[0].provider.type, 'openai-compatible')
  const ark = proxy.validateRoutes([{ model: ' exact-id ', provider: { id: 'legacy-ark', type: 'ark', baseUrl: upstream.baseUrl } }])
  assert.equal(ark[0].provider.type, 'openai-compatible')
  assert.equal(ark[0].model, ' exact-id ')
  assert.deepEqual(proxy.validateRoutes([]), [])
  await proxy.start()
  t.after(() => proxy.stop())

  let response = await fetch(`http://127.0.0.1:${proxy.status().port}/v1/models`)
  assert.equal(response.status, 401)
  response = await fetch(`http://127.0.0.1:${proxy.status().port}/v1/models`, { headers: { Authorization: `Bearer ${token}`, Origin: 'http://evil.test' } })
  assert.equal(response.status, 403)
  response = await fetch(`http://127.0.0.1:${proxy.status().port}/v1/models`, { headers: { 'x-api-key': token } })
  assert.deepEqual((await response.json()).data.map((item) => item.id), ['m-one'])

  proxy.setRoutes([{ model: 'm-two', provider: provider('openai-compatible', upstream.baseUrl, 'p1') }])
  response = await fetch(`http://127.0.0.1:${proxy.status().port}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })
  assert.deepEqual((await response.json()).data.map((item) => item.id), ['m-two'])

  assert.throws(() => proxy.setRoutes([
    { model: 'm-two', provider: provider('openai-compatible', upstream.baseUrl, 'p1') },
    { model: 'm-two', provider: provider('anthropic', upstream.baseUrl, 'p2') }
  ]), /多个 Provider/)
  response = await fetch(`http://127.0.0.1:${proxy.status().port}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })
  assert.deepEqual((await response.json()).data.map((item) => item.id), ['m-two'])

  response = await proxyRequest(proxy, '/v1/chat/completions', { model: 'not-registered', messages: [] })
  assert.equal(response.status, 400)
  assert.equal(calls, 0)
  response = await proxyRequest(proxy, '/v1/chat/completions', '{bad json')
  assert.equal(response.status, 400)
  response = await proxyRequest(proxy, '/v1/chat/completions', 'x'.repeat(1024 * 1024 + 1))
  assert.equal(response.status, 413)

  proxy.setTarget({ id: 'default', baseUrl: upstream.baseUrl }, 'default-model')
  response = await proxyRequest(proxy, '/v1/chat/completions', { messages: [] })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).model, 'default-model')
  proxy.setTarget(null, '')
  assert.deepEqual(proxy.status(), { running: true, port: proxy.status().port, provider: null, model: '' })
  response = await proxyRequest(proxy, '/v1/chat/completions', { messages: [] })
  assert.equal(response.status, 400)
})

test('OpenAI to Anthropic preserves system, tools, tool calls/results and emits valid OpenAI SSE', async (t) => {
  const received = []
  const upstream = await mockServer(async (req, res) => {
    received.push(await readRequest(req))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-tool', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'call-1', name: 'weather', input: { city: 'Shanghai' } }],
      usage: { input_tokens: 3, output_tokens: 4 }
    }))
  })
  t.after(() => closeServer(upstream.server))
  const proxy = createModelProxy({ port: 0, token })
  proxy.setRoutes([{ model: 'claude-tool', provider: provider('anthropic', upstream.baseUrl, 'anthropic-1') }])
  await proxy.start()
  t.after(() => proxy.stop())

  const requestBody = {
    model: 'claude-tool', max_tokens: 100, stream: true,
    messages: [
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', tool_calls: [{ id: 'call-0', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } }] },
      { role: 'tool', tool_call_id: 'call-0', content: 'sunny' }
    ],
    tools: [{ type: 'function', function: { name: 'weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'weather' } }
  }
  const response = await proxyRequest(proxy, '/v1/chat/completions', requestBody)
  const text = await response.text()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  assert.match(text, /"tool_calls"/)
  assert.match(text, /weather/)
  assert.match(text, /data: \[DONE\]/)
  assert.equal(received[0].system, 'be concise')
  assert.equal(received[0].tools[0].name, 'weather')
  assert.deepEqual(received[0].messages.at(-1).content[0], { type: 'tool_result', tool_use_id: 'call-0', content: [{ type: 'text', text: 'sunny' }] })
})

test('Anthropic to OpenAI preserves system, tools and tool results; Anthropic SSE has message_stop only', async (t) => {
  const received = []
  const upstream = await mockServer(async (req, res) => {
    received.push(await readRequest(req))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'chat-1', model: 'gpt-tool', choices: [{
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'weather', arguments: '{"city":"Beijing"}' } }] },
        finish_reason: 'tool_calls'
      }], usage: { prompt_tokens: 5, completion_tokens: 6 }
    }))
  })
  t.after(() => closeServer(upstream.server))
  const proxy = createModelProxy({ port: 0, token })
  proxy.setRoutes([{ model: 'gpt-tool', provider: provider('openai-compatible', upstream.baseUrl, 'openai-1') }])
  await proxy.start()
  t.after(() => proxy.stop())

  const response = await proxyRequest(proxy, '/v1/messages', {
    model: 'gpt-tool', max_tokens: 100, stream: true,
    system: [{ type: 'text', text: 'be precise' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'weather', input: { city: 'Shanghai' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'sunny' }] }] }
    ],
    tools: [{ name: 'weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'weather' }
  })
  const text = await response.text()
  assert.equal(response.status, 200)
  assert.match(text, /event: message_start/)
  assert.match(text, /event: message_stop/)
  assert.doesNotMatch(text, /\[DONE\]/)
  assert.match(text, /input_json_delta/)
  assert.equal(received[0].messages[0].role, 'system')
  assert.deepEqual(received[0].messages.at(-1), { role: 'tool', tool_call_id: 'call-1', content: 'sunny' })
  assert.equal(received[0].tools[0].function.name, 'weather')
})

test('Anthropic same-protocol streaming response is byte-for-byte forwarded', async (t) => {
  const raw = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  const upstream = await mockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(raw)
  })
  t.after(() => closeServer(upstream.server))
  const proxy = createModelProxy({ port: 0, token })
  proxy.setRoutes([{ model: 'claude-raw', provider: provider('anthropic', upstream.baseUrl, 'anthropic-raw') }])
  await proxy.start()
  t.after(() => proxy.stop())
  const response = await proxyRequest(proxy, '/v1/messages', { model: 'claude-raw', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(await response.text(), raw)
})

test('upstream errors are returned and client disconnect aborts the upstream request', async (t) => {
  const failed = await mockServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"error":"upstream"}')
  })
  t.after(() => closeServer(failed.server))
  const proxy = createModelProxy({ port: 0, token })
  proxy.setRoutes([{ model: 'failed', provider: provider('openai-compatible', failed.baseUrl, 'failed-provider') }])
  await proxy.start()
  t.after(() => proxy.stop())
  let response = await proxyRequest(proxy, '/v1/chat/completions', { model: 'failed', messages: [] })
  assert.equal(response.status, 503)
  assert.equal(await response.text(), '{"error":"upstream"}')

  let upstreamAborted
  const aborted = new Promise((resolve) => { upstreamAborted = resolve })
  const hanging = await mockServer((req, res) => {
    req.once('aborted', upstreamAborted)
    res.once('close', upstreamAborted)
  })
  t.after(() => closeServer(hanging.server))
  const cancelProxy = createModelProxy({ port: 0, token })
  cancelProxy.setRoutes([{ model: 'hanging', provider: provider('openai-compatible', hanging.baseUrl, 'hanging-provider') }])
  await cancelProxy.start()
  t.after(() => cancelProxy.stop())
  const request = http.request({ hostname: '127.0.0.1', port: cancelProxy.status().port, path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  request.on('error', () => {})
  request.end(JSON.stringify({ model: 'hanging', messages: [] }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  request.destroy()
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 2_000))])
})
