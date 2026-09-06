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
  // 商店版（MSIX）：shell:AppsFolder 启动标识经 explorer 拉起
  if (exePath.startsWith('shell:')) {
    // 商店版（MSIX）用 cmd start 拉 shell: URI——经 explorer 直接传参在
    // CreateProcess 下不会生效（实测整个 45s 冷启动期间进程从未出现）
    try {
      const child = spawn('cmd.exe', ['/c', 'start', exePath], { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, message: '已启动（商店应用）' }
    } catch (err) {
      return { ok: false, message: String(err) }
    }
  }
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

let sysScanCache = null

/**
 * 系统级应用扫描（一次全量，60s 缓存）：卸载注册表 + 运行中进程 + 开始菜单快捷方式。
 * 返回 find(...keywords)：按关键词匹配返回真实存在的 exe 路径（无则 null）。
 * 各 GUI 适配器 detect 兜底用——新装应用不在硬编码路径也能被发现。
 */
export async function scanSystemApps(force = false) {
  if (!force && sysScanCache && Date.now() - sysScanCache.ts < 60000) return sysScanCache.data
  const exists = (p) => p && fs.existsSync(p)
  let lastRaw = { reg: [], proc: [], lnk: [], appx: [] }
  // 公开签名：find('zcode', 'z-ai') —— 关键词即适配器的应用名/别名/进程名
  const find = (...keywords) => {
    const raw = lastRaw
    const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean)
    const hit = (text) => kws.some((k) => text.includes(k))
    // 1) 运行中进程：最可靠（装过且启动过即有 exe 全路径）
    for (const p of raw.proc || []) {
      if (hit(p.name.toLowerCase()) && exists(p.exe)) return p.exe
    }
    // 1.5) 商店版（MSIX）：包内完整 exe 路径可直接 CreateProcess（实测可行，
    // 且 fs.existsSync 同样为 true——ACL 允许包用户访问已知完整路径）
    for (const a of raw.appx || []) {
      if (hit(a.name.toLowerCase())) return a.location + path.sep + a.exeRel
    }
    // 2) 注册表 DisplayIcon：通常指向主 exe（去掉 ",0" 资源索引后缀；指向 .ico 的跳过）
    for (const r of raw.reg || []) {
      if (!hit(r.name.toLowerCase())) continue
      const icon = (r.icon || '').split(',')[0].trim().replace(/^"|"$/g, '')
      if (icon.toLowerCase().endsWith('.exe') && exists(icon)) return icon
    }
    // 3) 注册表 InstallLocation + 关键词拼 exe
    for (const r of raw.reg || []) {
      const loc = (r.location || '').replace(/\\+$/, '')
      if (!loc || (!hit(r.name.toLowerCase()) && !hit(loc.toLowerCase()))) continue
      for (const k of kws) {
        const exe = loc + '\\' + k + '.exe'
        if (exists(exe)) return exe
      }
    }
    // 4) 开始菜单快捷方式目标
    for (const l of raw.lnk || []) {
      if (hit(l.name.toLowerCase()) && exists(l.target) && l.target.toLowerCase().endsWith('.exe')) return l.target
    }
    return null
  }
  const data = { find }
  try {
    const scriptPath = path.join(process.env.TEMP || process.cwd(), 'oh-scan-system.ps1')
    const ps = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      // 中文用户名下路径必须 UTF-8 输出，否则 stdout 乱码、existsSync 全 false，
      // 用户目录下安装的 harness 永远检测不到
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$keys = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
      "        'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
      'foreach ($k in Get-ItemProperty $keys) {',
      "  if ($k.DisplayName) { Write-Output ('reg|' + $k.DisplayName + '|' + $k.InstallLocation + '|' + $k.DisplayIcon) }",
      '}',
      'Get-Process | ForEach-Object {',
      '  try {',
      '    $exe = $_.MainModule.FileName',
      "    if ($exe) { Write-Output ('proc|' + $_.ProcessName + '|' + $exe) }",
      '  } catch {}',
      '}',
      'Get-AppxPackage | ForEach-Object {',
      '  try {',
      '    $m = Get-AppxPackageManifest $_',
      '    $exe = $m.Package.Applications.Application.Executable',
      "    if ($exe) { Write-Output ('appx|' + $_.Name + '|' + $_.InstallLocation + '|' + $exe) }",
      '  } catch {}',
      '}',
      '$wsh = New-Object -ComObject WScript.Shell',
      'foreach ($root in @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")) {',
      '  Get-ChildItem $root -Recurse -Filter *.lnk | ForEach-Object { Write-Output ("lnk|" + $_.BaseName + "|" + $wsh.CreateShortcut($_.FullName).TargetPath) }',
      '}'
    ].join('\n')
    // 写脚本必须先于执行（首次调用无文件会拿到空结果并缓存 60s）
    fs.writeFileSync(scriptPath, ps, 'utf-8')
    const { stdout } = await execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true, timeout: 25000, maxBuffer: 8 * 1024 * 1024 })
    const reg = []
    const proc = []
    const lnk = []
    const appx = []
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (t.startsWith('reg|')) {
        const parts = t.split('|')
        reg.push({ name: parts[1] || '', location: parts[2] || '', icon: parts[3] || '' })
      } else if (t.startsWith('proc|')) {
        const parts = t.split('|')
        if (parts[2]) proc.push({ name: parts[1] || '', exe: parts[2] })
      } else if (t.startsWith('lnk|')) {
        const parts = t.split('|')
        if (parts[2]) lnk.push({ name: parts[1] || '', target: parts[2] })
      } else if (t.startsWith('appx|')) {
        const parts = t.split('|')
        if (parts[2] && parts[3]) appx.push({ name: parts[1] || '', location: parts[2], exeRel: parts[3] })
      }
    }
    data.raw = { reg, proc, lnk, appx }
    lastRaw = data.raw
    // 只有扫描成功才缓存：失败（PS 超时/异常）被缓存 60s 会让
    // 刚装完应用就点扫描的场景反复拿到空结果，误报未安装
    sysScanCache = { ts: Date.now(), data }
  } catch {}
  return data
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
