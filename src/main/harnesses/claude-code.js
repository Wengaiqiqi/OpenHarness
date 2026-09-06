import { APPDATA, USERPROFILE, exists, firstExists, injectMcpIntoFile, launchExe } from './base.js'
import path from 'node:path'
import { mergeClaudeCodeSettings } from './agent-config.js'

/**
 * Claude Code（CLI）：模型注入通过 ~/.claude/settings.json 的 env 指向本地代理
 *   ANTHROPIC_BASE_URL = http://127.0.0.1:18200
 *   ANTHROPIC_AUTH_TOKEN = <proxyToken>
 * 代理负责把 Anthropic 协议翻译到「模型服务」里的任意 Provider
 */
const claudeCode = {
  id: 'claude-code',
  name: 'Claude Code',
  desc: 'Anthropic 官方 CLI，支持模型配置注入',
  color: '#d97757',
  icon: 'icons/claude.svg',
  cli: 'claude',
  usePty: true,
  processHints: ['claude'],
  exeCandidates: [`${USERPROFILE}\\.local\\bin\\claude.exe`, `${APPDATA}\\npm\\claude.cmd`, `${USERPROFILE}\\AppData\\Roaming\\npm\\claude.cmd`],
  configCandidates: [`${USERPROFILE}\\.claude\\settings.json`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configPath = firstExists(this.settingsCandidates())
    return {
      installed: !!(exe || configPath || exists(`${USERPROFILE}\\.claude`)),
      exePath: exe,
      configPath,
      canInjectMcp: true,
      canConfigureModel: true
    }
  },
  settingsCandidates() {
    return process.env.CLAUDE_CONFIG_DIR
      ? [path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')]
      : this.configCandidates
  },
  configPath() {
    const candidates = this.settingsCandidates()
    return firstExists(candidates) || candidates[0]
  },
  mcpConfigPath() {
    return process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : path.join(USERPROFILE, '.claude.json')
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 Claude Code（可通过 npm i -g @anthropic-ai/claude-code 安装）' }
    return launchExe(exe)
  },
  async injectMcp(servers) {
    return injectMcpIntoFile(this.mcpConfigPath(), servers, 'mcpServers')
  },
  /** 模型注入：env 指向本地代理，代理翻译到已配置的 Provider */
  async configureModel({ models, model, token }) {
    return mergeClaudeCodeSettings(this.configPath(), { models, model, token })
  }
}

export default claudeCode
