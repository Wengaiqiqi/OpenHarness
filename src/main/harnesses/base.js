import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

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

/** 在候选路径中找到第一个存在的 */
function firstExists(paths) {
  for (const p of paths) if (exists(p)) return p
  return null
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
  firstExists
}
