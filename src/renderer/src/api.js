/**
 * window.api 的主世界包装层。
 *
 * contextBridge 跨世界传参会克隆参数，而 Vue reactive Proxy 无法被克隆
 * （DataCloneError: An object could not be cloned），因此任何要跨 IPC 的
 * 响应式数据必须先在主世界转成纯数据——这里统一做 JSON 往返。
 */

const clean = (v) => {
  // 回调函数与原始值直接透传（净化函数会破坏 onChatChunk 的回调注册）
  if (v === undefined || v === null || typeof v !== 'object') return v
  // 对象参数做 JSON 往返，剥离 Vue reactive Proxy（无法过结构化克隆）
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return v
  }
}

const raw = { ...window.api }

const api = {}
for (const name of Object.keys(raw)) {
  const fn = raw[name]
  api[name] =
    typeof fn === 'function'
      ? (...args) => fn(...args.map(clean))
      : fn
}

export { api }
