/**
 * 最小 CDP 客户端：连接 Electron 远程调试端口，在页面里执行 JS。
 * 用法：npx electron 无关——直接 node cdp-eval.mjs "表达式" [端口]
 */
const PORT = Number(process.argv[3] || 9333)
const EXPR = process.argv[2]

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let msgId = 0
    const fail = (error) => {
      reject(error)
      for (const request of pending.values()) request.reject(error)
      pending.clear()
    }
    socket.onopen = () => resolve({
      send: (obj) => new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) return reject(new Error('WebSocket is closed'))
        const id = ++msgId
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ ...obj, id }))
      }),
      close: () => socket.close()
    })
    socket.onmessage = ({ data }) => {
      let msg
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      pending.get(msg.id)?.resolve(msg)
      pending.delete(msg.id)
    }
    socket.onerror = (event) => fail(event.error || new Error('WebSocket connection failed'))
    socket.onclose = () => fail(new Error('WebSocket is closed'))
  })
}

const response = await fetch(`http://127.0.0.1:${PORT}/json`)
if (!response.ok) throw new Error(`CDP targets: HTTP ${response.status}`)
const targets = await response.json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.log('no page target')
  process.exit(1)
}
console.log('target:', page.title, page.url.slice(0, 60))

const ws = await wsConnect(page.webSocketDebuggerUrl)

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
