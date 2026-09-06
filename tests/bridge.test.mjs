import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'

const source = fs.readFileSync(new URL('../src/main/embed/win32-bridge.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace('export default bridge', 'globalThis.bridge = bridge')

function setup() {
  const processes = []
  const timers = []
  const context = {
    spawn() {
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {}
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {}
      proc.stdin = new EventEmitter(); proc.stdin.writable = true
      proc.writes = []; proc.stdin.write = (value) => proc.writes.push(value)
      proc.stdin.end = () => {}; proc.kill = () => { proc.killed = true }
      processes.push(proc)
      return proc
    },
    setTimeout(fn) { timers.push(fn); return timers.length }, clearTimeout() {}
  }
  vm.createContext(context); vm.runInContext(source, context)
  return { bridge: context.bridge, processes, timers }
}

test('late response after timeout cannot resolve the following request', async () => {
  const { bridge, processes, timers } = setup()
  const first = bridge.send('getstyle', 1)
  const second = bridge.send('pidof', 2)
  timers[0]()
  assert.equal(await first, 'err:timeout')
  processes[0].stdout.emit('data', '1|style:123\n')
  assert.equal(bridge.queue.size, 1)
  processes[0].stdout.emit('data', '2|pid:456\n')
  assert.equal(await second, 'pid:456')
})

test('old process exit and output cannot affect replacement process', async () => {
  const { bridge, processes } = setup()
  const first = bridge.send('getstyle', 1)
  bridge.dispose()
  assert.equal(await first, 'err:bridge-exited')
  const second = bridge.send('pidof', 2)
  processes[0].emit('exit')
  processes[0].stdout.emit('data', '2|pid:999\n')
  assert.equal(bridge.proc, processes[1])
  processes[1].stdout.emit('data', '2|pid:456\n')
  assert.equal(await second, 'pid:456')
})

test('fire uses a nonresponse ID; stdin failures drain waiting promises', async () => {
  const { bridge, processes } = setup()
  bridge.fire('move', 1, 0, 0, 800, 600)
  assert.match(processes[0].writes[0], /^0\|move\|/)
  const waiting = bridge.send('pidof', 1)
  processes[0].stdin.emit('error', new Error('mock broken pipe'))
  assert.equal(await waiting, 'err:bridge-exited')
  assert.equal(bridge.queue.size, 0)
})
