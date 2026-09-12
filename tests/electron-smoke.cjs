// Run after build: npx electron tests/electron-smoke.cjs (no real providers or user data).
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

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
  const { createSkillService } = await import(pathToFileURL(path.join(root, 'src/main/skills.js')).href)
  const skillService = createSkillService({ root: path.join(dir, 'skills'), home: path.join(dir, 'home'), env: {} })
  const skillSource = path.join(dir, 'smoke-skill')
  fs.mkdirSync(skillSource)
  fs.writeFileSync(path.join(skillSource, 'SKILL.md'), '---\nname: Smoke Skill\ndescription: Electron import test\n---\n# SKILL_SMOKE_OK')
  ipcMain.handle('skills:list', () => skillService.list())
  ipcMain.handle('skills:detail', (_e, id) => skillService.detail(id))
  ipcMain.handle('skills:install', (_e, source, folder) => skillService.install(source, folder))
  ipcMain.handle('skills:sync', (_e, id, targets) => skillService.sync(id, targets))
  ipcMain.handle('skills:pickDirectory', () => skillSource)
  ipcMain.handle('skills:scan', () => skillService.scan())
  const longToolName = '用于验证扫描卡片自适应的工具名称'.repeat(5).slice(0, 80)
  const longToolPath = path.join(dir, 'long-tool-skills')
  await skillService.addTarget({ name: longToolName, path: longToolPath })
  for (let i = 0; i < 24; i++) {
    const folder = path.join(dir, 'home', '.claude', 'skills', `scan-${i}`)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: Local Skill ${i}\ndescription: ${i === 0 ? '中文检索示例' : 'A local skill for your workflow'}\n---\n# Example`)
  }
  fs.mkdirSync(path.join(longToolPath, 'long-label'), { recursive: true })
  fs.writeFileSync(path.join(longToolPath, 'long-label', 'SKILL.md'), '---\nname: Long label fixture\n---\n# Example')
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
  for (let n = 0; n < 50; n++) {
    if (await win.webContents.executeJavaScript("!!document.querySelector('.rail-nav')")) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await win.webContents.executeJavaScript("location.hash = '#/chat'")
  for (let n = 0; n < 50; n++) {
    if (await win.webContents.executeJavaScript("!!document.querySelector('.input-box textarea') && document.querySelector('.chat-shell')?.textContent.includes('fake')")) break
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
  await win.webContents.executeJavaScript("location.hash = '#/skills'")
  async function waitFor(script) {
    for (let n = 0; n < 50; n++) {
      if (await win.webContents.executeJavaScript(script)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Skills UI timeout: ${script}`)
  }
  const clickText = (text) => win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && b.getClientRects().length)
    if (!button) throw new Error('button missing: ' + ${JSON.stringify(text)})
    button.click()
  })()`)
  await waitFor("!!document.querySelector('.skills-page')")
  await clickText('扫描本机')
  await waitFor("document.querySelectorAll('.scan-item').length === 25")
  await waitFor("!document.querySelector('.skill-scan-dialog').closest('.el-overlay').className.includes('enter-active')")
  for (const [width, height, zoom] of [[1280, 820, 1], [960, 600, 1], [1600, 900, 1], [960, 600, 1.25]]) {
    win.setContentSize(width, height)
    win.webContents.setZoomFactor(zoom)
    await new Promise(resolve => setTimeout(resolve, 150))
    const fit = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.skill-scan-dialog'), results = document.querySelector('.scan-results')
      const r = dialog.getBoundingClientRect(), list = results.getBoundingClientRect()
      return { ratio: r.width / r.height, fits: r.left >= 0 && r.top >= 36 && r.right <= innerWidth && r.bottom <= innerHeight,
        scrolls: results.scrollHeight > results.clientHeight, noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth,
        listFits: list.bottom <= document.querySelector('.scan-footer').getBoundingClientRect().top,
        labelsFit: [...document.querySelectorAll('.scan-item')].every(item => {
          const tag = item.querySelector('.el-tag'), content = tag.querySelector('.el-tag__content')
          return tag.getBoundingClientRect().right <= item.getBoundingClientRect().right && tag.title === tag.textContent.trim()
            && (tag.title.length < 50 || (content.scrollWidth > content.clientWidth && getComputedStyle(content).textOverflow === 'ellipsis'))
        }) }
    })()`)
    assert.ok(Math.abs(fit.ratio - 16 / 9) < 0.01, JSON.stringify(fit))
    assert.ok(fit.fits && fit.scrolls && fit.noHorizontalOverflow && fit.listFits && fit.labelsFit, JSON.stringify(fit))
  }
  for (const [query, count] of [['  LOCAL SKILL 12  ', 1], ['中文检索', 1], ['Claude Code', 24], ['scan-23', 1], ['no-match-example', 0], ['', 25]]) {
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[aria-label="搜索扫描结果"]')
      input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(`document.querySelectorAll('.scan-item').length === ${count}`)
  }
  win.webContents.setZoomFactor(1)
  win.setContentSize(1280, 820)
  await new Promise(resolve => setTimeout(resolve, 150))
  fs.writeFileSync(path.join(dir, 'skills-scan.png'), (await win.webContents.capturePage()).toPNG())
  console.log('Scan dialog screenshot:', path.join(dir, 'skills-scan.png'))
  await clickText('完成')
  await clickText('导入 Skill')
  await waitFor("!!document.querySelector('[aria-label=\"选择 Skill 文件夹\"]')")
  await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"选择 Skill 文件夹\"]').click()")
  await waitFor("document.querySelector('input[placeholder^=\"如 my-skill\"]')?.value === 'smoke-skill'")
  await clickText('导入')
  await waitFor("!!document.querySelector('.skill-card')")
  assert.equal(skillService.list().skills[0].name, 'Smoke Skill')
  await clickText('同步工具')
  await waitFor("!!document.querySelector('.el-checkbox-group .el-checkbox')")
  await win.webContents.executeJavaScript(`(() => {
    const label = [...document.querySelectorAll('.el-checkbox')].find(e => e.textContent.includes('Codex'))
    label.querySelector('input').click()
  })()`)
  await clickText('保存同步状态')
  await waitFor("document.querySelector('.skill-card .tags')?.textContent.includes('Codex')")
  const synced = path.join(dir, 'home', '.codex', 'skills', 'smoke-skill', 'SKILL.md')
  assert.match(fs.readFileSync(synced, 'utf8'), /SKILL_SMOKE_OK/)
  await win.webContents.reload()
  await waitFor("document.querySelector('.skill-card .tags')?.textContent.includes('Codex')")
  await clickText('查看')
  await waitFor("document.querySelector('.skill-content')?.textContent.includes('SKILL_SMOKE_OK')")
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
  console.log(`PASS Electron ${process.versions.electron}: built renderer, preload IPC, chat persistence, Skills scan search/responsive 16:9/import/sync/reload/detail, native PTY`)
}).catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  clearTimeout(timeout)
  win?.destroy()
  try { terminal?.kill() } catch {}
  app.exit(process.exitCode || 0)
})
