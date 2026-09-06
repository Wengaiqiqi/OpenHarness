import { USERPROFILE, exists, firstExists, commandExists } from './base.js'
import { mergeTomlProvider } from './agent-config.js'

/** Grok Build：模型配置注入到 ~/.grok/config.toml（TOML） */
const grok_build = {
  id: 'grok-build',
  name: 'Grok Build',
  desc: 'xAI Grok 编码工具，支持模型配置注入',
  color: '#7f7f7f',
  icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/grok.svg',
  cli: 'grok',
  usePty: true,
  processHints: [],
  exeCandidates: [`${USERPROFILE}\\.grok\\bin\\grok.exe`],
  configCandidates: [`${USERPROFILE}\\.grok\\config.toml`],

  async detect() {
    const configPath = firstExists(this.configCandidates)
    const exe = firstExists(this.exeCandidates)
    // 命令自愈：~/.grok/bin 常常不在 PATH 里，detect 时把 cli 修正为完整路径
    if (!(await commandExists(this.cli)) && exe) {
      this.cli = exe
    }
    const binary = await commandExists(this.cli)
    return { installed: !!(binary || configPath), exePath: exe, configPath, canInjectMcp: false, canConfigureModel: true }
  },
  configPath() {
    return firstExists(this.configCandidates) || this.configCandidates[0]
  },
  async launch() {
    return { ok: false, message: 'Grok Build 为 CLI 工具，请在终端中启动' }
  },
  async configureModel({ models, model, token }) {
    return mergeTomlProvider(this.configPath(), { models, model, token })
  }
}

export default grok_build
