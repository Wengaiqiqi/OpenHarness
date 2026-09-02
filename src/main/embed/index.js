import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import bridge from './win32-bridge'
import { launchExe } from '../harnesses/base'

const exec = promisify(execFile)

/** 剥离的窗口样式位：CAPTION|SYSMENU|THICKFRAME|MINIMIZEBOX|MAXIMIZEBOX */
const STYLE_STRIP = 0x00cf0000
const SW_SHOW = 5
const SW_HIDE = 0
const SW_RESTORE = 9

// 多开：harnessId -> { hwnd, origStyle }；activeId 为当前显示的那个
const attached = new Map()
let activeId = null

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

/**
 * 将目标应用主窗口附着（嵌入）到 OpenHarness 窗口内；已附着则直接激活
 * @param {number} parentHwnd OpenHarness BrowserWindow 的 HWND
 * @param {{x:number,y:number,width:number,height:number}} [initialRect] 容器物理像素矩形，附着后立即定位
 */
export async function embedApp({ harnessId, exePath, processHints, parentHwnd, initialRect }) {
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

  // 先找已运行的实例，找不到再冷启动
  let hwnd = await findWindowByNames(processHints)
  let pid = null
  if (!hwnd && exePath) {
    const r = launchExe(exePath)
    if (!r.ok) return r
    pid = r.pid
    hwnd = await findWindowByPid(pid)
  }
  if (!hwnd) {
    return { ok: false, message: '未能找到应用窗口（应用可能启动失败或窗口尚未创建）' }
  }

  // 先还原最大化/最小化状态，否则 Chromium 仍按最大化布局渲染，内容会被裁剪
  bridge.fire('show', hwnd, SW_RESTORE)
  await sleep(400)

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
  activate(harnessId, initialRect)
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
  return { attached: [...attached.keys()], activeId }
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
