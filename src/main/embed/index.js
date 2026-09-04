import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import bridge from './win32-bridge'
import { launchExe, launchCliConsole } from '../harnesses/base'
import * as pty from '../pty'
import fs from 'node:fs'
import path from 'node:path'

const exec = promisify(execFile)

/** 剥离的窗口样式位：CAPTION|SYSMENU|THICKFRAME|MINIMIZEBOX|MAXIMIZEBOX */
const STYLE_STRIP = 0x00cf0000
const SW_SHOW = 5
const SW_HIDE = 0
const SW_RESTORE = 9

// 多开：harnessId -> { hwnd, origStyle }；activeId 为当前显示的那个
const attached = new Map()
let activeId = null

// 最新打开请求：慢冷启动完成时只有仍是最新目标才能激活/显示，过期结果仅登记保持隐藏
let latestOpenId = null

export function setLatest(id) {
  latestOpenId = id
}

function isLatest(harnessId) {
  return latestOpenId === harnessId
}

function clearLatestIf(id) {
  if (latestOpenId === id) latestOpenId = null
}

function runPS(script) {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 45000
  }).then((r) => r.stdout.trim()).catch(() => '')
}

/** 按进程名查找主窗口句柄 */
export async function findWindowByNames(processHints = []) {
  if (!processHints.length) return 0
  const list = processHints.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$names = @(${list})`,
    '$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $names -contains $_.ProcessName } | Select-Object -First 1',
    'if ($w) { Write-Output $w.MainWindowHandle } else { Write-Output 0 }'
  ].join('\n')
  const out = await runPS(script)
  const n = parseInt(out, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 按窗口标题轮询查找主窗口句柄（CLI 控制台窗口） */
export async function findWindowByTitle(title, maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const out = await bridge.send('findbytitle', title)
    const m = /^hwnd:(\d+)$/.exec(out || '')
    const n = parseInt(m?.[1], 10)
    if (Number.isFinite(n) && n > 0) return n
    await sleep(500)
  }
  return 0
}

/** 按宿主 PID 找其子进程的主窗口句柄（conhost -> cmd 控制台窗口） */
export async function findChildWindow(hostPid, maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const out = await bridge.send('findchild', String(hostPid))
    const m = /^hwnd:(\d+)$/.exec(out || '')
    const n = parseInt(m?.[1], 10)
    if (Number.isFinite(n) && n > 0) return n
    await sleep(500)
  }
  return 0
}

/** 按已启动的 PID 轮询主窗口句柄（应用冷启动需要时间） */
export async function findWindowByPid(pid, maxWaitMs = 20000) {
  if (!pid) return 0
  const script = `
$ErrorActionPreference='SilentlyContinue'
for ($i=0; $i -lt ${Math.ceil(maxWaitMs / 500)}; $i++) {
  $h = (Get-Process -Id ${pid}).MainWindowHandle
  if ($h -ne 0) { Write-Output $h; break }
  Start-Sleep -Milliseconds 500
}
`
  const out = await runPS(script)
  const n = parseInt(out, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 按进程名轮询主窗口句柄（Electron 启动器会退出并把窗口交给子进程，pid 轮询不可靠） */
export async function findWindowByNamesPoll(processHints = [], maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const hwnd = await findWindowByNames(processHints)
    if (hwnd) return hwnd
    await sleep(500)
  }
  return 0
}

/** 按本地服务监听端口找主窗口句柄（Web 型 CLI：dsh web --port N） */
export async function findWindowByPort(port, maxWaitMs = 25000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const out = await bridge.send('findbyport', String(port))
    const m = /^hwnd:(\d+)$/.exec(out || '')
    const n = parseInt(m?.[1], 10)
    if (Number.isFinite(n) && n > 0) return n
    await sleep(500)
  }
  return 0
}

/** 找一个当前空闲的 TCP 端口（listen 0 让 OS 分配，随即释放） */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** 轮询 TCP 端口直到可连接（服务就绪） */
function waitForPort(port, maxWaitMs = 40000) {
  const deadline = Date.now() + maxWaitMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ port, host: '127.0.0.1' })
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() < deadline) setTimeout(tryOnce, 800)
        else resolve(false)
      })
    }
    tryOnce()
  })
}

// Web 型 harness 的运行中服务：harnessId -> { port }，关闭标签时杀进程树用
const webServices = new Map()

function activateWeb(harnessId) {
  for (const [, a] of attached) bridge.fire('show', a.hwnd, SW_HIDE)
  setClipRect(null)
  activeId = harnessId
}

/**
 * 将目标应用主窗口附着（嵌入）到 OpenHarness 窗口内；已附着则直接激活
 * @param {number} parentHwnd OpenHarness BrowserWindow 的 HWND
 * @param {{x:number,y:number,width:number,height:number}} [initialRect] 容器物理像素矩形，附着后立即定位
 */
export async function embedApp({ harnessId, exePath, processHints, parentHwnd, initialRect, cli, webPort }) {
  // Web 型服务已在运行：直接返回其 URL，不再起新实例
  if (webServices.has(harnessId)) {
    const { port } = webServices.get(harnessId)
    if (isLatest(harnessId)) activateWeb(harnessId)
    return { ok: true, webUrl: 'http://127.0.0.1:' + port, serviceOnly: true, reactivated: true }
  }
  // 已附着：贴合新容器矩形后直接激活
  if (attached.has(harnessId)) {
    const a = attached.get(harnessId)
    if (initialRect) {
      bridge.fire(
        'move', a.hwnd,
        Math.round(initialRect.x), Math.round(initialRect.y),
        Math.round(initialRect.width), Math.round(initialRect.height)
      )
    }
    activate(harnessId, initialRect)
    return { ok: true, hwnd: a.hwnd, reactivated: true }
  }

  let pid = null
  let coldStart = false

  // CLI 型 harness：起一个带标题的控制台窗口跑 CLI（wt 优先 + cmd start 兜底），按标题找到窗口附着
  let hwnd = 0
  if (cli) {
    const title = `OH-CLI-${harnessId}`
    let port = 0
    if (webPort) {
      // Web 型 CLI：动态分配空闲端口，替换命令里的 {port} —— 无需 killport，天然不冲突
      port = await getFreePort()
      cli = cli.replace('{port}', String(port))
      // Web 型 harness：用 ConPTY 隐藏宿主（dsh 等会自拉起新控制台窗口，windowsHide 拦不住，
      // ConPTY 虚拟终端让任何子进程都渲染进虚拟终端，全程无真实窗口），UI 用 iframe 加载
      coldStart = true
      const host = pty.openSilent(harnessId, cli)
      if (!host.ok) return { ok: false, message: host.message || '隐藏宿主启动失败' }
      const ok = await waitForPort(port, 60000)
      // 兜底：服务进程自身（如 node 再启子进程）可能创建的控制台窗口，一并隐藏
      bridge.send('hidebyport', String(port)).catch(() => {})
      if (!ok) {
        await bridge.send('killport', String(port))
        return { ok: false, message: `服务未能在预期时间内启动（${cli}）` }
      }
      webServices.set(harnessId, { port })
      if (isLatest(harnessId)) activateWeb(harnessId)
      return { ok: true, webUrl: `http://127.0.0.1:${port}`, serviceOnly: true }
    }
    const launched = launchCliConsole(title, cli)
    coldStart = true
    // 按 conhost 子进程 cmd 定位控制台窗口（标题会被 claude 等程序改掉，PID 链不受影响）
    hwnd = await findChildWindow(launched.hostPid, 20000)
    if (!hwnd) {
      return { ok: false, message: `未能找到 ${cli} 的控制台窗口（命令可能未安装，可在终端直接运行 ${cli} 验证）` }
    }
  } else {
    // 先找已运行的实例，找不到再冷启动
    hwnd = await findWindowByNames(processHints)
    if (!hwnd && exePath) {
      const r = launchExe(exePath)
      if (!r.ok) return r
      pid = r.pid
      coldStart = true
      // Electron 启动器（如 Code.exe）会退出并把窗口交给真正的子进程，
      // 所以 pid 轮询失败时退回按进程名轮询
      hwnd = await findWindowByPid(pid, 10000)
      if (!hwnd) hwnd = await findWindowByNamesPoll(processHints, 15000)
    }
    if (!hwnd) {
      return { ok: false, message: '未能找到应用窗口（应用可能启动失败或窗口尚未创建）' }
    }
  }

  if (coldStart) {
    // 冷启动：窗口一出现就隐藏，剥样式/附着/定位完成后再显示，
    // 避免原窗口先闪现在屏幕上再被"吸"进来
    bridge.fire('show', hwnd, SW_HIDE)
    await sleep(150)
  } else {
    // 已运行实例：先还原最大化/最小化状态，否则 Chromium 仍按最大化布局渲染，内容会被裁剪
    bridge.fire('show', hwnd, SW_RESTORE)
    await sleep(400)
  }

  const styleRes = await bridge.send('getstyle', hwnd)
  const origStyle = parseValue(styleRes)

  await bridge.send('setparent', hwnd, parentHwnd)
  await bridge.send('style', hwnd, toInt32(origStyle & ~STYLE_STRIP))

  // 附着瞬间立即定位，避免旧位置/旧尺寸闪现
  if (initialRect) {
    bridge.fire(
      'move', hwnd,
      Math.round(initialRect.x), Math.round(initialRect.y),
      Math.round(initialRect.width), Math.round(initialRect.height)
    )
  }

  attached.set(harnessId, { hwnd, origStyle, parentHwnd })
  // 只有仍是最新打开目标时才激活/显示；过期冷启动登记后保持隐藏，切回时即时复用
  if (isLatest(harnessId)) {
    activate(harnessId, initialRect)
    if (coldStart) {
      // 冷启动窗口是隐藏着被附着的：定位完成后 RESTORE（清最小化态）再由 activate 的 SW_SHOW 显示
      bridge.fire('show', hwnd, SW_RESTORE)
    }
  } else {
    bridge.fire('show', hwnd, SW_HIDE)
  }
  return { ok: true, hwnd, pid, launched: !!pid }
}

/** 激活某个已附着窗口：显示它、隐藏其余，并可顺手贴合矩形 */
export function activate(harnessId, rect) {
  if (!attached.has(harnessId)) return
  for (const [id, a] of attached) {
    if (id !== harnessId) bridge.fire('show', a.hwnd, SW_HIDE)
  }
  const a = attached.get(harnessId)
  if (rect) {
    allowedRect = rect
    bridge.fire(
      'move', a.hwnd,
      Math.round(rect.x), Math.round(rect.y),
      Math.round(rect.width), Math.round(rect.height)
    )
  }
  bridge.fire('show', a.hwnd, SW_SHOW)
  activeId = harnessId
}

/** 重定位当前激活的嵌入窗口（物理像素，相对 BrowserWindow 客户区） */
export function reposition(rect) {
  const a = attached.get(activeId)
  if (!a) return
  allowedRect = rect
  bridge.fire(
    'move', a.hwnd,
    Math.round(rect.x), Math.round(rect.y),
    Math.round(rect.width), Math.round(rect.height)
  )
  a.lastRgn = null
  applyRgn(a, rect, rect)
}

/**
 * 硬裁剪：把子窗口可见区域限制在 allowedRect 与子窗口当前矩形的交集内
 * （区域坐标相对子窗口自身）。即使子窗口在两次看门狗轮询之间把自己挪出
 * 容器（如自绘标题栏拖动），越界部分也永远画不出来。
 */
function applyRgn(a, allowed, cur) {
  if (!allowed || !cur) return
  const left = Math.max(0, Math.round(allowed.x - cur.x))
  const top = Math.max(0, Math.round(allowed.y - cur.y))
  const right = Math.min(Math.round(cur.width), Math.round(allowed.x + allowed.width - cur.x))
  const bottom = Math.min(Math.round(cur.height), Math.round(allowed.y + allowed.height - cur.y))
  if (right - left < 10 || bottom - top < 10) return
  const key = left + ',' + top + ',' + (right - left) + ',' + (bottom - top)
  if (a.lastRgn === key) return
  a.lastRgn = key
  bridge.fire('setrgn', a.hwnd, left, top, right - left, bottom - top)
}

// ---- 越界看门狗：子窗口被内部拖动（如 VS Code 自定义标题栏）时自动拉回 ----
// allowedRect 为当前激活嵌入允许占用的物理像素矩形（相对主窗口客户区）
let allowedRect = null
let clipTimer = null

function safeWarn(...a) {
  // 日志绝不能抛异常阻断拉回逻辑
  try {
    console.warn(...a)
  } catch {}
}

export function setClipRect(rect) {
  allowedRect = rect || null
  if (allowedRect) {
    const a = attached.get(activeId)
    if (a) {
      bridge.fire(
        'move', a.hwnd,
        Math.round(allowedRect.x), Math.round(allowedRect.y),
        Math.round(allowedRect.width), Math.round(allowedRect.height)
      )
    }
  }
  if (clipTimer) clearInterval(clipTimer)
  clipTimer = null
  if (allowedRect) clipTimer = setInterval(clipTick, 100)
}

async function clipTick() {
  const a = attached.get(activeId)
  if (!a || !allowedRect) return
  try {
    const [originLine, rectLine] = await Promise.all([
      bridge.send('clientorigin', a.parentHwnd),
      bridge.send('getrect', a.hwnd)
    ])
    const [, ox, oy] = /^origin:(-?\d+),(-?\d+)$/.exec(originLine) || []
    const [, l, t, r, b] = /^rect:(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/.exec(rectLine) || []
    if (ox === undefined || l === undefined) {
      safeWarn('[clipTick] 解析失败:', originLine, rectLine)
      return
    }
    // 子窗口实际（客户区相对）矩形
    const cx = Number(l) - Number(ox)
    const cy = Number(t) - Number(oy)
    const cw = Number(r) - Number(l)
    const ch = Number(b) - Number(t)
    // 硬裁剪：轮询间隙内子窗口自己挪动时，越界部分也画不出来
    applyRgn(a, allowedRect, { x: cx, y: cy, width: cw, height: ch })
    const drift =
      Math.abs(cx - allowedRect.x) > 2 ||
      Math.abs(cy - allowedRect.y) > 2 ||
      Math.abs(cw - allowedRect.width) > 2 ||
      Math.abs(ch - allowedRect.height) > 2
    if (drift) {
      // 先拉回，再记日志
      bridge.fire(
        'move', a.hwnd,
        Math.round(allowedRect.x), Math.round(allowedRect.y),
        Math.round(allowedRect.width), Math.round(allowedRect.height)
      )
      a.lastRgn = null
      applyRgn(a, allowedRect, allowedRect)
      safeWarn(`[clipTick] 越界 (${cx},${cy},${cw},${ch})，已拉回`)
    }
  } catch (e) {
    safeWarn('[clipTick] 异常:', String(e))
  }
}

/** 释放指定（默认当前激活的）嵌入：恢复原样式并脱离父窗口，应用本身继续运行 */
export async function release(harnessId) {
  const id = harnessId || activeId
  clearLatestIf(id)
  // Web 型 harness 没有附着窗口：服务继续跑，仅从激活态移除
  if (webServices.has(id)) {
    if (activeId === id) activeId = null
    return
  }
  const a = attached.get(id)
  if (!a) return
  bridge.fire('clearrgn', a.hwnd)
  await bridge.send('style', a.hwnd, a.origStyle)
  await bridge.send('setparent', a.hwnd, 0)
  bridge.fire('show', a.hwnd, SW_RESTORE)
  attached.delete(id)
  if (activeId === id) {
    activeId = null
    setClipRect(null)
  }
}

/** 关闭指定（默认当前激活的）嵌入：先脱离再杀掉应用进程树 */
export async function closeAndKill(harnessId) {
  const id = harnessId || activeId
  // Web 型 harness：杀服务进程树（按端口反查 PID），并结束 ConPTY 隐藏宿主
  if (webServices.has(id)) {
    const { port } = webServices.get(id)
    await bridge.send('killport', String(port))
    pty.closeSilent(id)
    webServices.delete(id)
    if (activeId === id) activeId = null
    return
  }
  const a = attached.get(id)
  if (!a) return
  // PID 必须在脱离前查：脱离后 hwnd 仍有效但窗口已变独立窗口
  const pidLine = await bridge.send('pidof', a.hwnd)
  const pid = /^pid:(\d+)$/.exec(pidLine || '')?.[1]
  await release(id)
  if (pid) {
    // /T 杀进程树（Electron/Chromium 多进程），/F 强制
    exec('taskkill', ['/T', '/F', '/PID', pid]).catch(() => {})
  }
}

/** 释放全部嵌入（应用退出时调用，避免外部应用残留无边框样式） */
export async function releaseAll() {
  setClipRect(null)
  // Web 型服务：应用退出时一并结束
  for (const [id, s] of webServices) {
    await bridge.send('killport', String(s.port))
    pty.closeSilent(id)
  }
  webServices.clear()
  for (const id of [...attached.keys()]) {
    await release(id)
  }
}

/** 隐藏全部附着窗口（离开工作台路由时调用，保持附着） */
export function hideAll() {
  for (const [, a] of attached) bridge.fire('show', a.hwnd, SW_HIDE)
}

/** 重新显示当前激活的附着窗口 */
export function showActive() {
  const a = attached.get(activeId)
  if (a) bridge.fire('show', a.hwnd, SW_SHOW)
}

export function status() {
  return { attached: [...attached.keys(), ...webServices.keys()], activeId }
}

function parseValue(line = '') {
  const i = line.indexOf(':')
  if (i < 0) return 0
  const n = parseInt(line.slice(i + 1), 10)
  return Number.isFinite(n) ? n >>> 0 : 0
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** uint32 -> int32（PowerShell [int] 只接受有符号 32 位） */
function toInt32(v) {
  return v > 0x7fffffff ? v - 0x100000000 : v
}
