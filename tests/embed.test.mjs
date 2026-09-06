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
