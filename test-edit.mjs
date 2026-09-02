/**
 * E2E 测试：在真实渲染进程页面上下文里验证聊天链路。
 * 运行：npx electron test-edit.mjs
 * 覆盖：onChatChunk 注册/回调、chatSend 跨界（含 Proxy 模拟）、流回传。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

app.whenReady().then(async () => {
  // 动态加载 chat 服务（chat.js 为 ESM 语法但扩展名 .js，经 data-URL 以 ESM 导入）
  const chatSrc = fs.readFileSync(path.join(ROOT, 'src/main/chat.js'), 'utf8')
  const chatModule = await import(
    'data:text/javascript;base64,' + Buffer.from(chatSrc).toString('base64')
  )
  const chat = chatModule.createChatService()

  // 注册与应用主进程一致的处理器（读取同一份真实配置）
  const cfgPath = path.join(app.getPath('appData'), 'openharness', 'config.json')
  const getProviders = () => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).providers || [] } catch { return [] }
  }
  ipcMain.handle('provider:getAll', () => getProviders())
  ipcMain.handle('chat:send', (_e, args) => chat.send(win, args))
  ipcMain.handle('db:get', () => null)
  ipcMain.handle('db:set', () => true)

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'))
  await new Promise((r) => setTimeout(r, 1500)) // 等应用挂载

  // 第 1 步：在页面主世界注册 onChatChunk + 用 Proxy 模拟 resendEdit 的载荷发起 chatSend
  const step1 = await win.webContents.executeJavaScript(
    `(async () => {
      const out = { registerOk: false, registerErr: null, sendErr: null, sendResult: null }
      try {
        window.__chunks = []
        window.api.onChatChunk((c) => { window.__chunks.push(c) })
        out.registerOk = true
        const providers = await window.api.providerGetAll()
        const p = providers && providers[0]
        if (!p) { out.sendErr = 'no provider'; return out }
        out.sendResult = await window.api.chatSend({
          sessionId: 'e2e-' + Date.now(),
          provider: p,
          model: (p.models || [])[0],
          messages: [{ role: 'user', content: '回复一个字：好' }],
          thinkingLevel: 'medium'
        })
      } catch (e) {
        out.sendErr = String(e && e.stack ? e.message : e)
      }
      return out
    })()`,
    true
  )
  console.log('STEP1 注册+发送:', JSON.stringify(step1))

  // 第 2 步：轮询等待流回传（最多 40s）
  let final = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    final = await win.webContents.executeJavaScript(
      `JSON.stringify({ n: window.__chunks.length, types: window.__chunks.map(c => c.type), done: window.__chunks.some(c => c.type === 'done' || c.type === 'error') })`
    )
    const parsed = JSON.parse(final)
    if (parsed.done) break
  }

  const summary = await win.webContents.executeJavaScript(
    `(() => {
      const cs = window.__chunks || []
      const content = cs.filter(c => c.type === 'delta').map(c => c.delta).join('')
      const reasoning = cs.filter(c => c.type === 'reasoning').map(c => c.delta).join('')
      const err = cs.find(c => c.type === 'error')
      return JSON.stringify({
        chunkCount: cs.length,
        contentLen: content.length,
        contentPreview: content.slice(0, 120),
        reasoningLen: reasoning.length,
        error: err ? err.message : null
      })
    })()`
  )
  console.log('STEP2 流回传:', final)
  console.log('STEP3 汇总:', summary)

  app.quit()
})
