import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import vm from 'node:vm'

test('real Windows bridge reparents, resizes and shuts down a fixture; watcher leaves input children intact', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const embedSource = fs.readFileSync(new URL('../src/main/embed/index.js', import.meta.url), 'utf8')
  const watcher = vm.runInNewContext(embedSource.match(/const WATCHER_PS = (`[\s\S]*?`)\r?\n/)[1])
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FixtureDpi { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c); }'
[FixtureDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
$parent = New-Object System.Windows.Forms.Form
$child = New-Object System.Windows.Forms.Form
$parent.Size = New-Object System.Drawing.Size(100, 100)
$child.Size = New-Object System.Drawing.Size(100, 100)
$inputBox = New-Object System.Windows.Forms.TextBox
$child.Controls.Add($inputBox)
$parentHandle = $parent.Handle
$childHandle = $child.Handle
$inputHandle = $inputBox.Handle
${watcher.split('$g = [OHWatch]::SetWinEventHook')[0]}
$script:names = @((Get-Process -Id $PID).ProcessName)
$before = New-Object OHWatch+RECT
[OHWatch]::GetWindowRect($inputHandle, [ref]$before) | Out-Null
$cb.Invoke([IntPtr]::Zero, 0x8002, $inputHandle, 0, 0, 0, 0)
$after = New-Object OHWatch+RECT
[OHWatch]::GetWindowRect($inputHandle, [ref]$after) | Out-Null
if ($before.Left -ne $after.Left -or $before.Top -ne $after.Top) { throw 'watcher moved input child' }
[Console]::WriteLine('fixture:' + $parentHandle + ':' + $childHandle)
[System.Windows.Forms.Application]::Run()`
  const fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
  const bridgeSource = fs.readFileSync(new URL('../src/main/embed/win32-bridge.js', import.meta.url), 'utf8')
  const { default: bridge } = await import('data:text/javascript;base64,' + Buffer.from(bridgeSource).toString('base64'))
  t.after(() => { bridge.dispose(); if (fixture.exitCode === null) fixture.kill() })
  let diagnostics = ''
  fixture.stderr.on('data', (chunk) => { diagnostics += chunk })
  try {
    const [parent, child] = await new Promise((resolve, reject) => {
      let text = ''
      fixture.stdout.on('data', (chunk) => {
        text += chunk
        const match = /fixture:(\d+):(\d+)/.exec(text)
        if (match) resolve(match.slice(1))
      })
      fixture.on('exit', () => reject(new Error(diagnostics || 'fixture exited')))
      fixture.on('error', reject)
    })
    const identity = await bridge.send('identity', child)
    assert.equal(await bridge.send('close', 0), 'close:True', 'closing an already gone window is successful')
    assert.match(identity, new RegExp(`^process:${fixture.pid}:\\d+$`))
    assert.equal(await bridge.send('findnames', 'powershell'), 'hwnd:0', 'startup helper windows must not be accepted as the application')
    bridge.fire('move', child, 0, 0, 400, 300)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await bridge.send('findnames', 'powershell'), 'hwnd:' + child)
    const original = Number((await bridge.send('getstyle', child)).split(':')[1])
    const style = (original & ~0x80cf0000) | 0x40000000
    assert.match(await bridge.send('style', child, style), /^style:/)
    assert.match(await bridge.send('setparent', child, parent), /^old:/)
    assert.match(await bridge.send('chk', child), new RegExp(`^chk:1:${parent}:`))
    bridge.fire('show', parent, 8)
    bridge.fire('show', child, 8)
    assert.match(await bridge.send('focus', child), /^focus:[1-9]\d*$/)
    for (const [width, height] of [[300, 200], [900, 700]]) {
      bridge.fire('move', child, 0, 0, width, height)
      bridge.fire('setrgn', child, 0, 0, width, height)
      // SetWindowPos is asynchronous across input queues; wait for the observed rectangle.
      let size
      for (let n = 0; n < 20; n++) {
        const rect = (await bridge.send('getrect', child)).slice(5).split(',').map(Number)
        size = [rect[2] - rect[0], rect[3] - rect[1]]
        if (size[0] === width && size[1] === height) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.deepEqual(size, [width, height])
    }
    assert.match(await bridge.send('setparent', child, 0), /^old:/)
    assert.match(await bridge.send('style', child, original), /^style:/)
    bridge.fire('show', parent, 0)
    const exited = once(fixture, 'exit')
    assert.equal(await bridge.send('shutdown', child, ...identity.split(':').slice(1)), 'shutdown:True')
    await exited
    assert.equal(await bridge.send('identity', child), 'gone:')
  } finally {
    bridge.dispose()
    if (fixture.exitCode === null) fixture.kill()
  }
})

test('Windows region bindings create and release a real GDI region', { skip: process.platform !== 'win32' }, () => {
  const source = fs.readFileSync(new URL('../src/main/embed/win32-bridge.js', import.meta.url), 'utf8')
  const definition = source.match(/\$def = @"\r?\n([\s\S]*?)\r?\n"@/)[1]
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
${definition}
"@
$region = [OHWin]::CreateRectRgn(0, 0, 10, 10)
if ($region -eq [IntPtr]::Zero) { throw 'region creation failed' }
if (-not [OHWin]::DeleteObject($region)) { throw 'region cleanup failed' }
Write-Output 'region-ok'`
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000 })
  assert.match(output, /region-ok/)
})
