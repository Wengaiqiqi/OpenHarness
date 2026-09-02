import { USERPROFILE, exists, firstExists, launchExe } from './base'

/** Hermes（Nous Research hermes-agent）：个人 AI Agent，检测 CLI 与配置目录 */
const hermes = {
  id: 'hermes',
  name: 'Hermes',
  desc: 'Nous Research 个人 AI Agent',
  color: '#d97757',
  processHints: ['hermes'],
  exeCandidates: [`${USERPROFILE}\\.hermes\\bin\\hermes.exe`, `${USERPROFILE}\\AppData\\Roaming\\npm\\hermes.cmd`],
  configCandidates: [`${USERPROFILE}\\.hermes\\config.json`, `${USERPROFILE}\\.hermes\\hermes.json`],
  icon: '/icons/hermes.png',

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath || exists(`${USERPROFILE}\\.hermes`)), exePath: exe, configPath, canInjectMcp: false }
  },
  configPath() {
    return firstExists(this.configCandidates)
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Hermes' }
    return launchExe(exe)
  },
  async injectMcp() {
    return { ok: false, message: 'Hermes 配置格式暂不支持直接注入' }
  }
}

export default hermes
