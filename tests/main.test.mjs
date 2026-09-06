import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

const routingSource = fs.readFileSync(new URL('../src/main/model-routing.js', import.meta.url), 'utf8')
const { buildModelRoutes } = await import('data:text/javascript;base64,' + Buffer.from(routingSource).toString('base64'))
const source = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')

function setup(saved = {}) {
  const data = { providers: [], modelConfigHistory: {}, ...saved }
  class Store {
    static initRenderer() {}
    constructor({ defaults }) { for (const [k, v] of Object.entries(defaults)) if (!(k in data)) data[k] = v }
    get(k) { return data[k] === undefined ? undefined : structuredClone(data[k]) }
    set(k, v) { if (typeof k === 'object') Object.assign(data, structuredClone(k)); else data[k] = structuredClone(v) }
  }
  const app = new EventEmitter()
  let quits = 0
  app.whenReady = () => new Promise(() => {})
  app.quit = () => { quits++ }
  const handles = new Map()
  const proxy = { routes: [], target: null, running: false,
    status() { return { running: this.running } },
    validateRoutes() {},
    setRoutes(routes) { this.routes = routes },
    setTarget(provider, model) { this.target = { provider, model } },
    async start() { this.running = true }, async stop() { this.running = false }
  }
  const adapter = { async configureModel() { return { ok: true, path: 'mock-config' } } }
  const embed = { hideAll() {}, async releaseAll() {}, disposeBridge() {} }
  const pty = { initPty() {}, closeAll() {} }
  const context = { Store, randomBytes, app, embed, pty, buildModelRoutes, console,
    process: { on() {}, env: {} },
    ipcMain: { handle: (name, fn) => handles.set(name, fn), on() {} },
    createChatService: () => ({}), createModelProxy: (options) => { proxy.options = options; return proxy },
    harnessRegistry: { get: () => adapter }, dialog: { showErrorBox() {} }
  }
  vm.createContext(context)
  vm.runInContext(source + ';globalThis.autoStartProxy = autoStartProxy', context)
  return { data, proxy, app, adapter, embed, context, call: (name, ...args) => handles.get(name)({}, ...args), quits: () => quits }
}
const providers = [{ id: 'a', name: 'A', apiKey: 'fake-a' }, { id: 'b', name: 'B', apiKey: 'fake-b' }]
const history = { agent: { items: [{ providerId: 'a', model: 'one' }, { providerId: 'b', model: 'two' }] } }

test('startup restores all selected routes with current credentials', async () => {
  const s = setup({ providers, modelConfigHistory: history, proxyTarget: { providerId: 'a', model: 'one' } })
  await s.context.autoStartProxy()
  assert.equal(s.proxy.routes.find((r) => r.model === 'two').provider.id, 'b')
  assert.match(s.proxy.options.token, /^[a-f0-9]{64}$/)
  s.call('provider:save', { ...providers[1], apiKey: 'rotated-fake' })
  assert.equal(s.proxy.routes.find((r) => r.model === 'two').provider.apiKey, 'rotated-fake')
  s.call('provider:remove', 'b')
  assert.equal(s.proxy.routes.some((r) => r.model === 'two'), false)
})

test('configuration failure leaves routing and saved selections intact', async () => {
  const s = setup({ providers, modelConfigHistory: history })
  await s.context.autoStartProxy()
  s.adapter.configureModel = async () => { throw new Error('mock write denied') }
  const result = await s.call('harness:configureModel', 'agent', { selection: [{ providerId: 'a', model: 'other' }] })
  assert.equal(result.ok, false)
  assert.equal(s.proxy.routes.some((r) => r.model === 'two'), true)
  assert.deepEqual(s.data.modelConfigHistory, history)
})

test('conflicting provider/model selection is rejected before writing config', async () => {
  const s = setup({ providers, modelConfigHistory: history })
  let writes = 0
  s.adapter.configureModel = async () => { writes++; return { ok: true } }
  const result = await s.call('harness:configureModel', 'second-agent', { selection: [{ providerId: 'b', model: 'one' }] })
  assert.equal(result.ok, false)
  assert.equal(writes, 0)
})

test('invalid proxy provider is rejected before the adapter can write', async () => {
  const s = setup({ providers })
  let writes = 0
  s.adapter.configureModel = async () => { writes++; return { ok: true } }
  s.proxy.validateRoutes = () => { throw new Error('mock invalid provider URL') }
  const result = await s.call('harness:configureModel', 'agent', { selection: [{ providerId: 'a', model: 'one' }] })
  assert.equal(result.ok, false)
  assert.equal(writes, 0)
  assert.equal(s.proxy.running, false)
})

test('settings patch preserves unrelated settings and rejects unknown fields', () => {
  const s = setup({ settings: { theme: 'dark', language: 'zh-CN', thinkingLevel: 'high' } })
  s.call('db:patchSettings', { theme: 'light' })
  assert.equal(s.data.settings.thinkingLevel, 'high')
  assert.equal(s.data.settings.language, 'zh-CN')
  assert.throws(() => s.call('db:patchSettings', { arbitrary: true }))
})

test('quit waits for external window release before terminating', async () => {
  const s = setup()
  let finish
  s.embed.releaseAll = () => new Promise((resolve) => { finish = resolve })
  let prevented = false
  s.app.emit('before-quit', { preventDefault() { prevented = true } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(prevented, true)
  assert.equal(s.quits(), 0)
  finish()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(s.quits(), 1)
})
