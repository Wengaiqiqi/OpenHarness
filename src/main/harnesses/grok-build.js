import { USERPROFILE, exists, firstExists, commandExists } from './base'
import { mergeTomlProvider } from './agent-config'

/** Grok Build：模型配置注入到 ~/.grok/config.toml（TOML） */
const grok_build = {
  id: 'grok-build',
  name: 'Grok Build',
  desc: 'xAI Grok 编码工具，支持模型配置注入',
  color: '#7f7f7f',
  icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/grok.svg',
  cli: 'grok',
  processHints: [],
  configCandidates: [`${USERPROFILE}\\.grok\\config.toml`],

  async detect() {
    const configPath = firstExists(this.configCandidates)
    const binary = await commandExists(this.cli)
    return { installed: binary && !!configPath, exePath: null, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    return { ok: false, message: 'Grok Build 为 CLI 工具，请在终端中启动' }
  },
  async configureModel({ models, model }) {
    return mergeTomlProvider(this.configPath(), { model })
  }
}

export default grok_build
