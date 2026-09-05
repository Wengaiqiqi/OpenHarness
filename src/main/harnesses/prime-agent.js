import { USERPROFILE, exists, firstExists, commandExists } from './base'
import { mergeJsonAgentProviders } from './agent-config'

/** Prime Agent：模型配置注入到 ~/.prime/agent/models.json（JSON） */
const prime_agent = {
  id: 'prime-agent',
  name: 'Prime Agent',
  desc: 'Prime 编码代理，支持模型配置注入',
  color: '#14b8a6',
  icon: 'https://github.com/PrimeIntellect-ai.png',
  cli: 'prime',
  usePty: true,
  processHints: [],
  configCandidates: [`${USERPROFILE}\\.prime\\agent\\models.json`],

  async detect() {
    const configPath = firstExists(this.configCandidates)
    const binary = await commandExists(this.cli)
    return { installed: binary && !!configPath, exePath: null, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    return { ok: false, message: 'Prime Agent 为 CLI 工具，请在终端中启动' }
  },
  async configureModel({ models }) {
    return mergeJsonAgentProviders(this.configPath(), { models })
  }
}

export default prime_agent
