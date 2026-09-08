import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

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
