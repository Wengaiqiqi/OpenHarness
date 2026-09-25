<script setup>
import { api } from '@/api'
import OhLogo from '@/components/OhLogo.vue'
import MarkdownIt from 'markdown-it'
import { ref, onMounted, onUnmounted, onActivated, onDeactivated, nextTick, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Promotion, Delete, VideoPause, EditPen, CopyDocument, FullScreen } from '@element-plus/icons-vue'
import { useAppStore } from '@/store/app'

const appStore = useAppStore()
const MAX_MODELS = 6
const markdown = new MarkdownIt({ html: false, breaks: true }).disable('image')
markdown.validateLink = (url) => /^https?:\/\//i.test(url)
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}
const sessions = ref([])
const activeId = ref(null)
const input = ref('')
const streaming = ref(false)
const streamingSessionId = ref(null)
const providers = ref([])
const thinkingLevel = ref('medium')
const stopping = ref(false)
const requestPending = ref(false)
const selectedModels = ref([])
const modelSearch = ref('')
const modelPickerOpen = ref(false)
const expandedReply = ref(null)
const expandVisible = ref(false)
const activeRequestIds = new Set()

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
const expandedHtml = computed(() => markdown.render(expandedReply.value?.content || '正在等待模型回答…'))
const availableModels = computed(() => providers.value.map((provider) => ({
  ...provider,
  visibleModels: (provider.models || []).filter((name) =>
    `${provider.name} ${name}`.toLowerCase().includes(modelSearch.value.trim().toLowerCase()))
})).filter((provider) => provider.visibleModels.length))
const activeTurns = computed(() => {
  const turns = []
  for (const [index, message] of (activeSession.value?.messages || []).entries()) {
    if (message.role === 'user') turns.push({ user: message, userIndex: index, replies: [] })
    else if (turns.length) turns[turns.length - 1].replies.push(message)
  }
  return turns
})

function modelKey(item) {
  return `${item.providerId}\u0000${item.model}`
}

function sessionModels(s) {
  return s.selectedModels?.length ? s.selectedModels :
    s.providerId && s.model ? [{ providerId: s.providerId, model: s.model }] : []
}

function validModels(models) {
  return models.filter((item) => providers.value.some((p) =>
    p.id === item.providerId && p.models?.includes(item.model))).slice(0, MAX_MODELS)
}

function isSelected(providerId, model) {
  return selectedModels.value.some((item) => item.providerId === providerId && item.model === model)
}

function toggleModel(providerId, model, checked) {
  if (streaming.value || requestPending.value) return
  const next = selectedModels.value.filter((item) => modelKey(item) !== modelKey({ providerId, model }))
  if (checked) {
    if (next.length >= MAX_MODELS) {
      ElMessage.warning(`最多选择 ${MAX_MODELS} 个模型`)
      return
    }
    next.push({ providerId, model })
  }
  selectedModels.value = next
  if (activeSession.value) {
    activeSession.value.selectedModels = next
    schedulePersist()
  }
}

function providerName(providerId) {
  return providers.value.find((p) => p.id === providerId)?.name || providerId || '模型'
}

async function copyReply(reply) {
  if (!reply.content) return
  try {
    await api.copyText(reply.content)
    ElMessage.success('已复制回答')
  } catch (err) {
    ElMessage.error(`复制失败：${String(err)}`)
  }
}

function expandReply(reply) {
  expandedReply.value = reply
  expandVisible.value = true
}

// 思考过程折叠状态（按消息下标，默认全部折叠）
const openReasonings = ref({})

function toggleReasoning(i) {
  openReasonings.value[i] = !openReasonings.value[i]
}

// 标题：流式中显示"思考中…"，完成后显示"已思考 (X 秒)"
function reasoningTitle(m) {
  const isThinking = ['pending', 'streaming'].includes(m.status) && !m.content
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
  selectedModels.value = validModels(selectedModels.value)
  if (!selectedModels.value.length && next[0]?.models?.length) {
    selectedModels.value = [{ providerId: next[0].id, model: next[0].models[0] }]
  }
}

async function load() {
  sessions.value = (await api.dbGet('sessions')) || []
  let recovered = false
  for (const session of sessions.value) {
    for (const message of session.messages || []) {
      if (['pending', 'streaming'].includes(message.status)) {
        message.status = 'stopped'
        if (!message.content) message.content = '（已中断）'
        recovered = true
      }
    }
  }
  if (recovered) await persist()
  const settings = (await api.dbGet('settings')) || {}
  thinkingLevel.value = settings.thinkingLevel || 'medium'
  await refreshProviders()
}

function setThinkingLevel(v) {
  thinkingLevel.value = v
  api.patchSettings({ thinkingLevel: v })
}

function newSession() {
  expandVisible.value = false
  const s = {
    id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: '新对话',
    selectedModels: [...selectedModels.value],
    messages: [],
    createdAt: Date.now()
  }
  sessions.value.unshift(s)
  activeId.value = s.id
  persist()
  return s
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
  expandVisible.value = false
  activeId.value = s.id
  selectedModels.value = validModels(sessionModels(s))
  if (!selectedModels.value.length && providers.value[0]?.models?.length) {
    selectedModels.value = [{ providerId: providers.value[0].id, model: providers.value[0].models[0] }]
  }
}

async function removeSession(s) {
  if (streamingSessionId.value === s.id) await stop()
  sessions.value = sessions.value.filter((x) => x.id !== s.id)
  if (activeId.value === s.id) activeId.value = sessions.value[0]?.id || null
  await persist()
}

async function send() {
  if (streaming.value || requestPending.value) return
  const text = input.value.trim()
  if (!text) return
  const models = validModels(selectedModels.value)
  if (!models.length) {
    ElMessage.warning('请先选择至少一个模型')
    return
  }
  if (editingIndex.value !== null) cancelEdit()
  modelPickerOpen.value = false
  if (!activeSession.value) newSession()

  const s = activeSession.value
  s.selectedModels = [...models]
  // 标题自动取用户第一句话
  if (s.title === '新对话') s.title = text.slice(0, 20)
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  s.messages.push({ role: 'user', content: text, turnId })
  const replies = addReplies(s, models, turnId)
  input.value = ''
  startCompletion(s, replies)
}

function addReplies(s, models, turnId) {
  return models.map((item, index) => {
    const reply = {
      role: 'assistant', providerId: item.providerId, model: item.model, turnId,
      requestId: `${s.id}:${turnId}:${index}`, content: '', reasoning: '', status: 'pending'
    }
    s.messages.push(reply)
    return reply
  })
}

function historyFor(s, reply) {
  return s.messages.filter((m) => m.role === 'user' || (
    m.role === 'assistant' && m !== reply && m.content && (!m.status || m.status === 'done') &&
    !m.content.startsWith('[错误]') &&
    (m.providerId || s.providerId) === reply.providerId &&
    (m.model || s.model) === reply.model
  )).map((m) => ({ role: m.role, content: m.content }))
}

function finishRequest(s, reply) {
  activeRequestIds.delete(reply.requestId)
  if (!activeRequestIds.size) finishStreaming(s.id)
}

async function startCompletion(s, replies) {
  if (streaming.value || requestPending.value) return
  streaming.value = true
  streamingSessionId.value = s.id
  stopping.value = false
  requestPending.value = true
  for (const reply of replies) activeRequestIds.add(reply.requestId)

  try {
    await persist()
    if (stopping.value) {
      for (const reply of replies) {
        reply.status = 'stopped'
        reply.content = '（已停止）'
        finishRequest(s, reply)
      }
      await persist().catch(() => {})
      return
    }
    scrollToLatestTurn()
    await Promise.all(replies.map(async (reply) => {
      try {
        const res = await api.chatSend({
          sessionId: s.id,
          requestId: reply.requestId,
          provider: providers.value.find((p) => p.id === reply.providerId),
          model: reply.model,
          messages: historyFor(s, reply),
          thinkingLevel: thinkingLevel.value
        })
        if ((!res || res.ok === false) && !['error', 'stopped'].includes(reply.status)) {
          reply.status = 'error'
          const message = res?.message || '请求未完成'
          reply.content = reply.content ? `${reply.content}\n[错误] ${message}` : `[错误] ${message}`
        }
        // IPC 返回和流式事件来自不同通道；成功时由该请求的 done 事件收尾。
        if (!res || res.ok === false) finishRequest(s, reply)
      } catch (err) {
        reply.status = 'error'
        reply.content = `[错误] ${String(err)}`
        finishRequest(s, reply)
      } finally {
        schedulePersist()
      }
    }))
  } catch (err) {
    for (const reply of replies) {
      reply.status = 'error'
      reply.content = `[错误] ${String(err)}`
      finishRequest(s, reply)
    }
    ElMessage.error({ message: `发送失败：${String(err)}`, duration: 10000 })
  } finally {
    requestPending.value = false
    schedulePersist()
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
  const models = validModels(selectedModels.value)
  if (!models.length) {
    ElMessage.warning('请先选择至少一个模型')
    return
  }
  s.selectedModels = [...models]
  modelPickerOpen.value = false
  s.messages[idx].content = text
  s.messages.splice(idx + 1)
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  s.messages[idx].turnId = turnId
  const replies = addReplies(s, models, turnId)
  cancelEdit()
  startCompletion(s, replies)
}

async function stop() {
  if (!activeRequestIds.size || stopping.value) return
  stopping.value = true
  try {
    await Promise.all([...activeRequestIds].map((id) => api.chatAbort(id)))
  } catch (err) {
    stopping.value = false
    ElMessage.error({ message: `停止失败：${String(err)}`, duration: 10000 })
  }
}

function useSuggestion(text) {
  input.value = text
}

async function scrollToLatestTurn() {
  await nextTick()
  const container = messagesEl.value
  const turn = container?.querySelector('.chat-turn:last-child')
  if (turn) container.scrollTop += turn.getBoundingClientRect().top - container.getBoundingClientRect().top
}

async function scrollReply(requestId) {
  await nextTick()
  const el = [...(messagesEl.value?.querySelectorAll('.answer-scroll') || [])]
    .find((node) => node.dataset.requestId === requestId)
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
}

function handleChunk(chunk) {
  const { sessionId, requestId, type, delta, message } = chunk
  if (sessionId !== streamingSessionId.value) return
  const s = sessions.value.find((x) => x.id === sessionId)
  if (!s) return
  const reply = requestId ? s.messages.find((m) => m.requestId === requestId) :
    s.messages[s.messages.length - 1]
  if (!reply || !activeRequestIds.has(reply.requestId)) return
  if (type === 'delta' && delta) {
    if (reply.role === 'assistant') {
      if (reply.reasoning && !reply.reasoningElapsed) {
        reply.reasoningEndAt = Date.now()
        if (reply.reasoningStartAt) {
          reply.reasoningElapsed = Math.max(1, Math.round((reply.reasoningEndAt - reply.reasoningStartAt) / 1000))
        }
      }
      reply.status = 'streaming'
      reply.content += delta
      schedulePersist()
      scrollReply(reply.requestId)
    }
  } else if (type === 'reasoning' && delta) {
    if (reply.role === 'assistant') {
      if (!reply.reasoningStartAt) reply.reasoningStartAt = Date.now()
      reply.status = 'streaming'
      reply.reasoning = (reply.reasoning || '') + delta
      schedulePersist()
    }
  } else if (type === 'error') {
    reply.status = 'error'
    reply.content = reply.content ? `${reply.content}\n[错误] ${message}` : `[错误] ${message}`
    finishRequest(s, reply)
    flushPersist()
  } else if (type === 'done') {
    if (reply.role === 'assistant') {
      if (reply.reasoning && !reply.reasoningEndAt) {
        reply.reasoningEndAt = Date.now()
        if (reply.reasoningStartAt) {
          reply.reasoningElapsed = Math.max(1, Math.round((reply.reasoningEndAt - reply.reasoningStartAt) / 1000))
        }
      }
      reply.status = chunk.aborted ? 'stopped' : 'done'
      if (!reply.content) {
        reply.content = chunk.aborted ? '（已停止）' : '（空响应，请检查 Provider 与模型配置）'
      }
    }
    finishRequest(s, reply)
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

onDeactivated(() => {
  modelPickerOpen.value = false
  expandVisible.value = false
  flushPersist()
})

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
        <el-popover v-model:visible="modelPickerOpen" placement="bottom-start" :width="400" trigger="click" popper-class="model-picker-popper">
          <template #reference>
            <button class="model-selector" type="button" :disabled="streaming || requestPending" :aria-label="`选择模型，最多 ${MAX_MODELS} 个`">
              <span class="selector-label">选择模型</span>
              <span class="selected-models">
                <span v-for="item in selectedModels" :key="modelKey(item)" class="selected-model-chip" :title="`${providerName(item.providerId)} · ${item.model}`">{{ item.model }}</span>
                <span v-if="!selectedModels.length" class="selector-placeholder">请选择模型</span>
              </span>
              <span class="model-count">已选 {{ selectedModels.length }}/{{ MAX_MODELS }}</span>
            </button>
          </template>
          <div class="model-picker">
            <el-input v-model="modelSearch" placeholder="搜索 Provider 或模型" clearable aria-label="搜索模型" />
            <div class="model-picker-list">
              <div v-for="group in availableModels" :key="group.id" class="model-group">
                <div class="model-group-name">{{ group.name }}</div>
                <el-checkbox v-for="name in group.visibleModels" :key="name"
                  :model-value="isSelected(group.id, name)"
                  :disabled="(streaming || requestPending) || (!isSelected(group.id, name) && selectedModels.length >= MAX_MODELS)"
                  @change="(checked) => toggleModel(group.id, name, checked)">{{ name }}</el-checkbox>
              </div>
              <div v-if="!availableModels.length" class="picker-empty">没有匹配的模型，请先到「模型服务」配置</div>
            </div>
            <div class="picker-foot">滚动查看更多 · 最多选择 {{ MAX_MODELS }} 个模型</div>
          </div>
        </el-popover>
        <el-select v-model="thinkingLevel" class="thinking-select" @change="setThinkingLevel">
          <el-option v-for="t in thinkingOptions" :key="t.value" :label="t.label" :value="t.value" />
        </el-select>
      </div>

      <div ref="messagesEl" class="messages">
        <div v-if="activeTurns.length" class="messages-col">
          <div v-for="(turn, turnIndex) in activeTurns" :key="turn.user.turnId || turnIndex" class="chat-turn">
            <div class="turn-user">
              <div class="msg-avatar user">你</div>
              <div class="user-content">
                <div v-if="editingIndex === turn.userIndex" class="edit-box">
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
                  <div class="user-bubble">{{ turn.user.content }}</div>
                  <div v-if="!streaming && editingIndex === null" class="msg-actions">
                    <el-button size="small" text :icon="EditPen" @click="startEdit(turn.userIndex)">编辑</el-button>
                  </div>
                </template>
              </div>
            </div>
            <div class="answer-grid">
              <article v-for="(reply, replyIndex) in turn.replies" :key="reply.requestId || replyIndex" class="answer-card">
                <div class="answer-head">
                  <span class="answer-avatar">AI</span>
                  <div class="answer-identity">
                    <strong :title="reply.model || activeSession.model">{{ reply.model || activeSession.model || '模型回答' }}</strong>
                    <span>{{ providerName(reply.providerId || activeSession.providerId) }}</span>
                  </div>
                  <div class="answer-actions">
                    <button class="answer-action" type="button" title="复制回答" :aria-label="`复制 ${reply.model || '模型'} 的回答`" :disabled="!reply.content" @click="copyReply(reply)">
                      <el-icon :size="15"><CopyDocument /></el-icon>
                    </button>
                    <button class="answer-action" type="button" title="展开回答" :aria-label="`展开 ${reply.model || '模型'} 的回答`" @click="expandReply(reply)">
                      <el-icon :size="15"><FullScreen /></el-icon>
                    </button>
                  </div>
                </div>
                <div class="answer-status" :class="reply.status || 'done'">
                  {{ reply.status === 'pending' ? '等待回答' : reply.status === 'streaming' ? '回答中' : reply.status === 'error' ? '回答失败' : reply.status === 'stopped' ? '已停止' : '回答完成' }}
                </div>
                <div class="answer-scroll" tabindex="0" :data-request-id="reply.requestId" :aria-label="`${reply.model || activeSession.model || '模型'}的回答，可滚动查看`">
                  <div v-if="reply.reasoning" class="msg-reasoning" :class="{ open: !!openReasonings[reply.requestId || `${turnIndex}-${replyIndex}`] }">
                    <button class="reasoning-head" type="button" @click="toggleReasoning(reply.requestId || `${turnIndex}-${replyIndex}`)">
                      <span class="reasoning-label">{{ reasoningTitle(reply) }}</span>
                      <span class="chev">⌄</span>
                    </button>
                    <div v-show="openReasonings[reply.requestId || `${turnIndex}-${replyIndex}`]" class="reasoning-text">{{ reply.reasoning }}</div>
                  </div>
                  <div class="answer-content">{{ reply.content || '正在等待模型回答…' }}<span v-if="['pending', 'streaming'].includes(reply.status) && reply.content" class="caret" /></div>
                </div>
              </article>
            </div>
          </div>
        </div>
        <div v-else class="welcome">
          <OhLogo :size="52" class="welcome-mark" />
          <h2 class="welcome-title">开始一段新对话</h2>
          <p class="welcome-sub">选择最多 {{ MAX_MODELS }} 个模型，输入一句话即可并排比较回答。</p>
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
              :placeholder="selectedModels.length ? `发送给 ${selectedModels.length} 个模型…` : '先选择模型，再输入消息…'"
              @keydown.enter.exact.prevent="send"
            />
            <div class="input-foot">
              <span class="input-hint">Enter 发送 / Shift+Enter 换行</span>
              <el-button v-if="streaming" :icon="VideoPause" :loading="stopping" @click="stop">停止</el-button>
              <el-button v-else type="primary" :icon="Promotion" :disabled="!selectedModels.length || requestPending" @click="send">发送给 {{ selectedModels.length }} 个模型</el-button>
            </div>
          </div>
        </div>
      </div>
      <el-dialog v-model="expandVisible" class="answer-dialog" :title="expandedReply?.model || activeSession?.model || '模型回答'"
        width="min(900px, calc(100vw - 32px))" align-center @closed="expandedReply = null">
        <div class="expanded-provider">{{ providerName(expandedReply?.providerId || activeSession?.providerId) }}</div>
        <div class="expanded-answer" v-html="expandedHtml"></div>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped lang="scss">
.chat-shell {
  display: flex;
  height: 100%;
}

.session-panel {
  width: clamp(100px, 12vw, 160px);
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
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 10px;
  padding: 42px 24px 10px;
}

.model-selector {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(700px, 100%);
  min-height: 36px;
  padding: 5px 10px;
  border: 1px solid var(--oh-border);
  border-radius: var(--oh-radius-sm);
  background: var(--oh-bg-card);
  color: var(--oh-text);
  font: inherit;
  cursor: pointer;
  text-align: left;

  &:hover, &:focus-visible { border-color: var(--oh-primary); }
  &:disabled { opacity: 0.65; cursor: not-allowed; }
}

.selector-label { flex: none; font-weight: 600; }
.selected-models { display: flex; flex: 1; flex-wrap: wrap; gap: 4px; min-width: 0; }
.selected-model-chip {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--oh-primary-soft);
  color: var(--oh-primary);
  font-size: 12px;
}
.selector-placeholder { color: var(--oh-text-dim); }
.model-count { flex: none; color: var(--oh-text-dim); font-size: 12px; }
.thinking-select { width: 130px; flex: none; }
.model-picker { min-width: 0; }
:global(.model-picker-popper.el-popover) { border-radius: var(--oh-radius-lg); }
.model-picker-list {
  max-height: min(220px, 45vh);
  overflow-y: auto;
  overscroll-behavior-y: contain;
  padding-top: 8px;
  scrollbar-width: thin;
  scrollbar-color: var(--oh-border-strong) transparent;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: var(--oh-border-strong); border-radius: 6px; }
}
.model-group { display: flex; flex-direction: column; padding: 7px 2px; border-bottom: 1px solid var(--oh-border); }
.model-group-name { margin-bottom: 4px; color: var(--oh-text-dim); font-size: 12px; font-weight: 600; }
.model-group :deep(.el-checkbox) { margin-right: 0; min-height: 30px; }
.model-group :deep(.el-checkbox__label) { overflow: hidden; text-overflow: ellipsis; }
.picker-empty { padding: 18px 2px; color: var(--oh-text-dim); font-size: 12px; }
.picker-foot { padding-top: 9px; color: var(--oh-text-dim); font-size: 12px; }

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px 24px 20px;
}

.messages-col {
  max-width: 1680px;
  margin: 0 auto;
}

.chat-turn { margin-bottom: 30px; }
.turn-user { display: flex; flex-direction: row-reverse; align-items: flex-start; gap: 10px; margin-bottom: 14px; }
.user-content { display: flex; flex-direction: column; align-items: flex-end; min-width: 0; flex: 1; }
.user-bubble {
  max-width: min(80%, 720px);
  padding: 10px 14px;
  border: 1px solid var(--oh-border);
  border-radius: 12px;
  background: var(--oh-primary-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.answer-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.answer-card {
  display: flex;
  flex: 0 1 320px;
  flex-direction: column;
  width: min(100%, 320px);
  height: 320px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--oh-border);
  border-radius: var(--oh-radius-lg);
}
.answer-head { display: flex; align-items: center; gap: 9px; min-width: 0; }
.answer-avatar {
  width: 30px; height: 30px; display: grid; place-items: center; flex: none;
  border-radius: 8px; background: var(--oh-primary-soft); color: var(--oh-primary);
  font-size: 11px; font-weight: 700;
}
.answer-identity { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }
.answer-identity strong, .answer-identity span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.answer-identity strong { font-size: 13px; }
.answer-identity span { color: var(--oh-text-dim); font-size: 11px; }
.answer-actions { display: flex; gap: 2px; margin-left: auto; flex: none; }
.answer-action {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--oh-radius-sm);
  background: transparent;
  color: var(--oh-text-dim);
  cursor: pointer;

  &:hover, &:focus-visible { background: var(--oh-hover); color: var(--oh-primary); }
  &:disabled { opacity: 0.4; cursor: default; }
}
.answer-status { margin: 12px 0; color: var(--oh-text-dim); font-size: 11px; }
.answer-status.streaming { color: var(--oh-primary); }
.answer-status.error { color: var(--oh-danger); }
.answer-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--oh-border-strong) transparent;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: var(--oh-border-strong); border-radius: 6px; }
}
.answer-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.7; }
.expanded-provider { margin-bottom: 10px; color: var(--oh-text-dim); font-size: 12px; }
.expanded-answer {
  max-height: min(70vh, 640px);
  overflow-y: auto;
  overflow-wrap: anywhere;
  line-height: 1.75;
  scrollbar-width: thin;
  scrollbar-color: var(--oh-border-strong) transparent;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: var(--oh-border-strong); border-radius: 6px; }
  :deep(> :first-child) { margin-top: 0; }
  :deep(> :last-child) { margin-bottom: 0; }
  :deep(h1), :deep(h2), :deep(h3) { margin: 20px 0 8px; line-height: 1.3; }
  :deep(p), :deep(ul), :deep(ol), :deep(pre), :deep(blockquote) { margin: 0 0 12px; }
  :deep(ul), :deep(ol) { padding-left: 24px; }
  :deep(a) { color: var(--oh-primary); }
  :deep(code) { padding: 1px 4px; border-radius: 4px; background: var(--oh-bg-input); }
  :deep(pre) { overflow-x: auto; padding: 12px; border-radius: 8px; background: var(--oh-bg-input); }
  :deep(pre code) { padding: 0; background: none; }
  :deep(blockquote) { padding-left: 12px; border-left: 3px solid var(--oh-border-strong); color: var(--oh-text-2); }
  :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin-bottom: 12px; }
  :deep(th), :deep(td) { padding: 6px 10px; border: 1px solid var(--oh-border); }
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

  &.user {
    background: var(--oh-bg-input);
    border: 1px solid var(--oh-border);
    color: var(--oh-text-2);
  }
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

.turn-user:hover .msg-actions, .turn-user:focus-within .msg-actions {
  opacity: 1;
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
  max-width: 1680px;
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

@media (max-width: 1080px) {
  .chat-toolbar { padding-left: 16px; padding-right: 16px; }
  .messages { padding-left: 16px; padding-right: 16px; }
  .input-area { padding-left: 16px; padding-right: 16px; }
  .session-panel { width: 100px; }
}

@media (max-width: 700px) {
  .session-panel { width: 86px; }
  .chat-toolbar { padding-left: 10px; padding-right: 10px; }
  .messages { padding-left: 10px; padding-right: 10px; }
  .input-area { padding-left: 10px; padding-right: 10px; }
  .model-selector { gap: 6px; }
  .selector-label { display: none; }
  .input-foot { gap: 8px; }
  .input-hint { display: none; }
}
</style>
