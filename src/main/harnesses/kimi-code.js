import { APPDATA, LOCALAPPDATA, USERPROFILE, exists, firstExists, commandExists } from './base'
import { mergeTomlProvider } from './agent-config'

/** Kimi Code：模型配置注入到 ~/.kimi-code/config.toml（TOML） */
const kimi_code = {
  id: 'kimi-code',
  name: 'Kimi Code',
  desc: 'Kimi 编码 CLI，支持模型配置注入',
  color: '#111111',
  icon: 'https://cdn.simpleicons.org/kimi/111111',
  cli: 'kimi',
  exeCandidates: [`${APPDATA}\\npm\\kimi.cmd`, `${USERPROFILE}\\.kimi\\bin\\kimi.exe`, `${LOCALAPPDATA}\\Programs\\kimi\\bin\\kimi.exe`],
  usePty: true,
  processHints: [],
  configCandidates: [`${USERPROFILE}\\.kimi-code\\config.toml`],

  async detect() {
    const configPath = firstExists(this.configCandidates)
    const binary = await commandExists(this.cli)
    return { installed: binary && !!configPath, exePath: null, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    return { ok: false, message: 'Kimi Code 为 CLI 工具，请在终端中启动' }
  },
  async configureModel({ model }) {
    return mergeTomlProvider(this.configPath(), { model })
  }
}

export default kimi_code
