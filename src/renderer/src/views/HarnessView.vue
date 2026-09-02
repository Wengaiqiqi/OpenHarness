<script setup>
import { api } from '@/api'
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh, VideoPlay, FolderOpened, Link } from '@element-plus/icons-vue'

const router = useRouter()
const harnesses = ref([])
const loading = ref(false)
const injectVisible = ref(false)
const injectTarget = ref(null)
const mcpServers = ref([])
const selectedMcp = ref([])

async function load() {
  loading.value = true
  try {
    harnesses.value = await api.harnessList()
  } finally {
    loading.value = false
  }
}

function embed(h) {
  if (!h.installed) return
  router.push({ path: '/workspace', query: { id: h.id } })
}

async function openConfig(h) {
  const res = await api.harnessOpenConfig(h.id)
  if (!res.ok) ElMessage.warning(res.message)
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

onMounted(load)
</script>

<template>
  <div class="page harness-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">Harness 管理</h1>
        <p class="page-sub">检测本机桌面级 Agent Harness，启动应用、注入 MCP、打开配置</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="load">扫描本机</el-button>
    </div>

    <div v-if="!harnesses.length && !loading" class="empty-state">
      <div class="empty-icon">
        <el-icon :size="26"><Box /></el-icon>
      </div>
      <div class="empty-title">未检测到任何 Harness</div>
      <div class="empty-desc">
        点击右上角「扫描本机」重新检测，支持 Claude Desktop、Cursor、Trae、Windsurf、VS Code 等
      </div>
      <el-button type="primary" :icon="Refresh" :loading="loading" @click="load">扫描本机</el-button>
    </div>

    <div v-else class="harness-list">
      <div v-for="h in harnesses" :key="h.id" class="card card-hover harness-card">
        <div class="h-badge" :style="{ background: h.color }">{{ h.name.slice(0, 2).toUpperCase() }}</div>
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
          <el-button size="small" :icon="FolderOpened" :disabled="!h.configPath" @click="openConfig(h)">配置</el-button>
          <el-button size="small" type="primary" plain :icon="Link" :disabled="!h.installed || !h.canInjectMcp" @click="openInject(h)">注入 MCP</el-button>
        </div>
      </div>
    </div>

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
</style>
