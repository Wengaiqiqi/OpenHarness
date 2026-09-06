import { APPDATA, LOCALAPPDATA, firstExists, launchExe } from './base.js'

/** CherryStudio：结构为 Electron store，不适合直接注入，仅检测 + 启动 */
const cherry = {
  id: 'cherrystudio',
  name: 'CherryStudio',
  desc: 'LLM 聚合客户端（本项目的对标参考），仅检测/启动',
  color: '#e8a33d',
  icon: 'icons/cherrystudio.png',
  processHints: ['Cherry Studio', 'CherryStudio'],
  exeCandidates: [`${LOCALAPPDATA}\\Programs\\CherryStudio\\Cherry Studio.exe`, `${LOCALAPPDATA}\\Programs\\cherry-studio\\Cherry Studio.exe`],
  configCandidates: [`${APPDATA}\\CherryStudio`],

  async detect() {
    const exe = firstExists(this.exeCandidates)
    const configDir = firstExists(this.configCandidates)
    return { installed: !!(exe || configDir), exePath: exe, configPath: configDir, canInjectMcp: false }
  },
  configPath() {
    return firstExists(this.configCandidates)
  },
  async launch() {
    const exe = firstExists(this.exeCandidates)
    if (!exe) return { ok: false, message: '未检测到 CherryStudio' }
    return launchExe(exe)
  },
  async injectMcp() {
    return { ok: false, message: 'CherryStudio 配置为 Electron store 格式，暂不支持直接注入' }
  }
}

export default cherry
