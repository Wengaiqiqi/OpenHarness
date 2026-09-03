import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as Icons from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import './styles/main.scss'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ElementPlus)

// 全局错误显式呈现：任何静默失败（含未处理的 Promise 拒绝）都会弹出具体原因
function surfaceError(label, err) {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
  try {
    ElMessage.error({ message: `[${label}] ${text}`, duration: 10000, grouping: true })
  } catch {}
  console.error(`[${label}]`, err)
}

app.config.errorHandler = (err, _inst, info) => surfaceError(`渲染错误:${info}`, err)
window.addEventListener('unhandledrejection', (e) =>
  surfaceError('异步错误', e.reason)
)
window.addEventListener('error', (e) => surfaceError('脚本错误', e.error || e.message))

for (const [name, comp] of Object.entries(Icons)) {
  app.component(name, comp)
}

// preload 竞态兜底：dev 热更时 renderer 可能先于 preload 就绪，等 window.api 出现再挂载
function mount() {
  app.mount('#app')
}
if (window.api) {
  mount()
} else {
  let tries = 0
  const t = setInterval(() => {
    tries += 1
    if (window.api || tries > 50) {
      clearInterval(t)
      mount()
    }
  }, 100)
}
