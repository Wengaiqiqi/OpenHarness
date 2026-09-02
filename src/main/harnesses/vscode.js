import { APPDATA, LOCALAPPDATA, injectMcpIntoFile, launchExe, firstExists } from './base'

const vscode = {
  id: 'vscode',
  name: 'VS Code',
  desc: 'Visual Studio Code（Copilot MCP 模式）',
  color: '#23a9f2',
  icon: 'https://api.iconify.design/vscode-icons:file-type-vscode.svg',
  processHints: ['Code', 'Code - Insiders'],
  exeCandidates: [
    `${LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe`,
    `${LOCALAPPDATA}\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe`
  ],
  configCandidates: [`${APPDATA}\\Code\\User\\mcp.json`, `${APPDATA}\\Code - Insiders\\User\\mcp.json`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath), exePath: exe, configPath, canInjectMcp: !!configPath }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 VS Code' }
    return launchExe(exe)
  },
  async injectMcp(servers) {
    // VS Code 的 mcp.json 使用 "servers" 作为顶层 key
    return injectMcpIntoFile(this.configPath(), servers, 'servers')
  }
}

export default vscode
