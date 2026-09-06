import { USERPROFILE, exists, firstExists, commandExists } from './base.js'
import { mergeYamlAgentProviders } from './agent-config.js'

/** DeepSeek Harness (DSH)：模型配置注入到 ~/.dsh/settings.yaml（YAML，llm-pi-ai.providers 路径） */
const dsh = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  desc: 'DeepSeek Harness，支持模型配置注入',
  color: '#4d6bfe',
  icon: 'https://cdn.simpleicons.org/deepseek/4d6bfe',
  cli: 'dsh web --port {port}',
  /** Web 型 harness：CLI 起本地服务；{port} 运行时替换为动态空闲端口 */
  webPort: true,
  processHints: [],
  configCandidates: [`${USERPROFILE}\\.dsh\\settings.yaml`],

  async detect() {
    const configPath = firstExists(this.configCandidates)
    const binary = await commandExists(this.cli)
    return { installed: binary && !!configPath, exePath: null, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    return { ok: false, message: 'DeepSeek Harness 为 CLI 工具，请在终端中启动' }
  },
  async configureModel({ models, model, token }) {
    return mergeYamlAgentProviders(this.configPath(), { models, model, token }, ['llm-pi-ai', 'providers'])
  }
}

export default dsh
