// Run after build: npx electron tests/electron-smoke.cjs (no real providers or user data).
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openharness-smoke-'))
app.setPath('userData', dir)
const root = path.resolve(__dirname, '..')
const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : root
const pty = require(path.join(appRoot, 'node_modules/node-pty'))
let terminal
let win
const timeout = setTimeout(() => { console.error('smoke timeout'); app.exit(1) }, 20000)

app.whenReady().then(async () => {
  const data = { sessions: [], settings: { theme: 'dark' } }
  ipcMain.handle('db:get', (_e, key) => data[key])
  ipcMain.handle('db:set', (_e, key, value) => { data[key] = value; return true })
  ipcMain.handle('db:patchSettings', (_e, patch) => Object.assign(data.settings, patch))
  ipcMain.handle('app:syncThemeOverlay', () => true)
  ipcMain.handle('harness:list', () => [])
  ipcMain.handle('provider:getAll', () => [{ id: 'test', name: 'Test', models: ['fake'], apiKey: 'fake', baseUrl: 'https://example.test' }])
  const source = fs.readFileSync(path.join(root, 'src/main/chat.js'), 'utf8')
  const { createChatService } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const chat = createChatService()
  global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"SMOKE_OK"}}]}\n\ndata: [DONE]\n\n')
  ipcMain.handle('chat:send', (_e, payload) => chat.send(win, payload))
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(appRoot, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message) })
  win.webContents.on('preload-error', (_event, _path, error) => console.error(error))
  await win.loadFile(path.join(appRoot, 'out/renderer/index.html'))
  await win.webContents.executeJavaScript("location.hash = '#/chat'")
  for (let n = 0; n < 50; n++) {
    if (await win.webContents.executeJavaScript("!!document.querySelector('.input-box textarea')")) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.input-box textarea')
    if (!input) throw new Error('chat input missing')
    input.value = 'test'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.input-foot .el-button').click()
  })()`)
  for (let n = 0; n < 50 && !data.sessions[0]?.messages.some((m) => m.content === 'SMOKE_OK'); n++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(data.sessions[0]?.messages.at(-1).content, 'SMOKE_OK')
  const terminalOutput = await new Promise((resolve, reject) => {
    let output = ''
    terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo NATIVE_PTY_OK'], { cols: 80, rows: 24, cwd: dir, env: process.env })
    terminal.onData((chunk) => { output += chunk })
    terminal.onExit(({ exitCode }) => {
      terminal = null
      exitCode === 0 ? resolve(output) : reject(new Error(`PTY exit ${exitCode}`))
    })
  })
  assert.match(terminalOutput, /NATIVE_PTY_OK/)
  console.log(`PASS Electron ${process.versions.electron}: built renderer, preload IPC, chat persistence, native PTY`)
}).catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  clearTimeout(timeout)
  win?.destroy()
  try { terminal?.kill() } catch {}
  app.exit(process.exitCode || 0)
})
