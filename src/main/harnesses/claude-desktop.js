import { LOCALAPPDATA, firstExists, injectMcpIntoFile, launchExe } from './base'

const claudeDesktop = {
  id: 'claude-desktop',
  name: 'Claude Desktop',
  desc: 'Anthropic 官方桌面端，支持 MCP',
  color: '#d97757',
  icon: 'icons/claude.svg',
  processHints: ['Claude'],
  exeCandidates: [`${LOCALAPPDATA}\\AnthropicClaude\\claude.exe`, `${LOCALAPPDATA}\\AnthropicClaude\\Claude.exe`],
  configCandidates: [`${process.env.APPDATA}\\Claude\\claude_desktop_config.json`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
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
