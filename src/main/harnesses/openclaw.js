import { USERPROFILE, APPDATA, exists, firstExists, launchExe } from './base.js'
import { mergeJsonAgentProviders } from './agent-config.js'

/** OpenClaw（原 Clawdbot/Moltbot）：个人 AI 助理网关，检测常见安装位置 */
const openclaw = {
  id: 'openclaw',
  name: 'OpenClaw',
  desc: '个人 AI 助理 Gateway，实验性检测',
  color: '#a78bfa',
  icon: 'icons/openclaw.svg',
  cli: 'openclaw',
  usePty: true,
  processHints: ['openclaw'],
  exeCandidates: [`${USERPROFILE}\\.openclaw\\bin\\openclaw.cmd`, `${APPDATA}\\npm\\openclaw.cmd`],
  configCandidates: [`${USERPROFILE}\\.openclaw\\openclaw.json`, `${USERPROFILE}\\.openclaw\\clawdbot.json`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return {
      installed: !!(exe || configPath || exists(`${USERPROFILE}\\.openclaw`)),
      exePath: exe,
      configPath,
      canInjectMcp: false
    }
  },
  configPath() {
    return firstExists(this.configCandidates)
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 OpenClaw（可通过 npm i -g openclaw 安装）' }
    return launchExe(exe)
  },
  async injectMcp() {
    return { ok: false, message: 'OpenClaw 暂不支持直接注入，请在 Gateway 配置中手动添加' }
  },
  async configureModel({ models, model, token }) {
    const p = this.configPath() || this.configCandidates[0]
    return mergeJsonAgentProviders(p, { models, model, token })
  }
}

export default openclaw
