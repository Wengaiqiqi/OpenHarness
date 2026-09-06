import { LOCALAPPDATA, USERPROFILE, injectMcpIntoFile, launchExe, firstExists } from './base.js'

const trae = {
  id: 'trae',
  name: 'Trae',
  desc: '字节跳动 AI IDE（国内/国际版），支持 MCP',
  color: '#eb4d4b',
  icon: 'https://cdn.simpleicons.org/trae/eb4d4b',
  processHints: ['Trae CN', 'Trae'],
  exeCandidates: [`${LOCALAPPDATA}\\Programs\\Trae CN\\Trae CN.exe`, `${LOCALAPPDATA}\\Programs\\Trae\\Trae.exe`],
  configCandidates: [`${USERPROFILE}\\.trae\\mcp.json`, `${USERPROFILE}\\.trae-cn\\mcp.json`],

  async detect(sys) {
    const exe = firstExists(this.exeCandidates) || (sys?.find ? sys.find(['trae']) : null)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath), exePath: exe, configPath, canInjectMcp: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Trae' }
    return launchExe(exe)
  },
  async injectMcp(servers) {
    return injectMcpIntoFile(this.configPath(), servers, 'mcpServers')
  }
}

export default trae
