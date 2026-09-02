/**
 * UI 驱动 E2E：在真实构建产物页面上模拟用户操作链。
 * 运行：先 npm run build，再 npx electron test-ui.mjs
 * 覆盖：路由导航 → 输入框 v-model → 点发送 → 气泡出现 → 流回答 →
 *       点编辑 → 编辑框 → 点编辑发送 → 重新流回答
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const chatSrc = fs.readFileSync(path.join(ROOT, 'src/main/chat.js'), 'utf8')
  const chatModule = await import(
    'data:text/javascript;base64,' + Buffer.from(chatSrc).toString('base64')
  )
  const chat = chatModule.createChatService()

  const cfgPath = path.join(app.getPath('appData'), 'openharness', 'config.json')
  const store = { providers: [], sessions: [], settings: {}, mcpServers: [] }
  try { Object.assign(store, JSON.parse(fs.readFileSync(cfgPath, 'utf8'))) } catch {}
  const save = () => fs.writeFileSync(cfgPath, JSON.stringify(store, null, 2))

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  ipcMain.handle('provider:getAll', () => store.providers)
  ipcMain.handle('chat:send', (_e, args) => chat.send(win, args))
  ipcMain.handle('chat:abort', (_e, sid) => chat.abort(sid))
  ipcMain.handle('db:get', (_e, key) => store[key] ?? null)
  ipcMain.handle('db:set', (_e, key, value) => { store[key] = value; save(); return true })

  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'))
  await sleep(1500)

  const js = (code) => win.webContents.executeJavaScript(code, true)

  // ---- 步骤 1：导航到对话页 ----
  const nav = await js(`(() => {
    const rails = [...document.querySelectorAll('.rail-item')]
    const chat = rails.find((r) => r.textContent.trim() === '对话')
    if (!chat) return 'rail 对话 not found: ' + rails.map(r => r.textContent.trim()).join(',')
    chat.click()
    return 'clicked'
  })()`)
  console.log('S1 导航:', nav)
  await sleep(800)

  // ---- 步骤 2：填写输入框并点发送 ----
  const fill = await js(`(() => {
    const ta = document.querySelector('.input-box textarea')
    if (!ta) return 'textarea not found'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '用两个字回复：收到')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'filled: ' + ta.value
  })()`)
  console.log('S2 填写:', fill)

  const clickSend = await js(`(() => {
    const btns = [...document.querySelectorAll('.input-foot .el-button')]
    const send = btns.find((b) => b.textContent.includes('发送'))
    if (!send) return 'send btn not found: ' + btns.map(b => b.textContent).join('|')
    send.click()
    return 'clicked: ' + send.textContent
  })()`)
  console.log('S3 点击发送:', clickSend)
  await sleep(2500)

  // ---- 步骤 3：验证气泡与流 ----
  let after = null
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    after = await js(`(() => {
      const users = [...document.querySelectorAll('.msg.user .msg-content')].map(e => e.textContent)
      const assistants = [...document.querySelectorAll('.msg:not(.user) .msg-content')].map(e => e.textContent)
      const reasoning = [...document.querySelectorAll('.msg-reasoning')].map(e => e.textContent.length)
      const caret = !!document.querySelector('.caret')
      const stopBtn = [...document.querySelectorAll('.input-foot .el-button')].some(b => b.textContent.includes('停止'))
      return JSON.stringify({ users, assistantLen: assistants.join('').length, assistantHead: assistants.join('').slice(0, 60), reasoningLens: reasoning, caret, stopBtn })
    })()`)
    const p = JSON.parse(after)
    if (!p.caret && p.assistantLen > 0) break
  }
  console.log('S4 发送后状态:', after)

  // ---- 步骤 4：点编辑，改文本，点编辑发送 ----
  const editOpen = await js(`(() => {
    const editBtn = [...document.querySelectorAll('.msg-actions .el-button')].at(-1)
    if (!editBtn) return 'edit btn not found'
    editBtn.click()
    return 'clicked'
  })()`)
  console.log('S5 点击编辑:', editOpen)
  await sleep(600)

  const editBox = await js(`(() => {
    const ta = document.querySelector('.edit-box textarea')
    if (!ta) return 'edit textarea not found'
    const v = ta.value
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, v + '，谢谢')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'edit value: ' + ta.value
  })()`)
  console.log('S6 编辑填写:', editBox)

  const editSend = await js(`(() => {
    const btns = [...document.querySelectorAll('.edit-actions .el-button')]
    const send = btns.find((b) => b.textContent.includes('发送'))
    if (!send) return 'edit send not found: ' + btns.map(b => b.textContent).join('|')
    send.click()
    return 'clicked'
  })()`)
  console.log('S7 点击编辑发送:', editSend)
  await sleep(2500)

  let after2 = null
  let lastReport = ''
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    after2 = await js(`(() => {
      const users = [...document.querySelectorAll('.msg.user .msg-content')].map(e => e.textContent)
      const assistants = [...document.querySelectorAll('.msg:not(.user) .msg-content')].map(e => e.textContent)
      const reasoning = [...document.querySelectorAll('.msg-reasoning .reasoning-text')].map(e => e.textContent.length)
      const editBoxOpen = !!document.querySelector('.edit-box')
      const caret = !!document.querySelector('.caret')
      return JSON.stringify({ users, assistantLen: assistants.join('').length, assistantHead: assistants.join('').slice(0, 80), reasoningLens: reasoning, editBoxOpen, caret })
    })()`)
    if (i % 10 === 9) console.log(`  [${i + 1}s]`, after2)
    const p = JSON.parse(after2)
    lastReport = after2
    if (!p.caret && p.assistantLen > 0 && !p.editBoxOpen) break
  }
  console.log('S8 编辑重发后状态:', lastReport)

  // ---- 步骤 5：验证思考过程折叠组件 ----
  const collapse = await js(`(() => {
    const comp = document.querySelector('.msg-reasoning')
    if (!comp) return 'reasoning component not found'
    const head = comp.querySelector('.reasoning-head')
    const label = head?.textContent.trim() || ''
    const textVisibleBefore = !!(comp.querySelector('.reasoning-text')?.offsetParent)
    head.click()
    return JSON.stringify({ label, textVisibleBefore })
  })()`)
  console.log('S9 折叠组件初始态:', collapse)
  await sleep(400)

  const expanded = await js(`(() => {
    const comp = document.querySelector('.msg-reasoning')
    const head = comp.querySelector('.reasoning-head')
    const textVisible = !!(comp.querySelector('.reasoning-text')?.offsetParent)
    const textLen = (comp.querySelector('.reasoning-text')?.textContent || '').length
    head.click() // 再次点击折叠回去
    return JSON.stringify({ textVisible, textLen })
  })()`)
  console.log('S10 点击展开后:', expanded)
  await sleep(400)

  const recollapsed = await js(`(() => {
    const comp = document.querySelector('.msg-reasoning')
    const textVisible = !!(comp.querySelector('.reasoning-text')?.offsetParent)
    const answerVisible = !!document.querySelector('.msg:not(.user) .msg-content')?.offsetParent
    return JSON.stringify({ textVisibleAfterRecollapse: textVisible, answerVisible })
  })()`)
  console.log('S11 再折叠后:', recollapsed)

  app.quit()
})
