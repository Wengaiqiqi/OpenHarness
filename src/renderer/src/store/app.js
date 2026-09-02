import { api } from '@/api'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const theme = ref('dark')

  function applyTheme(t) {
    theme.value = t
    document.documentElement.classList.toggle('dark', t === 'dark')
    api?.dbSet('settings', { theme: t })
    api?.syncThemeOverlay?.(t === 'dark')
  }

  async function init() {
    try {
      const settings = await api?.dbGet('settings')
      applyTheme(settings?.theme || 'dark')
    } catch {
      applyTheme('dark')
    }
  }

  return { theme, applyTheme, init }
})
