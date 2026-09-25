import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import MarkdownIt from 'markdown-it'

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

test('workspace unmount ignores late initial status and late activation completion', async () => {
  for (const phase of ['status', 'open']) {
    const hooks = {}
    let finish
    let opens = 0
    let resized = 0
    const pending = new Promise((resolve) => { finish = resolve })
    const context = {
      ...vueMock(hooks),
      useRoute: () => ({ query: { id: 'app' } }), useRouter: () => ({}),
      ElMessage: { error() {} }, TerminalView: null, iconFallback() {},
      SwitchButton: null, Position: null, Close: null, Monitor: null, Plus: null, Refresh: null,
      ResizeObserver: class { observe() {} disconnect() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
      api: {
        harnessList: async () => [{ id: 'app', installed: true }],
        embedStatus: () => phase === 'status' ? pending : Promise.resolve({ attached: [] }),
        embedOpen: () => { opens++; return pending },
        embedReposition: () => { resized++ }, embedHide() {}
      }
    }
    vm.createContext(context)
    vm.runInContext(compile('views/WorkspaceView.vue').replace(/^import .*$/gm, '').replace('export default', 'globalThis.component ='), context)
    const state = context.component.setup({}, { expose() {} })
    state.hostEl.value = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }
    const mounting = hooks.mounted()
    await new Promise(setImmediate)
    hooks.beforeUnmount()
    finish(phase === 'status' ? { attached: [] } : { ok: true })
    await mounting
    assert.equal(opens, phase === 'status' ? 0 : 1)
    assert.equal(resized, 0)
  }
})

test('external exit removes the tab and switches to a survivor; late status cannot erase a new activation', async () => {
  const context = {
    ...vueMock({}), useRoute: () => ({ query: {} }), useRouter: () => ({}),
    ElMessage: { error() {} }, TerminalView: null, iconFallback() {},
    SwitchButton: null, Position: null, Close: null, Monitor: null, Plus: null, Refresh: null,
    api: { embedStatus: async () => ({ attached: ['b'] }), embedOpen: async () => ({ ok: true, mode: 'pty' }) }
  }
  vm.createContext(context)
  vm.runInContext(compile('views/WorkspaceView.vue').replace(/^import .*$/gm, '').replace('export default', 'globalThis.component ='), context)
  const state = context.component.setup({}, { expose() {} })
  state.tabs.value = [{ id: 'a', mode: 'native', opened: true }, { id: 'b', mode: 'native', opened: true }]
  state.activeTabId.value = 'a'
  state.embedOk.value = true
  await state.syncStatus()
  assert.deepEqual(Array.from(state.tabs.value, (t) => t.id), ['b'])
  assert.equal(state.activeTabId.value, 'b')
  let finish
  context.api.embedStatus = () => new Promise((resolve) => { finish = resolve })
  const pending = state.syncStatus()
  await state.activateTab(state.tabs.value[0])
  finish({ attached: [] })
  await pending
  assert.equal(state.tabs.value.length, 1)
  context.api.embedStatus = async () => ({ attached: [] })
  await state.syncStatus()
  assert.equal(state.tabs.value.length, 0)
  assert.equal(state.activeTabId.value, null)
  assert.equal(state.embedOk.value, false)
})

function makeContext(source, globals) {
  const transformed = source
    .replace(/^import \{ api \} from '@\/api'\r?\n/m, 'const { api } = globalThis.mocks\n')
    .replace(/^import OhLogo from '@\/components\/OhLogo\.vue'\r?\n/m, 'const OhLogo = null\n')
    .replace(/^import MarkdownIt from 'markdown-it'\r?\n/m, 'const MarkdownIt = globalThis.MarkdownIt\n')
    .replace(/^import \{ ref, onMounted, onUnmounted, onActivated, onDeactivated, nextTick, computed \} from 'vue'\r?\n/m, 'const { ref, onMounted, onUnmounted, onActivated, onDeactivated, nextTick, computed } = globalThis.vue\n')
    .replace(/^import \{ onBeforeUnmount, onMounted, ref, watch \} from 'vue'\r?\n/m, 'const { onBeforeUnmount, onMounted, ref, watch } = globalThis.vue\n')
    .replace(/^import \{ ElMessage, ElMessageBox \} from 'element-plus'\r?\n/m, 'const { ElMessage, ElMessageBox } = globalThis.ui\n')
    .replace(/^import \{ Plus, Promotion, Delete, VideoPause, EditPen, CopyDocument, FullScreen \} from '@element-plus\/icons-vue'\r?\n/m, 'const { Plus, Promotion, Delete, VideoPause, EditPen, CopyDocument, FullScreen } = globalThis.icons\n')
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
    MarkdownIt,
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

async function setupChat(chatSend = async () => ({ ok: true }), chatProviders) {
  const hooks = {}
  let chunkHandler
  let dbWrites = 0
  let aborts = 0
  const abortIds = []
  const copied = []
  const providers = chatProviders || [{ id: 'p1', name: 'Provider', models: ['m1'], baseUrl: 'https://example.test', apiKey: 'key' }]
  const api = {
    dbGet: async (key) => key === 'sessions' ? [] : { thinkingLevel: 'medium' },
    dbSet: async () => { dbWrites++ },
    patchSettings: async () => {},
    providerGetAll: async () => providers,
    copyText: async (text) => { copied.push(text) },
    chatSend,
    chatAbort: async (id) => { aborts++; abortIds.push(id) },
    onChatChunk: (fn) => { chunkHandler = fn; return () => { chunkHandler = null } }
  }
  const context = makeContext(compile('views/ChatView.vue'), {
    mocks: { api, useAppStore: () => ({}) },
    vue: vueMock(hooks),
    ui: { ElMessage: { warning() {}, error() {}, success() {} }, ElMessageBox: { prompt: async () => ({ value: '' }) } },
    icons: { Plus: null, Promotion: null, Delete: null, VideoPause: null, EditPen: null, CopyDocument: null, FullScreen: null }
  })
  const state = context.component.setup({}, { expose() {} })
  await hooks.mounted()
  return { state, hooks, emit: (chunk) => chunkHandler?.(chunk), abortIds, copied, get dbWrites() { return dbWrites }, get aborts() { return aborts } }
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

test('compiled ChatView sends one prompt to six models and routes replies independently', async () => {
  const calls = []
  const providers = [
    { id: 'p1', name: 'First', models: ['m1', 'm2'], baseUrl: 'https://example.test', apiKey: 'key' },
    { id: 'p2', name: 'Second', models: ['m3', 'm4', 'm5', 'm6', 'm7'], baseUrl: 'https://example.test', apiKey: 'key' }
  ]
  const chat = await setupChat((payload) => new Promise((resolve) => calls.push({ payload, resolve })), providers)
  for (const [providerId, model] of [['p1', 'm2'], ['p2', 'm3'], ['p2', 'm4'], ['p2', 'm5'], ['p2', 'm6']]) {
    chat.state.toggleModel(providerId, model, true)
  }
  chat.state.toggleModel('p2', 'm7', true)
  assert.equal(chat.state.selectedModels.value.length, 6)

  chat.state.input.value = 'first'
  await chat.state.send()
  await new Promise(setImmediate)
  assert.equal(calls.length, 6)
  assert.equal(new Set(calls.map((call) => call.payload.requestId)).size, 6)
  assert.equal(new Set(calls.map((call) => call.payload.provider.id)).size, 2)
  const sid = calls[0].payload.sessionId
  for (const call of [...calls].reverse()) {
    call.resolve({ ok: true })
    await new Promise(setImmediate)
    chat.emit({ sessionId: sid, requestId: call.payload.requestId, type: 'delta', delta: call.payload.model })
    chat.emit({ sessionId: sid, requestId: call.payload.requestId, type: 'done' })
  }
  await new Promise(setImmediate)
  const replies = chat.state.sessions.value[0].messages.filter((m) => m.role === 'assistant')
  assert.equal(replies.length, 6)
  assert.ok(replies.every((reply) => reply.content === reply.model && reply.status === 'done'))

  chat.state.input.value = 'follow up'
  await chat.state.send()
  await new Promise(setImmediate)
  assert.equal(calls.length, 12)
  for (const call of calls.slice(6)) {
    assert.equal(call.payload.messages.length, 3)
    assert.equal(call.payload.messages[1].content, call.payload.model)
  }
  await chat.state.stop()
  assert.equal(chat.abortIds.length, 6)
  for (const call of calls.slice(6)) {
    chat.emit({ sessionId: sid, requestId: call.payload.requestId, type: 'done', aborted: true })
    call.resolve({ ok: true, aborted: true })
  }
  await new Promise(setImmediate)
  assert.equal(chat.state.requestPending.value, false)
})

test('reply actions copy source text and render safe Markdown in the expanded answer', async () => {
  const chat = await setupChat()
  const content = '# Title\n\n- item\n\n`code` [site](https://example.com) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>'
  const reply = { role: 'assistant', providerId: 'p1', model: 'm1', content }
  await chat.state.copyReply(reply)
  assert.deepEqual(chat.copied, [content])
  chat.state.expandReply(reply)
  assert.equal(chat.state.expandedReply.value, reply)
  assert.equal(chat.state.expandVisible.value, true)
  assert.match(chat.state.expandedHtml.value, /<h1>Title<\/h1>/)
  assert.match(chat.state.expandedHtml.value, /<li>item<\/li>/)
  assert.match(chat.state.expandedHtml.value, /<code>code<\/code>/)
  assert.match(chat.state.expandedHtml.value, /target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(chat.state.expandedHtml.value, /href="javascript:|<img\b/i)
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
