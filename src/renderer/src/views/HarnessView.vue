<script>
import { ref } from 'vue'

// 跨页面复用首次扫描结果；重启渲染进程后重置。
const harnessesCache = ref([])
let autoScanned = false
</script>

<script setup>
import { onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store/app'
import { Refresh, VideoPlay, Link, MagicStick } from '@element-plus/icons-vue'
import { api } from '@/api'
import { iconFallback } from '@/icon-fallback'

const router = useRouter()
const appStore = useAppStore()
// 复用模块级缓存（首次扫描结果跨页面保留），避免每次进入重扫
const harnesses = harnessesCache
const loading = ref(false)
const injectVisible = ref(false)
const injectTarget = ref(null)
const mcpServers = ref([])
const selectedMcp = ref([])

// stale-while-revalidate：进页面秒回缓存；按钮「扫描本机」才强制刷新（有 loading）
// 后台静默刷新完成后经 harness:updated 广播无痕更新本页状态
function applyList(list) {
  // 已检测到（可开启）的排前面，未安装的沉底；新装的应用重新扫描后自动靠前
  harnesses.value = [...list.filter((h) => h.installed), ...list.filter((h) => !h.installed)]
}

async function load(force = false) {
  if (force) loading.value = true
  try {
    applyList((await api.harnessList(force)) || [])
  } finally {
    if (force) loading.value = false
  }
}

function embed(h) {
  if (!h.installed) return
  router.push({ path: '/workspace', query: { id: h.id } })
}

function openInject(h) {
  injectTarget.value = h
  selectedMcp.value = []
  api.mcpGetAll().then((list) => {
    mcpServers.value = list || []
    injectVisible.value = true
  })
}

async function doInject() {
  if (!selectedMcp.value.length) {
    ElMessage.warning('请选择要注入的 MCP Server')
    return
  }
  const servers = mcpServers.value.filter((s) => selectedMcp.value.includes(s.id))
  const res = await api.harnessInjectMcp(injectTarget.value.id, servers)
  if (res.ok) {
    ElMessage.success(`已注入到 ${injectTarget.value.name}（已自动备份原配置）`)
    injectVisible.value = false
  } else {
    ElMessage.error(res.message)
  }
}

onMounted(() => {
  if (autoScanned) return
  autoScanned = true
  load()
  // 后台静默刷新完成 → 无痕更新本页状态
  offUpdated = api.onHarnessUpdated((list) => applyList(list || []))
})

let offUpdated = null
onBeforeUnmount(() => { offUpdated?.(); offUpdated = null })

/* ---------------- 模型配置（参考 opencodex：本地代理 + 注入） ---------------- */
const cfgVisible = ref(false)
const cfgTarget = ref(null)
const cfgProviders = ref([])
const cfgLoading = ref(false)
const proxyInfo = ref(null)
// 已选模型：providerId -> 模型名数组（跨供应商累积）
const cfgSelection = ref({})
// 上次配置记录（main 进程持久化）：打开弹窗时回显
const cfgHistory = ref(null)

const usableProviders = computed(() => cfgProviders.value.filter((p) => !['bedrock', 'openai-responses'].includes(p.type)))
const selectedCount = computed(() => Object.values(cfgSelection.value).reduce((n, arr) => n + arr.length, 0))

const cfgHistoryText = computed(() => {
  const h = cfgHistory.value
  if (!h?.items?.length) return ''
  const byProvider = {}
  for (const it of h.items) {
    (byProvider[it.providerName] ||= []).push(it.model)
  }
  const parts = Object.entries(byProvider).map(([name, models]) => `${name} · ${models[0]}${models.length > 1 ? ` 等 ${models.length} 个模型` : ''}`)
  const d = new Date(h.updatedAt)
  const pad = (n) => String(n).padStart(2, '0')
  return `${parts.join('；')}（${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}）`
})

function cfgSelectionModels() {
  return Object.entries(cfgSelection.value).flatMap(([providerId, models]) =>
    models.map((model) => ({ providerId, model }))
  )
}

async function openConfigure(h) {
  cfgTarget.value = h
  cfgProviders.value = (await api.providerGetAll()) || []
  if (!usableProviders.value.length) {
    ElMessage.warning('请先在「模型服务」中添加 OpenAI Compatible / Anthropic / Gemini Provider')
    return
  }
  // 回显上次配置：勾选仍存在于供应商模型列表里的项；完整记录在提示条展示
  cfgHistory.value = (await api.modelConfigHistory(h.id)) || null
  cfgSelection.value = {}
  for (const it of cfgHistory.value?.items || []) {
    const avail = cfgProviders.value.find((p) => p.id === it.providerId)?.models || []
    if (!avail.includes(it.model)) continue
    const cur = cfgSelection.value[it.providerId] || []
    if (!cur.includes(it.model)) {
      cfgSelection.value = { ...cfgSelection.value, [it.providerId]: [...cur, it.model] }
    }
  }
  cfgVisible.value = true
  proxyInfo.value = await api.proxyStatus()
}

async function doConfigure() {
  const selection = cfgSelectionModels()
  if (!selection.length) {
    ElMessage.warning('请至少勾选一个模型')
    return
  }
  cfgLoading.value = true
  try {
    const r = await api.harnessConfigureModel(cfgTarget.value.id, { selection })
    if (r.ok) {
      cfgVisible.value = false
      cfgHistory.value = (await api.modelConfigHistory(cfgTarget.value.id)) || null
      ElMessage.success(`已配置：${cfgTarget.value.name} 通过本地代理可使用 ${selection.length} 个模型`)
    } else {
      ElMessage.error({ message: r.message, duration: 8000 })
    }
  } finally {
    cfgLoading.value = false
  }
}

function isModelSelected(providerId, model) {
  return (cfgSelection.value[providerId] || []).includes(model)
}

function toggleAllOf(providerId, checked) {
  const p = cfgProviders.value.find((x) => x.id === providerId)
  cfgSelection.value = checked
    ? { ...cfgSelection.value, [providerId]: [...(p?.models || [])] }
    : { ...cfgSelection.value, [providerId]: [] }
}

function clearSelection() {
  cfgSelection.value = {}
}
</script>

<template>
  <div class="page harness-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">Harness 管理</h1>
        <p class="page-sub">检测本机桌面级 Agent Harness，启动应用、注入 MCP、配置模型</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="load(true)">扫描本机</el-button>
    </div>

    <div v-if="!harnesses.length && !loading" class="empty-state">
      <div class="empty-icon">
        <el-icon :size="26"><Box /></el-icon>
      </div>
      <div class="empty-title">未检测到任何 Harness</div>
      <div class="empty-desc">
        点击右上角「扫描本机」重新检测，支持 Claude Desktop、Cursor、Trae、Windsurf、VS Code 等
      </div>
      <el-button type="primary" :icon="Refresh" :loading="loading" @click="load(true)">扫描本机</el-button>
    </div>

    <div v-else class="harness-list">
      <div v-for="h in harnesses" :key="h.id" class="card card-hover harness-card">
          <img v-if="h.icon" :src="h.icon" class="h-badge-logo" :class="{ 'h-badge-logo-dark': appStore.theme === 'dark' && /simpleicons|jsdelivr/.test(h.icon || '') }" alt="" @error="iconFallback($event, h.name, h.color)" />
        <div v-else class="h-badge" :style="{ background: h.color }">{{ h.name.slice(0, 2).toUpperCase() }}</div>
        <div class="h-info">
          <div class="h-name">
            {{ h.name }}
            <el-tag v-if="h.installed" type="success" size="small" effect="plain">已安装</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">未检测到</el-tag>
          </div>
          <div class="h-desc">{{ h.desc }}</div>
          <div v-if="h.configPath" class="h-path" :title="h.configPath">
            配置：{{ h.configPath }}
          </div>
        </div>
        <div class="h-actions">
          <el-button size="small" type="primary" :icon="VideoPlay" :disabled="!h.installed" @click="embed(h)">内嵌打开</el-button>
          <el-button size="small" type="primary" plain :icon="Link" :disabled="!h.installed || !h.canInjectMcp" @click="openInject(h)">注入 MCP</el-button>
          <el-button v-if="h.canConfigureModel" size="small" plain :icon="MagicStick" :disabled="!h.installed" @click="openConfigure(h)">配置模型</el-button>
        </div>
      </div>
    </div>

    <el-dialog
      v-model="cfgVisible"
      :close-on-click-modal="false"
      :title="`配置模型：${cfgTarget?.name || ''}`"
      width="min(960px, 92vw)"
      style="aspect-ratio: 16 / 9; display: flex; flex-direction: column"
    >
      <div class="cfg-alert">
        通过内置本地代理（127.0.0.1:18200）使用「模型服务」里的模型<span v-if="proxyInfo?.running" class="cfg-dot" />
      </div>
      <div v-if="cfgHistoryText" class="cfg-history">
        上次配置：{{ cfgHistoryText }}——再次写入将覆盖
      </div>
      <div class="cfg-body">
        <div v-for="p in usableProviders" :key="p.id" class="card cfg-card">
          <div class="cfg-card-head">
            <span class="cfg-card-name">{{ p.name }}</span>
            <el-checkbox
              size="small"
              :model-value="(cfgSelection[p.id] || []).length === (p.models || []).length && (p.models || []).length > 0"
              :indeterminate="(cfgSelection[p.id] || []).length > 0 && (cfgSelection[p.id] || []).length < (p.models || []).length"
              @change="toggleAllOf(p.id, $event)"
            >全选</el-checkbox>
          </div>
          <div class="cfg-card-row">
            <span class="cfg-card-label">模型：</span>
            <el-select
              v-model="cfgSelection[p.id]"
              multiple
              filterable
              allow-create
              default-first-option
              collapse-tags
              collapse-tags-tooltip
              placeholder="勾选或输入模型名后回车"
              style="flex: 1"
            >
              <el-option v-for="m in p.models || []" :key="m" :label="m" :value="m" />
            </el-select>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="cfg-footer">
          <span class="cfg-summary">已选 {{ selectedCount }} 个模型</span>
          <div class="cfg-footer-btns">
            <el-button size="small" text @click="clearSelection">清空</el-button>
            <el-button @click="cfgVisible = false">取消</el-button>
            <el-button type="primary" :loading="cfgLoading" @click="doConfigure">写入配置</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="injectVisible" :close-on-click-modal="false" :title="`注入 MCP 到 ${injectTarget?.name || ''}`" width="520px">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 14px"
        title="注入前会自动备份原配置文件（.openharness.bak）" />
      <el-checkbox-group v-model="selectedMcp">
        <div v-for="s in mcpServers" :key="s.id" class="mcp-row">
          <el-checkbox :value="s.id">
            <span class="mcp-name">{{ s.name }}</span>
            <el-tag size="small" effect="plain" style="margin-left: 8px">{{ s.transport === 'http' ? 'HTTP' : 'STDIO' }}</el-tag>
          </el-checkbox>
          <div class="mcp-cmd">{{ s.transport === 'http' ? s.url : s.command + ' ' + (s.args || []).join(' ') }}</div>
        </div>
      </el-checkbox-group>
      <div v-if="!mcpServers.length" class="empty-tip">
        暂无 MCP Server，请先到「MCP」页面添加
      </div>
      <template #footer>
        <el-button @click="injectVisible = false">取消</el-button>
        <el-button type="primary" @click="doInject">注入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 20px;
}

.harness-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.harness-card {
  display: flex;
  align-items: center;
  gap: 16px;
}

.h-badge {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.h-badge-logo {
  width: 38px;
  height: 38px;
  object-fit: contain;
  flex-shrink: 0;
}

.h-badge-logo-dark {
  filter: invert(1);
}

.h-badge-img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}

.h-badge-img-dark {
  filter: invert(1);
}

.h-info {
  flex: 1;
  min-width: 0;
}

.h-name {
  font-weight: 600;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.h-desc {
  font-size: 13px;
  color: var(--oh-text-dim);
  margin-top: 3px;
}

.h-path {
  font-size: 11px;
  color: var(--oh-text-dim);
  margin-top: 5px;
  font-family: Consolas, 'JetBrains Mono', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.h-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.mcp-row {
  padding: 8px 4px;
  border-bottom: 1px dashed var(--oh-border);
  &:last-child {
    border-bottom: none;
  }
}

.mcp-name {
  font-weight: 600;
}

.mcp-cmd {
  font-size: 11px;
  color: var(--oh-text-dim);
  margin: 2px 0 0 24px;
  word-break: break-all;
}

.empty-tip {
  text-align: center;
  color: var(--oh-text-dim);
  padding: 20px 0;
}

/* ---- 配置模型弹窗（16:9 多供应商卡片） ---- */
.cfg-alert {
  font-size: 12px;
  color: var(--oh-text-dim);
  margin-bottom: 10px;
}

.cfg-history {
  font-size: 12px;
  color: var(--oh-primary);
  background: var(--oh-primary-soft);
  border-radius: var(--oh-radius-sm);
  padding: 6px 10px;
  margin-bottom: 10px;
  word-break: break-all;
}

.cfg-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--oh-success);
  margin-left: 6px;
  vertical-align: middle;
}

.cfg-body {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  align-content: start;
  padding: 4px 2px;
}

.cfg-models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cfg-model {
  padding: 5px 10px;
  font-size: 12px;
  font-family: Consolas, monospace;
  color: var(--oh-text-2);
  background: var(--oh-bg-input);
  border: 1px solid var(--oh-border);
  border-radius: 999px;
  cursor: pointer;
  transition:
    border-color var(--oh-dur) var(--oh-ease),
    background var(--oh-dur) var(--oh-ease),
    color var(--oh-dur) var(--oh-ease);

  &:hover {
    border-color: var(--oh-primary);
  }

  &.on {
    background: var(--oh-active);
    border-color: var(--oh-primary);
    color: var(--oh-primary);
    font-weight: 600;
  }
}

.cfg-none {
  font-size: 12px;
  color: var(--oh-text-dim);
}

.cfg-card {
  border: 1px solid var(--oh-border);
  border-radius: var(--oh-radius);
  padding: 14px 16px;
}

.cfg-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.cfg-card-name {
  font-weight: 600;
  font-size: 14px;
}

.cfg-card-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cfg-card-label {
  font-size: 13px;
  color: var(--oh-text-dim);
  flex-shrink: 0;
}

.cfg-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: auto;
}

/* el-dialog 内部结构用 :deep 穿透：body 撑满剩余高度，footer 才能贴到弹窗底部 */
:deep(.el-dialog) {
  display: flex;
  flex-direction: column;
}

:deep(.el-dialog__body) {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.cfg-summary {
  font-size: 12px;
  color: var(--oh-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  text-align: left;
  margin-right: auto;
}

.cfg-footer-btns {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
</style>
