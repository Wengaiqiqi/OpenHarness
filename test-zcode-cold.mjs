// ZCode 冷启动复现：采样主窗口可见性/位置，捕捉"弹窗"与附着结果
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
        `Add-Type 'using System; using System.Runtime.InteropServices; public class P { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } }'; ` +
        `$m = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
        `if ($m) { $r = New-Object P+RECT; [P]::GetWindowRect($m.MainWindowHandle, [ref]$r) | Out-Null; Write-Output ("vis=" + [P]::IsWindowVisible($m.MainWindowHandle) + " x=" + $r.Left + " y=" + $r.Top + " pid=" + $m.Id) } else { Write-Output "nowindow" }`], { encoding: 'utf-8' }).trim()
      samples.push(out)
    } catch {}
    await sleep(300)
  }
}

const t0 = Date.now()
const samplerP = sampler()
console.log('冷启动 embedOpen(zcode)...')
const r = ev("window.api.embedOpen('zcode', {x: 300, y: 120, width: 900, height: 600}).then(r => JSON.stringify(r))")
sampling = false
await samplerP
console.log('结果:', JSON.stringify(r))
console.log('采样序列（相邻去重）:')
let last = ''
for (const s of samples) {
  if (s !== last) { console.log('  +' + (Date.now() - t0) + 'ms', s); last = s }
}
