<script setup>
import { api } from '@/api'
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { SwitchButton, Position, Close, Monitor, Plus, Refresh } from '@element-plus/icons-vue'
import TerminalView from '@/components/TerminalView.vue'
import { iconFallback } from '@/icon-fallback'

const route = useRoute()
const router = useRouter()

const tabs = ref([]) // { id, name, color }
const activeTabId = ref(null)
const loading = ref(false)
const embedOk = ref(false)
const hostEl = ref(null)
const harnessList = ref([]) // { id, name, color, installed }
const addVisible = ref(false)

let resizeObserver = null
let throttleTimer = null
let activationSeq = 0

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) || null)
// 尚未打开且已安装的 harness，供"+"下拉选择
const addable = computed(() => harnessList.value.filter((h) => h.installed && !tabs.value.some((t) => t.id === h.id)))

function tabIcon(id) {
  return harnessList.value.find((h) => h.id === id)?.icon || null
}

function hostRect() {
  const r = hostEl.value?.getBoundingClientRect()
  return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : { x: 0, y: 0, width: 100, height: 100 }
}

async function syncSize() {
  if (!hostEl.value || !embedOk.value) return
  await api.embedReposition(hostRect())
}

function scheduleSync() {
  if (throttleTimer) return
  throttleTimer = setTimeout(() => {
    throttleTimer = null
    syncSize()
  }, 120)
}

/** 激活标签：已附着 → 直接切换显示；未附着 → 附着（冷启动可能较慢） */
function activateTab(t) {
  const seq = ++activationSeq
  activeTabId.value = t.id
  loading.value = true
  const run = async () => {
    try {
      const res = await api.embedOpen(t.id, hostRect())
      if (seq !== activationSeq) return
      if (!res.ok) {
        embedOk.value = false
        ElMessage.error(res.message || '附着失败')
        return
      }
      embedOk.value = true
      t.webUrl = res.webUrl || null
      t.mode = res.mode || (t.webUrl ? 'web' : 'native')
      if (t.webUrl || t.mode === 'pty') return
      await syncSize()
      setTimeout(() => {
        if (seq === activationSeq && embedOk.value && hostEl.value) syncSize()
      }, 400)
    } finally {
      if (seq === activationSeq) loading.value = false
    }
  }
  return run()
}

/** 关闭标签：先切 UI 再后台杀进程（杀进程可能耗时数秒，绝不让 UI 等待） */
function closeTab(t) {
  const idx = tabs.value.findIndex((x) => x.id === t.id)
  if (idx < 0) return
  tabs.value.splice(idx, 1)
  if (activeTabId.value === t.id) {
    activeTabId.value = null
    embedOk.value = false
    const next = tabs.value[idx] || tabs.value[idx - 1]
    if (next) activateTab(next)
  }
  api.embedClose(t.id).catch(() => {})
}

/** "+" 下拉选择后新开一个嵌入标签 */
async function addTab(h) {
  addVisible.value = false
  if (tabs.value.some((t) => t.id === h.id)) return
  tabs.value.push({ id: h.id, name: h.name, color: h.color })
  await activateTab(h)
}

/** 工具条"重新扫描"：重新检测本机 harness 并刷新可开列表 */
async function rescan() {
  loading.value = true
  try {
    harnessList.value = (await api.harnessList()) || []
    ElMessage.success('已重新扫描本机 Harness')
  } finally {
    loading.value = false
  }
}

/** 转为独立窗口：先切 UI，脱离放后台 */
function toStandalone() {
  const t = activeTab.value
  if (!t) return
  const idx = tabs.value.findIndex((x) => x.id === t.id)
  if (idx >= 0) tabs.value.splice(idx, 1)
  if (activeTabId.value === t.id) {
    activeTabId.value = null
    embedOk.value = false
    const next = tabs.value[idx] || tabs.value[idx - 1]
    if (next) activateTab(next)
  }
  api.embedRelease(t.id).catch(() => {})
  ElMessage.success(`「${t.name}」已转为独立窗口运行`)
}

/** 释放并返回：先导航，释放放后台（DeepSeek 等 web 型要杀服务进程树，可能耗时数秒） */
function releaseAndBack() {
  router.replace('/harness')
  api.embedReleaseAll().catch(() => {})
}

onMounted(async () => {
  resizeObserver = new ResizeObserver(scheduleSync)
  if (hostEl.value) resizeObserver.observe(hostEl.value)

  // 不在这里无条件置 loading：无标签时应立即显示空态，而非误导的"正在附着"。
  // 真正附着发生在 activateTab（其内部才设置 loading）。
  try {
    const list = (await api.harnessList()) || []
    harnessList.value = list
    const st = await api.embedStatus()

    // 恢复已附着的标签
    for (const id of st.attached || []) {
      const h = list.find((x) => x.id === id)
      if (h) tabs.value.push({ id, name: h.name, color: h.color })
    }
    // 路由指定打开的
    const qid = route.query.id
    if (qid && !tabs.value.some((t) => t.id === qid)) {
      const h = list.find((x) => x.id === qid)
      if (h) tabs.value.push({ id: h.id, name: h.name, color: h.color })
      else ElMessage.error('未找到指定 Harness')
    }
    // 激活目标：路由指定 > 上次激活 > 第一个
    const target =
      (qid && tabs.value.find((t) => t.id === qid)) ||
      tabs.value.find((t) => t.id === st.activeId) ||
      tabs.value[0]
    if (target) await activateTab(target)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (throttleTimer) clearTimeout(throttleTimer)
  // 切走页面时隐藏全部附着窗口，保持附着，回来继续用
  api.embedHide()
})
</script>

<template>
  <div class="workspace">
    <header class="ws-bar">
      <div class="ws-tabs">
        <div
          v-for="t in tabs"
          :key="t.id"
          class="ws-tab"
          :class="{ active: t.id === activeTabId }"
          :title="t.name"
          @click="activateTab(t)"
        >
          <span class="ws-dot" :style="{ background: t.color }" />
          <img v-if="tabIcon(t.id)" :src="tabIcon(t.id)" class="ws-tab-icon" alt="" @error="iconFallback($event, t.name, t.color)" />
          <span class="ws-tab-name">{{ t.name }}</span>
          <el-icon class="ws-tab-close" @click.stop="closeTab(t)"><Close /></el-icon>
        </div>
        <span v-if="!tabs.length" class="ws-tabs-empty">尚未打开应用</span>
        <button class="ws-add" title="打开应用" @click.stop="addVisible = !addVisible">
          <el-icon :size="14"><Plus /></el-icon>
        </button>
      </div>
      <div class="ws-actions">
        <el-button size="small" :icon="Position" :disabled="!activeTab || activeTab.mode === 'pty'" @click="toStandalone">转为独立窗口</el-button>
        <el-button size="small" type="danger" plain :icon="SwitchButton" :disabled="!tabs.length" @click="releaseAndBack">释放并返回</el-button>
      </div>
    </header>

    <!-- 原生子窗口永远浮在 Web 弹层之上，任何 dropdown 都会被嵌入应用遮挡；
         因此用内嵌工具条：展开时 host 变矮（ResizeObserver 自动缩放嵌入窗口） -->
    <div v-if="addVisible" class="ws-add-bar">
      <span class="ws-add-bar-label">打开应用：</span>
      <template v-if="addable.length">
        <button
          v-for="h in addable"
          :key="h.id"
          class="ws-add-bar-item"
          @click="addTab(h)"
        >
          <img v-if="h.icon" :src="h.icon" class="ws-tab-icon" alt="" @error="iconFallback($event, h.name, h.color)" />
          <span v-else class="ws-add-dot" :style="{ background: h.color }" />
          {{ h.name }}
        </button>
      </template>
      <span v-else class="ws-add-bar-empty">未检测到其他可打开的 Harness</span>
      <span class="ws-add-bar-spacer" />
      <button class="ws-add-bar-item ws-add-bar-rescan" @click="rescan">
        <el-icon :size="12"><Refresh /></el-icon>
        重新扫描
      </button>
      <button class="ws-add-bar-item ws-add-bar-close" @click="addVisible = false">收起</button>
    </div>

    <div ref="hostEl" class="ws-host">
      <TerminalView
        v-for="t in tabs.filter((tab) => tab.mode === 'pty')"
        :key="t.id"
        :id="t.id"
        :visible="t.id === activeTabId"
        :class="{ 'ws-terminal-hidden': t.id !== activeTabId }"
        class="ws-terminal"
      />
      <iframe v-if="activeTab && activeTab.webUrl" :src="activeTab.webUrl" class="ws-web" frameborder="0" />
      <div v-if="loading" class="ws-tip">
        <el-icon class="is-loading" :size="28"><Loading /></el-icon>
        <p>正在附着应用窗口…（冷启动可能需要十几秒）</p>
      </div>
      <div v-else-if="!tabs.length" class="ws-tip ws-empty">
        <el-icon :size="36"><Monitor /></el-icon>
        <p>还没有打开的应用</p>
        <el-button type="primary" @click="router.push('/harness')">去 Harness 页打开</el-button>
      </div>
      <div v-else-if="!embedOk" class="ws-tip"><p>未附着应用</p></div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.workspace {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.ws-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 42px 16px 8px;
}

.ws-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  padding: 2px;
}

.ws-tabs-empty {
  font-size: 12px;
  color: var(--oh-text-dim);
  padding: 4px 6px;
}

.ws-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px dashed var(--oh-border-strong);
  border-radius: var(--oh-radius-sm);
  background: transparent;
  color: var(--oh-text-dim);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    border-color var(--oh-dur) var(--oh-ease),
    color var(--oh-dur) var(--oh-ease);

  &:hover {
    border-color: var(--oh-primary);
    color: var(--oh-primary);
  }
}

.ws-add-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.ws-add-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--oh-border);
  background: var(--oh-bg);
}

.ws-add-bar-label {
  font-size: 12px;
  color: var(--oh-text-dim);
}

.ws-add-bar-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--oh-border);
  border-radius: var(--oh-radius-sm);
  background: var(--oh-bg-card);
  font-size: 12px;
  font-family: inherit;
  color: var(--oh-text-2);
  cursor: pointer;
  transition:
    border-color var(--oh-dur) var(--oh-ease),
    color var(--oh-dur) var(--oh-ease);

  &:hover {
    border-color: var(--oh-primary);
    color: var(--oh-primary);
  }
}

.ws-add-bar-empty {
  font-size: 12px;
  color: var(--oh-text-dim);
}

.ws-add-bar-spacer {
  flex: 1;
}

.ws-add-bar-close {
  border-style: dashed;
  color: var(--oh-text-dim);
}

.ws-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--oh-radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--oh-text-2);
  white-space: nowrap;
  transition:
    background var(--oh-dur) var(--oh-ease),
    color var(--oh-dur) var(--oh-ease);

  &:hover {
    background: var(--oh-hover);
    color: var(--oh-text);
    .ws-tab-close {
      opacity: 1;
    }
  }

  &.active {
    background: var(--oh-active);
    color: var(--oh-primary);
    font-weight: 500;
    .ws-tab-close {
      opacity: 1;
    }
  }
}

.ws-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ws-tab-icon {
  width: 14px;
  height: 14px;
  object-fit: contain;
  flex-shrink: 0;
}

.ws-tab-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ws-tab-close {
  font-size: 12px;
  opacity: 0;
  color: var(--oh-text-dim);
  border-radius: 4px;
  transition: opacity var(--oh-dur) var(--oh-ease);

  &:hover {
    color: var(--oh-danger);
  }
}

.ws-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.ws-host {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--oh-bg);
}

.ws-terminal {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.ws-terminal-hidden {
  visibility: hidden;
  pointer-events: none;
}

.ws-web {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

.ws-tip {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--oh-text-dim);
  font-size: 13px;
  pointer-events: none;

  &.ws-empty {
    pointer-events: auto;
  }
}

</style>
