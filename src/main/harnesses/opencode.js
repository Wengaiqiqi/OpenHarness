import { USERPROFILE, exists, firstExists, launchExe } from './base'
import { mergeJsonAgentProviders } from './agent-config'

/** OpenCode Desktop（ai.opencode.desktop，Electron）：桌面 AI 编码 Agent */
const opencode = {
  id: 'opencode',
  name: 'OpenCode',
  desc: 'OpenCode Desktop AI 编码 Agent（opencode.ai）',
  color: '#111111',
  processHints: ['OpenCode'],
  exeCandidates: [
    `${process.env.LOCALAPPDATA}\\Programs\\@opencode-aidesktop\\OpenCode.exe`,
    `${USERPROFILE}\\.opencode\\bin\\opencode.exe`
  ],
  configCandidates: [`${process.env.APPDATA}\\ai.opencode.desktop`, `${USERPROFILE}\\.opencode\\opencode.json`],
  icon: 'https://cdn.simpleicons.org/opencode/111111',

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath), exePath: exe, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates)
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 OpenCode Desktop' }
    return launchExe(exe)
  },
  async injectMcp() {
    return { ok: false, message: 'OpenCode 请在 opencode.json 中手动配置 MCP' }
  },
  async configureModel({ models }) {
    const p = this.configPath() || this.configCandidates[0]
    return mergeJsonAgentProviders(p, { models })
  }
}

export default opencode
