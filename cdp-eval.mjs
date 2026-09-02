/**
 * 最小 CDP 客户端：连接 Electron 远程调试端口，在页面里执行 JS。
 * 用法：npx electron 无关——直接 node cdp-eval.mjs "表达式" [端口]
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

const PORT = Number(process.argv[3] || 9333)
const EXPR = process.argv[2]

function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve(JSON.parse(buf)))
      })
      .on('error', reject)
  })
}

// 极简 WebSocket 客户端（仅够 CDP 用）
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const u = new URL(url)
    const req =
      `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
      `Host: ${u.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    const sock = net.connect(Number(u.port), '127.0.0.1', () => sock.write(req))
    let buf = Buffer.alloc(0)
    let upgraded = false
    const pending = new Map()
    let msgId = 0
    const listeners = []

    const handleData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        const head = buf.slice(0, idx).toString()
        if (!/101/.test(head.split('\r\n')[0])) {
          reject(new Error('upgrade failed: ' + head.split('\r\n')[0]))
          return
        }
        upgraded = true
        buf = buf.slice(idx + 4)
        resolve({
          send: (obj) => {
            const id = ++msgId
            const p = new Promise((res2) => pending.set(id, res2))
            sendFrame(JSON.stringify({ id, ...obj }))
            return p
          },
          onMessage: (fn) => listeners.push(fn),
          close: () => sock.end()
        })
      }
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f
        let offset = 2
        let len = len0
        if (len0 === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          offset = 4
        } else if (len0 === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          offset = 10
        }
        if (buf.length < offset + len) return
        const payload = buf.slice(offset, offset + len)
        buf = buf.slice(offset + len)
        const text = payload.toString('utf8')
        let msg
        try {
          msg = JSON.parse(text)
        } catch {
          continue
        }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        } else {
          listeners.forEach((f) => f(msg))
        }
      }
    }
    const sendFrame = (text) => {
      const payload = Buffer.from(text, 'utf8')
      const mask = crypto.randomBytes(4)
      let header
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length])
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4)
        header[0] = 0x81
        header[1] = 0x80 | 126
        header.writeUInt16BE(payload.length, 2)
      } else {
        header = Buffer.alloc(10)
        header[0] = 0x81
        header[1] = 0x80 | 127
        header.writeBigUInt64BE(BigInt(payload.length), 2)
      }
      const masked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
      sock.write(Buffer.concat([header, mask, masked]))
    }

    sock.on('data', handleData)
    sock.on('error', reject)
  })
}

const targets = await getTargets()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.log('no page target')
  process.exit(1)
}
console.log('target:', page.title, page.url.slice(0, 60))

const ws = await wsConnect(page.webSocketDebuggerUrl)
await new Promise((r) => setTimeout(r, 300))

const evaluate = async (expr) => {
  const r = await ws.send({ method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + JSON.stringify(r.result.exceptionDetails.exception?.description || '').slice(0, 200) }
  return r.result?.result?.value
}

try {
  const result = await evaluate(EXPR)
  console.log('RESULT:', JSON.stringify(result, null, 2))
} catch (e) {
  console.log('EVAL ERROR:', String(e))
}
ws.close()
process.exit(0)
