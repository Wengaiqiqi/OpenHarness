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
  let harnessList = [
    { id: 'codex', name: 'Codex', color: '#10a37f', icon: 'https://cdn.simpleicons.org/openai/10a37f', installed: true },
    { id: 'claude-code', name: 'Claude Code', color: '#d97757', icon: 'icons/claude.svg', installed: true },
    { id: 'dsh', name: 'DeepSeek Harness', color: '#4d6bfe', icon: 'https://cdn.simpleicons.org/deepseek/4d6bfe', installed: false }
  ]
  ipcMain.handle('harness:list', () => harnessList)
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
  const existingCodex = path.join(dir, 'home', '.codex', 'skills', 'existing-codex')
  fs.mkdirSync(existingCodex, { recursive: true })
  fs.writeFileSync(path.join(existingCodex, 'SKILL.md'), '---\nname: Existing Codex Skill\n---\n# Existing')
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
  assert.equal(await win.webContents.executeJavaScript("!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === '导入 Skill' && b.getClientRects().length)"), false)
  await waitFor("document.querySelectorAll('.harness-skill-card').length === 3")
  assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.harness-skill-card .harness-icon').length"), 3)
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('.harness-skill-card[data-target-id=\"codex\"]')?.textContent.includes('1')"), true)
  harnessList = [...harnessList, { id: 'cursor', name: 'Cursor', color: '#4b8bbe', icon: 'https://cdn.simpleicons.org/cursor/4b8bbe', installed: true }]
  win.webContents.send('harness:updated', harnessList)
  await waitFor("document.querySelectorAll('.harness-skill-card').length === 4")
  await clickText('Skill 管理')
  await waitFor("document.querySelector('.skills-page.is-manage')")
  await waitFor("document.querySelectorAll('.manage-tabs .el-tabs__item').length === 2")
  await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('.manage-tabs .el-tabs__item')].find((item) => item.textContent.trim() === '管理库')
    if (!tab) throw new Error('管理库 tab missing')
    tab.click()
  })()`)
  await waitFor("document.querySelector('.library-section')?.getClientRects().length > 0")
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('.scan-section')?.getClientRects().length || 0"), 0)
  await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('.manage-tabs .el-tabs__item')].find((item) => item.textContent.trim() === '扫描本机')
    if (!tab) throw new Error('扫描本机 tab missing')
    tab.click()
  })()`)
  await waitFor("document.querySelector('.scan-section')?.getClientRects().length > 0")
  await clickText('扫描本机')
  await waitFor("document.querySelectorAll('.scan-item').length === 26")
  assert.ok(await win.webContents.executeJavaScript("localStorage.getItem('openharness.skills.scan.v1')"))
  for (const [width, height, zoom] of [[1280, 820, 1], [960, 600, 1], [1600, 900, 1], [960, 600, 1.25]]) {
    win.setContentSize(width, height)
    win.webContents.setZoomFactor(zoom)
    await new Promise(resolve => setTimeout(resolve, 150))
    const fit = await win.webContents.executeJavaScript(`(() => {
      const grid = document.querySelector('.scan-grid'), cards = [...document.querySelectorAll('.scan-item')]
      const rects = cards.map((item) => item.getBoundingClientRect())
      const width = rects[0]?.width || 0, height = rects[0]?.height || 0
      return { uniform: rects.every((r) => Math.abs(r.width - width) < 1 && Math.abs(r.height - height) < 1),
        bounded: cards.every((item) => { const r = item.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 }),
        fixedHeight: height >= 200 && height <= 230, noHorizontalOverflow: grid.scrollWidth <= grid.clientWidth + 1,
        noPageOverflow: document.querySelector('.skills-page').scrollWidth <= document.querySelector('.skills-page').clientWidth + 1 }
    })()`)
    assert.ok(fit.uniform && fit.bounded && fit.fixedHeight && fit.noHorizontalOverflow && fit.noPageOverflow, JSON.stringify(fit))
  }
  for (const [query, count] of [['  LOCAL SKILL 12  ', 1], ['中文检索', 1], ['Claude Code', 24], ['scan-23', 1], ['no-match-example', 0], ['', 26]]) {
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[aria-label="搜索扫描结果"]')
      input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(`document.querySelectorAll('.scan-item').length === ${count}`)
  }
  await win.webContents.executeJavaScript("location.hash = '#/home'")
  await waitFor("!!document.querySelector('.page.home')")
  await win.webContents.executeJavaScript("location.hash = '#/skills'")
  await waitFor("!!document.querySelector('.skills-page')")
  await clickText('Skill 管理')
  await waitFor("document.querySelector('.skills-page.is-manage') && document.querySelectorAll('.scan-item').length === 26")
  const refreshOnly = path.join(longToolPath, 'refresh-only')
  fs.mkdirSync(refreshOnly, { recursive: true })
  fs.writeFileSync(path.join(refreshOnly, 'SKILL.md'), '---\nname: Refresh only skill\n---\n# Example')
  assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.scan-item').length"), 26)
  await clickText('刷新')
  await waitFor("document.querySelectorAll('.scan-item').length === 27")
  win.webContents.setZoomFactor(1)
  win.setContentSize(1280, 820)
  await new Promise(resolve => setTimeout(resolve, 150))
  fs.writeFileSync(path.join(dir, 'skills-scan.png'), (await win.webContents.capturePage()).toPNG())
  console.log('Skills management screenshot:', path.join(dir, 'skills-scan.png'))
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll('.scan-item input[type="checkbox"]')].slice(0, 2).forEach((input) => input.click())
  })()`)
  await waitFor("document.querySelector('.scan-count')?.textContent.includes('已选 2')")
  await clickText('导入 Skill')
  await waitFor("!!document.querySelector('[aria-label=\"选择目标 Harness\"]')")
  await waitFor("!!document.querySelector('.harness-target-dialog .target-card-icon')")
  const targetDialog = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('.harness-target-dialog')
    const rect = dialog?.getBoundingClientRect()
    const codex = document.querySelector('.harness-target-dialog .target-card[data-target-id="codex"]')
    const checkbox = codex?.querySelector('.target-card-top .el-checkbox')?.getBoundingClientRect()
    const card = codex?.getBoundingClientRect()
    const foot = codex?.querySelector('.target-card-foot')?.getBoundingClientRect()
    const icon = codex?.querySelector('.target-card-icon')?.getBoundingClientRect()
    const dsh = document.querySelector('.harness-target-dialog .target-card[data-target-id="dsh"]')
    const status = dsh?.querySelector('.target-card-top .el-tag')?.getBoundingClientRect()
    const dshIcon = dsh?.querySelector('.target-card-icon')?.getBoundingClientRect()
    return { left: rect?.left || 0, top: rect?.top || 0, width: rect?.width || 0, height: rect?.height || 0, icons: document.querySelectorAll('.harness-target-dialog .target-card-icon').length, cards: document.querySelectorAll('.harness-target-dialog .target-card').length, hasInstalledLabel: [...document.querySelectorAll('.harness-target-dialog .target-card-top')].some((item) => item.textContent.includes('已安装')), checkboxRight: checkbox?.right || 0, cardRight: card?.right || 0, cardHeight: card?.height || 0, footTop: foot?.top || 0, iconTop: icon?.top || 0, cardTop: card?.top || 0, statusBottom: status?.bottom || 0, statusIconTop: dshIcon?.top || 0, viewportWidth: innerWidth, viewportHeight: innerHeight }
  })()`)
  assert.ok(targetDialog.icons >= 4)
  assert.ok(targetDialog.cards >= 4)
  assert.equal(targetDialog.hasInstalledLabel, false)
  assert.ok(targetDialog.checkboxRight > targetDialog.cardRight - 80, JSON.stringify(targetDialog))
  assert.ok(targetDialog.cardHeight <= 170 && targetDialog.footTop - targetDialog.cardTop < 130, JSON.stringify(targetDialog))
  assert.ok(targetDialog.iconTop - targetDialog.cardTop <= 20, JSON.stringify(targetDialog))
  assert.ok(!targetDialog.statusBottom || targetDialog.statusIconTop >= targetDialog.statusBottom, JSON.stringify(targetDialog))
  assert.ok(Math.abs(targetDialog.width / targetDialog.height - 16 / 9) < 0.08 && targetDialog.width <= targetDialog.viewportWidth && targetDialog.height <= targetDialog.viewportHeight, JSON.stringify(targetDialog))
  assert.ok(Math.abs(targetDialog.left + targetDialog.width / 2 - targetDialog.viewportWidth / 2) < 1 && Math.abs(targetDialog.top + targetDialog.height / 2 - targetDialog.viewportHeight / 2) < 1, JSON.stringify(targetDialog))
  await win.webContents.executeJavaScript(`(() => {
    const label = [...document.querySelectorAll('.harness-target-dialog .target-card')].find(e => e.textContent.includes('Codex'))
    if (!label) throw new Error('Codex target missing')
    label.querySelector('input').click()
  })()`)
  await waitFor("document.querySelector('.harness-target-dialog .target-card[data-target-id=\"codex\"]')?.classList.contains('selected')")
  await clickText('导入到选中 Harness')
  await waitFor("document.querySelectorAll('.library-card').length === 2")
  const imported = skillService.list().skills
  assert.equal(imported.length, 2)
  assert.ok(imported.every((skill) => skill.targets.some((item) => item.id === 'codex' && item.state === 'on')))
  await win.webContents.executeJavaScript("document.querySelector('.manage-back').click()")
  await waitFor("document.querySelector('.harness-skill-card[data-target-id=\"codex\"]')?.textContent.includes('3')")
  await win.webContents.executeJavaScript("document.querySelector('.harness-skill-card[data-target-id=\"codex\"]').click()")
  await waitFor("document.querySelector('.harness-detail') && document.querySelectorAll('.detail-skill').length === 3")
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
  console.log(`PASS Electron ${process.versions.electron}: built renderer, preload IPC, chat persistence, Skills overview/manage scan/search/select/import/target/detail, native PTY`)
}).catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  clearTimeout(timeout)
  win?.destroy()
  try { terminal?.kill() } catch {}
  app.exit(process.exitCode || 0)
})
