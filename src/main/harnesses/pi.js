import { USERPROFILE, exists, firstExists, commandExists } from './base'
import { mergeJsonAgentProviders } from './agent-config'

/** Pi：模型配置注入到 ~/.pi/agent/models.json（JSON） */
const pi = {
  id: 'pi',
  name: 'Pi',
  desc: 'Pi 编码代理，支持模型配置注入',
  color: '#8b5cf6',
  icon: 'icons/pi.svg',
  cli: 'pi',
  processHints: [],
  configCandidates: [`${USERPROFILE}\\.pi\\agent\\models.json`],

  async detect() {
    const configPath = firstExists(this.configCandidates)
    const binary = await commandExists(this.cli)
    return { installed: binary && !!configPath, exePath: null, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    return { ok: false, message: 'Pi 为 CLI 工具，请在终端中启动' }
  },
  async configureModel({ models }) {
    return mergeJsonAgentProviders(this.configPath(), { models })
  }
}

export default pi
