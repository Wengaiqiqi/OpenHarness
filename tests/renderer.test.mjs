import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'

function compile(file) {
  const source = fs.readFileSync(new URL(`../src/renderer/src/${file}`, import.meta.url), 'utf8')
  return compileScript(parse(source, { filename: file }).descriptor, { id: file }).content
}

function vueMock(hooks) {
  return {
    ref: (value) => ({ value }),
    computed: (get) => ({ get value() { return get() } }),
    nextTick: () => Promise.resolve(),
    onMounted: (fn) => { hooks.mounted = fn },
    onActivated: (fn) => { hooks.activated = fn },
    onDeactivated: (fn) => { hooks.deactivated = fn },
    onUnmounted: (fn) => { hooks.unmounted = fn },
    onBeforeUnmount: (fn) => { hooks.beforeUnmount = fn },
    watch: () => {}
  }
}

function makeContext(source, globals) {
  const transformed = source
    .replace(/^import \{ api \} from '@\/api'\r?\n/m, 'const { api } = globalThis.mocks\n')
    .replace(/^import OhLogo from '@\/components\/OhLogo\.vue'\r?\n/m, 'const OhLogo = null\n')
    .replace(/^import \{ ref, onMounted, onUnmounted, onActivated, onDeactivated, nextTick, computed \} from 'vue'\r?\n/m, 'const { ref, onMounted, onUnmounted, onActivated, onDeactivated, nextTick, computed } = globalThis.vue\n')
    .replace(/^import \{ onBeforeUnmount, onMounted, ref, watch \} from 'vue'\r?\n/m, 'const { onBeforeUnmount, onMounted, ref, watch } = globalThis.vue\n')
    .replace(/^import \{ ElMessage, ElMessageBox \} from 'element-plus'\r?\n/m, 'const { ElMessage, ElMessageBox } = globalThis.ui\n')
    .replace(/^import \{ Plus, Promotion, Delete, VideoPause, EditPen \} from '@element-plus\/icons-vue'\r?\n/m, 'const { Plus, Promotion, Delete, VideoPause, EditPen } = globalThis.icons\n')
    .replace(/^import \{ useAppStore \} from '@\/store\/app'\r?\n/m, 'const { useAppStore } = globalThis.mocks\n')
    .replace(/^import \{ Terminal \} from '@xterm\/xterm'\r?\n/m, 'const { Terminal } = globalThis.xterm\n')
    .replace(/^import \{ FitAddon \} from '@xterm\/addon-fit'\r?\n/m, 'const { FitAddon } = globalThis.xterm\n')
    .replace(/^import '@xterm\/xterm\/css\/xterm\.css'\r?\n/m, '')
    .replace('export default', 'globalThis.component =')
  const context = {
    ...globals,
    console,
    Promise,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => { setImmediate(fn); return 1 },
    cancelAnimationFrame: () => {},
    window: { addEventListener() {}, removeEventListener() {} },
    document: { documentElement: { classList: { toggle() {} } } }
  }
  vm.createContext(context)
  vm.runInContext(transformed, context)
  return context
}

async function setupChat(chatSend = async () => ({ ok: true })) {
  const hooks = {}
  let chunkHandler
  let dbWrites = 0
  let aborts = 0
  const providers = [{ id: 'p1', name: 'Provider', models: ['m1'], baseUrl: 'https://example.test', apiKey: 'key' }]
  const api = {
    dbGet: async (key) => key === 'sessions' ? [] : { thinkingLevel: 'medium' },
    dbSet: async () => { dbWrites++ },
    patchSettings: async () => {},
    providerGetAll: async () => providers,
    chatSend,
    chatAbort: async () => { aborts++ },
    onChatChunk: (fn) => { chunkHandler = fn; return () => { chunkHandler = null } }
  }
  const context = makeContext(compile('views/ChatView.vue'), {
    mocks: { api, useAppStore: () => ({}) },
    vue: vueMock(hooks),
    ui: { ElMessage: { warning() {}, error() {} }, ElMessageBox: { prompt: async () => ({ value: '' }) } },
    icons: { Plus: null, Promotion: null, Delete: null, VideoPause: null, EditPen: null }
  })
  const state = context.component.setup({}, { expose() {} })
  await hooks.mounted()
  return { state, hooks, emit: (chunk) => chunkHandler?.(chunk), get dbWrites() { return dbWrites }, get aborts() { return aborts } }
}

test('compiled ChatView guards double send and waits for old IPC completion after done', async () => {
  let resolveOld
  let calls = 0
  const chat = await setupChat(() => {
    calls++
    if (calls === 1) return new Promise((resolve) => { resolveOld = resolve })
    return Promise.resolve({ ok: true })
  })

  chat.state.input.value = 'first'
  await chat.state.send()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)

  chat.state.input.value = 'second'
  await chat.state.send()
  assert.equal(calls, 1)
  await chat.state.stop()
  assert.equal(chat.aborts, 1)

  const sid = chat.state.sessions.value[0].id
  chat.emit({ sessionId: sid, type: 'done', aborted: true })
  chat.state.input.value = 'third'
  await chat.state.send()
  assert.equal(calls, 1)

  resolveOld({ ok: true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(chat.state.requestPending.value, false)
  await chat.state.send()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
})

test('compiled ChatView keeps receiving deltas after deactivation and throttles persistence', async () => {
  let resolveSend
  const chat = await setupChat(() => new Promise((resolve) => { resolveSend = resolve }))
  chat.state.input.value = 'first'
  await chat.state.send()
  await new Promise((resolve) => setImmediate(resolve))
  const sid = chat.state.sessions.value[0].id
  const before = chat.dbWrites
  chat.hooks.deactivated()
  chat.emit({ sessionId: sid, type: 'delta', delta: 'still here' })
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(chat.state.sessions.value[0].messages.at(-1).content, 'still here')
  assert.ok(chat.dbWrites > before)
  chat.emit({ sessionId: sid, type: 'done' })
  resolveSend({ ok: true })
})

test('compiled TerminalView writes a live block once when the matching snapshot arrives while hidden', async () => {
  const hooks = {}
  let dataHandler
  let resolveBuffer
  const writes = []
  class FakeTerminal {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    write(data) { writes.push(data) }
    refresh() {}
    dispose() {}
  }
  class FakeResizeObserver { observe() {}; disconnect() {} }
  const api = {
    ptyBuffer: async () => new Promise((resolve) => { resolveBuffer = resolve }),
    onPtyData: (fn) => { dataHandler = fn; return () => { dataHandler = null } },
    onPtyExit: () => () => {},
    ptyResize() {},
    ptyInput() {}
  }
  const context = makeContext(compile('components/TerminalView.vue'), {
    mocks: { api },
    vue: vueMock(hooks),
    xterm: { Terminal: FakeTerminal, FitAddon: class { fit() {} } },
    ResizeObserver: FakeResizeObserver
  })
  context.component.setup({ id: 's1', visible: false }, { expose() {} })
  const mounted = hooks.mounted()
  dataHandler({ id: 's1', data: 'abc', startOffset: 0, endOffset: 3 })
  resolveBuffer({ data: 'abc', startOffset: 0, endOffset: 3, truncated: false })
  await mounted
  await new Promise((resolve) => setImmediate(resolve))
  dataHandler({ id: 's1', data: 'def', startOffset: 3, endOffset: 6 })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(writes, ['abc', 'def'])
})
