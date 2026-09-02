<script setup>
import { api } from '@/api'
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Delete, Edit } from '@element-plus/icons-vue'

const providers = ref([])
const visible = ref(false)
const editing = ref(null)
const form = ref({ name: '', type: 'openai-compatible', baseUrl: '', apiKey: '', models: [] })

const typeOptions = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'bedrock', label: 'Amazon Bedrock' },
  { value: 'gemini', label: 'Google (Gemini)' }
]

const placeholderMap = {
  'openai-responses': 'https://api.openai.com/v1',
  'openai-compatible': 'https://ark.cn-beijing.volces.com/api/v3',
  anthropic: 'https://api.anthropic.com',
  bedrock: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
}

async function load() {
  providers.value = (await api.providerGetAll()) || []
}

function openAdd() {
  editing.value = null
  form.value = { name: '', type: 'openai-compatible', baseUrl: '', apiKey: '', models: [] }
  fetchedModels.value = []
  visible.value = true
}

function openEdit(p) {
  editing.value = p
  form.value = JSON.parse(JSON.stringify(p))
  fetchedModels.value = []
  visible.value = true
}

async function save() {
  if (!form.value.name || !form.value.baseUrl) {
    ElMessage.warning('名称与 Base URL 为必填项')
    return
  }
  try {
    const provider = { ...form.value, id: editing.value?.id || `prov-${Date.now()}` }
    providers.value = await api.providerSave(provider)
    visible.value = false
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error({ message: `保存失败：${String(err)}`, duration: 8000 })
  }
}

async function remove(p) {
  await ElMessageBox.confirm(`确定删除「${p.name}」？`, '提示', { type: 'warning' })
  providers.value = await api.providerRemove(p.id)
  ElMessage.success('已删除')
}

const loadingModels = ref(false)
const fetchedModels = ref([])

const modelOptions = computed(() => [...new Set([...fetchedModels.value, ...form.value.models])])

async function fetchModels() {
  if (!form.value.baseUrl) {
    ElMessage.warning({ message: '请先填写 Base URL', duration: 6000 })
    return
  }
  loadingModels.value = true
  try {
    const res = await api.providerListModels({
      type: form.value.type,
      baseUrl: form.value.baseUrl,
      apiKey: form.value.apiKey
    })
    if (!res.ok) {
      ElMessage.error({ message: res.message || '获取模型列表失败', duration: 8000 })
      return
    }
    fetchedModels.value = res.models
    if (res.models.length) ElMessage.success(`获取到 ${res.models.length} 个模型，请在下拉中勾选`)
    else ElMessage.warning({ message: '该服务未返回任何模型，可手动输入模型名', duration: 6000 })
  } catch (err) {
    ElMessage.error({ message: String(err), duration: 8000 })
  } finally {
    loadingModels.value = false
  }
}

function selectAllModels() {
  form.value.models = [...new Set([...form.value.models, ...fetchedModels.value])]
}

function clearModels() {
  form.value.models = []
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">模型服务</h1>
        <p class="page-sub">统一管理 LLM Provider，配置后可用于统一对话</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openAdd">添加服务</el-button>
    </div>

    <div v-if="!providers.length" class="empty-state">
      <div class="empty-icon">
        <el-icon :size="26"><Cpu /></el-icon>
      </div>
      <div class="empty-title">还没有模型服务</div>
      <div class="empty-desc">
        添加 OpenAI、Anthropic、Gemini 或 Bedrock Provider，配置一次即可在统一对话中切换使用
      </div>
      <el-button type="primary" :icon="Plus" @click="openAdd">添加服务</el-button>
    </div>

    <div v-else class="provider-list">
      <div v-for="p in providers" :key="p.id" class="card card-hover provider-card">
        <div class="p-head">
          <div class="p-id">
            <div class="p-badge">{{ p.name.slice(0, 2).toUpperCase() }}</div>
            <span class="p-name">{{ p.name }}</span>
          </div>
          <el-tag size="small" effect="plain">{{ typeOptions.find((t) => t.value === p.type)?.label || p.type }}</el-tag>
        </div>
        <div class="p-row">Base URL：{{ p.baseUrl }}</div>
        <div class="p-row">Key：{{ p.apiKey ? p.apiKey.slice(0, 8) + '••••••' : '未设置' }}</div>
        <div v-if="p.models?.length" class="p-row">模型：{{ p.models.join('、') }}</div>
        <div class="p-actions">
          <el-button size="small" :icon="Edit" @click="openEdit(p)">编辑</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="remove(p)">删除</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="visible" :close-on-click-modal="false" :title="editing ? '编辑模型服务' : '添加模型服务'" width="560px">
      <el-form label-width="90px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：火山方舟 / OpenAI / Claude" />
        </el-form-item>
        <el-form-item label="协议类型">
          <el-select v-model="form.type" style="width: 100%">
            <el-option v-for="t in typeOptions" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="Base URL" required>
          <el-input v-model="form.baseUrl" :placeholder="placeholderMap[form.type]" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" type="password" show-password placeholder="sk-..." />
        </el-form-item>
        <el-form-item label="模型列表">
          <div class="models-field">
            <div class="models-actions">
              <el-button size="small" :loading="loadingModels" @click="fetchModels">获取模型列表</el-button>
              <template v-if="fetchedModels.length">
                <el-button size="small" text type="primary" @click="selectAllModels">全选</el-button>
                <el-button size="small" text @click="clearModels">清空</el-button>
                <span class="models-count">共 {{ fetchedModels.length }} 个模型</span>
              </template>
            </div>
            <el-select v-model="form.models" multiple filterable allow-create default-first-option
              :loading="loadingModels" placeholder="获取后在下拉中勾选，也可直接输入模型名后回车" style="width: 100%">
              <el-option v-for="m in modelOptions" :key="m" :label="m" :value="m" />
            </el-select>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
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

.provider-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.provider-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.p-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}

.p-id {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.p-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--oh-primary-soft);
  color: var(--oh-primary);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.p-name {
  font-weight: 600;
  font-size: 15px;
}

.p-row {
  font-size: 12px;
  color: var(--oh-text-dim);
  word-break: break-all;
}

.p-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--oh-border);
}

.models-field {
  width: 100%;
}

.models-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;

  .el-button + .el-button {
    margin-left: 0;
  }
}

.models-count {
  font-size: 12px;
  color: var(--oh-text-dim);
}
</style>
