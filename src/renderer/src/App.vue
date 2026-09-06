<script setup>
import { onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/store/app'
import { Moon, Sunny } from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const navs = [
  { path: '/home', name: '首页', icon: 'HomeFilled' },
  { path: '/chat', name: '对话', icon: 'ChatDotRound' },
  { path: '/workspace', name: '工作台', icon: 'Monitor' },
  { path: '/harness', name: 'Harness', icon: 'Box' },
  { path: '/providers', name: '模型服务', icon: 'Cpu' },
  { path: '/mcp', name: 'MCP', icon: 'Connection' },
  { path: '/settings', name: '设置', icon: 'Setting' }
]

const active = computed(() => '/' + (route.path.split('/')[1] || 'home'))

function toggleTheme() {
  store.applyTheme(store.theme === 'dark' ? 'light' : 'dark')
}

onMounted(() => store.init())
</script>

<template>
  <div class="drag-strip" />
  <div class="app-shell">
    <aside class="icon-rail">
      <div class="logo">
        <img :src="store.theme === 'dark' ? 'logo-dark.png' : 'logo.png'" class="logo-mark" alt="OpenHarness" />
      </div>
      <nav class="rail-nav">
        <div
          v-for="nav in navs"
          :key="nav.path"
          class="rail-item"
          :class="{ active: active === nav.path }"
          :title="nav.name"
          @click="router.push(nav.path)"
        >
          <el-icon :size="20"><component :is="nav.icon" /></el-icon>
          <span class="rail-label">{{ nav.name }}</span>
        </div>
      </nav>
      <div class="rail-bottom">
        <div class="rail-item" title="切换主题" @click="toggleTheme">
          <el-icon :size="20">
            <Sunny v-if="store.theme === 'dark'" />
            <Moon v-else />
          </el-icon>
        </div>
      </div>
    </aside>
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <KeepAlive include="ChatView">
          <component :is="Component" />
        </KeepAlive>
      </router-view>
    </main>
  </div>
</template>

<style scoped lang="scss">
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.icon-rail {
  width: 72px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 44px 0 12px;
}

.logo {
  margin-bottom: 24px;
}

.logo-mark {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  object-fit: contain;
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.rail-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 56px;
  padding: 9px 4px;
  border-radius: var(--oh-radius);
  cursor: pointer;
  color: var(--oh-text-dim);
  transition:
    background var(--oh-dur) var(--oh-ease),
    color var(--oh-dur) var(--oh-ease);
  user-select: none;

  &:hover {
    background: var(--oh-hover);
    color: var(--oh-text);
  }

  &.active {
    background: var(--oh-active);
    color: var(--oh-primary);
    font-weight: 600;
  }

  .rail-label {
    font-size: 10px;
    letter-spacing: 0.02em;
  }
}

.rail-bottom {
  padding-top: 10px;
  margin-top: 8px;
  border-top: 1px solid var(--oh-border);
  width: 100%;
  display: flex;
  justify-content: center;

  .rail-item {
    width: 56px;
  }
}

.app-main {
  flex: 1;
  overflow: hidden;
}
</style>
