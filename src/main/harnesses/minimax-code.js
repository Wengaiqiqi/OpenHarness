import { USERPROFILE, exists, firstExists, commandExists } from './base'
import { mergeYamlAgentProviders } from './agent-config'

/** MiniMax Code：模型配置注入到 ~/.minimax/config.yaml（YAML） */
const minimax_code = {
  id: 'minimax-code',
  name: 'MiniMax Code',
  desc: 'MiniMax 编码 CLI，支持模型配置注入',
  color: '#ff5722',
  icon: 'https://cdn.simpleicons.org/minimax/ff5722',
  cli: 'minimax',
  usePty: true,
  processHints: [],
  configCandidates: [`${USERPROFILE}\\.minimax\\config.yaml`],

  async detect() {
    const configPath = firstExists(this.configCandidates)
    const binary = await commandExists(this.cli)
    return { installed: binary && !!configPath, exePath: null, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    return { ok: false, message: 'MiniMax Code 为 CLI 工具，请在终端中启动' }
  },
  async configureModel({ models }) {
    return mergeYamlAgentProviders(this.configPath(), { models }, ['providers'])
  }
}

export default minimax_code
