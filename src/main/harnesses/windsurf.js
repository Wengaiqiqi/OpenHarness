import { LOCALAPPDATA, USERPROFILE, injectMcpIntoFile, launchExe, firstExists } from './base'

const windsurf = {
  id: 'windsurf',
  name: 'Windsurf',
  desc: 'Codeium AI 编辑器，支持 MCP',
  color: '#09b6a2',
  icon: 'https://cdn.simpleicons.org/windsurf/09b6a2',
  processHints: ['Windsurf'],
  exeCandidates: [`${LOCALAPPDATA}\\Programs\\windsurf\\Windsurf.exe`, `${LOCALAPPDATA}\\Programs\\Windsurf\\Windsurf.exe`],
  configCandidates: [`${USERPROFILE}\\.codeium\\windsurf\\mcp_config.json`],

  async detect(sys) {
    const exe = firstExists(this.exeCandidates) || (sys?.find ? sys.find(['windsurf']) : null)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath), exePath: exe, configPath, canInjectMcp: !!configPath }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Windsurf' }
    return launchExe(exe)
  },
  async injectMcp(servers) {
    return injectMcpIntoFile(this.configPath(), servers, 'mcpServers')
  }
}

export default windsurf
