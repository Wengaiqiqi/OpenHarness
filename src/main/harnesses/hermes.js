import { LOCALAPPDATA, USERPROFILE, exists, firstExists, launchExe } from './base'
import { mergeYamlAgentProviders } from './agent-config'

/** Hermes（Nous Research hermes-agent）：个人 AI Agent，检测 CLI 与配置目录 */
const hermes = {
  id: 'hermes',
  name: 'Hermes',
  desc: 'Nous Research 个人 AI Agent',
  color: '#d97757',
  processHints: ['hermes'],
  exeCandidates: [`${USERPROFILE}\\.hermes\\bin\\hermes.exe`, `${USERPROFILE}\\AppData\\Roaming\\npm\\hermes.cmd`],
  configCandidates: [`${USERPROFILE}\\.hermes\\config.json`, `${USERPROFILE}\\.hermes\\hermes.json`],
  icon: 'icons/hermes.png',

  async detect(sys) {
    // 系统扫描兜底：Hermes Desktop 装在 AppData\Local\hermes\...（动态版本路径），
    // 硬编码候选覆盖不了，经开始菜单快捷方式/注册表/运行进程发现
    const exe = firstExists(this.exeCandidates) || (sys?.find ? sys.find('hermes') : null)
    const configPath = firstExists(this.configCandidates)
    // Hermes Desktop 数据目录在 %LOCALAPPDATA%\hermes（CLI 才用 ~/.hermes）
    return { installed: !!(exe || configPath || exists(`${USERPROFILE}\\.hermes`) || exists(`${LOCALAPPDATA}\\hermes`)), exePath: exe, configPath, canInjectMcp: false, canConfigureModel: true }
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
  },
  async configureModel({ models }) {
    const p = this.configPath() || this.configCandidates[0]
    return mergeYamlAgentProviders(p, { models }, ['providers'])
  }
}

export default hermes
