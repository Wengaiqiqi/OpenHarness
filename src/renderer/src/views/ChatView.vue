<script setup>
import { api } from '@/api'
import OhLogo from '@/components/OhLogo.vue'
import { ref, onMounted, onUnmounted, onActivated, onDeactivated, nextTick, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Promotion, Delete, VideoPause, EditPen } from '@element-plus/icons-vue'
import { useAppStore } from '@/store/app'

const appStore = useAppStore()
const sessions = ref([])
const activeId = ref(null)
const input = ref('')
const streaming = ref(false)
const streamingSessionId = ref(null)
const providers = ref([])
const providerId = ref('')
const model = ref('')
const thinkingLevel = ref('medium')
const stopping = ref(false)
const requestPending = ref(false)

const messagesEl = ref(null)
let unsubscribe = null
let persistTimer = null
let initialized = false

const suggestions = [
  '帮我写一段天马行空的文章',
  '写一个正则表达式，匹配 IPv4 地址',
  '把这段话翻译成英文：一切皆文件',
  '解释一下 MCP 协议的核心概念'
]

const thinkingOptions = [
  { value: 'off', label: '思考：关闭' },
  { value: 'low', label: '思考：低' },
  { value: 'medium', label: '思考：中' },
  { value: 'high', label: '思考：高' }
]

const activeSession = computed(() => sessions.value.find((s) => s.id === activeId.value))
const activeProvider = computed(() => providers.value.find((p) => p.id === providerId.value))

// 思考过程折叠状态（按消息下标，默认全部折叠）
const openReasonings = ref({})

function toggleReasoning(i) {
  openReasonings.value[i] = !openReasonings.value[i]
}

// 标题：流式中显示"思考中…"，完成后显示"已思考 (X 秒)"
function reasoningTitle(m, i) {
  const isThinking =
    streamingSessionId.value === activeSession.value?.id &&
    m.role === 'assistant' && !m.content && activeSession.value?.messages[i] === m
  if (isThinking) return '思考中…'
  return `已思考 (${reasoningSeconds(m)} 秒)`
}

// 优先用实测耗时（思考开始 → 首条回答），持久化恢复的消息按字数估算（约 30 字/秒）
function reasoningSeconds(m) {
  if (m.reasoningElapsed) return m.reasoningElapsed
  if (m.reasoningStartAt && m.reasoningEndAt) {
    return Math.max(1, Math.round((m.reasoningEndAt - m.reasoningStartAt) / 1000))
  }
  return Math.max(1, Math.round((m.reasoning || '').length / 30))
}

async function persist() {
  await api.dbSet('sessions', sessions.value)
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist().catch(() => {})
  }, 100)
}

function flushPersist() {
  clearTimeout(persistTimer)
  persistTimer = null
  return persist()
}

async function refreshProviders() {
  const next = (await api.providerGetAll()) || []
  providers.value = next
  const selected = next.find((p) => p.id === providerId.value) || next[0]
  providerId.value = selected?.id || ''
  if (!selected?.models?.includes(model.value)) model.value = selected?.models?.[0] || ''
}

async function load() {
  sessions.value = (await api.dbGet('sessions')) || []
  const settings = (await api.dbGet('settings')) || {}
  thinkingLevel.value = settings.thinkingLevel || 'medium'
  await refreshProviders()
}

function setThinkingLevel(v) {
  thinkingLevel.value = v
  api.patchSettings({ thinkingLevel: v })
}

function newSession() {
  const s = {
    id: `sess-${Date.now()}`,
    title: '新对话',
    providerId: providerId.value,
    model: model.value,
    messages: [],
    createdAt: Date.now()
  }
  sessions.value.unshift(s)
  activeId.value = s.id
  persist()
}

/** 双击标题就地重命名 */
function renameSession(s) {
  ElMessageBox.prompt('输入新标题', '重命名', {
    inputValue: s.title,
    confirmButtonText: '确定',
    cancelButtonText: '取消'
  }).then(({ value }) => {
    const t = (value || '').trim()
    if (t) {
      s.title = t
      persist()
    }
  }).catch(() => {})
}

function selectSession(s) {
  activeId.value = s.id
  if (s.providerId) {
    providerId.value = s.providerId
    model.value = s.model
  }
}

async function removeSession(s) {
  sessions.value = sessions.value.filter((x) => x.id !== s.id)
  if (activeId.value === s.id) activeId.value = sessions.value[0]?.id || null
  await persist()
}

async function send() {
  if (streaming.value || requestPending.value) return
  const text = input.value.trim()
  if (!text) return
  if (!activeProvider.value) {
    ElMessage.warning('请先在「模型服务」中添加 Provider')
    return
  }
  if (editingIndex.value !== null) cancelEdit()
  if (!activeSession.value) newSession()

  const s = activeSession.value
  s.providerId = providerId.value
  s.model = model.value
  // 标题自动取用户第一句话
  if (s.title === '新对话') s.title = text.slice(0, 20)
  s.messages.push({ role: 'user', content: text })
  s.messages.push({ role: 'assistant', content: '', reasoning: '' })
  input.value = ''
  startCompletion(s)
}

// 基于会话现有消息（最后一条为用户新输入）向上游发起补全
async function startCompletion(s) {
  if (streaming.value || requestPending.value) return
  streaming.value = true
  streamingSessionId.value = s.id
  stopping.value = false
  requestPending.value = true

  const requestProvider = providers.value.find((p) => p.id === s.providerId)
  const requestModel = s.model || model.value
  const payloadMessages = s.messages
    .filter((m) => m.role !== 'assistant' || m.content)
    .map((m) => ({ role: m.role, content: m.content }))

  try {
    await persist()
    if (stopping.value) {
      finishStreaming(s.id)
      const last = s.messages[s.messages.length - 1]
      if (last?.role === 'assistant' && !last.content && !last.reasoning) last.content = '（已停止）'
      await persist().catch(() => {})
      return
    }
    scrollToBottom()
    const res = await api.chatSend({
      sessionId: s.id,
      provider: requestProvider,
      model: requestModel,
      messages: payloadMessages,
      thinkingLevel: thinkingLevel.value
    })

    // 主进程直接拒绝（如未配置 Key）时此前是静默失败，这里显式呈现
    if (res && res.ok === false && finishStreaming(s.id)) {
      const last = s.messages[s.messages.length - 1]
      if (last?.role === 'assistant') last.content = `[错误] ${res.message}`
      await persist().catch(() => {})
    }
  } catch (err) {
    if (!finishStreaming(s.id)) return
    const last = s.messages[s.messages.length - 1]
    if (last?.role === 'assistant') last.content = `[错误] ${String(err)}`
    await persist().catch(() => {})
    ElMessage.error({ message: `发送失败：${String(err)}`, duration: 10000 })
  } finally {
    requestPending.value = false
  }
}

function finishStreaming(sessionId) {
  if (streamingSessionId.value !== sessionId) return false
  streaming.value = false
  streamingSessionId.value = null
  stopping.value = false
  return true
}

// 气泡原位编辑：撤回该消息之后的内容，编辑后从该消息重新发送
const editingIndex = ref(null)
const editingText = ref('')

function startEdit(idx) {
  const s = activeSession.value
  if (!s || streaming.value || requestPending.value) return
  const m = s.messages[idx]
  if (!m || m.role !== 'user') return
  editingIndex.value = idx
  editingText.value = m.content
}

function cancelEdit() {
  editingIndex.value = null
  editingText.value = ''
}

async function resendEdit() {
  if (streaming.value || requestPending.value) return
  const s = activeSession.value
  const idx = editingIndex.value
  if (!s || idx === null) return
  const text = editingText.value.trim()
  if (!text) return
  s.providerId = providerId.value
  s.model = model.value
  s.messages[idx].content = text
  s.messages.splice(idx + 1)
  // 补回 assistant 占位：流式 chunk 只会追加到最后一条 assistant 消息上
  s.messages.push({ role: 'assistant', content: '', reasoning: '' })
  cancelEdit()
  startCompletion(s)
}

async function stop() {
  // 停止"正在流式输出"的那个会话，而非当前选中的会话
  const sid = streamingSessionId.value || activeSession.value?.id
  if (!sid || stopping.value) return
  stopping.value = true
  try {
    await api.chatAbort(sid)
  } catch (err) {
    stopping.value = false
    ElMessage.error({ message: `停止失败：${String(err)}`, duration: 10000 })
  }
}

function useSuggestion(text) {
  input.value = text
}

async function scrollToBottom() {
  await nextTick()
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
}

function handleChunk(chunk) {
  const { sessionId, type, delta, message } = chunk
  if (sessionId !== streamingSessionId.value) return
  const s = sessions.value.find((x) => x.id === sessionId)
  if (!s) {
    if (type === 'error' || type === 'done') finishStreaming(sessionId)
    return
  }
  const last = s.messages[s.messages.length - 1]
  if (type === 'delta' && delta) {
    if (last?.role === 'assistant') {
      // 首条回答到达：关闭思考计时
      if (last.reasoning && !last.reasoningElapsed) {
        last.reasoningEndAt = Date.now()
        if (last.reasoningStartAt) {
          last.reasoningElapsed = Math.max(1, Math.round((last.reasoningEndAt - last.reasoningStartAt) / 1000))
        }
      }
      last.content += delta
      schedulePersist()
      scrollToBottom()
    }
  } else if (type === 'reasoning' && delta) {
    // GLM / DeepSeek 等思考型模型先输出 reasoning_content
    if (last?.role === 'assistant') {
      if (!last.reasoningStartAt) last.reasoningStartAt = Date.now()
      last.reasoning = (last.reasoning || '') + delta
      schedulePersist()
      scrollToBottom()
    }
  } else if (type === 'error') {
    if (last?.role === 'assistant' && !last.content) last.content = `[错误] ${message}`
    else s.messages.push({ role: 'assistant', content: `[错误] ${message}` })
    finishStreaming(sessionId)
    flushPersist()
  } else if (type === 'done') {
    finishStreaming(sessionId)
    if (last?.role === 'assistant') {
      if (last.reasoning && !last.reasoningEndAt) {
        last.reasoningEndAt = Date.now()
        if (last.reasoningStartAt) {
          last.reasoningElapsed = Math.max(1, Math.round((last.reasoningEndAt - last.reasoningStartAt) / 1000))
        }
      }
      if (!last.content && !last.reasoning) {
        // 中止且未收到任何内容时标记为已停止
        last.content = chunk.aborted ? '（已停止）' : '（空响应，请检查 Provider 与模型配置）'
      }
    }
    flushPersist()
  }
}

function handleBeforeUnload() {
  flushPersist()
}

onMounted(async () => {
  unsubscribe = api.onChatChunk(handleChunk)
  window.addEventListener('beforeunload', handleBeforeUnload)
  await load()
  initialized = true
})

onActivated(() => {
  if (initialized) refreshProviders()
})

onDeactivated(flushPersist)

onUnmounted(() => {
  unsubscribe?.()
  window.removeEventListener('beforeunload', handleBeforeUnload)
  flushPersist()
})
</script>

<template>
  <div class="chat-shell">
    <!-- 会话列表 -->
    <aside class="session-panel">
      <el-button type="primary" class="new-btn" :icon="Plus" @click="newSession">新对话</el-button>
      <div class="session-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === activeId }"
          @click="selectSession(s)"
        >
          <span class="session-title" title="双击可重命名" @dblclick.stop="renameSession(s)">{{ s.title }}</span>
          <el-icon class="session-del" @click.stop="removeSession(s)"><Delete /></el-icon>
        </div>
        <div v-if="!sessions.length" class="session-empty">暂无会话</div>
      </div>
    </aside>

    <!-- 对话主区 -->
    <div class="chat-main">
      <div class="chat-toolbar">
        <el-select v-model="providerId" placeholder="选择 Provider" style="width: 180px" size="default"
          @change="(v) => { model = providers.find((p) => p.id === v)?.models?.[0] || '' }">
          <el-option v-for="p in providers" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-select v-model="model" placeholder="选择模型" style="width: 240px">
          <el-option v-for="m in activeProvider?.models || []" :key="m" :label="m" :value="m" />
        </el-select>
        <el-select v-model="thinkingLevel" style="width: 130px" @change="setThinkingLevel">
          <el-option v-for="t in thinkingOptions" :key="t.value" :label="t.label" :value="t.value" />
        </el-select>
      </div>

      <div ref="messagesEl" class="messages">
        <div v-if="activeSession" class="messages-col">
          <div v-for="(m, i) in activeSession.messages" :key="i" class="msg" :class="m.role">
            <OhLogo v-if="m.role === 'assistant'" :size="30" class="msg-avatar assistant" />
            <div v-else class="msg-avatar user">你</div>
            <div class="msg-body">
              <div v-if="m.reasoning" class="msg-reasoning" :class="{ open: !!openReasonings[i] }">
                <button class="reasoning-head" type="button" @click="toggleReasoning(i)">
                  <span class="reasoning-label">{{ reasoningTitle(m, i) }}</span>
                  <el-icon class="chev" :size="12"><ArrowDown /></el-icon>
                </button>
                <div v-show="openReasonings[i]" class="reasoning-text">{{ m.reasoning }}</div>
              </div>
              <div v-if="m.role === 'user' && editingIndex === i" class="edit-box">
                <el-input
                  v-model="editingText"
                  type="textarea"
                  :rows="3"
                  resize="none"
                  @keydown.enter.exact.prevent="resendEdit"
                />
                <div class="edit-actions">
                  <el-button size="small" @click="cancelEdit">取消</el-button>
                  <el-button size="small" type="primary" :icon="Promotion" @click="resendEdit">发送</el-button>
                </div>
              </div>
              <template v-else>
                <div class="msg-content">{{ m.content }}<span
                    v-if="streamingSessionId === activeSession.id && m.role === 'assistant' && i === activeSession.messages.length - 1"
                    class="caret"
                  /></div>
                <div
                  v-if="m.role === 'user' && !streaming && editingIndex === null"
                  class="msg-actions"
                >
                  <el-button size="small" text :icon="EditPen" @click="startEdit(i)">编辑</el-button>
                </div>
              </template>
            </div>
          </div>
        </div>
        <div v-else class="welcome">
          <OhLogo :size="52" class="welcome-mark" />
          <h2 class="welcome-title">开始一段新对话</h2>
          <p class="welcome-sub">选择上方的 Provider 与模型，或从这些问题开始：</p>
          <div class="welcome-chips">
            <button v-for="q in suggestions" :key="q" class="chip" type="button" @click="useSuggestion(q)">
              {{ q }}
            </button>
          </div>
        </div>
      </div>

      <div class="input-area">
        <div class="input-col">
          <div class="input-box">
            <el-input
              v-model="input"
              type="textarea"
              :rows="3"
              resize="none"
              placeholder="输入消息…"
              @keydown.enter.exact.prevent="send"
            />
            <div class="input-foot">
              <span class="input-hint">Enter 发送 / Shift+Enter 换行</span>
              <el-button v-if="streaming" :icon="VideoPause" :loading="stopping" @click="stop">停止</el-button>
              <el-button v-else type="primary" :icon="Promotion" @click="send">发送</el-button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-shell {
  display: flex;
  height: 100%;
}

.session-panel {
  width: 112px;
  flex-shrink: 0;
  padding: 44px 6px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.new-btn {
  width: 100%;
}

.session-list {
  flex: 1;
  overflow-y: auto;
}

.session-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 28px 8px 8px;
  position: relative;
  border-radius: var(--oh-radius-sm);
  cursor: pointer;
  font-size: 12px;
  margin-bottom: 2px;
  color: var(--oh-text-2);
  transition: background var(--oh-dur) var(--oh-ease);

  &:hover {
    background: var(--oh-hover);
    color: var(--oh-text);
    .session-del {
      opacity: 1;
    }
  }

  &.active {
    background: var(--oh-active);
    color: var(--oh-primary);
    font-weight: 500;
  }
}

.session-title {
  width: 100%;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
  line-height: 1.4;
}

.session-del {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
  color: var(--oh-text-dim);
  transition: opacity 0.15s;

  &:hover {
    color: var(--oh-danger);
  }
}

.session-empty {
  text-align: center;
  color: var(--oh-text-dim);
  font-size: 13px;
  padding: 24px 0;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-toolbar {
  display: flex;
  gap: 10px;
  padding: 42px 24px 10px;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px 24px 20px;
}

.messages-col {
  max-width: 860px;
  margin: 0 auto;
}

.msg {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  animation: msg-in 0.28s var(--oh-ease);

  &.user {
    flex-direction: row-reverse;

    .msg-body {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }

    .msg-content {
      background: var(--oh-primary-soft);
      border: 1px solid var(--oh-border);
      padding: 10px 14px;
      border-radius: 12px;
      max-width: 80%;
    }
  }
}

@keyframes msg-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;

  &.assistant {
    background: var(--oh-primary);
    color: #fff;
  }

  &.user {
    background: var(--oh-bg-input);
    border: 1px solid var(--oh-border);
    color: var(--oh-text-2);
  }
}

.msg-body {
  flex: 1;
  min-width: 0;
  padding-top: 4px;
}

.msg-actions {
  margin-top: 6px;
  opacity: 0;
  transition: opacity var(--oh-dur) var(--oh-ease);

  .el-button {
    color: var(--oh-text-dim);
  }

  .el-button:hover {
    color: var(--oh-primary);
  }
}

.msg:hover .msg-actions {
  opacity: 1;
}

.msg.user .msg-actions {
  display: flex;
  justify-content: flex-end;
}

.edit-box {
  width: 100%;

  :deep(.el-textarea__inner) {
    background: var(--oh-primary-soft);
    border: 1px solid var(--oh-border);
    border-radius: 12px;
    padding: 10px 14px;
  }
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.msg-content {
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-reasoning {
  background: var(--oh-bg-input);
  border-radius: var(--oh-radius-sm);
  margin-bottom: 8px;
  overflow: hidden;
  /* 收紧为包裹标题内容的胶囊，展开时全文仍受宽度约束 */
  width: fit-content;
  max-width: 100%;
}

.reasoning-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  color: var(--oh-text-dim);
  transition: color var(--oh-dur) var(--oh-ease);

  &:hover {
    color: var(--oh-primary);
  }
}

.reasoning-label {
  font-weight: 600;
}

.reasoning-head .chev {
  transition: transform var(--oh-dur) var(--oh-ease);
}

.msg-reasoning.open .chev {
  transform: rotate(180deg);
}

.reasoning-text {
  padding: 0 12px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--oh-text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: currentColor;
  border-radius: 1px;
  animation: caret-blink 1s steps(2, start) infinite;
}

@keyframes caret-blink {
  to {
    visibility: hidden;
  }
}

.welcome {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
}

.welcome-mark {
  margin-bottom: 16px;
}

.welcome-title {
  margin: 0 0 6px;
  font-size: 18px;
  letter-spacing: -0.01em;
}

.welcome-sub {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--oh-text-dim);
}

.welcome-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: 520px;
}

.chip {
  padding: 7px 14px;
  font-size: 13px;
  font-family: inherit;
  color: var(--oh-text-2);
  background: var(--oh-bg-card);
  border: 1px solid var(--oh-border);
  border-radius: 999px;
  cursor: pointer;
  transition:
    border-color var(--oh-dur) var(--oh-ease),
    color var(--oh-dur) var(--oh-ease),
    background var(--oh-dur) var(--oh-ease);

  &:hover {
    border-color: var(--oh-primary);
    color: var(--oh-primary);
    background: var(--oh-primary-soft);
  }
}

.input-area {
  padding: 10px 24px 18px;
}

.input-col {
  max-width: 860px;
  margin: 0 auto;
}

.input-box {
  border: 1px solid var(--oh-border);
  border-radius: var(--oh-radius-lg);
  padding: 10px 12px 8px;
  background: var(--oh-bg-card);
  transition: border-color var(--oh-dur) var(--oh-ease);

  &:focus-within {
    border-color: var(--oh-primary);
  }

  :deep(.el-textarea__inner) {
    border: none;
    box-shadow: none;
    padding: 0;
    background: transparent;
  }
}

.input-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;

  .el-button + .el-button {
    margin-left: 0;
  }
}

.input-hint {
  font-size: 12px;
  color: var(--oh-text-dim);
}
</style>
