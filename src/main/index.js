import { app, BrowserWindow, ipcMain, shell, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import Store from 'electron-store'
import harnessRegistry from './harnesses'
import { createChatService } from './chat'
import { createModelProxy } from './proxy'
import * as embed from './embed'
import { resolveCliCommand, scanSystemApps } from './harnesses/base'
import * as pty from './pty'

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
const inflightOpens = new Map()
pty.initPty((channel, payload) => mainWindow?.webContents.send(channel, payload))
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
  // 最小化/被其他应用覆盖后回到 OpenHarness：Windows 会把子窗口一起隐藏且恢复时不
  // 自动显示，必须主动 SW_SHOW + 重新贴合，否则嵌入的 harness 表现为"卡死"。
  // 只挂在 restore/focus/show 上——move/resize 期间频繁重声明会打断嵌入窗口内部拖动
  const reassertEmbed = () => embed.reassertActive()
  mainWindow.on('move', resyncEmbed)
  mainWindow.on('resize', resyncEmbed)
  mainWindow.on('maximize', () => { resyncEmbed(); reassertEmbed() })
  mainWindow.on('unmaximize', () => { resyncEmbed(); reassertEmbed() })
  mainWindow.on('restore', () => { resyncEmbed(); reassertEmbed() })
  mainWindow.on('focus', reassertEmbed)
  mainWindow.on('show', () => { resyncEmbed(); reassertEmbed() })
  mainWindow.on('enter-full-screen', resyncEmbed)
  mainWindow.on('leave-full-screen', resyncEmbed)
  screen.on('display-metrics-changed', resyncEmbed)

  autoStartProxy()
  // 启动即预热 harness 列表（自动刷新一次；之后进页面秒回缓存，过期仅后台静默刷新）
  refreshHarnessList().catch(() => {})
  // 预热看门钩子：PowerShell 拉起+编译要 1.5-3 秒，若等冷启动才拉起，
  // 应用的 logo 闪窗会抢在钩子生效前出现（毫秒级闪现）。启动时即常驻预热，
  // 冷启动时只经文件热更目标名单（毫秒级生效），窗口创建瞬间即被停靠——零闪现
  embed.startWatcher([])

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  pty.closeAll()
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
// harness 列表 stale-while-revalidate：进页面秒回缓存；超过 60s 后台静默刷新；
// 刷新完成后广播 harness:updated，各页面无痕更新状态。手动「扫描本机」才走强制刷新
// 检测结果持久化：重启应用先显示上次的检测结果（磁盘缓存），
// 启动时的自动刷新在后台静默完成并广播更新
let harnessListCache = store.get('harnessListCache') || { data: null, ts: 0 }
let harnessListRefreshing = null

async function refreshHarnessList(force = false) {
  const sys = await scanSystemApps(force).catch(() => null)
  const results = await Promise.all(
    harnessRegistry.all().map(async (adapter) => {
      try {
        const info = await adapter.detect(sys)
        return { ...info, id: adapter.id, name: adapter.name, desc: adapter.desc, color: adapter.color, icon: adapter.icon }
      } catch (err) {
        return { id: adapter.id, name: adapter.name, desc: adapter.desc, color: adapter.color, icon: adapter.icon, installed: false, error: String(err) }
      }
    })
  )
  harnessListCache = { data: results, ts: Date.now() }
  store.set('harnessListCache', harnessListCache)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('harness:updated', results)
  return results
}

function startBackgroundHarnessRefresh(maxAgeMs = 60000) {
  if (Date.now() - harnessListCache.ts <= maxAgeMs) return
  if (harnessListRefreshing) return
  harnessListRefreshing = refreshHarnessList(false)
    .catch(() => {})
    .finally(() => { harnessListRefreshing = null })
}

ipcMain.handle('harness:list', async (_e, opts) => {
  // 强制（扫描本机按钮）或首次（无缓存）→ 同步刷新；否则秒回缓存 + 过期后台静默刷新
  if (opts?.force || !harnessListCache.data) return refreshHarnessList(!!opts?.force)
  startBackgroundHarnessRefresh()
  return harnessListCache.data
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
  const previous = inflightOpens.get(id)
  if (previous) return previous
  const operation = openHarness(id, cssRect)
  inflightOpens.set(id, operation)
  operation.then(
    () => { if (inflightOpens.get(id) === operation) inflightOpens.delete(id) },
    () => { if (inflightOpens.get(id) === operation) inflightOpens.delete(id) }
  )
  return operation
})

async function openHarness(id, cssRect) {
  const adapter = harnessRegistry.get(id)
  if (!adapter) return { ok: false, message: `未找到 harness: ${id}` }
  if (!mainWindow) return { ok: false, message: '主窗口未就绪' }
  // 内嵌打开也必须带系统扫描结果：适配器靠它兜底解析 exePath
  // （新装应用不在硬编码路径时只有系统扫描能发现——漏传会报"未能找到应用窗口"）
  const sys = await scanSystemApps().catch(() => null)
  const detectInfo = await adapter.detect(sys)
  if (!detectInfo.installed) return { ok: false, message: `${adapter.name} 未安装` }

  if (cssRect) lastCssRect = cssRect
  const initialRect = cssRect ? clampRect(cssRect) : undefined

  try {
    if (adapter.usePty) {
      pty.setLatest(id)
      // 同步顶掉 embed 的最新目标，避免更早的原生慢冷启动误判为新目标而抢前台
      embed.setLatest(id)
      // PTY 渲染在 HTML 里，而原生附着窗口永远浮在 HTML 之上——
      // 必须先把已附着的老窗口停靠屏幕外，否则它盖住终端，表现为"卡死在新界面"
      embed.parkForNonNative(id)
      // 中央 cli 自愈：PATH 外安装的 harness（grok/codex/kimi…）按 exeCandidates 回退
      return pty.open(id, await resolveCliCommand(adapter))
    }
    pty.deactivate()
    embed.setLatest(id)
    const res = await embed.embedApp({
      harnessId: id,
      exePath: detectInfo.exePath,
      processHints: adapter.processHints || [adapter.name],
      parentHwnd: getParentHwnd(),
      initialRect,
      cli: adapter.cli,
      webPort: adapter.webPort
    })
    if (res.ok) applyClip()
    return res
  } catch (err) {
    return { ok: false, message: String(err) }
  }
}

ipcMain.on('pty:input', (_e, id, data) => pty.input(id, data))
ipcMain.on('pty:resize', (_e, id, cols, rows) => pty.resize(id, cols, rows))
ipcMain.handle('pty:buffer', (_e, id) => pty.readBuffer(id))
ipcMain.handle('pty:close', (_e, id) => { pty.close(id); return true })

ipcMain.handle('embed:reposition', (_e, rect) => {
  if (!mainWindow) return false
  lastCssRect = rect
  embed.reposition(clampRect(rect))
  applyClip()
  return true
})

// 关闭标签 = 释放该嵌入（恢复原样式并脱离，应用本身继续独立运行）
// 关闭标签 = 关闭嵌入的应用本身（杀进程树），而非释放为独立窗口
ipcMain.handle('embed:close', (_e, id) => {
  if (id === 'claude-code') { pty.close(id); return true }
  return embed.closeAndKill(id)
})

// 转为独立窗口 = 仅脱离（恢复原样式/父子关系），进程继续运行
ipcMain.handle('embed:release', (_e, id) => {
  if (id === 'claude-code') return true
  return embed.release(id)
})

ipcMain.handle('embed:releaseAll', async () => {
  pty.closeAll()
  await embed.releaseAll()
  return true
})

ipcMain.handle('embed:hide', () => {
  embed.hideAll()
  return true
})

ipcMain.handle('embed:status', () => {
  const status = embed.status()
  return { ...status, attached: [...status.attached, ...pty.ids()], activeId: pty.status() || status.activeId }
})

/* ---------------- 内置模型代理 + Harness 模型配置 ---------------- */
const modelProxy = createModelProxy({ port: 18200, log: (...a) => console.warn('[proxy]', ...a) })

async function ensureProxy(provider, model) {
  modelProxy.setTarget(provider, model)
  store.set('proxyTarget', { providerId: provider.id, model })
  const st = modelProxy.status()
  if (!st.running) await modelProxy.start().catch((e) => { throw new Error('本地代理启动失败：' + e.message) })
  return modelProxy.status()
}

// 开机自动拉起代理：只要配置过模型注入且存在对应 Provider
async function autoStartProxy() {
  try {
    const target = store.get('proxyTarget')
    if (!target?.providerId) return
    const provider = (store.get('providers') || []).find((p) => p.id === target.providerId)
    if (!provider) return
    modelProxy.setTarget(provider, target.model)
    if (!modelProxy.status().running) await modelProxy.start()
    console.warn('[proxy] auto-started for', provider.name, target.model)
  } catch (e) {
    console.warn('[proxy] auto-start failed:', String(e))
  }
}

ipcMain.handle('proxy:status', () => modelProxy.status())

ipcMain.handle('harness:configureModel', async (_e, id, { selection }) => {
  const adapter = harnessRegistry.get(id)
  if (!adapter || !adapter.configureModel) return { ok: false, message: '该 Harness 暂不支持模型配置' }
  const providers = store.get('providers') || []
  // selection = [{ providerId, model }]，可跨 Provider 多选
  const resolved = (selection || [])
    .map(({ providerId: pid, model: m }) => ({ provider: providers.find((p) => p.id === pid), model: m }))
    .filter((x) => x.provider && x.model)
  if (!resolved.length) return { ok: false, message: '请至少选择一个模型' }
  const bad = resolved.find((x) => ['bedrock', 'openai-responses'].includes(x.provider.type))
  if (bad) return { ok: false, message: `协议 ${bad.provider.type} 暂不支持代理接入，请使用 OpenAI Compatible / Anthropic / Gemini` }

  try {
    const primary = resolved[0]
    await ensureProxy(primary.provider, primary.model)
    // 注册模型路由：代理按请求的模型名转发到对应 Provider
    modelProxy.setRoutes(resolved.map((x) => ({ provider: x.provider, model: x.model })))
    const r = await adapter.configureModel({
      models: resolved.map((x) => x.model),
      model: primary.model
    })
    if (r.ok) {
      r.proxy = modelProxy.status()
      // 配置历史：下次打开「配置模型」弹窗时回显上次选择
      const history = store.get('modelConfigHistory') || {}
      history[id] = {
        items: resolved.map((x) => ({ providerId: x.provider.id, providerName: x.provider.name, model: x.model })),
        configPath: r.path || null,
        updatedAt: Date.now()
      }
      store.set('modelConfigHistory', history)
    }
    return r
  } catch (err) {
    return { ok: false, message: String(err) }
  }
})

ipcMain.handle('model-config:history', (_e, id) => {
  const history = store.get('modelConfigHistory') || {}
  return history[id] || null
})
