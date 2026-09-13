<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search, FolderOpened, ArrowLeft, Collection } from '@element-plus/icons-vue'
import { api } from '@/api'
import { iconFallback } from '@/icon-fallback'
import { useAppStore } from '@/store/app'

const emptyData = { skills: [], targets: [], errors: [], root: '' }
const appStore = useAppStore()
const data = ref(emptyData)
const harnesses = ref([])
const busy = ref(false)
const error = ref('')
const managing = ref(false)
const managementTab = ref('scan')
const overviewQuery = ref('')
const libraryQuery = ref('')
const found = ref([])
const scanErrors = ref([])
const scanQuery = ref('')
const selectedScan = ref([])
const importedScan = ref(new Set())
const importVisible = ref(false)
const selectedTargets = ref([])
const syncing = ref(null)
const selectedSyncTargets = ref([])
const harnessDetail = ref(null)
const detail = ref(null)
const addVisible = ref(false)
const targetsVisible = ref(false)
const form = ref({ type: 'local', path: '', url: '', subdir: '', folder: '' })
const target = ref({ name: '', path: '' })

const targetCards = computed(() => harnesses.value
  .map((harness) => {
    const target = data.value.targets.find((item) => item.id === harness.id)
    return {
      ...harness,
      target,
      path: target?.path || '',
      exists: !!target?.exists,
      skills: target?.skills || [],
      syncSupported: !!target
    }
  })
  .sort((a, b) => Number(b.installed) - Number(a.installed)))

const customTargets = computed(() => data.value.targets
  .filter((target) => !harnesses.value.some((harness) => harness.id === target.id))
  .map((target) => ({ ...target, installed: false, syncSupported: true })))

const syncTargets = computed(() => [
  ...targetCards.value.filter((card) => card.syncSupported),
  ...customTargets.value
])

const overviewCards = computed(() => {
  const q = overviewQuery.value.trim().toLowerCase()
  if (!q) return targetCards.value
  return targetCards.value.filter((card) => `${card.name} ${card.path} ${card.skills.map((skill) => skill.name).join(' ')}`.toLowerCase().includes(q))
})

const scanResults = computed(() => {
  const q = scanQuery.value.trim().toLowerCase()
  return found.value.filter((skill) => [skill.name, skill.description, skill.tool, skill.path].some((value) => String(value || '').toLowerCase().includes(q)))
})

const selectedScanItems = computed(() => found.value.filter((skill) => selectedScan.value.includes(skill.path)))
const managedSkills = computed(() => {
  const q = libraryQuery.value.trim().toLowerCase()
  return data.value.skills.filter((skill) => `${skill.name} ${skill.description} ${skill.folder}`.toLowerCase().includes(q))
})

async function run(fn) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = e.message || String(e)
  } finally {
    busy.value = false
  }
}

async function load(force = false) {
  await run(async () => {
    const [skillsResult, harnessResult] = await Promise.allSettled([api.skillsList(), api.harnessList(force)])
    if (skillsResult.status === 'fulfilled') data.value = skillsResult.value || emptyData
    else throw skillsResult.reason
    harnesses.value = harnessResult.status === 'fulfilled' ? harnessResult.value || [] : []
  })
}

function enterManagement() {
  managing.value = true
  managementTab.value = 'scan'
  error.value = ''
}

function leaveManagement() {
  managing.value = false
  importVisible.value = false
  harnessDetail.value = null
  detail.value = null
  error.value = ''
}

async function scan() {
  await run(async () => {
    const result = await api.skillsScan()
    found.value = result.found || []
    scanErrors.value = result.errors || []
    scanQuery.value = ''
    selectedScan.value = []
    importedScan.value = new Set()
  })
}

function setScanSelected(path, checked) {
  if (importedScan.value.has(path)) return
  selectedScan.value = checked
    ? [...new Set([...selectedScan.value, path])]
    : selectedScan.value.filter((item) => item !== path)
}

function isImported(path) {
  return importedScan.value.has(path)
}

function openImport() {
  if (!selectedScanItems.value.length) {
    ElMessage.warning('请先勾选要导入的 Skill')
    return
  }
  selectedTargets.value = []
  importVisible.value = true
}

function folderName(candidate, reserved, index) {
  const sourceName = candidate.path.split(/[\\/]/).pop() || `skill-${index + 1}`
  const base = sourceName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || `skill-${index + 1}`
  const safeBase = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(base) ? `skill-${base}` : base
  let folder = safeBase
  let suffix = 2
  while (reserved.has(folder.toLowerCase())) folder = `${safeBase}-${suffix++}`
  reserved.add(folder.toLowerCase())
  return folder
}

async function importSelected() {
  if (!selectedTargets.value.length) {
    ElMessage.warning('请选择目标 Harness')
    return
  }
  await run(async () => {
    const reserved = new Set(data.value.skills.map((skill) => skill.folder.toLowerCase()))
    const imported = []
    const failed = []
    for (const [index, candidate] of selectedScanItems.value.entries()) {
      try {
        const folder = folderName(candidate, reserved, index)
        const result = await api.skillsInstall({ type: 'local', path: candidate.path }, folder)
        const skill = result.skills.find((item) => item.folder.toLowerCase() === folder.toLowerCase())
        if (!skill) throw new Error('导入后没有找到 Skill 记录')
        await api.skillsSync(skill.id, selectedTargets.value)
        imported.push(candidate.path)
      } catch (e) {
        failed.push(`${candidate.name || candidate.path}: ${e.message || e}`)
      }
    }
    data.value = await api.skillsList()
    selectedScan.value = selectedScan.value.filter((path) => !imported.includes(path))
    importedScan.value = new Set([...importedScan.value, ...imported])
    importVisible.value = false
    if (failed.length) error.value = `已导入 ${imported.length} 个，失败 ${failed.length} 个：${failed.join('；')}`
    else ElMessage.success(`已将 ${imported.length} 个 Skill 导入到 ${selectedTargets.value.length} 个 Harness`)
  })
}

function openHarnessDetail(card) {
  harnessDetail.value = card
}

function openSkillSync(skill) {
  syncing.value = skill
  selectedSyncTargets.value = skill.targets.filter((item) => item.state === 'on').map((item) => item.id)
}

async function saveSkillSync() {
  if (!syncing.value) return
  await run(async () => {
    data.value = await api.skillsSync(syncing.value.id, selectedSyncTargets.value)
    syncing.value = null
    ElMessage.success('目标 Harness 已保存')
  })
}

function openAdd(path = '') {
  form.value = { type: 'local', path, url: '', subdir: '', folder: path.split(/[\\/]/).pop() || '' }
  addVisible.value = true
}

async function choose(forTarget = false) {
  await run(async () => {
    const path = await api.skillsPickDirectory()
    if (!path) return
    if (forTarget) target.value.path = path
    else {
      form.value.path = path
      form.value.folder = path.split(/[\\/]/).pop()
    }
  })
}

async function installManual() {
  await run(async () => {
    const source = form.value.type === 'local'
      ? { type: 'local', path: form.value.path }
      : { type: 'git', url: form.value.url.trim(), subdir: form.value.subdir.trim() }
    data.value = await api.skillsInstall(source, form.value.folder.trim())
    addVisible.value = false
    ElMessage.success('已导入管理库，请在管理库中选择目标 Harness')
  })
}

async function confirmAction(skill, action) {
  try {
    await ElMessageBox.confirm(
      action === 'remove'
        ? `删除「${skill.name}」的管理库副本和由本应用创建的同步链接？原始导入目录会保留。`
        : `从原始来源重新获取「${skill.name}」？管理库中的手动修改会被替换。`,
      action === 'remove' ? '删除 Skill' : '更新 Skill',
      { type: 'warning' }
    )
  } catch {
    return
  }
  await run(async () => {
    data.value = action === 'remove' ? await api.skillsRemove(skill.id) : await api.skillsUpdate(skill.id)
    ElMessage.success(action === 'remove' ? '已删除' : '已更新')
  })
}

function openSkillDetail(skill) {
  run(async () => { detail.value = await api.skillsDetail(skill.id) })
}

async function addTarget() {
  await run(async () => {
    data.value = await api.skillsAddTarget(target.value)
    target.value = { name: '', path: '' }
    ElMessage.success('已添加 Skill 目录')
  })
}

async function removeTarget(id) {
  await run(async () => {
    data.value = await api.skillsRemoveTarget(id)
    ElMessage.success('已移除 Skill 目录')
  })
}

let offHarnessUpdated = null
onMounted(() => {
  load()
  if (api.onHarnessUpdated) offHarnessUpdated = api.onHarnessUpdated(async (list) => {
    harnesses.value = list || []
    try { data.value = (await api.skillsList()) || emptyData } catch (e) { error.value = e.message || String(e) }
  })
})
onUnmounted(() => offHarnessUpdated?.())
</script>

<template>
  <div class="page skills-page" :class="{ 'is-manage': managing }" v-loading="busy">
    <template v-if="!managing">
      <div class="page-head">
        <div>
          <h1 class="page-title">Skills 中心</h1>
          <p class="page-sub">按 Harness 查看本机已有的 Skill，按需导入到指定目标</p>
        </div>
        <div class="actions">
          <el-button :icon="Refresh" :disabled="busy" @click="load(true)">刷新</el-button>
          <el-button type="primary" :icon="Collection" :disabled="busy" @click="enterManagement">Skill 管理</el-button>
        </div>
      </div>
      <el-alert v-if="error" class="notice" type="error" :closable="false" :title="error" role="alert" />
      <el-alert v-for="item in data.errors" :key="item" class="notice" type="warning" :closable="false" :title="item" />
      <div class="overview-toolbar">
        <el-input v-model="overviewQuery" :prefix-icon="Search" placeholder="搜索 Harness 或 Skill" clearable aria-label="搜索 Harness" />
        <span class="muted">{{ targetCards.length }} 个 Harness</span>
      </div>
      <div v-if="overviewCards.length" class="harness-grid">
        <article v-for="card in overviewCards" :key="card.id" class="card harness-skill-card" :data-target-id="card.id" tabindex="0" @click="openHarnessDetail(card)" @keydown.enter="openHarnessDetail(card)">
          <div class="harness-card-head">
            <img v-if="card.icon" :src="card.icon" class="harness-icon" :class="{ 'harness-icon-dark': appStore.theme === 'dark' && /simpleicons|jsdelivr/.test(card.icon || '') }" :alt="`${card.name} 图标`" @error="iconFallback($event, card.name, card.color)" />
            <div v-else class="harness-avatar" :style="{ background: card.color || 'var(--oh-primary)' }">{{ card.name.slice(0, 2).toUpperCase() }}</div>
            <div class="harness-card-title">
              <h2>{{ card.name }}</h2>
              <el-tag size="small" :type="card.installed ? 'success' : card.exists ? 'info' : 'warning'" effect="plain">{{ card.installed ? '已安装' : card.exists ? '目录可用' : '未检测到' }}</el-tag>
            </div>
          </div>
          <div class="harness-card-count"><strong>{{ card.skills.length }}</strong><span>个本机 Skill</span></div>
          <div v-if="card.skills.length" class="harness-skill-list">
            <div v-for="skill in card.skills.slice(0, 4)" :key="skill.path" class="harness-skill-row" :title="skill.name"><span class="skill-dot" />{{ skill.name }}</div>
            <div v-if="card.skills.length > 4" class="harness-more">还有 {{ card.skills.length - 4 }} 个，点击查看全部</div>
          </div>
          <div v-else class="harness-empty">尚未发现 Skill</div>
          <div class="harness-card-foot"><span class="path" :title="card.path">{{ card.path || '未配置 Skill 目录' }}</span><el-button text type="primary" @click.stop="openHarnessDetail(card)">查看详情</el-button></div>
        </article>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon"><el-icon :size="26"><Collection /></el-icon></div>
        <div class="empty-title">没有匹配的 Harness</div>
        <div class="empty-desc">可以进入 Skill 管理扫描本机，导入 Skill 后再选择目标 Harness。</div>
        <el-button type="primary" @click="enterManagement">进入 Skill 管理</el-button>
      </div>
    </template>

    <template v-else>
      <div class="page-head manage-head">
        <div>
          <div class="manage-back" @click="leaveManagement"><el-icon><ArrowLeft /></el-icon>返回概览</div>
          <h1 class="page-title">Skill 管理</h1>
          <p class="page-sub">扫描本机 Skill，勾选后导入到指定 Harness</p>
        </div>
        <div class="actions">
          <el-button :icon="Refresh" :disabled="busy" @click="load(true)">刷新</el-button>
          <el-tooltip content="配置各 Harness 实际读取 Skill 的文件夹；扫描和导入都会使用这里的目录" placement="bottom">
            <el-button :disabled="busy" @click="targetsVisible = true">Skill 目录</el-button>
          </el-tooltip>
          <el-button :disabled="busy" @click="openAdd()">手动导入</el-button>
          <el-button :disabled="busy" @click="scan">扫描本机</el-button>
          <el-button type="primary" :icon="Plus" :disabled="busy || !selectedScanItems.length" @click="openImport">导入 Skill</el-button>
        </div>
      </div>
      <el-alert v-if="error" class="notice" type="error" :closable="false" :title="error" role="alert" />
      <el-tabs v-model="managementTab" class="manage-tabs">
        <el-tab-pane label="扫描本机" name="scan">
          <section class="manage-section scan-section">
            <div class="section-head">
              <div><h2>本机扫描结果</h2><p class="muted">只显示包含 SKILL.md 的目录；原目录不会被修改。</p></div>
              <div v-if="found.length" class="scan-tools"><el-input v-model="scanQuery" :prefix-icon="Search" placeholder="搜索名称、说明、工具或路径" clearable aria-label="搜索扫描结果" /><span class="scan-count" role="status">已选 {{ selectedScanItems.length }} · {{ scanResults.length }} / {{ found.length }}</span></div>
            </div>
            <div v-if="scanErrors.length" class="scan-errors"><el-alert v-for="item in scanErrors" :key="item" type="warning" :title="item" :closable="false" /></div>
            <div v-if="!found.length" class="manage-empty"><el-icon :size="24"><Collection /></el-icon><strong>还没有扫描结果</strong><span>点击右上角「扫描本机」，把散落在各个工具里的 Skill 集中到这里。</span><el-button type="primary" :disabled="busy" @click="scan">扫描本机</el-button></div>
            <div v-else-if="!scanResults.length" class="manage-empty"><strong>没有匹配的 Skill</strong><span>试试其他关键词。</span><el-button @click="scanQuery = ''">清空搜索</el-button></div>
            <div v-else class="scan-grid">
              <article v-for="skill in scanResults" :key="skill.path" class="scan-item" :class="{ selected: selectedScan.includes(skill.path), imported: isImported(skill.path) }">
                <div class="scan-item-top"><el-checkbox :model-value="selectedScan.includes(skill.path)" :disabled="isImported(skill.path)" :aria-label="`选择 ${skill.name}`" @click.stop @change="setScanSelected(skill.path, $event)" /><el-tag size="small" effect="plain">{{ skill.tool }}</el-tag><el-tag v-if="isImported(skill.path)" size="small" type="success" effect="plain">已导入</el-tag></div>
                <h3 :title="skill.name">{{ skill.name }}</h3>
                <p class="scan-description">{{ skill.description || '暂无说明' }}</p>
                <div class="scan-item-foot"><div class="path" :title="skill.path">{{ skill.path }}</div><span class="scan-state">{{ isImported(skill.path) ? '已纳入管理库' : '待导入' }}</span></div>
              </article>
            </div>
          </section>
        </el-tab-pane>

        <el-tab-pane label="管理库" name="library">
          <section class="manage-section library-section">
            <div class="section-head"><div><h2>管理库</h2><p class="muted">集中查看、更新和删除已导入的 Skill。</p></div><div class="library-tools"><el-input v-model="libraryQuery" :prefix-icon="Search" placeholder="搜索管理库" clearable aria-label="搜索管理库" /><span class="muted">{{ data.skills.length }} 个 Skill</span></div></div>
            <div v-if="!managedSkills.length" class="manage-empty compact"><span>管理库还是空的，先扫描并导入一个 Skill。</span></div>
            <div v-else class="library-grid">
              <article v-for="skill in managedSkills" :key="skill.id" class="card library-card">
                <div class="library-title"><h3 :title="skill.name">{{ skill.name }}</h3><el-tag size="small" effect="plain">{{ skill.source.type === 'git' ? 'Git' : '本地' }}</el-tag></div>
                <p class="description">{{ skill.description || '暂无说明' }}</p><div class="path">{{ skill.folder }}</div>
                <div class="tags"><el-tag v-for="targetItem in skill.targets.filter((item) => item.state !== 'off')" :key="targetItem.id" size="small" :type="targetItem.state === 'on' ? 'success' : 'warning'" effect="plain">{{ data.targets.find((item) => item.id === targetItem.id)?.name }}{{ targetItem.state === 'conflict' ? ' · 同名冲突' : '' }}</el-tag><span v-if="!skill.targets.some((item) => item.state === 'on')" class="muted">尚未同步</span></div>
                <div class="card-actions"><el-button size="small" @click="openSkillDetail(skill)">查看</el-button><el-button size="small" @click="confirmAction(skill, 'update')">更新</el-button><el-button size="small" type="primary" plain @click="openSkillSync(skill)">同步工具</el-button><el-button size="small" type="danger" plain @click="confirmAction(skill, 'remove')">删除</el-button></div>
              </article>
            </div>
          </section>
        </el-tab-pane>
      </el-tabs>
    </template>

    <el-dialog v-model="importVisible" title="选择目标 Harness" width="min(680px, 92vw)" :close-on-click-modal="false">
      <p class="muted">已选择 {{ selectedScanItems.length }} 个 Skill。勾选目标后导入，已有同名目录不会被覆盖。</p>
      <el-checkbox-group v-model="selectedTargets" aria-label="选择目标 Harness">
        <div v-for="card in syncTargets" :key="card.id" class="import-target-row"><el-checkbox :value="card.id"><strong>{{ card.name }}</strong><el-tag size="small" :type="card.installed ? 'success' : 'info'" effect="plain">{{ card.installed ? '已安装' : card.exists ? '目录可用' : '未检测到' }}</el-tag></el-checkbox><div class="path">{{ card.path }}</div></div>
      </el-checkbox-group>
      <template #footer><el-button :disabled="busy" @click="importVisible = false">取消</el-button><el-button type="primary" :loading="busy" aria-label="导入到选中 Harness" @click="importSelected">导入到选中 Harness</el-button></template>
    </el-dialog>

    <el-dialog :model-value="!!syncing" title="同步工具" width="min(680px, 92vw)" :close-on-click-modal="false" @close="syncing = null">
      <p class="muted">选择「{{ syncing?.name }}」要同步到的 Harness；取消勾选会移除由本应用创建的同步链接。</p>
      <el-checkbox-group v-model="selectedSyncTargets" aria-label="选择同步 Harness">
        <div v-for="card in syncTargets" :key="card.id" class="import-target-row"><el-checkbox :value="card.id" :disabled="syncing?.targets.find((item) => item.id === card.id)?.state === 'conflict'"><strong>{{ card.name }}</strong><el-tag size="small" :type="card.installed ? 'success' : 'info'" effect="plain">{{ card.installed ? '已安装' : card.exists ? '目录可用' : '未检测到' }}</el-tag></el-checkbox><div class="path">{{ card.path }}</div></div>
      </el-checkbox-group>
      <template #footer><el-button :disabled="busy" @click="syncing = null">取消</el-button><el-button type="primary" :loading="busy" @click="saveSkillSync">保存同步状态</el-button></template>
    </el-dialog>

    <el-dialog v-model="addVisible" title="手动导入 Skill" width="min(580px, 92vw)" :close-on-click-modal="false">
      <el-form label-width="90px" @submit.prevent="installManual">
        <el-form-item label="来源"><el-radio-group v-model="form.type"><el-radio-button value="local">本地文件夹</el-radio-button><el-radio-button value="git">Git 仓库</el-radio-button></el-radio-group></el-form-item>
        <el-form-item v-if="form.type === 'local'" label="文件夹"><el-input v-model="form.path" placeholder="包含 SKILL.md 的目录"><template #append><el-button :icon="FolderOpened" aria-label="选择 Skill 文件夹" @click="choose()" /></template></el-input></el-form-item>
        <template v-else><el-form-item label="仓库地址"><el-input v-model="form.url" placeholder="https://github.com/owner/repository.git" /></el-form-item><el-form-item label="子目录"><el-input v-model="form.subdir" placeholder="如 skills/example；根目录则留空" /></el-form-item><p class="muted">需要本机 Git；使用仓库默认分支。</p></template>
        <el-form-item label="目录名"><el-input v-model="form.folder" placeholder="如 my-skill（英文、数字、短横线）" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="addVisible = false">取消</el-button><el-button type="primary" :loading="busy" @click="installManual">导入</el-button></template>
    </el-dialog>

    <el-dialog v-model="targetsVisible" title="Skill 目录设置" width="min(700px, 92vw)">
      <div v-for="item in data.targets" :key="item.id" class="target-row"><strong>{{ item.name }}</strong><span class="muted"> · {{ item.exists ? '目录已存在' : '导入时创建' }}</span><el-button v-if="item.id.length === 36" text type="danger" :disabled="busy" @click="removeTarget(item.id)">移除目录</el-button><div class="path">{{ item.path }}</div></div>
      <p class="muted target-help">Skill 目录就是 Harness 实际读取 Skill 的文件夹。扫描本机和导入目标都会使用这里的目录；也可以添加自定义工具或项目目录。</p>
      <el-form label-width="80px"><el-form-item label="工具名称"><el-input v-model="target.name" placeholder="如：项目 A · Claude Code" /></el-form-item><el-form-item label="Skill 目录"><el-input v-model="target.path"><template #append><el-button :icon="FolderOpened" aria-label="选择 Skill 目录" @click="choose(true)" /></template></el-input></el-form-item></el-form>
      <template #footer><el-button :loading="busy" @click="addTarget">添加目录</el-button></template>
    </el-dialog>

    <el-dialog :model-value="!!harnessDetail" :title="`${harnessDetail?.name || 'Harness'} · 本机 Skill`" width="min(720px, 92vw)" @close="harnessDetail = null">
      <div v-if="harnessDetail" class="harness-detail"><div class="detail-header"><img v-if="harnessDetail.icon" :src="harnessDetail.icon" class="harness-icon" :class="{ 'harness-icon-dark': appStore.theme === 'dark' && /simpleicons|jsdelivr/.test(harnessDetail.icon || '') }" :alt="`${harnessDetail.name} 图标`" @error="iconFallback($event, harnessDetail.name, harnessDetail.color)" /><div v-else class="harness-avatar" :style="{ background: harnessDetail.color || 'var(--oh-primary)' }">{{ (harnessDetail.name || 'Harness').slice(0, 2).toUpperCase() }}</div><div><strong>{{ harnessDetail.skills.length }} 个 Skill</strong><div class="path">{{ harnessDetail.path || '未配置 Skill 目录' }}</div></div></div><div v-if="harnessDetail.skills.length" class="detail-skill-list"><div v-for="skill in harnessDetail.skills" :key="skill.path" class="detail-skill" :class="{ clickable: skill.id }" @click="skill.id && openSkillDetail(skill)"><span class="skill-dot" /><span>{{ skill.name }}</span><span class="muted">{{ skill.id ? '查看内容 →' : '本机已有' }}</span></div></div><div v-else class="manage-empty compact"><span>这个 Harness 还没有发现 Skill。</span></div></div>
    </el-dialog>

    <el-dialog :model-value="!!detail" :title="detail?.name || 'Skill 内容'" width="min(800px, 92vw)" @close="detail = null">
      <template v-if="detail"><p class="path">来源：{{ detail.source.path || detail.source.url }} {{ detail.source.subdir || '' }}</p><el-button :icon="FolderOpened" @click="run(() => api.openPath(detail.path))">打开完整文件夹</el-button><pre class="skill-content">{{ detail.content }}</pre></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head, .actions, .overview-toolbar, .section-head, .scan-tools, .library-tools, .harness-card-head, .library-title, .card-actions, .scan-item-top, .scan-item-foot, .detail-header { display: flex; align-items: center; gap: 10px; }
.page-head { justify-content: space-between; flex-wrap: wrap; margin-bottom: 20px; }
.actions { flex-wrap: wrap; justify-content: flex-end; }
.overview-toolbar { margin-bottom: 20px; }
.overview-toolbar .el-input { max-width: 400px; }
.notice { margin-bottom: 12px; }
.muted { color: var(--oh-text-dim); font-size: 12px; line-height: 1.7; }
.path { color: var(--oh-text-dim); font: 12px/1.6 Consolas, 'JetBrains Mono', monospace; overflow-wrap: anywhere; }
.harness-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr)); gap: 14px; }
.harness-skill-card { height: 274px; min-width: 0; padding: 18px; display: flex; flex-direction: column; cursor: pointer; transition: border-color var(--oh-dur) var(--oh-ease), transform var(--oh-dur) var(--oh-ease); }
.harness-skill-card:hover, .harness-skill-card:focus-visible { border-color: var(--oh-primary); transform: translateY(-1px); outline: none; }
.harness-icon { width: 42px; height: 42px; border-radius: 11px; object-fit: contain; flex-shrink: 0; }
.harness-icon-dark { filter: invert(1); }
.harness-card-head { min-width: 0; }
.harness-avatar { width: 42px; height: 42px; border-radius: 11px; display: grid; place-items: center; flex-shrink: 0; color: #fff; font-size: 13px; font-weight: 700; letter-spacing: .02em; }
.harness-card-title { min-width: 0; flex: 1; }
.harness-card-title h2 { margin: 0 0 6px; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.harness-card-count { display: flex; align-items: baseline; gap: 8px; margin: 20px 0 10px; }
.harness-card-count strong { font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.harness-card-count span { color: var(--oh-text-dim); font-size: 12px; }
.harness-skill-list { height: 92px; overflow: hidden; }
.harness-skill-row, .harness-more { height: 22px; display: flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--oh-text); font-size: 12px; }
.harness-more { color: var(--oh-primary); }
.skill-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--oh-primary); }
.harness-empty { height: 92px; display: flex; align-items: center; color: var(--oh-text-dim); font-size: 12px; }
.harness-card-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--oh-border); }
.harness-card-foot .path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.harness-card-foot .el-button { flex-shrink: 0; padding: 0 4px; }
.is-manage .page-head { margin-bottom: 14px; }
.manage-back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 8px; color: var(--oh-primary); cursor: pointer; font-size: 12px; }
.manage-tabs { margin-top: 4px; }
.manage-tabs :deep(.el-tabs__header) { position: sticky; top: -1px; z-index: 4; margin-bottom: 0; padding-top: 2px; background: var(--oh-bg); }
.manage-tabs :deep(.el-tabs__content) { overflow: visible; }
.manage-section { margin-top: 18px; }
.section-head { justify-content: space-between; align-items: flex-end; margin-bottom: 12px; }
.section-head h2 { margin: 0 0 4px; font-size: 16px; }
.section-head p { margin: 0; }
.scan-tools, .library-tools { flex-wrap: wrap; justify-content: flex-end; }
.scan-tools .el-input { width: min(320px, 42vw); }
.library-tools .el-input { width: 240px; }
.scan-count { color: var(--oh-text-dim); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.scan-errors { display: grid; gap: 8px; margin-bottom: 12px; }
.manage-empty { min-height: 210px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: 1px dashed var(--oh-border); border-radius: 14px; color: var(--oh-text-dim); text-align: center; padding: 20px; }
.manage-empty strong { color: var(--oh-text); }
.manage-empty.compact { min-height: 90px; }
.scan-grid, .library-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr)); gap: 12px; }
.scan-item { height: 218px; min-width: 0; padding: 15px; border: 1px solid var(--oh-border); border-radius: 12px; display: flex; flex-direction: column; background: var(--oh-bg-card); transition: border-color var(--oh-dur) var(--oh-ease), background var(--oh-dur) var(--oh-ease); }
.scan-item.selected { border-color: var(--oh-primary); background: var(--oh-primary-soft); }
.scan-item.imported { opacity: .7; }
.scan-item-top { min-height: 24px; }
.scan-item-top .el-tag:first-of-type { margin-left: auto; max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scan-item h3 { margin: 14px 0 8px; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scan-description { height: 42px; margin: 0 0 12px; color: var(--oh-text-dim); font-size: 12px; line-height: 1.7; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.scan-item-foot { min-width: 0; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--oh-border); }
.scan-item-foot .path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.scan-state { flex-shrink: 0; color: var(--oh-text-dim); font-size: 11px; }
.library-section { padding-top: 4px; }
.library-card { min-width: 0; min-height: 220px; display: flex; flex-direction: column; }
.library-title { justify-content: space-between; }
.library-title h3 { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.description { color: var(--oh-text-dim); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.card-actions { justify-content: flex-end; flex-wrap: wrap; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--oh-border); }
.card-actions .el-button + .el-button { margin-left: 0; }
.import-target-row, .target-row { padding: 10px 4px; border-bottom: 1px solid var(--oh-border); }
.import-target-row:last-child, .target-row:last-child { border-bottom: none; }
.import-target-row .el-tag { margin-left: 8px; }
.import-target-row .path { margin: 3px 0 0 24px; }
.harness-detail { min-height: 220px; }
.detail-header { padding: 4px 0 16px; border-bottom: 1px solid var(--oh-border); }
.detail-header strong { font-size: 18px; }
.detail-skill-list { display: grid; gap: 6px; padding-top: 12px; max-height: 48vh; overflow: auto; }
.detail-skill { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 12px; border: 1px solid var(--oh-border); border-radius: 9px; background: transparent; color: var(--oh-text); text-align: left; cursor: pointer; }
.detail-skill:not(.clickable) { cursor: default; }
.detail-skill span:nth-child(2) { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-skill:hover { border-color: var(--oh-primary); }
.skill-content { max-height: 55vh; margin-top: 14px; padding: 16px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--oh-border); border-radius: 8px; font: 13px/1.7 Consolas, 'JetBrains Mono', monospace; }
@media (max-width: 900px) {
  .section-head { align-items: flex-start; flex-direction: column; }
  .scan-tools, .library-tools { width: 100%; justify-content: flex-start; }
  .scan-tools .el-input, .library-tools .el-input { width: min(100%, 360px); }
}
@media (max-width: 600px) {
  .page-head { align-items: flex-start; }
  .actions { width: 100%; justify-content: flex-start; }
  .harness-skill-card { height: 260px; }
  .scan-item { height: 208px; }
}
</style>
