<script setup>
import { api } from '@/api'
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh, Right } from '@element-plus/icons-vue'

const router = useRouter()
const harnesses = ref([])
const loading = ref(false)

const features = [
  { title: 'Harness 聚合', desc: '检测并管理本机桌面级 Agent Harness：Claude Desktop、Cursor、Trae、Windsurf、VS Code 等', path: '/harness', icon: 'Box' },
  { title: '模型服务', desc: '统一配置 Provider（OpenAI 兼容 / Anthropic / 火山方舟），一处配置处处可用', path: '/providers', icon: 'Cpu' },
  { title: 'MCP 中心', desc: '集中注册 MCP Server，一键注入到各 Harness 的配置文件', path: '/mcp', icon: 'Connection' },
  { title: '统一对话', desc: '多模型流式对话，随时切换 Provider 与模型', path: '/chat', icon: 'ChatDotRound' }
]

const installedCount = computed(() => harnesses.value.filter((h) => h.installed).length)

async function load() {
  loading.value = true
  try {
    harnesses.value = await api.harnessList()
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page home">
    <section class="hero">
      <h1 class="hero-title">OpenHarness</h1>
      <p class="hero-sub">桌面级 Agent Harness 统一集成服务 —— 一个入口，管理你所有的 AI Agent</p>
      <div class="hero-actions">
        <el-button type="primary" size="large" @click="router.push('/harness')">管理 Harness</el-button>
        <el-button size="large" @click="router.push('/chat')">开始对话</el-button>
      </div>
    </section>

    <section class="feature-grid">
      <div v-for="f in features" :key="f.path" class="card card-hover feature-card" @click="router.push(f.path)">
        <div class="feature-icon">
          <el-icon :size="20"><component :is="f.icon" /></el-icon>
        </div>
        <div class="feature-body">
          <div class="feature-title">{{ f.title }}</div>
          <div class="feature-desc">{{ f.desc }}</div>
        </div>
        <el-icon class="feature-arrow" :size="16"><Right /></el-icon>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h3 class="section-title">
          本机 Harness 状态
          <span v-if="harnesses.length" class="section-count">{{ installedCount }}/{{ harnesses.length }} 已安装</span>
        </h3>
        <el-button :icon="Refresh" text :loading="loading" @click="load">刷新</el-button>
      </div>
      <div v-if="harnesses.length" class="status-grid">
        <div v-for="h in harnesses" :key="h.id" class="card card-hover status-card">
          <span class="status-dot" :class="h.installed ? 'on' : 'off'" />
          <div class="status-name" :title="h.name">{{ h.name }}</div>
          <div class="status-tag">{{ h.installed ? '已安装' : '未检测到' }}</div>
        </div>
      </div>
      <div v-else class="card status-empty">
        <el-icon :size="24"><Box /></el-icon>
        <span>未检测到任何 Harness，点击右上角「刷新」重新扫描</span>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.home {
  max-width: 1080px;
}

.hero {
  padding: 44px 0 36px;
}

.hero-title {
  font-size: 38px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin: 0 0 10px;
}

.hero-sub {
  color: var(--oh-text-2);
  font-size: 15px;
  margin: 0 0 24px;
}

.hero-actions {
  display: flex;
  gap: 12px;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
  margin-bottom: 36px;
}

.feature-card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  cursor: pointer;

  &:hover .feature-arrow {
    opacity: 1;
    transform: translateX(0);
  }
}

.feature-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--oh-radius);
  background: var(--oh-primary-soft);
  color: var(--oh-primary);
  flex-shrink: 0;
}

.feature-body {
  flex: 1;
  min-width: 0;
}

.feature-title {
  font-weight: 600;
  margin-bottom: 5px;
}

.feature-desc {
  font-size: 13px;
  color: var(--oh-text-dim);
  line-height: 1.55;
}

.feature-arrow {
  align-self: center;
  color: var(--oh-primary);
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity var(--oh-dur) var(--oh-ease),
    transform var(--oh-dur) var(--oh-ease);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-count {
  margin-left: 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--oh-text-dim);
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.status-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;

  &.on {
    background: var(--oh-success);
    box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.15);
  }
  &.off {
    background: var(--oh-text-dim);
    opacity: 0.5;
  }
}

.status-name {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-tag {
  margin-left: auto;
  font-size: 12px;
  color: var(--oh-text-dim);
  white-space: nowrap;
  flex-shrink: 0;
}

.status-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--oh-text-dim);
  font-size: 13px;
  padding: 18px 20px;
}
</style>
