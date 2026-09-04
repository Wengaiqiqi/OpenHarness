import os from 'node:os'
import path from 'node:path'
import { execFile as rawExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as pty from 'node-pty'

const execFile = promisify(rawExecFile)

const sessions = new Map()
const buffers = new Map()
const pending = new Map()
const timers = new Map()
// 隐藏宿主（web 型 harness）：ConPTY 起服务，不上 UI、不参与激活；关闭标签时 kill
const silentHosts = new Map()
const FLUSH_MS = 16
const FLUSH_LIMIT = 32 * 1024
const BUFFER_LIMIT = 512 * 1024
let send = () => {}
let activeId = null
let latestId = null

export function initPty(onEvent) { send = onEvent }

// 最新打开请求：只有仍是最新目标的 PTY 才能成为当前活动，过期请求不抢前台
export function setLatest(id) {
  latestId = id
}

function isLatest(id) {
  return id === latestId
}

function commandFor(command) {
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `call ${command}`]
  }
}

function flush(id) {
  const data = pending.get(id) || ''
  pending.set(id, '')
  timers.delete(id)
  if (data) send('pty:data', { id, data })
}

function queueOutput(id, data) {
  const buffer = (buffers.get(id) || '') + data
  buffers.set(id, buffer.length > BUFFER_LIMIT ? buffer.slice(-BUFFER_LIMIT) : buffer)
  const queued = (pending.get(id) || '') + data
  if (queued.length >= FLUSH_LIMIT) {
    if (timers.has(id)) clearTimeout(timers.get(id))
    flush(id)
    return
  }
  pending.set(id, queued)
  if (!timers.has(id)) timers.set(id, setTimeout(() => flush(id), FLUSH_MS))
}

function clearSessionState(id) {
  if (timers.has(id)) clearTimeout(timers.get(id))
  timers.delete(id)
  pending.delete(id)
  buffers.delete(id)
}

export function open(id, exe, cols = 80, rows = 24) {
  if (isLatest(id)) activeId = id
  if (sessions.has(id)) return { ok: true, mode: 'pty', reactivated: true }
  const cmd = commandFor(exe)
  const env = { ...process.env, FORCE_COLOR: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' }
  const session = pty.spawn(cmd.file, cmd.args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env })
  sessions.set(id, session)
  buffers.set(id, '')
  pending.set(id, '')
  session.onData((data) => queueOutput(id, data))
  session.onExit(({ exitCode }) => {
    flush(id)
    sessions.delete(id)
    clearSessionState(id)
    send('pty:exit', { id, exitCode })
  })
  return { ok: true, mode: 'pty' }
}

/**
 * 隐藏宿主（web 型 harness）：用 ConPTY 起命令但不上 UI、不参与激活。
 * dsh 等会自行拉起新控制台窗口的 CLI，CREATE_NO_WINDOW 拦不住其孙进程；
 * ConPTY 给命令一个虚拟伪终端，任何子进程都渲染进虚拟终端，全程无真实窗口。
 * 进程靠 session.kill() 清理（关闭标签时由 pty.closeSilent 调用）。
 */
export function openSilent(id, command) {
  if (silentHosts.has(id)) return { ok: true, mode: 'silent', reactivated: true }
  try {
    const cmd = commandFor(command)
    const env = { ...process.env, FORCE_COLOR: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' }
    const session = pty.spawn(cmd.file, cmd.args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env })
    session.onData(() => {}) // 输出丢弃
    session.onExit(() => silentHosts.delete(id))
    silentHosts.set(id, session)
    return { ok: true, mode: 'silent', pid: session.pid }
  } catch (err) {
    return { ok: false, message: String(err) }
  }
}

export function closeSilent(id) {
  const session = silentHosts.get(id)
  if (!session) return
  silentHosts.delete(id)
  const pid = session.pid
  session.kill()
  if (pid) execFile('taskkill', ['/T', '/F', '/PID', String(pid)]).catch(() => {})
}
export function silentIds() { return [...silentHosts.keys()] }

export function input(id, data) { sessions.get(id)?.write(data) }
export function resize(id, cols, rows) { sessions.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)) }
export function readBuffer(id) {
  const data = buffers.get(id) || ''
  buffers.set(id, '')
  return data
}

export function close(id) {
  const session = sessions.get(id)
  if (!session) return
  const pid = session.pid
  session.kill()
  flush(id)
  sessions.delete(id)
  clearSessionState(id)
  if (activeId === id) activeId = null
  if (latestId === id) latestId = null
  if (pid) execFile('taskkill', ['/T', '/F', '/PID', String(pid)]).catch(() => {})
}

export function closeAll() { for (const id of [...sessions.keys()]) close(id); for (const id of [...silentHosts.keys()]) closeSilent(id); activeId = null }
export function ids() { return [...sessions.keys()] }
export function status() { return activeId }
export function deactivate() { activeId = null }
