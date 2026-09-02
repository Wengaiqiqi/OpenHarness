import { app, BrowserWindow, ipcMain, shell, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import Store from 'electron-store'
import harnessRegistry from './harnesses'
import { createChatService } from './chat'
import * as embed from './embed'

Store.initRenderer()

// 主进程兜底：任何未捕获异常只记日志，绝不弹错误对话框阻塞应用
process.on('uncaughtException', (e) => {
  try { console.error('[main] uncaught:', e) } catch {}
})
process.on('unhandledRejection', (e) => {
  try { console.error('[main] unhandledRejection:', e) } catch {}
})

const store = new Store({
  defaults: {
    providers: [],
    sessions: [],
    mcpServers: [],
    settings: { theme: 'dark', language: 'zh-CN' }
  }
})

let mainWindow = null
const chat = createChatService()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#131316',
    icon: path.join(__dirname, '../renderer/logo.png'),
    title: 'OpenHarness',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#18181b',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 始终暴露无障碍树：辅助技术/自动化依赖它，且 Windows 上 Chromium 默认懒激活不稳定
  app.accessibilitySupportEnabled = true
  createWindow()

  // 窗口移动/缩放/最大化/跨屏/DPI 变化：按最新 DPI 重算嵌入矩形并重新钳制
  const resyncEmbed = () => applyClip()
  mainWindow.on('move', resyncEmbed)
  mainWindow.on('resize', resyncEmbed)
  mainWindow.on('maximize', resyncEmbed)
  mainWindow.on('unmaximize', resyncEmbed)
  mainWindow.on('restore', resyncEmbed)
  mainWindow.on('enter-full-screen', resyncEmbed)
  mainWindow.on('leave-full-screen', resyncEmbed)
  screen.on('display-metrics-changed', resyncEmbed)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  embed.releaseAll().catch(() => {})
})

/* ---------------- IPC: 应用通用 ---------------- */
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath('userData')
}))

ipcMain.handle('app:openPath', (_e, p) => {
  if (fs.existsSync(p)) shell.openPath(p)
  return fs.existsSync(p)
})

// 主题切换时同步 Windows 窗口控制按钮（覆盖层）颜色，使其融入应用背景
ipcMain.handle('app:syncThemeOverlay', (_e, dark) => {
  try {
    if (process.platform === 'win32' && mainWindow?.setTitleBarOverlay) {
      mainWindow.setTitleBarOverlay({
        color: dark ? '#131316' : '#ffffff',
        symbolColor: dark ? '#f4f4f5' : '#18181b',
        height: 36
      })
    }
    return true
  } catch (err) {
    return String(err)
  }
})

/* ---------------- IPC: 数据存取 ---------------- */
ipcMain.handle('db:get', (_e, key) => store.get(key))
ipcMain.handle('db:set', (_e, key, value) => {
  store.set(key, value)
  return true
})

/* ---------------- IPC: Harness 管理 ---------------- */
ipcMain.handle('harness:list', async () => {
  const results = []
  for (const adapter of harnessRegistry.all()) {
    try {
      const info = await adapter.detect()
      results.push({ ...info, id: adapter.id, name: adapter.name, desc: adapter.desc, color: adapter.color, icon: adapter.icon })
    } catch (err) {
      results.push({ id: adapter.id, name: adapter.name, desc: adapter.desc, color: adapter.color, icon: adapter.icon, installed: false, error: String(err) })
    }
  }
  return results
})

ipcMain.handle('harness:injectMcp', async (_e, id, servers) => {
  const adapter = harnessRegistry.get(id)
  if (!adapter) return { ok: false, message: `未找到 harness: ${id}` }
  try {
    return await adapter.injectMcp(servers)
  } catch (err) {
    return { ok: false, message: String(err) }
  }
})

ipcMain.handle('harness:openConfig', async (_e, id) => {
  const adapter = harnessRegistry.get(id)
  if (!adapter) return { ok: false, message: `未找到 harness: ${id}` }
  const p = adapter.configPath()
  if (p && fs.existsSync(p)) {
    shell.openPath(p)
    return { ok: true, path: p }
  }
  return { ok: false, message: '配置文件不存在: ' + (p || '未知') }
})

/* ---------------- IPC: MCP 管理 ---------------- */
ipcMain.handle('mcp:getAll', () => store.get('mcpServers'))

ipcMain.handle('mcp:save', (_e, server) => {
  const list = store.get('mcpServers')
  const idx = list.findIndex((s) => s.id === server.id)
  if (idx >= 0) list[idx] = server
  else list.push(server)
  store.set('mcpServers', list)
  return list
})

ipcMain.handle('mcp:remove', (_e, id) => {
  const list = store.get('mcpServers').filter((s) => s.id !== id)
  store.set('mcpServers', list)
  return list
})

/* ---------------- IPC: Provider 管理 ---------------- */
ipcMain.handle('provider:getAll', () => store.get('providers'))

ipcMain.handle('provider:save', (_e, provider) => {
  const list = store.get('providers')
  const idx = list.findIndex((p) => p.id === provider.id)
  if (idx >= 0) list[idx] = provider
  else list.push(provider)
  store.set('providers', list)
  return list
})

ipcMain.handle('provider:remove', (_e, id) => {
  const list = store.get('providers').filter((p) => p.id !== id)
  store.set('providers', list)
  return list
})

// 拉取提供商的可用模型列表（GET /models）
ipcMain.handle('provider:listModels', async (_e, { type, baseUrl, apiKey }) => {
  const t = type || 'openai-compatible'
  try {
    if (t === 'bedrock') {
      return { ok: false, message: 'Amazon Bedrock 暂不支持获取模型列表，请手动输入模型名' }
    }
    const base = String(baseUrl || '').replace(/\/+$/, '')
    if (!base) return { ok: false, message: '请先填写 Base URL' }

    let url, headers
    if (t === 'anthropic') {
      url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
      headers = { 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) }
    } else {
      url = `${base}/models`
      headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    }

    const res = await fetch(url, { headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    const json = await res.json()
    const models = (json.data || json.models || [])
      .map((m) => m.id || m.name || m)
      .filter((m) => typeof m === 'string' && m)
    return { ok: true, models: [...new Set(models)].sort() }
  } catch (err) {
    return { ok: false, message: String(err) }
  }
})

/* ---------------- IPC: 对话 ---------------- */
ipcMain.handle('chat:send', async (_e, { sessionId, provider, model, messages, thinkingLevel }) => {
  return chat.send(mainWindow, { sessionId, provider, model, messages, thinkingLevel })
})

ipcMain.handle('chat:abort', (_e, sessionId) => {
  chat.abort(sessionId)
  return true
})

/* ---------------- IPC: 应用内嵌 ---------------- */
function getParentHwnd() {
  try {
    const buf = mainWindow.getNativeWindowHandle()
    return Number(buf.readBigUInt64LE(0))
  } catch {
    return mainWindow.getNativeWindowHandle().readUInt32LE(0)
  }
}
function clampRect(cssRect) {
  const cb = mainWindow ? mainWindow.getContentBounds() : { width: 1600, height: 1000 }
  const display = screen.getDisplayMatching(cb)
  const scale = display.scaleFactor || 1
  const maxW = Math.max(100, Math.round(cb.width * scale))
  const maxH = Math.max(100, Math.round(cb.height * scale))
  let width = Math.round((cssRect?.width || 100) * scale)
  let height = Math.round((cssRect?.height || 100) * scale)
  width = Math.min(Math.max(100, width), maxW)
  height = Math.min(Math.max(100, height), maxH)
  const x = Math.min(Math.max(0, Math.round((cssRect?.x || 0) * scale)), maxW - width)
  const y = Math.min(Math.max(0, Math.round((cssRect?.y || 0) * scale)), maxH - height)
  return { x, y, width, height }
}

// 渲染层上报的容器 CSS 矩形缓存：窗口移动/缩放/DPI 变化时据此重算物理矩形并喂给看门狗
let lastCssRect = null

function applyClip() {
  if (!lastCssRect || !mainWindow) return
  embed.setClipRect(clampRect(lastCssRect))
}

ipcMain.handle('embed:open', async (_e, id, cssRect) => {
  const adapter = harnessRegistry.get(id)
  if (!adapter) return { ok: false, message: `未找到 harness: ${id}` }
  if (!mainWindow) return { ok: false, message: '主窗口未就绪' }
  const detectInfo = await adapter.detect()
  if (!detectInfo.installed) return { ok: false, message: `${adapter.name} 未安装` }

  if (cssRect) lastCssRect = cssRect
  const initialRect = cssRect ? clampRect(cssRect) : undefined

  try {
    const res = await embed.embedApp({
      harnessId: id,
      exePath: detectInfo.exePath,
      processHints: adapter.processHints || [adapter.name],
      parentHwnd: getParentHwnd(),
      initialRect
    })
    if (res.ok) applyClip()
    return res
  } catch (err) {
    return { ok: false, message: String(err) }
  }
})

ipcMain.handle('embed:reposition', (_e, rect) => {
  if (!mainWindow) return false
  lastCssRect = rect
  embed.reposition(clampRect(rect))
  applyClip()
  return true
})

// 关闭标签 = 释放该嵌入（恢复原样式并脱离，应用本身继续独立运行）
// 关闭标签 = 关闭嵌入的应用本身（杀进程树），而非释放为独立窗口
ipcMain.handle('embed:close', (_e, id) => embed.closeAndKill(id))

ipcMain.handle('embed:releaseAll', async () => {
  await embed.releaseAll()
  return true
})

ipcMain.handle('embed:hide', () => {
  embed.hideAll()
  return true
})

ipcMain.handle('embed:status', () => embed.status())
