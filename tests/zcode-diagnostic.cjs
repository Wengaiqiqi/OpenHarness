// Opt-in: npm run build && npx electron tests/zcode-diagnostic.cjs
// Real OH with temporary data and installed ZCode; never sends the input marker.
const { app, BrowserWindow, desktopCapturer } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-zcode-diagnostic-'))
app.setPath('userData', path.join(dir, 'profile'))
require('../out/main/index.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const measure = `(() => { const r = document.querySelector('.ws-host').getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, scale:devicePixelRatio }; })()`
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  while (win.webContents.isLoadingMainFrame()) await sleep(100)
  await win.webContents.executeJavaScript("location.hash='#/workspace?id=zcode'")
  let ready = false
  for (let n = 0; n < 150; n++) {
    ready = await win.webContents.executeJavaScript("!!document.querySelector('.ws-host') && !document.querySelector('.ws-tip')")
    if (ready) break
    await sleep(400)
  }
  assert.ok(ready, 'real workspace failed to attach ZCode')
  const result = await win.webContents.executeJavaScript(`window.api.embedOpen('zcode', ${measure})`)
  assert.ok(result.ok && result.hwnd)
  const parent = Number(win.getNativeWindowHandle().readBigUInt64LE())
  const bridgeSource = fs.readFileSync(path.join(__dirname, '../src/main/embed/win32-bridge.js'), 'utf8')
  const { default: probe } = await import('data:text/javascript;base64,' + Buffer.from(bridgeSource).toString('base64'))
  console.log(JSON.stringify({ dir, parent, result, identity: await probe.send('identity', result.hwnd) }))
  for (const [width, height] of [[1000, 620], [0, 0], [1200, 660]]) {
    if (width) { win.unmaximize(); win.setSize(width, height) }
    else win.maximize()
    win.focus()
    await sleep(700)
    const css = await win.webContents.executeJavaScript(measure)
    const actual = (await probe.send('getrect', result.hwnd)).slice(5).split(',').map(Number)
    const origin = (await probe.send('clientorigin', parent)).slice(7).split(',').map(Number)
    const expected = [css.x, css.y, css.width, css.height].map((v) => Math.round(v * css.scale))
    const observed = [actual[0] - origin[0], actual[1] - origin[1], actual[2] - actual[0], actual[3] - actual[1]]
    expected.forEach((value, i) => assert.ok(Math.abs(value - observed[i]) <= 1, `${value} != ${observed[i]}`))
    const shots = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
    fs.writeFileSync(path.join(dir, `${width}-${height}.png`), shots[0].thumbnail.toPNG())
    console.log(JSON.stringify({ size: [width, height], expected, observed }))
  }
  win.minimize()
  await sleep(200)
  win.restore()
  win.focus()
  await sleep(600)
  console.log(await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'zcode-input-probe.ps1'), '-ParentHwnd', String(parent), '-ChildHwnd', String(result.hwnd), '-OutputPath', path.join(dir, 'input.png')], { windowsHide: true }))
  probe.dispose()
  app.once('will-quit', () => console.log('PASS actual OpenHarness: ZCode input, container bounds, app shutdown'))
  app.quit()
}).catch((error) => { console.error(error); app.quit(); process.exitCode = 1 })
