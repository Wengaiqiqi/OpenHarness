<script setup>
import { api } from '@/api'
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Delete, Edit, Promotion } from '@element-plus/icons-vue'

const servers = ref([])
const harnesses = ref([])
const visible = ref(false)
const editing = ref(null)
const form = ref({ name: '', transport: 'stdio', command: '', args: [], url: '' })
const argText = ref('')

const injectVisible = ref(false)
const injectServers = ref([])
const selectedHarnesses = ref([])

const injectableHarnesses = computed(() => harnesses.value.filter((h) => h.installed && h.canInjectMcp))

async function load() {
  servers.value = (await api.mcpGetAll()) || []
  harnesses.value = await api.harnessList()
}

function openAdd() {
  editing.value = null
  form.value = { name: '', transport: 'stdio', command: '', args: [], url: '' }
  argText.value = ''
  visible.value = true
}

function openEdit(s) {
  editing.value = s
  form.value = JSON.parse(JSON.stringify(s))
  argText.value = (s.args || []).join('\n')
  visible.value = true
}

async function save() {
  if (!form.value.name) {
    ElMessage.warning('请填写名称')
    return
  }
  if (form.value.transport === 'stdio' && !form.value.command) {
    ElMessage.warning('请填写启动命令')
    return
  }
  if (form.value.transport === 'http' && !form.value.url) {
    ElMessage.warning('请填写 URL')
    return
  }
  const server = {
    ...form.value,
    args: argText.value.split('\n').map((s) => s.trim()).filter(Boolean),
    id: editing.value?.id || `mcp-${Date.now()}`
  }
  servers.value = await api.mcpSave(server)
  visible.value = false
  ElMessage.success('已保存')
}

async function remove(s) {
  await ElMessageBox.confirm(`确定删除「${s.name}」？`, '提示', { type: 'warning' })
  servers.value = await api.mcpRemove(s.id)
  ElMessage.success('已删除')
}

function openInject() {
  injectServers.value = servers.value.filter((s) => s.transport === 'stdio' || s.transport === 'http')
  if (!injectServers.value.length) {
    ElMessage.warning('请先添加 MCP Server')
    return
  }
  selectedHarnesses.value = []
  injectVisible.value = true
}

async function doInject() {
  if (!selectedHarnesses.value.length) {
    ElMessage.warning('请选择目标 Harness')
    return
  }
  let okCount = 0
  for (const id of selectedHarnesses.value) {
    const res = await api.harnessInjectMcp(id, injectServers.value)
    if (res.ok) okCount++
  }
  ElMessage.success(`已注入 ${okCount}/${selectedHarnesses.value.length} 个 Harness（原配置已自动备份）`)
  injectVisible.value = false
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">MCP 中心</h1>
        <p class="page-sub">集中注册 MCP Server，一键注入到各桌面 Harness 的配置文件</p>
      </div>
      <div class="head-actions">
        <el-button type="primary" plain :icon="Promotion" :disabled="!servers.length" @click="openInject">批量注入</el-button>
        <el-button type="primary" :icon="Plus" @click="openAdd">添加 Server</el-button>
      </div>
    </div>

    <div v-if="!servers.length" class="empty-state">
      <div class="empty-icon">
        <el-icon :size="26"><Connection /></el-icon>
      </div>
      <div class="empty-title">还没有 MCP Server</div>
      <div class="empty-desc">
        注册 STDIO 或 HTTP 类型的 MCP Server，然后一键注入到 Claude Desktop、Cursor、VS Code 等桌面 Harness
      </div>
      <el-button type="primary" :icon="Plus" @click="openAdd">添加 Server</el-button>
    </div>

    <div v-else class="mcp-list">
      <div v-for="s in servers" :key="s.id" class="card card-hover mcp-card">
        <div class="m-head">
          <div class="m-icon" :class="s.transport">
            <el-icon :size="15">
              <Link v-if="s.transport === 'http'" />
              <Connection v-else />
            </el-icon>
          </div>
          <span class="m-name">{{ s.name }}</span>
          <el-tag size="small" effect="plain">{{ s.transport === 'http' ? 'HTTP' : 'STDIO' }}</el-tag>
        </div>
        <div class="m-cmd">
          <template v-if="s.transport === 'http'">{{ s.url }}</template>
          <template v-else>{{ s.command }} {{ (s.args || []).join(' ') }}</template>
        </div>
        <div class="m-actions">
          <el-button size="small" :icon="Edit" @click="openEdit(s)">编辑</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="remove(s)">删除</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="visible" :close-on-click-modal="false" :title="editing ? '编辑 MCP Server' : '添加 MCP Server'" width="560px">
      <el-form label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：openharness-bridge" />
        </el-form-item>
        <el-form-item label="传输方式">
          <el-radio-group v-model="form.transport">
            <el-radio-button value="stdio">STDIO</el-radio-button>
            <el-radio-button value="http">HTTP</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.transport === 'stdio'">
          <el-form-item label="命令" required>
            <el-input v-model="form.command" placeholder="如：npx / node / python" />
          </el-form-item>
          <el-form-item label="参数">
            <el-input v-model="argText" type="textarea" :rows="3" placeholder="每行一个参数，如：&#10;-y&#10;@modelcontextprotocol/server-filesystem&#10;E:\some\path" />
          </el-form-item>
        </template>
        <el-form-item v-else label="URL" required>
          <el-input v-model="form.url" placeholder="http://localhost:3000/mcp" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="injectVisible" :close-on-click-modal="false" title="批量注入 MCP" width="520px">
      <p class="inject-tip">把选中的 MCP Server 写入目标 Harness 的 MCP 配置文件（自动备份原文件）：</p>
      <el-checkbox-group v-model="selectedHarnesses">
        <div v-for="h in injectableHarnesses" :key="h.id" class="inject-row">
          <el-checkbox :value="h.id">
            <span class="m-name">{{ h.name }}</span>
          </el-checkbox>
          <div class="inject-path">{{ h.configPath || '配置文件将在首次注入时创建' }}</div>
        </div>
      </el-checkbox-group>
      <el-alert v-if="!injectableHarnesses.length" type="warning" :closable="false" title="未检测到可注入的 Harness" />
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

.head-actions {
  display: flex;
  gap: 10px;
}

.mcp-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.m-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.m-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--oh-primary-soft);
  color: var(--oh-primary);
  flex-shrink: 0;

  &.http {
    background: rgba(22, 163, 74, 0.1);
    color: var(--oh-success);
  }
}

.m-name {
  font-weight: 600;
  font-size: 15px;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-cmd {
  font-size: 12px;
  color: var(--oh-text-dim);
  font-family: Consolas, 'JetBrains Mono', monospace;
  word-break: break-all;
  margin-bottom: 12px;
}

.m-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
  border-top: 1px solid var(--oh-border);
}

.inject-tip {
  font-size: 13px;
  color: var(--oh-text-dim);
  margin: 0 0 12px;
}

.inject-row {
  padding: 8px 4px;
  border-bottom: 1px dashed var(--oh-border);
  &:last-child {
    border-bottom: none;
  }
}

.inject-path {
  font-size: 11px;
  color: var(--oh-text-dim);
  margin: 2px 0 0 24px;
  word-break: break-all;
}
</style>
