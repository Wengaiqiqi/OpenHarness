const { contextBridge, ipcRenderer } = require('electron')

// Vue reactive Proxy 对象无法通过 IPC 结构化克隆（DataCloneError），
// 统一在出口处做 JSON 往返，保证跨 IPC 的都是纯数据
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)))
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args.map(plain))

contextBridge.exposeInMainWorld('api', {
  /* 应用 */
  appInfo: () => invoke('app:info'),
  openPath: (p) => invoke('app:openPath', p),
  syncThemeOverlay: (dark) => invoke('app:syncThemeOverlay', dark),

  /* 存储 */
  dbGet: (key) => invoke('db:get', key),
  dbSet: (key, value) => invoke('db:set', key, value),

  /* Harness */
  harnessList: () => invoke('harness:list'),
  harnessInjectMcp: (id, servers) => invoke('harness:injectMcp', id, servers),
  harnessOpenConfig: (id) => invoke('harness:openConfig', id),

  /* MCP */
  mcpGetAll: () => invoke('mcp:getAll'),
  mcpSave: (server) => invoke('mcp:save', server),
  mcpRemove: (id) => invoke('mcp:remove', id),

  /* Provider */
  providerGetAll: () => invoke('provider:getAll'),
  providerSave: (p) => invoke('provider:save', p),
  providerRemove: (id) => invoke('provider:remove', id),
  providerListModels: (payload) => invoke('provider:listModels', payload),

  /* 对话 */
  chatSend: (payload) => invoke('chat:send', payload),
  chatAbort: (sessionId) => invoke('chat:abort', sessionId),
  onChatChunk: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('chat:chunk', handler)
    return () => ipcRenderer.removeListener('chat:chunk', handler)
  },

  /* 应用内嵌 */
  embedOpen: (id, rect) => invoke('embed:open', id, rect),
  embedReposition: (rect) => invoke('embed:reposition', rect),
  embedClose: (id) => invoke('embed:close', id),
  embedReleaseAll: () => invoke('embed:releaseAll'),
  embedHide: () => invoke('embed:hide'),
  embedStatus: () => invoke('embed:status')
})
