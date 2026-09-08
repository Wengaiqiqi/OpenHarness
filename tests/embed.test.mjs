import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/main/embed/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/export (async )?function /g, '$1function ')

test('closing an attached app restores it and requests WM_CLOSE without force-killing', async () => {
  const commands = []
  const context = {
    execFile() { throw new Error('must not kill a native application') }, promisify: (fn) => fn,
    bridge: {
      fire: (...args) => commands.push(args),
      send: async (...args) => { commands.push(args); return ({ style: 'style:1', setparent: 'old:1', close: 'close:True' })[args[0]] }
    },
    pty: { ids: () => [] }, clearInterval() {}, console
  }
  vm.createContext(context)
  vm.runInContext(source + `;attached.set('app', {hwnd:123,origStyle:0x80cf0000,lastRect:{x:0,y:0,width:800,height:600}});globalThis.closeApp=()=>closeAndKill('app');globalThis.getStatus=status`, context)
  await context.closeApp()
  assert.equal(commands.find((c) => c[0] === 'style')[2], -2133917696)
  assert.deepEqual(commands.filter((c) => c[0] === 'setparent' || c[0] === 'close'), [['setparent', 123, 0], ['close', 123]])
  assert.equal(context.getStatus().attached.length, 0)
})

test('reactivating an attached stale request does not show or move its window', async () => {
  const commands = []
  const context = { execFile() {}, promisify: (fn) => fn, bridge: { fire: (...args) => commands.push(args) } }
  vm.createContext(context)
  vm.runInContext(source + `;attached.set('old', {hwnd:123});setLatest('new');globalThis.open=embedApp`, context)
  const result = await context.open({ harnessId: 'old', initialRect: { x: 0, y: 0, width: 800, height: 600 } })
  assert.equal(result.ok, true)
  assert.deepEqual(commands, [])
})

test('a web startup timeout closes its silent host so retry can start a fresh process', async () => {
  let running = false
  let starts = 0
  let closes = 0
  const commands = []
  const context = {
    execFile() {}, promisify: (fn) => fn,
    bridge: { send: async (command) => commands.push(command) },
    pty: {
      openSilent() { assert.equal(running, false); running = true; starts++; return { ok: true } },
      closeSilent() { running = false; closes++ }
    }
  }
  vm.createContext(context)
  vm.runInContext(source + ';getFreePort=async()=>12345;waitForPort=async()=>false;globalThis.open=embedApp', context)
  for (let n = 0; n < 2; n++) {
    assert.equal((await context.open({ harnessId: 'web', cli: 'fake --port {port}', webPort: true })).ok, false)
  }
  assert.equal(starts, 2)
  assert.equal(closes, 2)
  assert.equal(commands.includes('killport'), false)
})
