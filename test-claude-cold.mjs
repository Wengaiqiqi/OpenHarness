import { execFileSync } from 'node:child_process'
const ev = (expr) => {
  const raw = execFileSync('node', ['cdp-eval.mjs', expr, '9333'], { encoding: 'utf-8', timeout: 30000 }).replace(/^[\s\S]*?RESULT: /, '').trim()
  let v = JSON.parse(raw)
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch {} }
  return v
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let samples = []
let sampling = true
async function sampler() {
  while (sampling) {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
        `$ps = Get-Process | Where-Object { $_.ProcessName -match 'claude' } | Select-Object -First 5; ` +
        `if ($ps) { $ps | ForEach-Object { $w = $_.MainWindowHandle; $t = ''; try { $t = $_.MainWindowTitle } catch {}; Write-Output ("P " + $_.ProcessName + " pid=" + $_.Id + " hwnd=" + $w + " title=[" + $t + "]") } } else { Write-Output "noproc" }`], { encoding: 'utf-8' }).trim()
      samples.push(out)
    } catch {}
    await sleep(400)
  }
}
const t0 = Date.now()
const samplerP = sampler()
console.log('冷启动 embedOpen(claude-desktop)...')
const r = ev("window.api.embedOpen('claude-desktop', {x: 300, y: 120, width: 900, height: 600}).then(r => JSON.stringify(r))")
sampling = false
await samplerP
console.log('结果:', JSON.stringify(r))
console.log('采样（相邻去重，前 20 条）:')
let last = ''
let n = 0
for (const s of samples) {
  if (s !== last && n < 20) { console.log('  +' + (Date.now() - t0) + 'ms ' + s.replace(/\n/g, ' | ')); last = s }
  n++
}
process.exit(0)
