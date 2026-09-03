import { USERPROFILE, exists, firstExists, launchExe } from './base'
import { mergeJsonAgentProviders } from './agent-config'

/** ZCode（Z.ai AI IDE）：检测本机安装（含自定义安装路径），仅检测/启动 */
const zcode = {
  id: 'zcode',
  name: 'ZCode',
  desc: 'Z.ai AI IDE，支持编程计划与 Agent',
  color: '#7c5cff',
  processHints: ['ZCode'],
  exeCandidates: [`${USERPROFILE}\\AppData\\Local\\Programs\\zcode\\ZCode.exe`, 'D:\\zcode\\ZCode.exe'],
  configCandidates: [`${USERPROFILE}\\.zcode\\v2\\setting.json`],
  icon: 'icons/zcode.png',

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return { installed: !!(exe || configPath || exists(`${USERPROFILE}\\.zcode`)), exePath: exe, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates)
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 ZCode' }
    return launchExe(exe)
  },
  async injectMcp() {
    return { ok: false, message: 'ZCode 配置格式暂不支持直接注入，请在设置中手动添加' }
  },
  async configureModel({ models }) {
    const p = this.configPath() || this.configCandidates[0]
    return mergeJsonAgentProviders(p, { models })
  }
}

export default zcode
