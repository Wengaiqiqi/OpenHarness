import { LOCALAPPDATA, USERPROFILE, injectMcpIntoFile, launchExe, firstExists } from './base'

const cursor = {
  id: 'cursor',
  name: 'Cursor',
  desc: 'AI 代码编辑器，支持 MCP',
  color: '#4b8bbe',
  processHints: ['Cursor'],
  exeCandidates: [`${LOCALAPPDATA}\\Programs\\cursor\\Cursor.exe`, `${LOCALAPPDATA}\\Programs\\Cursor\\Cursor.exe`],
  configCandidates: [`${USERPROFILE}\\.cursor\\mcp.json`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath), exePath: exe, configPath, canInjectMcp: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Cursor' }
    return launchExe(exe)
  },
  async injectMcp(servers) {
    return injectMcpIntoFile(this.configPath(), servers, 'mcpServers')
  }
}

export default cursor
