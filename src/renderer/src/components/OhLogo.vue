<script setup>
import { ref, computed } from 'vue'
import { useAppStore } from '@/store/app'

/**
 * OpenHarness 品牌标志：按主题自动切换 logo.png / logo-dark.png，
 * 图片加载失败时回退为 OH 方块，保证永不裂图。
 */
const props = defineProps({ size: { type: Number, default: 40 } })
const store = useAppStore()
const failed = ref(false)

const src = computed(() => (store.theme === 'dark' ? 'logo-dark.png' : 'logo.png'))
const boxStyle = computed(() => ({ width: props.size + 'px', height: props.size + 'px' }))
const fallbackStyle = computed(() => ({ ...boxStyle.value, fontSize: Math.round(props.size * 0.38) + 'px' }))
</script>

<template>
  <img
    v-if="!failed"
    :src="src"
    :style="boxStyle"
    class="oh-logo"
    alt="OpenHarness"
    @error="failed = true"
  />
  <div v-else class="oh-logo oh-logo-fallback" :style="fallbackStyle">OH</div>
</template>

<style scoped>
.oh-logo {
  border-radius: 30%;
  object-fit: contain;
  display: block;
}

.oh-logo-fallback {
  background: var(--oh-primary);
  color: #fff;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
</style>
