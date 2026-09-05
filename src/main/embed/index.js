import { execFile, spawn } from 'node:child_process'
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

/**
 * 查找控制台窗口：优先按标题子串（findcon），TUI 程序会改掉控制台标题导致竞态，
 * 故同时按 hostPid 进程树匹配（findconpid）兜底 —— 两者任一命中即返回
 */
async function findConsoleWindow(title, maxWaitMs = 15000, hostPid = 0) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const out = await bridge.send('findcon', title)
    const m = /^con:(\d+):(\d+)$/.exec(out || '')
    if (m && parseInt(m[1], 10) > 0) return parseInt(m[1], 10)
    if (hostPid) {
      const out2 = await bridge.send('findconpid', String(hostPid))
      const m2 = /^hwnd:(\d+)$/.exec(out2 || '')
      if (m2 && parseInt(m2[1], 10) > 0) return parseInt(m2[1], 10)
    }
    await sleep(400)
  }
  return 0
}

/**
 * 按进程名查找主窗口（桥 findnames：EnumWindows，能找到隐藏窗口），
 * 用于已运行实例检测与冷启动隐藏窗口的高频轮询
 */
async function findWindowByNamesFast(processHints = [], maxWaitMs = 20000, tickMs = 250) {
  if (!processHints.length) return 0
  const csv = processHints.map((n) => String(n).replace(/['",|]/g, '')).filter(Boolean).join(',')
  if (!csv) return 0
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const out = await bridge.send('findnames', csv)
    const m = /^hwnd:(\d+)$/.exec(out || '')
    const n = parseInt(m?.[1], 10)
    if (Number.isFinite(n) && n > 0) return n
    await sleep(tickMs)
  }
  return 0
}

// WinEventHook 看门钩子：桌面应用（Electron/Chromium 系）冷启动时会无视 STARTF SW_HIDE 强制
// ShowWindow()，无法预先隐藏；用 OUTOFCONTEXT 钩子在窗口创建/显示事件瞬间将其移出屏幕并隐藏，
// 之后走常规附着流程在容器内显示，实现接近零闪窗。独立短命进程，超时自动退出。
const WATCHER_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$def = @"
using System;
using System.Runtime.InteropServices;
public class OHWatch {
  public delegate void WinEventProc(IntPtr hHook, uint ev, IntPtr hwnd, long idObject, long idChild, uint thread, uint time);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hHook);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -TypeDefinition $def
$script:names = @(__NAMES__)
$script:hidden = @{}
$cb = [OHWatch+WinEventProc]{
  param($hHook, $ev, $hwnd, $idObject, $idChild, $thread, $time)
  try {
    if ($idObject -ne 0 -or $hwnd -eq [IntPtr]::Zero) { return }
    if ($ev -ne 0x8000 -and $ev -ne 0x8002) { return }
    $wpid = 0
    [OHWatch]::GetWindowThreadProcessId($hwnd, [ref]$wpid) | Out-Null
    if ($wpid -eq 0) { return }
    $wp = Get-Process -Id $wpid -ErrorAction SilentlyContinue
    if (-not $wp -or $script:names -notcontains $wp.ProcessName) { return }
    $key = [string]$hwnd
    if ($script:hidden.ContainsKey($key)) { return }
    $script:hidden[$key] = 1
    # 只挪出屏幕（保留原尺寸），绝不 SW_HIDE：托盘优先的 Electron 应用（OpenCode 等）
    # 检测到窗口被隐藏会自行销毁窗口转入托盘，之后无窗口可吸附。
    # 挪出屏幕对用户同样不可见，但窗口保持「已显示」状态，吸附后原样进容器。
    $r = New-Object OHWatch+RECT
    [OHWatch]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    [OHWatch]::MoveWindow($hwnd, -32000, -32000, ([int]$r.Right - [int]$r.Left), ([int]$r.Bottom - [int]$r.Top), $false) | Out-Null
  } catch {}
}
$g = [OHWatch]::SetWinEventHook(0x8000, 0x8003, [IntPtr]::Zero, $cb, 0, 0, 2)
Add-Type -AssemblyName System.Windows.Forms
$deadline = [DateTime]::UtcNow.AddMilliseconds(25000)
while ([DateTime]::UtcNow -lt $deadline) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 25
}
if ($g -ne [IntPtr]::Zero) { [OHWatch]::UnhookWinEvent($g) | Out-Null }
`

let watcherTs = 0
let watcherProc = null

/** 终止看门钩子：附着流程拿到主窗口后必须立刻停，否则它会 HID 掉刚吸附/刚显示的窗口（HID 去重永不恢复） */
function stopWatcher() {
  if (watcherProc) {
    try { watcherProc.kill() } catch {}
    watcherProc = null
  }
}

/**
 * 启动窗口创建看门钩子（15 秒内不叠加多个；钩子进程 25 秒后自行退出）。
 * 必须走 -File：-Command 传递多行 here-string 脚本时 PowerShell 会静默提前退出（无 stderr、code 0），
 * 钩子从未安装过 —— 这是看门钩子一度完全失效的根因。
 */
function startWatcher(processHints = [], force = false) {
  const names = (processHints || []).map((n) => String(n).replace(/['",]/g, '')).filter(Boolean)
  if (!names.length) return
  const now = Date.now()
  if (!force && now - watcherTs < 15000) return
  watcherTs = now
  const script = WATCHER_PS.replace('__NAMES__', names.map((n) => `'${n}'`).join(','))
  try {
    const scriptPath = path.join(process.env.TEMP || process.cwd(), 'oh-watcher.ps1')
    fs.writeFileSync(scriptPath, script, 'utf-8')
    // 不能用 detached：DETACHED_PROCESS 下 PowerShell 完全没有控制台会静默退出/挂起，
    // 钩子永远装不上。windowsHide（CREATE_NO_WINDOW，隐藏控制台）是已被验证可用的组合
    const w = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      stdio: 'ignore',
      windowsHide: true
    })
    w.on('error', () => {})
    w.unref()
    watcherProc = w
  } catch {}
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
  for (const [, a] of attached) parkOffscreen(a)
  setClipRect(null)
  activeId = harnessId
}

/**
 * 停靠到屏幕外（窗口保持「已显示」状态）。
 * 绝不能对 GUI 窗口用 SW_HIDE：托盘优先的 Electron 应用（OpenCode 等）检测到窗口被隐藏
 * 会自行销毁窗口转入托盘，之后无窗口可吸附。挪出屏幕对用户同样不可见且无此风险。
 */
function parkOffscreen(a) {
  const w = a.lastRect ? Math.round(a.lastRect.width) : 800
  const h = a.lastRect ? Math.round(a.lastRect.height) : 600
  bridge.fire('move', a.hwnd, -32000, -32000, w, h)
  a.parked = true
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

  // 冷启动前先停靠当前激活窗口：原生子窗口永远浮在 HTML 之上，
  // 不挪开的话加载动画会被它盖住，用户看到的就是"旧界面卡住不动"。
  // 同时停掉看门狗，否则它会把停靠的窗口拉回容器。
  const prevActive = attached.get(activeId)
  if (prevActive && activeId !== harnessId) {
    parkOffscreen(prevActive)
    setClipRect(null)
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
    coldStart = true
    // 静默优先：conhost 以 STARTF SW_HIDE 启动，控制台窗口创建即隐藏，
    // 找到隐藏窗口附着进容器后再显示 —— 全程零弹窗
    let launched = launchCliConsole(title, cli, { silent: true })
    if (launched.ok) {
      hwnd = await findConsoleWindow(title, 15000, launched.hostPid)
    }
    // 兜底：静默路径不可用时回退可见控制台（旧行为，附着前短暂闪现）
    if (!hwnd) {
      launched = launchCliConsole(title, cli)
      if (!launched.ok) {
        return { ok: false, message: `未能启动 ${cli}（命令可能未安装，可在终端直接运行 ${cli} 验证）` }
      }
      // 按 conhost 子进程 cmd 定位控制台窗口（标题会被 claude 等程序改掉，PID 链不受影响）
      hwnd = await findChildWindow(launched.hostPid, 20000)
      if (!hwnd) {
        return { ok: false, message: `未能找到 ${cli} 的控制台窗口（命令可能未安装，可在终端直接运行 ${cli} 验证）` }
      }
    }
  } else {
    // 先找已运行的实例（findnames 也能找到隐藏窗口，如最小化到托盘的应用）
    hwnd = await findWindowByNamesFast(processHints, 2000, 500)
    if (!hwnd && exePath) {
      // GUI 冷启动：Electron 应用（OpenCode 等）启动初期会自毁/重建主窗口，
      // 一次附着可能落在短命窗口上。策略：布钩子停靠新窗口 → 找 → 附 → 验存活 →
      // 死了就重找重附（预算内循环），直到窗口稳定为止。
      startWatcher(processHints, true)
      const r = launchExe(exePath)
      if (!r.ok) return r
      pid = r.pid
      const deadline = Date.now() + 45000
      while (Date.now() < deadline && isLatest(harnessId)) {
        hwnd = await findWindowByNamesFast(processHints, 12000, 250)
        if (!hwnd) break
        // 拿到主窗口后立刻停钩子：它的停靠动作会挪走刚吸附的窗口
        stopWatcher()
        const attach = await attachNative({ harnessId, hwnd, parentHwnd, initialRect, hideOnCold: false })
        if (!attach.ok) {
          attached.delete(harnessId)
          startWatcher(processHints, true)
          continue
        }
        hwnd = attach.hwnd
        // 稳定验证：若应用自毁重建了窗口，此间 hwnd 会失效
        let stable = true
        for (let i = 0; i < 3; i++) {
          await sleep(900)
          const m = /^chk:(\d+):/.exec((await bridge.send('chk', String(hwnd))) || '')
          if (!m || m[1] !== '1') { stable = false; break }
        }
        if (stable) {
          if (isLatest(harnessId)) {
            activate(harnessId, initialRect)
            bridge.fire('show', hwnd, SW_SHOW)
          } else {
            // 过期冷启动：停靠屏幕外，切回该标签时即时复用
            parkOffscreen(attached.get(harnessId))
          }
          return { ok: true, hwnd, pid, launched: true }
        }
        // 窗口被应用自毁：清登记重来（重建的新窗口由钩子停靠在屏幕外）
        attached.delete(harnessId)
        startWatcher(processHints, true)
      }
      stopWatcher()
      return { ok: false, message: '未能附着应用窗口（应用可能启动失败或窗口未就绪）' }
    }
    if (!hwnd) {
      return { ok: false, message: '未能找到应用窗口（应用可能启动失败或窗口尚未创建）' }
    }
  }

  const attach = await attachNative({ harnessId, hwnd, parentHwnd, initialRect, hideOnCold: coldStart, restore: !coldStart })
  if (!attach.ok) {
    return { ok: false, message: '附着应用窗口失败' }
  }
  hwnd = attach.hwnd
  // 只有仍是最新打开目标时才激活/显示；过期冷启动登记后保持隐藏，切回时即时复用
  if (isLatest(harnessId)) {
    activate(harnessId, initialRect)
    if (coldStart) {
      // 冷启动窗口是隐藏着被附着的：定位完成后 RESTORE（清最小化态）再由 activate 的 SW_SHOW 显示
      bridge.fire('show', hwnd, SW_RESTORE)
    }
  } else {
    // 过期附着：停靠屏幕外（SW_HIDE 会触发托盘应用自毁窗口）
    parkOffscreen(attached.get(harnessId))
  }
  return { ok: true, hwnd, pid, launched: !!pid }
}

/**
 * 执行窗口附着：视需要先隐藏（控制台）/还原（已运行实例），剥样式、设父窗口、贴容器矩形并登记
 */
async function attachNative({ harnessId, hwnd, parentHwnd, initialRect, hideOnCold, restore }) {
  if (hideOnCold) {
    bridge.fire('show', hwnd, SW_HIDE)
    await sleep(150)
  } else if (restore) {
    // 已运行实例：先还原最大化/最小化状态，否则 Chromium 仍按最大化布局渲染，内容会被裁剪
    bridge.fire('show', hwnd, SW_RESTORE)
    await sleep(400)
  }

  const styleRes = await bridge.send('getstyle', hwnd)
  const origStyle = parseValue(styleRes)
  if (!origStyle) {
    return { ok: false }
  }

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

  attached.set(harnessId, { hwnd, origStyle, parentHwnd, lastRect: initialRect || null, parked: false })
  return { ok: true, hwnd }
}

/** 激活某个已附着窗口：显示它、其余停靠到屏幕外，并可顺手贴合矩形 */
export function activate(harnessId, rect) {
  if (!attached.has(harnessId)) return
  for (const [id, a] of attached) {
    if (id !== harnessId) parkOffscreen(a)
  }
  const a = attached.get(harnessId)
  if (rect) {
    allowedRect = rect
    a.lastRect = rect
    bridge.fire(
      'move', a.hwnd,
      Math.round(rect.x), Math.round(rect.y),
      Math.round(rect.width), Math.round(rect.height)
    )
  }
  a.parked = false
  bridge.fire('show', a.hwnd, SW_SHOW)
  activeId = harnessId
}

/** 重定位当前激活的嵌入窗口（物理像素，相对 BrowserWindow 客户区） */
export function reposition(rect) {
  const a = attached.get(activeId)
  if (!a) return
  allowedRect = rect
  a.lastRect = rect
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
// 最近一次 allowedRect：离开工作台（停靠全部窗口）后仍保留，供 showActive 恢复基准
let lastAllowedRect = null
let clipTimer = null

function safeWarn(...a) {
  // 日志绝不能抛异常阻断拉回逻辑
  try {
    console.warn(...a)
  } catch {}
}

export function setClipRect(rect) {
  allowedRect = rect || null
  if (allowedRect) lastAllowedRect = allowedRect
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
  // 转独立窗口：若它正停靠在屏幕外，摆回屏幕上（位置用上次容器矩形近似）
  if (a.lastRect) {
    bridge.fire(
      'move', a.hwnd,
      Math.round(a.lastRect.x), Math.round(a.lastRect.y),
      Math.round(a.lastRect.width), Math.round(a.lastRect.height)
    )
  }
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
  // Web 型 harness：杀服务进程树（按端口反查 PID），并结束 ConPTY 隐藏宿主。
  // 杀进程可能耗时数秒（netstat/taskkill），全部放后台执行，绝不拖住 IPC 让 UI 等待
  if (webServices.has(id)) {
    const { port } = webServices.get(id)
    webServices.delete(id)
    if (activeId === id) activeId = null
    bridge.send('killport', String(port)).catch(() => {})
    pty.closeSilent(id)
    return
  }
  const a = attached.get(id)
  if (!a) return
  // PID 必须在脱离前查：脱离后 hwnd 仍有效但窗口已变独立窗口
  const pidLine = await bridge.send('pidof', a.hwnd)
  const pid = /^pid:(\d+)$/.exec(pidLine || '')?.[1]
  await release(id)
  if (pid) {
    // /T 杀进程树（Electron/Chromium 多进程），/F 强制；后台执行
    exec('taskkill', ['/T', '/F', '/PID', pid]).catch(() => {})
  }
}

/** 释放全部嵌入（应用退出时调用，避免外部应用残留无边框样式）。杀服务并发执行 */
export async function releaseAll() {
  setClipRect(null)
  const kills = []
  for (const [id, s] of webServices) {
    kills.push(bridge.send('killport', String(s.port)).catch(() => {}))
    pty.closeSilent(id)
  }
  webServices.clear()
  await Promise.all(kills)
  for (const id of [...attached.keys()]) {
    await release(id)
  }
}

/** 停靠全部附着窗口（离开工作台路由时调用；先停看门狗再停靠，否则看门狗会把停靠的窗口拉回容器） */
export function hideAll() {
  setClipRect(null)
  for (const [, a] of attached) parkOffscreen(a)
}

/** 重新显示当前激活的附着窗口（从屏幕外停靠位挪回容器） */
export function showActive() {
  const a = attached.get(activeId)
  if (!a) return
  const rect = allowedRect || lastAllowedRect
  if (rect) {
    allowedRect = rect
    a.lastRect = rect
    bridge.fire(
      'move', a.hwnd,
      Math.round(rect.x), Math.round(rect.y),
      Math.round(rect.width), Math.round(rect.height)
    )
  }
  a.parked = false
  bridge.fire('show', a.hwnd, SW_SHOW)
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
