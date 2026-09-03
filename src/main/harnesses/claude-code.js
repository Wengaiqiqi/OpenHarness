import { APPDATA, USERPROFILE, exists, firstExists, readJson, launchExe } from './base'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Claude Code（CLI）：模型注入通过 ~/.claude/settings.json 的 env 指向本地代理
 *   ANTHROPIC_BASE_URL = http://127.0.0.1:18200
 *   ANTHROPIC_AUTH_TOKEN = openharness
 * 代理负责把 Anthropic 协议翻译到「模型服务」里的任意 Provider
 */
const claudeCode = {
  id: 'claude-code',
  name: 'Claude Code',
  desc: 'Anthropic 官方 CLI，支持模型配置注入',
  color: '#d97757',
  icon: 'https://cdn.simpleicons.org/claude/d97757',
  cli: 'claude',
  usePty: true,
  processHints: ['claude'],
  exeCandidates: [`${USERPROFILE}\\.local\\bin\\claude.exe`, `${APPDATA}\\npm\\claude.cmd`, `${USERPROFILE}\\AppData\\Roaming\\npm\\claude.cmd`],
  configCandidates: [`${USERPROFILE}\\.claude\\settings.json`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.configCandidates)
    return {
      installed: !!(exe || configPath || exists(`${USERPROFILE}\\.claude`)),
      exePath: exe,
      configPath,
      canInjectMcp: true,
      canConfigureModel: true
    }
  },
  configPath() {
    return firstExists(this.configCandidates) || path.join(`${USERPROFILE}\\.claude`, 'settings.json')
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Claude Code（可通过 npm i -g @anthropic-ai/claude-code 安装）' }
    return launchExe(exe)
  },
  /** 模型注入：env 指向本地代理，代理翻译到已配置的 Provider */
  async configureModel({ model, token = 'openharness' }) {
    const p = this.configPath()
    const cfg = readJson(p)
    cfg.env = { ...(cfg.env || {}), ANTHROPIC_BASE_URL: 'http://127.0.0.1:18200', ANTHROPIC_AUTH_TOKEN: token }
    if (model) cfg.model = model
    fs.mkdirSync(path.dirname(p), { recursive: true })
    if (exists(p)) fs.copyFileSync(p, p + '.openharness.bak')
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8')
    return { ok: true, path: p, model }
  }
}

export default claudeCode
