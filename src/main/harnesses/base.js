import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile as rawExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { applyAuth } from './agent-config'

const execFile = promisify(rawExecFile)

const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming')
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local')
const USERPROFILE = process.env.USERPROFILE || 'C:\\Users\\Public'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** 读取 JSON（不存在/损坏返回 {}） */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

/** 写入 JSON 前自动备份原文件 */
function writeJsonWithBackup(p, data) {
  if (exists(p)) {
    const backup = p + '.openharness.bak'
    fs.copyFileSync(p, backup)
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 将 MCP servers 合并注入配置文件
 * key: 'mcpServers' | 'servers'
 */
function injectMcpIntoFile(configPath, servers, key = 'mcpServers') {
  const config = readJson(configPath)
  const existing = config[key] || {}
  const injected = []
  for (const s of servers) {
    const entry = buildStdioEntry(s)
    if (!entry) continue
    existing[s.name] = entry
    injected.push(s.name)
  }
  config[key] = existing
  writeJsonWithBackup(configPath, config)
  return { ok: true, path: configPath, injected }
}

/** 把 OpenHarness 注册的 MCP server 转为 stdio 启动项（http 类型合成鉴权到 URL/头） */
function buildStdioEntry(server) {
  if (server.transport === 'http') {
    const { url, headers } = applyAuth(server)
    return { type: 'http', url, ...(Object.keys(headers).length ? { headers } : {}) }
  }
  if (!server.command) return null
  const args = (server.args || []).filter(Boolean)
  return { command: server.command, args, ...(server.env ? { env: server.env } : {}) }
}

/**
 * 启动 exe（分离进程）。
 * 注意：绝不能加 windowsHide —— 它会附带 STARTF SW_HIDE 提示，托盘优先的 Electron 应用
 * （如 OpenCode Desktop）会据此静默启动且不创建任何窗口，导致无窗口可吸附。
 * 冷启动的闪窗防护由 embed 的 WinEventHook 看门钩子负责（窗口创建瞬间移出屏幕并隐藏）。
 */
function launchExe(exePath, args = []) {
  if (!exists(exePath)) return { ok: false, message: `未找到可执行文件: ${exePath}` }
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RENDERER_URL
    const child = spawn(exePath, args, { detached: true, stdio: 'ignore', env })
    child.unref()
    return { ok: true, message: `已启动: ${path.basename(exePath)}`, pid: child.pid }
  } catch (err) {
    return { ok: false, message: String(err) }
  }
}


/**
 * 启动 CLI 命令。写临时 .bat 后以 conhost 显式宿主（绕开 wt 接管、附着后色彩丢失），返回 hostPid 供定位 cmd 子窗口
 * @param {boolean} [opts.silent] 静默启动（STARTF SW_HIDE：控制台窗口创建即隐藏但真实存在，
 *   由 embed 找到隐藏窗口附着进容器后再显示 —— 全程零弹窗）。
 *   （Web 型 harness 起后台服务改用 pty.openSilent：ConPTY 虚拟终端能隐藏自拉起新控制台窗口的进程）
 */
function launchCliConsole(title, command, opts = {}) {
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RENDERER_URL
    env.FORCE_COLOR = '1'
    env.COLORTERM = 'truecolor'
    env.TERM = 'xterm-256color'
    const bat = path.join(env.TEMP || process.cwd(), title + '.bat')
    // silent 模式也写 title：embed 靠 ConsoleWindowClass + 标题定位隐藏窗口
    const lines = ['@echo off', 'chcp 65001 >nul', 'title ' + title, command, '']
    fs.writeFileSync(bat, lines.join(String.fromCharCode(13, 10)))
    if (opts.silent) {
      const child = spawn('conhost.exe', ['cmd', '/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, env })
      child.unref()
      return { ok: true, hostPid: child.pid }
    }
    const child = spawn('conhost.exe', ['cmd', '/c', bat], { detached: true, stdio: 'ignore', env })
    child.unref()
    return { ok: true, hostPid: child.pid }
  } catch {
    return { ok: false }
  }
}

/** 在候选路径中找到第一个存在的 */
function firstExists(paths) {
  for (const p of paths) if (exists(p)) return p
  return null
}

/**
 * 中央 cli 自愈：cli 不在 PATH 时按 exeCandidates 逐个回退（修"已安装却检测不到/启动失败"）。
 * 结果记忆在适配器对象上，进程内只解析一次。同步覆盖所有 PTY 型 harness。
 */
export async function resolveCliCommand(adapter) {
  if (adapter._cliResolved) return adapter._cliResolved
  let cli = adapter.cli
  if (cli && !(await commandExists(String(cli).trim().split(/\s+/)[0])) && adapter.exeCandidates) {
    const exe = firstExists(adapter.exeCandidates)
    if (exe) cli = exe
  }
  adapter._cliResolved = cli
  return cli
}

/** 探测命令是否在 PATH 中（取命令首词，兼容带参数/占位符的 cli 字段） */
async function commandExists(command) {
  const name = String(command || '').trim().split(/\s+/)[0]
  if (!name) return false
  try {
    const { stdout } = await execFile('where', [name], { windowsHide: true, timeout: 4000 })
    return !!stdout.trim()
  } catch {
    return false
  }
}

export {
  APPDATA,
  LOCALAPPDATA,
  USERPROFILE,
  exists,
  readJson,
  writeJsonWithBackup,
  injectMcpIntoFile,
  buildStdioEntry,
  launchExe,
  launchCliConsole,
  commandExists,
  firstExists
}
