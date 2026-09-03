import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile as rawExecFile } from 'node:child_process'
import { promisify } from 'node:util'

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

/** 把 OpenHarness 注册的 MCP server 转为 stdio 启动项 */
function buildStdioEntry(server) {
  if (server.transport === 'http') {
    return { type: 'http', url: server.url, ...(server.headers || {}) }
  }
  if (!server.command) return null
  const args = (server.args || []).filter(Boolean)
  return { command: server.command, args, ...(server.env ? { env: server.env } : {}) }
}

/** 启动 exe（分离进程） */
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
 * 启动 CLI 命令。写临时 .bat 后以 cmd /c 执行。
 * @param {boolean} [opts.hidden] 隐藏启动（CREATE_NO_WINDOW，全程无控制台窗口，适合只跑服务的 Web 型 harness）；
 *   否则用 conhost 显式宿主（绕开 wt 接管、附着后色彩丢失），返回 hostPid 供定位 cmd 子窗口
 */
function launchCliConsole(title, command, opts = {}) {
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RENDERER_URL
    env.FORCE_COLOR = '1'
    env.COLORTERM = 'truecolor'
    env.TERM = 'xterm-256color'
    const bat = path.join(env.TEMP || process.cwd(), title + '.bat')
    const lines = ['@echo off', 'chcp 65001 >nul']
    if (!opts.hidden) lines.push('title ' + title)
    lines.push(command, '')
    fs.writeFileSync(bat, lines.join(String.fromCharCode(13, 10)))
    if (opts.hidden) {
      const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, env })
      child.unref()
      return { ok: true }
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
