import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('CDP routes out-of-order replies and rejects requests on disconnect or failed handshake', async () => {
  let socket
  class Socket {
    static OPEN = 1
    readyState = 1
    sent = []
    constructor() { socket = this }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = 3; this.onclose() }
  }
  const source = fs.readFileSync(new URL('../cdp-eval.mjs', import.meta.url), 'utf8')
  const context = vm.createContext({ WebSocket: Socket, process: { argv: [] } })
  vm.runInContext(source.slice(0, source.indexOf('const response =')), context)
  const connected = context.wsConnect('ws://localhost/test')
  socket.onopen()
  const client = await connected
  const first = client.send({ method: 'first' }), second = client.send({ method: 'second' })
  assert.deepEqual(socket.sent.map(({ id }) => id), [1, 2])
  socket.onmessage({ data: 'invalid JSON' })
  socket.onmessage({ data: JSON.stringify({ method: 'Runtime.event' }) })
  for (const id of [2, 1]) socket.onmessage({ data: JSON.stringify({ id, result: id }) })
  assert.equal((await first).result, 1)
  assert.equal((await second).result, 2)
  const pending = client.send({ method: 'pending' })
  client.close()
  await assert.rejects(pending, /closed/)
  await assert.rejects(client.send({ method: 'afterClose' }), /closed/)
  const failed = context.wsConnect('ws://localhost/test')
  socket.onerror({ error: new Error('handshake failed') })
  await assert.rejects(failed, /handshake failed/)
})
