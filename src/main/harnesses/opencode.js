import { APPDATA, USERPROFILE, exists, firstExists, launchExe } from './base'
import { mergeJsonAgentProviders, mergeOpencodeMcp } from './agent-config'

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
  // OpenCode（含 Desktop 版）读取 XDG 配置目录下的 opencode.json；
  // ai.opencode.desktop 是 Electron userData 目录（不是配置文件，对它读写会 EPERM）
  configCandidates: [
    `${USERPROFILE}\\.config\\opencode\\opencode.json`,
    `${APPDATA}\\opencode\\opencode.json`,
    `${USERPROFILE}\\.opencode\\opencode.json`
  ],
  icon: 'https://cdn.simpleicons.org/opencode/111111',

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath), exePath: exe, configPath, canInjectMcp: true, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates)
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 OpenCode Desktop' }
    return launchExe(exe)
  },
  async injectMcp(servers) {
    const p = this.configPath() || this.configCandidates[0]
    return mergeOpencodeMcp(p, servers)
  },
  async configureModel({ models }) {
    const p = this.configPath() || this.configCandidates[0]
    return mergeJsonAgentProviders(p, { models })
  }
}

export default opencode
