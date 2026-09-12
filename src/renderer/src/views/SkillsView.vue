<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search, FolderOpened } from '@element-plus/icons-vue'
import { api } from '@/api'

const data = ref({ skills: [], targets: [], errors: [], root: '' })
const busy = ref(false), query = ref(''), error = ref('')
const addVisible = ref(false), scanVisible = ref(false), targetsVisible = ref(false)
const found = ref([]), scanErrors = ref([]), detail = ref(null), syncing = ref(null), selected = ref([])
const scanQuery = ref('')
const scanResults = computed(() => {
  const q = scanQuery.value.trim().toLowerCase()
  return found.value.filter(s => [s.name, s.description, s.tool, s.path].some(value => String(value || '').toLowerCase().includes(q)))
})
const form = ref({ type: 'local', path: '', url: '', subdir: '', folder: '' })
const target = ref({ name: '', path: '' })
const filtered = computed(() => data.value.skills.filter(s => `${s.name} ${s.description} ${s.folder}`.toLowerCase().includes(query.value.toLowerCase())))

async function run(fn) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await fn() } catch (e) { error.value = e.message || String(e) } finally { busy.value = false }
}
const load = () => run(async () => { data.value = await api.skillsList() })
function openAdd(p = '') {
  form.value = { type: 'local', path: p, url: '', subdir: '', folder: p.split(/[\\/]/).pop() || '' }
  addVisible.value = true
}
async function choose(forTarget = false) {
  await run(async () => {
    const p = await api.skillsPickDirectory()
    if (!p) return
    if (forTarget) target.value.path = p
    else { form.value.path = p; form.value.folder = p.split(/[\\/]/).pop() }
  })
}
async function install() {
  await run(async () => {
    const f = form.value
    const source = f.type === 'local' ? { type: 'local', path: f.path } : { type: 'git', url: f.url.trim(), subdir: f.subdir.trim() }
    data.value = await api.skillsInstall(source, f.folder.trim())
    addVisible.value = false
    scanVisible.value = false
    ElMessage.success('已导入管理库，可选择同步工具')
  })
}
function scan() {
  run(async () => {
    const result = await api.skillsScan()
    scanQuery.value = ''
    found.value = result.found; scanErrors.value = result.errors; scanVisible.value = true
  })
}
function openSync(s) {
  selected.value = s.targets.filter(t => t.state === 'on').map(t => t.id)
  syncing.value = s
}
function saveSync() {
  run(async () => {
    data.value = await api.skillsSync(syncing.value.id, selected.value)
    syncing.value = null
    ElMessage.success('同步状态已保存')
  })
}
async function confirmAction(s, action) {
  try {
    await ElMessageBox.confirm(action === 'remove'
      ? `删除「${s.name}」的管理库副本和由本应用创建的同步链接？原始导入目录会保留。`
      : `从原始来源重新获取「${s.name}」？管理库中的手动修改会被替换，已同步的工具将使用新内容。`, action === 'remove' ? '删除 Skill' : '更新 Skill', { type: 'warning' })
  } catch { return }
  await run(async () => {
    data.value = action === 'remove' ? await api.skillsRemove(s.id) : await api.skillsUpdate(s.id)
    ElMessage.success(action === 'remove' ? '已删除' : '已更新')
  })
}
function addTarget() {
  run(async () => {
    data.value = await api.skillsAddTarget(target.value)
    target.value = { name: '', path: '' }
    ElMessage.success('已添加同步目录')
  })
}
onMounted(load)
</script>

<template>
  <div class="page skills-page" v-loading="busy">
    <div class="page-head">
      <div><h1 class="page-title">Skills 中心</h1><p class="page-sub">集中管理，一次导入，同步到多个 AI 工具</p></div>
      <div class="actions">
        <el-button :icon="Refresh" :disabled="busy" @click="load">刷新</el-button>
        <el-button :disabled="busy" @click="targetsVisible = true">同步目录</el-button>
        <el-button :disabled="busy" @click="scan">扫描本机</el-button>
        <el-button type="primary" :icon="Plus" :disabled="busy" @click="openAdd()">导入 Skill</el-button>
      </div>
    </div>
    <el-alert v-if="error" class="notice" type="error" :closable="false" :title="error" role="alert" />
    <el-alert v-for="e in data.errors" :key="e" class="notice" type="warning" :closable="false" :title="e" />
    <div class="toolbar">
      <el-input v-model="query" :prefix-icon="Search" placeholder="搜索名称、说明或目录名" clearable aria-label="搜索 Skill" />
      <span class="muted">{{ data.skills.length }} 个 Skill</span>
    </div>
    <div v-if="!data.skills.length" class="empty-state">
      <div class="empty-icon"><el-icon :size="26"><Collection /></el-icon></div>
      <div class="empty-title">建立你的 Skill 库</div>
      <div class="empty-desc">导入包含 SKILL.md 的本地文件夹或 Git 仓库，也可以扫描工具中已安装的 Skill。</div>
      <el-button type="primary" @click="openAdd()">导入第一个 Skill</el-button>
    </div>
    <p v-else-if="!filtered.length" class="muted">没有匹配的 Skill</p>
    <div v-else class="skill-list">
      <article v-for="s in filtered" :key="s.id" class="card skill-card">
        <div class="skill-title"><h2>{{ s.name }}</h2><el-tag size="small" effect="plain">{{ s.source.type === 'git' ? 'Git' : '本地' }}</el-tag></div>
        <p class="description">{{ s.description || '暂无说明' }}</p>
        <div class="path">{{ s.folder }}</div>
        <div class="tags">
          <el-tag v-for="t in s.targets.filter(t => t.state !== 'off')" :key="t.id" size="small" :type="t.state === 'on' ? 'success' : 'warning'" effect="plain">
            {{ data.targets.find(x => x.id === t.id)?.name }}{{ t.state === 'conflict' ? ' · 同名冲突' : '' }}
          </el-tag>
          <span v-if="!s.targets.some(t => t.state === 'on')" class="muted">尚未同步到工具</span>
        </div>
        <div class="card-actions">
          <el-button size="small" @click="run(async () => { detail = await api.skillsDetail(s.id) })">查看</el-button>
          <el-button size="small" @click="confirmAction(s, 'update')">更新</el-button>
          <el-button size="small" type="primary" plain @click="openSync(s)">同步工具</el-button>
          <el-button size="small" type="danger" plain @click="confirmAction(s, 'remove')">删除</el-button>
        </div>
      </article>
    </div>

    <el-dialog v-model="addVisible" title="导入 Skill" width="580px" :close-on-click-modal="false" :before-close="done => { if (!busy) done() }">
      <el-form label-width="90px" @submit.prevent="install">
        <el-form-item label="来源"><el-radio-group v-model="form.type"><el-radio-button value="local">本地文件夹</el-radio-button><el-radio-button value="git">Git 仓库</el-radio-button></el-radio-group></el-form-item>
        <el-form-item v-if="form.type === 'local'" label="文件夹"><el-input v-model="form.path" placeholder="包含 SKILL.md 的目录"><template #append><el-button :icon="FolderOpened" aria-label="选择 Skill 文件夹" @click="choose()" /></template></el-input></el-form-item>
        <template v-else>
          <el-form-item label="仓库地址"><el-input v-model="form.url" placeholder="https://github.com/owner/repository.git" /></el-form-item>
          <el-form-item label="子目录"><el-input v-model="form.subdir" placeholder="如 skills/example；根目录则留空" /></el-form-item>
          <p class="muted">需要本机 Git；使用仓库默认分支。请填写仓库地址，不是网页上的 tree 链接。</p>
        </template>
        <el-form-item label="目录名"><el-input v-model="form.folder" placeholder="如 my-skill（英文、数字、短横线）" /></el-form-item>
        <p class="muted">导入普通文件副本到管理库。确认内容可信后，再通过「同步工具」启用。</p>
        <el-alert v-if="error" type="error" :title="error" :closable="false" />
      </el-form>
      <template #footer><el-button :disabled="busy" @click="addVisible = false">取消</el-button><el-button type="primary" :loading="busy" @click="install">导入</el-button></template>
    </el-dialog>

    <el-dialog v-model="scanVisible" class="skill-scan-dialog" title="本机 Skills" align-center append-to-body :close-on-click-modal="false"
      width="min(1200px, calc(100vw - 48px), calc((100dvh - 100px) * 16 / 9))">
      <template #header="{ titleId, titleClass }">
        <div class="scan-heading"><div class="scan-mark"><el-icon :size="22"><Collection /></el-icon></div><div><h2 :id="titleId" :class="titleClass">本机 Skills</h2><p class="muted">发现散落在各个工具中的技能，汇入你的统一管理库。</p></div></div>
      </template>
      <div class="scan-toolbar">
        <el-input v-model="scanQuery" :prefix-icon="Search" placeholder="搜索名称、说明、工具或路径" clearable aria-label="搜索扫描结果" />
        <span class="scan-count" role="status">{{ scanResults.length }} / {{ found.length }} 个 Skill</span>
      </div>
      <div class="scan-results" tabindex="0" aria-label="本机 Skill 扫描结果">
        <el-alert v-for="e in scanErrors" :key="e" class="notice" type="warning" :title="e" :closable="false" />
        <el-empty v-if="!found.length" description="没有发现可导入的 Skill" />
        <el-empty v-else-if="!scanResults.length" description="没有匹配的 Skill，试试其他关键词"><el-button @click="scanQuery = ''">清空搜索</el-button></el-empty>
        <div v-else class="scan-grid">
          <article v-for="s in scanResults" :key="s.path" class="scan-item">
            <div class="scan-item-head"><h3>{{ s.name }}</h3><el-tag size="small" effect="plain" :title="s.tool">{{ s.tool }}</el-tag></div>
            <p class="scan-description">{{ s.description || '暂无说明' }}</p>
            <div class="scan-item-foot"><div class="path" :title="s.path">{{ s.path }}</div><el-button size="small" type="primary" plain :aria-label="`导入 ${s.name}`" @click="openAdd(s.path)">导入</el-button></div>
          </article>
        </div>
      </div>
      <template #footer><div class="scan-footer"><span class="muted">导入会保留原文件，同名 Skill 可重命名。</span><el-button @click="scanVisible = false">完成</el-button></div></template>
    </el-dialog>

    <el-dialog :model-value="!!syncing" title="同步工具" width="640px" @close="syncing = null">
      <p class="muted">勾选以启用，取消勾选以停用。Windows 使用目录联接，其他系统使用符号链接；更新后所有工具共享新内容。</p>
      <el-checkbox-group v-model="selected">
        <div v-for="t in data.targets" :key="t.id" class="target-row">
          <el-checkbox :value="t.id" :disabled="busy || syncing?.targets.find(x => x.id === t.id)?.state === 'conflict'">{{ t.name }}{{ syncing?.targets.find(x => x.id === t.id)?.state === 'conflict' ? '（同名目录冲突）' : '' }}</el-checkbox>
          <div class="path">{{ t.path }}</div>
        </div>
      </el-checkbox-group>
      <p class="muted">同名原目录不会被覆盖。导入原目录后如需接管，请先自行备份并移走原目录，再刷新。</p>
      <el-alert v-if="error" type="error" :title="error" :closable="false" />
      <template #footer><el-button type="primary" :loading="busy" @click="saveSync">保存同步状态</el-button></template>
    </el-dialog>

    <el-dialog v-model="targetsVisible" title="同步目录" width="700px">
      <div v-for="t in data.targets" :key="t.id" class="target-row"><strong>{{ t.name }}</strong><span class="muted"> · {{ t.exists ? '目录已存在' : '同步时创建' }}</span><el-button v-if="t.id.length === 36" text type="danger" :disabled="busy" @click="run(async () => { data = await api.skillsRemoveTarget(t.id) })">移除目录</el-button><div class="path">{{ t.path }}</div></div>
      <p class="muted">自定义工具或项目：选择该工具实际读取的 skills 目录。</p>
      <el-form label-width="80px">
        <el-form-item label="工具名称"><el-input v-model="target.name" placeholder="如：项目 A · Claude Code" /></el-form-item>
        <el-form-item label="目录"><el-input v-model="target.path"><template #append><el-button :icon="FolderOpened" aria-label="选择同步目录" @click="choose(true)" /></template></el-input></el-form-item>
      </el-form>
      <el-alert v-if="error" type="error" :title="error" :closable="false" />
      <template #footer><el-button :loading="busy" @click="addTarget">添加目录</el-button></template>
    </el-dialog>

    <el-dialog :model-value="!!detail" :title="detail?.name || 'Skill 内容'" width="800px" @close="detail = null">
      <template v-if="detail">
        <p class="path">来源：{{ detail.source.path || detail.source.url }} {{ detail.source.subdir || '' }}</p>
        <el-button :icon="FolderOpened" @click="run(() => api.openPath(detail.path))">打开完整文件夹</el-button>
        <pre class="skill-content">{{ detail.content }}</pre>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head, .actions, .toolbar, .skill-title, .card-actions { display: flex; align-items: center; gap: 10px; }
.page-head { justify-content: space-between; flex-wrap: wrap; margin-bottom: 20px; }
.actions { flex-wrap: wrap; }
.toolbar { margin-bottom: 20px; }
.toolbar .el-input { max-width: 360px; }
.notice { margin-bottom: 12px; }
.skill-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.skill-card { min-width: 0; display: flex; flex-direction: column; }
.skill-title { justify-content: space-between; }
h2 { font-size: 16px; margin: 0; overflow-wrap: anywhere; }
.description { color: var(--oh-text-dim); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.muted { color: var(--oh-text-dim); font-size: 12px; line-height: 1.7; }
.path { color: var(--oh-text-dim); font: 12px/1.6 Consolas, monospace; overflow-wrap: anywhere; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; }
.card-actions { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--oh-border); justify-content: flex-end; flex-wrap: wrap; }
.card-actions .el-button + .el-button, .actions .el-button + .el-button { margin-left: 0; }
.target-row { padding: 10px 0; border-bottom: 1px solid var(--oh-border); }
:global(.el-dialog.skill-scan-dialog) { aspect-ratio: 16 / 9; box-sizing: border-box; padding: 24px; display: flex; flex-direction: column; overflow: hidden; }
:global(.skill-scan-dialog .el-dialog__header) { flex-shrink: 0; padding-bottom: 18px; }
:global(.skill-scan-dialog .el-dialog__body) { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
:global(.skill-scan-dialog .el-dialog__footer) { flex-shrink: 0; padding-top: 16px; }
.scan-heading, .scan-toolbar, .scan-item-head, .scan-item-foot, .scan-footer { display: flex; align-items: center; gap: 12px; }
.scan-heading p { margin: 4px 0 0; }
.scan-mark { width: 42px; height: 42px; flex-shrink: 0; display: grid; place-items: center; border-radius: 10px; color: var(--oh-primary); background: var(--oh-primary-soft); }
.scan-toolbar { flex-shrink: 0; padding-bottom: 16px; }
.scan-toolbar .el-input { flex: 1; }
.scan-count { white-space: nowrap; font-size: 12px; color: var(--oh-text-dim); font-variant-numeric: tabular-nums; }
.scan-results { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.scan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 12px; }
.scan-item { min-width: 0; padding: 16px; border: 1px solid var(--oh-border); border-radius: 12px; display: flex; flex-direction: column; }
.scan-item-head { justify-content: space-between; align-items: flex-start; }
.scan-item-head h3 { margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.scan-item-head .el-tag { flex-shrink: 0; max-width: 45%; min-width: 0; }
.scan-item-head :deep(.el-tag__content) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scan-description { margin: 10px 0 14px; color: var(--oh-text-dim); font-size: 12px; line-height: 1.65; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.scan-item-foot { margin-top: auto; }
.scan-item-foot .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scan-footer { justify-content: space-between; }
@media (max-width: 1000px), (max-height: 650px) {
  :global(.el-dialog.skill-scan-dialog) { padding: 16px; }
  :global(.skill-scan-dialog .el-dialog__header) { padding-bottom: 12px; }
  :global(.skill-scan-dialog .el-dialog__footer) { padding-top: 12px; }
  .scan-toolbar { padding-bottom: 12px; }
}
.skill-content { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 55vh; overflow: auto; padding: 16px; border: 1px solid var(--oh-border); border-radius: 8px; font: 13px/1.7 Consolas, monospace; }
</style>
