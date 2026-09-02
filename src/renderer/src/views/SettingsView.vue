<script setup>
import { api } from '@/api'
import { ref, onMounted } from 'vue'
import { useAppStore } from '@/store/app'

const store = useAppStore()
const info = ref({})

onMounted(async () => {
  try {
    info.value = await api.appInfo()
  } catch {}
})

function openDataDir() {
  if (info.value.userData) api.openPath(info.value.userData)
}
</script>

<template>
  <div class="page settings">
    <h1 class="page-title">设置</h1>
    <p class="page-sub">外观与关于</p>

    <div class="card section">
      <h3 class="sec-title">外观</h3>
      <div class="row">
        <div class="row-label">
          <span class="row-name">主题</span>
          <span class="row-hint">明暗两套，切换立即生效</span>
        </div>
        <el-radio-group :model-value="store.theme" @change="store.applyTheme">
          <el-radio-button value="dark">深色</el-radio-button>
          <el-radio-button value="light">浅色</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <div class="card section">
      <h3 class="sec-title">关于</h3>
      <div class="row"><span>应用</span><b>OpenHarness v{{ info.version || '0.1.0' }}</b></div>
      <div class="row"><span>平台</span><b>{{ info.platform }}</b></div>
      <div class="row"><span>数据目录</span><b class="path">{{ info.userData }}</b></div>
      <div class="section-foot">
        <el-button size="small" @click="openDataDir">打开数据目录</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.settings {
  max-width: 660px;
  margin: 0 auto;
  padding-top: clamp(28px, 7vh, 64px);
}

.section {
  margin-bottom: 16px;
  padding: 22px 24px;
}

.sec-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  font-size: 14px;

  & + .row {
    border-top: 1px solid var(--oh-border);
  }

  > span:first-child {
    color: var(--oh-text-dim);
  }
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .row-name {
    color: var(--oh-text-dim);
  }

  .row-hint {
    font-size: 12px;
    color: var(--oh-text-dim);
    opacity: 0.85;
  }
}

.path {
  font-size: 12px;
  font-weight: 400;
  font-family: Consolas, 'JetBrains Mono', monospace;
  color: var(--oh-text-dim);
  word-break: break-all;
  max-width: 400px;
  text-align: right;
}

.section-foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--oh-border);
}
</style>
