import { LOCALAPPDATA, firstExists, injectMcpIntoFile, launchExe } from './base.js'

const claudeDesktop = {
  id: 'claude-desktop',
  name: 'Claude Desktop',
  desc: 'Anthropic 官方桌面端，支持 MCP',
  color: '#d97757',
  icon: 'icons/claude.svg',
  processHints: ['Claude'],
  exeCandidates: [`${LOCALAPPDATA}\\AnthropicClaude\\claude.exe`, `${LOCALAPPDATA}\\AnthropicClaude\\Claude.exe`],
  configCandidates: [`${process.env.APPDATA}\\Claude\\claude_desktop_config.json`],

  async detect(sys) {
    // 商店版（MSIX）经 appx 层返回 shell:AppsFolder 启动标识；传统版路径须含 AnthropicClaude。
    // find 是可变参数签名：关键词必须逐个传（传数组会被当成单个关键词匹配失败）
    const exe = firstExists(this.exeCandidates) || (sys?.find ? (() => {
      const e = sys.find('claude desktop', 'claude')
      // 放行：商店版启动标识 / 商店版 WindowsApps 包内路径 / 传统版 AnthropicClaude
      if (!e || !(e.startsWith('shell:') || /windowsapps|anthropicclaude/i.test(e))) return null
      return e
    })() : null)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath), exePath: exe, configPath, canInjectMcp: !!configPath }
  },
  configPath() {
    return firstExists(this.configCandidates)
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Claude Desktop' }
    return launchExe(exe)
  },
  async injectMcp(servers) {
    const configPath = firstExists(this.configCandidates) || this.configCandidates[0]
    return injectMcpIntoFile(configPath, servers, 'mcpServers')
  }
}

export default claudeDesktop
