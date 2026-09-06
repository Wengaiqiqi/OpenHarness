import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const original = fs.readFileSync(new URL('../src/main/pty.js', import.meta.url), 'utf8')
  .replace("import os from 'node:os'", 'const os = globalThis.os')
  .replace("import path from 'node:path'", 'const path = globalThis.path')
  .replace("import { execFile as rawExecFile } from 'node:child_process'", 'const rawExecFile = globalThis.rawExecFile')
  .replace("import { promisify } from 'node:util'", 'const promisify = globalThis.promisify')
  .replace("import * as pty from 'node-pty'", 'const pty = globalThis.pty')
  .replace(/export function /g, 'function ')

function setup() {
  const sessions = []
  class FakeSession {
    onData(fn) { this.data = fn }
    onExit(fn) { this.exit = fn }
    emitData(data) { this.data?.(data) }
    emitExit(exitCode = 0) { this.exit?.({ exitCode }) }
    kill() { this.killed = true }
    write(data) { this.input = data }
    resize(cols, rows) { this.size = [cols, rows] }
  }
  const context = {
    console,
    process: { env: {} },
    os: { homedir: () => 'C:\\Users\\test' },
    path: {},
    rawExecFile: () => {},
    promisify: (fn) => fn,
    pty: { spawn: () => { const session = new FakeSession(); sessions.push(session); return session } },
    setTimeout,
    clearTimeout,
    Math,
    Number
  }
  vm.createContext(context)
  vm.runInContext(`${original}; globalThis.mod = { initPty, setLatest, open, readBuffer, close }`, context)
  const events = []
  context.mod.initPty((channel, payload) => events.push({ channel, payload }))
  return { mod: context.mod, sessions, events }
}

const plain = (value) => JSON.parse(JSON.stringify(value))

test('a full 32 KiB block is emitted and addressable without consuming the buffer', () => {
  const { mod, sessions, events } = setup()
  mod.setLatest('s1')
  mod.open('s1', 'demo')
  const data = 'x'.repeat(32 * 1024)
  sessions[0].emitData(data)

  assert.deepEqual(plain(events[0]), { channel: 'pty:data', payload: {
    id: 's1', data, startOffset: 0, endOffset: data.length
  } })
  assert.deepEqual(plain(mod.readBuffer('s1', 0)), {
    data, startOffset: 0, endOffset: data.length, truncated: false
  })
  assert.deepEqual(plain(mod.readBuffer('s1', data.length)), {
    data: '', startOffset: data.length, endOffset: data.length, truncated: false
  })
  mod.close('s1')
})

test('late output and exit from an old same-id session cannot clear its replacement', () => {
  const { mod, sessions, events } = setup()
  mod.setLatest('s1')
  mod.open('s1', 'old')
  const old = sessions[0]
  mod.close('s1')
  mod.open('s1', 'new')
  old.emitData('stale')
  old.emitExit(99)

  assert.equal(events.length, 0)
  assert.deepEqual(plain(mod.readBuffer('s1', 0)), {
    data: '', startOffset: 0, endOffset: 0, truncated: false
  })
  mod.close('s1')
})
