import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: () => import('@/views/HomeView.vue') },
  { path: '/chat', name: 'chat', component: () => import('@/views/ChatView.vue') },
  { path: '/workspace', name: 'workspace', component: () => import('@/views/WorkspaceView.vue') },
  { path: '/harness', name: 'harness', component: () => import('@/views/HarnessView.vue') },
  { path: '/providers', name: 'providers', component: () => import('@/views/ProvidersView.vue') },
  { path: '/mcp', name: 'mcp', component: () => import('@/views/McpView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
