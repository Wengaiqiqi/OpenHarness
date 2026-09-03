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
const FLUSH_MS = 16
const FLUSH_LIMIT = 32 * 1024
const BUFFER_LIMIT = 512 * 1024
let send = () => {}
let activeId = null
let latestId = null

export function initPty(onEvent) { send = onEvent }

// 最新打开请求：只有仍是最新目标的 PTY 才能成为当前活动，过期请求不抢前台
export function setLatest(_sequence, id) {
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

export function closeAll() { for (const id of [...sessions.keys()]) close(id); activeId = null }
export function ids() { return [...sessions.keys()] }
export function status() { return activeId }
export function deactivate() { activeId = null }
