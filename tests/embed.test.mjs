import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/main/embed/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/export (async )?function /g, '$1function ')

test('native attach sets child style before reparenting; resizing refreshes the hit region', async () => {
  const commands = []
  let rejectParent = false
  const context = {
    execFile() {}, promisify: (fn) => fn, clearInterval() {}, setInterval() { return 1 },
    bridge: { fire: (...args) => commands.push(args), send: async (...args) => {
      commands.push(args)
      return { getstyle: 'style:-2133917696', identity: 'process:99:12345', style: 'style:1', setparent: rejectParent ? 'err:denied' : 'old:0' }[args[0]]
    } }
  }
  vm.createContext(context)
  vm.runInContext(source + ';globalThis.mod={attachNative,activate,setClipRect,setLatest};globalThis.entry=()=>attached.get("app")', context)
  const mod = context.mod
  mod.setLatest('app')
  const options = { harnessId: 'app', hwnd: 123, parentHwnd: 456 }
  assert.equal((await mod.attachNative(options)).ok, true)
  const styled = commands.find((c) => c[0] === 'style')
  assert.ok(styled[2] & 0x40000000)
  assert.equal(styled[2] & 0x80000000, 0)
  assert.ok(commands.indexOf(styled) < commands.findIndex((c) => c[0] === 'setparent'))
  mod.activate('app', { x: 10, y: 20, width: 300, height: 200 })
  mod.setClipRect({ x: 10, y: 20, width: 900, height: 700 })
  assert.deepEqual(commands.filter((c) => c[0] === 'setrgn').at(-1), ['setrgn', 123, 0, 0, 900, 700])
  assert.equal(context.entry().lastRect.width, 900)
  assert.equal(commands.find((c) => c[0] === 'show')[2], 8)
  rejectParent = true
  assert.equal((await mod.attachNative({ ...options, harnessId: 'failed' })).ok, false)
  assert.deepEqual(commands.at(-1), ['style', 123, -2133917696])
})

test('shutdown remembers a cancelled close and retries; vanished windows do not block cleanup', async () => {
  let closes = 0
  const commands = []
  const context = {
    execFile() {}, promisify: (fn) => fn, clearInterval() {}, fs: { writeFileSync() {} }, path: { join: () => '' }, process: { env: {} },
    bridge: { fire() {}, send: async (...args) => {
      commands.push(args)
      if (args[0] === 'shutdown') return ++closes === 1 ? 'err:save pending' : 'shutdown:True'
      return { chk: 'chk:0:0:0' }[args[0]]
    } }
  }
  vm.createContext(context)
  vm.runInContext(source + `;attached.set('app',{hwnd:123,identity:'process:99:12345'});globalThis.shutdown=shutdownAll`, context)
  await assert.rejects(context.shutdown(), /save pending/)
  await context.shutdown()
  await context.shutdown()
  assert.equal(closes, 2)
  assert.deepEqual(commands.at(-1), ['shutdown', 123, '99', '12345'])
})

test('closing an attached app restores it and requests WM_CLOSE without force-killing', async () => {
  const commands = []
  const context = {
    execFile() { throw new Error('must not kill a native application') }, promisify: (fn) => fn,
    bridge: {
      fire: (...args) => commands.push(args),
      send: async (...args) => { commands.push(args); return ({ chk: 'chk:1:456:1', style: 'style:1', setparent: 'old:1', close: 'close:True' })[args[0]] }
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
  const context = { execFile() {}, promisify: (fn) => fn, bridge: { send: async () => 'chk:1:456:1', fire: (...args) => commands.push(args) } }
  vm.createContext(context)
  vm.runInContext(source + `;attached.set('old', {hwnd:123,parentHwnd:456});setLatest('new');globalThis.open=embedApp`, context)
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
