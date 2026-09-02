import { spawn } from 'node:child_process'

/**
 * Win32 窗口桥：常驻 PowerShell 进程，通过 stdin 按行收发指令
 * 指令格式（| 分隔）:
 *   getstyle|<hwnd>            -> style:<val>
 *   setparent|<child>|<parent> -> old:<val>
 *   style|<hwnd>|<newStyle>    -> style:<old>
 *   move|<hwnd>|x|y|w|h        -> (无输出)
 *   show|<hwnd>|<cmd>          -> (无输出)
 *   setrgn|<hwnd>|x|y|w|h      -> (无输出) 硬裁剪子窗口可见区域（子窗口自身坐标系）
 *   clearrgn|<hwnd>            -> (无输出) 清除裁剪区域
 *   pidof|<hwnd>               -> pid:<val>
 *
 * 需要响应的指令与输出按 FIFO 对应；move/show 无输出，不占用队列。
 */

const PS_SCRIPT = `
$def = @"
using System;
using System.Runtime.InteropServices;
public class OHWin {
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr CreateRectRgn(int x1, int y1, int x2, int y2);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@
Add-Type -TypeDefinition $def
# 桥进程必须 DPI-aware，否则 MoveWindow 坐标会被系统 DPI 虚拟化错位
[OHWin]::SetProcessDPIAware() | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $p = $line.Split('|')
  try {
    switch ($p[0]) {
      'getstyle'  { Write-Output ('style:' + [OHWin]::GetWindowLong([IntPtr][long]$p[1], -16)) }
      'setparent' { $old = [OHWin]::SetParent([IntPtr][long]$p[1], [IntPtr][long]$p[2]); Write-Output ('old:' + $old) }
      'style'     { $old = [OHWin]::GetWindowLong([IntPtr][long]$p[1], -16); [OHWin]::SetWindowLong([IntPtr][long]$p[1], -16, [int]$p[2]) | Out-Null; Write-Output ('style:' + $old) }
      'move'      { [OHWin]::MoveWindow([IntPtr][long]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5], $true) | Out-Null }
      'show'      { [OHWin]::ShowWindow([IntPtr][long]$p[1], [int]$p[2]) | Out-Null }
      'getrect'   { $r = New-Object OHWin+RECT; [OHWin]::GetWindowRect([IntPtr][long]$p[1], [ref]$r) | Out-Null; Write-Output ('rect:' + $r.Left + ',' + $r.Top + ',' + $r.Right + ',' + $r.Bottom) }
      'clientorigin' { $pt = New-Object OHWin+POINT; [OHWin]::ClientToScreen([IntPtr][long]$p[1], [ref]$pt) | Out-Null; Write-Output ('origin:' + $pt.X + ',' + $pt.Y) }
      'setrgn'    { $rgn = [OHWin]::CreateRectRgn([int]$p[2], [int]$p[3], ([int]$p[2] + [int]$p[4]), ([int]$p[3] + [int]$p[5])); [OHWin]::SetWindowRgn([IntPtr][long]$p[1], $rgn, $true) | Out-Null }
      'clearrgn'  { [OHWin]::SetWindowRgn([IntPtr][long]$p[1], [IntPtr]::Zero, $true) | Out-Null }
      'pidof'     { $procId = 0; [OHWin]::GetWindowThreadProcessId([IntPtr][long]$p[1], [ref]$procId) | Out-Null; Write-Output ('pid:' + $procId) }
    }
  } catch { Write-Output ('err:' + $p[0] + ':' + $_.Exception.Message) }
}
`

class Win32Bridge {
  constructor() {
    this.proc = null
    this.queue = [] // FIFO resolver，只给需要响应的指令用
    this.buffer = ''
  }

  ensure() {
    if (this.proc && !this.proc.killed) return this.proc
    this.buffer = ''
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    this.proc.stdout.setEncoding('utf-8')
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let idx
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (!line) continue
        const resolve = this.queue.shift()
        if (resolve) resolve(line)
      }
    })
    this.proc.stderr.setEncoding('utf-8')
    this.proc.stderr.on('data', () => {})
    this.proc.on('exit', () => {
      this.proc = null
      const pending = this.queue
      this.queue = []
      pending.forEach((r) => r('err:bridge-exited'))
    })
    return this.proc
  }

  /** 发送需要响应的指令（响应按 FIFO 对应）；写入失败自动重连 */
  send(...parts) {
    this.ensure()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const i = this.queue.indexOf(entry)
        if (i >= 0) this.queue.splice(i, 1)
        resolve('err:timeout')
      }, 8000)
      const entry = (line) => {
        clearTimeout(timeout)
        resolve(line)
      }
      this.queue.push(entry)
      try {
        if (this.proc && this.proc.stdin.writable) {
          this.proc.stdin.write(parts.join('|') + '\n')
        } else {
          this.proc = null
          this.ensure()
          this.proc.stdin.write(parts.join('|') + '\n')
        }
      } catch {
        this.proc = null
        clearTimeout(timeout)
        resolve('err:write-failed')
      }
    })
  }

  /** 发送无需响应的指令（move/show），不占用响应队列；写入失败静默重连 */
  fire(...parts) {
    try {
      this.ensure()
      if (this.proc && this.proc.stdin.writable) {
        this.proc.stdin.write(parts.join('|') + '\n')
      } else {
        this.proc = null
        this.ensure()
        this.proc.stdin.write(parts.join('|') + '\n')
      }
    } catch {
      /* 下一次调用会自动重连 */
    }
  }

  dispose() {
    if (this.proc) {
      try { this.proc.stdin.end() } catch {}
      this.proc.kill()
      this.proc = null
    }
  }
}

const bridge = new Win32Bridge()
export default bridge
