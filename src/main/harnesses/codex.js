import { APPDATA, USERPROFILE, exists, firstExists, launchExe } from './base'
import fs from 'node:fs'
import path from 'node:path'

/**
 * OpenAI Codex（CLI）：模型注入通过 ~/.codex/config.toml 指向本地代理
 *   model_provider = "openharness"
 *   [model_providers.openharness] base_url = http://127.0.0.1:18200/v1, wire_api = "chat"
 * 代理把 Codex 发出的 chat/completions 翻译到「模型服务」里的任意 Provider
 */
const codex = {
  id: 'codex',
  name: 'Codex',
  desc: 'OpenAI Codex CLI，支持模型配置注入',
  color: '#10a37f',
  icon: 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/openai.svg',
  cli: 'codex',
  processHints: ['codex'],
  exeCandidates: [`${USERPROFILE}\\.codex\\bin\\codex.exe`, `${APPDATA}\\npm\\codex.cmd`, `${USERPROFILE}\\AppData\\Roaming\\npm\\codex.cmd`],
  configCandidates: [`${USERPROFILE}\\.codex\\config.toml`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    // 命令自愈：不同环境装的是 codex 或 opencodex（npm 包名不同），
    // detect 在每次打开前都会跑，趁机把 cli 修正为真实可用的命令
    if (!(await commandExists(this.cli))) {
      for (const alt of ['codex', 'opencodex']) {
        if (alt !== this.cli && (await commandExists(alt))) {
          this.cli = alt
          break
        }
      }
    }
    return {
      installed: !!(exe || configPath || exists(`${USERPROFILE}\\.codex`)),
      exePath: exe,
      configPath,
      canInjectMcp: false,
      canConfigureModel: true
    }
  },
  configPath() {
    return firstExists(this.configCandidates) || path.join(`${USERPROFILE}\\.codex`, 'config.toml')
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Codex（可通过 npm i -g @openai/codex 安装）' }
    return launchExe(exe)
  },
  /** 模型注入：config.toml 的 model_provider 指向本地代理（wire_api=chat） */
  async configureModel({ model }) {
    const p = this.configPath()
    let toml = ''
    try { toml = fs.readFileSync(p, 'utf-8') } catch {}
    if (exists(p)) fs.copyFileSync(p, p + '.openharness.bak')

    // 移除旧的注入段（幂等），再写入新配置
    toml = toml.replace(/\[model_providers\.openharness\][\s\S]*?(?=\n\[|$)/g, '')
    toml = toml.replace(/^model_provider\s*=.*$/gm, '')
    toml = toml.replace(/^model\s*=.*$/gm, '')

    const inject =
      `model_provider = "openharness"\n` +
      (model ? `model = "${model}"\n` : '') +
      `\n[model_providers.openharness]\n` +
      `name = "OpenHarness"\n` +
      `base_url = "http://127.0.0.1:18200/v1"\n` +
      `wire_api = "chat"\n` +
      `env_key = "OPENHARNESS_API_KEY"\n`

    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, toml.trim() + '\n\n' + inject, 'utf-8')
    return { ok: true, path: p, model, note: '请设置环境变量 OPENHARNESS_API_KEY=openharness 后重启 Codex' }
  }
}

export default codex
