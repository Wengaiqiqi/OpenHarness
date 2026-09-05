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
 *   chk|<hwnd>                 -> chk:<alive1|0>:<parent>:<vis>  窗口存活/父窗口/可见性快检
 *   findcon|<title>            -> con:<hwnd>:<vis> 按标题子串找控制台窗口（EnumWindows，能找到隐藏窗口）
 *   findnames|<csv>            -> hwnd:<val> 按进程名找主窗口（EnumWindows，能找到隐藏窗口）
 *
 * 需要响应的指令与输出按 FIFO 对应；move/show 无输出，不占用队列。
 */

const PS_SCRIPT = `
$def = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OHWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
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
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
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
      'findbytitle' { $w = Get-Process | Where-Object { $_.MainWindowTitle -like ('*' + $p[1] + '*') } | Select-Object -First 1; if ($w) { Write-Output ('hwnd:' + $w.MainWindowHandle) } else { Write-Output 'hwnd:0' } }
      'findchild' { $kids = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + [int]$p[1]) -ErrorAction SilentlyContinue; foreach ($k in $kids) { $w = Get-Process -Id $k.ProcessId -ErrorAction SilentlyContinue; if ($w -and $w.MainWindowHandle -ne 0) { Write-Output ('hwnd:' + $w.MainWindowHandle) } } }
      'findbyport' { $w = Get-Process | Where-Object { $_.MainWindowTitle -like ('*--port ' + $p[1] + '*') } | Select-Object -First 1; if ($w -and $w.MainWindowHandle -ne 0) { Write-Output ('hwnd:' + $w.MainWindowHandle) } else { Write-Output 'hwnd:0' } }
      'killport' {
                    # netstat 解析比 Get-NetTCPConnection（CIM，1-3 秒）快一个数量级，释放标签不卡顿
                    $pid2 = 0
                    $lines = netstat -ano -p tcp 2>$null | Select-String (':' + [int]$p[1] + '\s')
                    foreach ($ln in $lines) {
                      if ($ln.ToString() -match 'LISTENING') {
                        $tail = ($ln.ToString() -split '\s+')[-1]
                        if ($tail -match '^\d+$') { $pid2 = [int]$tail; break }
                      }
                    }
                    if ($pid2 -gt 0) { taskkill /T /F /PID $pid2 2>$null | Out-Null }
                    else {
                      $c = Get-NetTCPConnection -LocalPort ([int]$p[1]) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
                      if ($c) { taskkill /T /F /PID $c.OwningProcess 2>$null | Out-Null }
                    }
                  }
      'hidebyport' {
                    $pid3 = 0
                    $lines2 = netstat -ano -p tcp 2>$null | Select-String (':' + [int]$p[1] + '\s')
                    foreach ($ln in $lines2) {
                      if ($ln.ToString() -match 'LISTENING') {
                        $tail = ($ln.ToString() -split '\s+')[-1]
                        if ($tail -match '^\d+$') { $pid3 = [int]$tail; break }
                      }
                    }
                    if ($pid3 -le 0) {
                      $c2 = Get-NetTCPConnection -LocalPort ([int]$p[1]) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
                      if ($c2) { $pid3 = $c2.OwningProcess }
                    }
                    if ($pid3 -gt 0) {
                      $w = Get-Process -Id $pid3 -ErrorAction SilentlyContinue
                      if ($w -and $w.MainWindowHandle -ne 0) { [OHWin]::ShowWindow([IntPtr]$w.MainWindowHandle, 0) | Out-Null; Write-Output ('hid:' + $w.MainWindowHandle) }
                    }
                  }
      'setrgn'    { $rgn = [OHWin]::CreateRectRgn([int]$p[2], [int]$p[3], ([int]$p[2] + [int]$p[4]), ([int]$p[3] + [int]$p[5])); [OHWin]::SetWindowRgn([IntPtr][long]$p[1], $rgn, $true) | Out-Null }
      'clearrgn'  { [OHWin]::SetWindowRgn([IntPtr][long]$p[1], [IntPtr]::Zero, $true) | Out-Null }
      'pidof'     { $procId = 0; [OHWin]::GetWindowThreadProcessId([IntPtr][long]$p[1], [ref]$procId) | Out-Null; Write-Output ('pid:' + $procId) }
      'chk'       {
                    # 窗口存活性快检：附着后验证用（Electron 冷启动可能自毁重建主窗口）
                    $h2 = [IntPtr][long]$p[1]
                    $alive2 = 0
                    try { if ($h2 -ne [IntPtr]::Zero -and [OHWin]::IsWindow($h2)) { $alive2 = 1 } } catch {}
                    $par2 = [OHWin]::GetParent($h2)
                    $vis2 = if ([OHWin]::IsWindowVisible($h2)) { 1 } else { 0 }
                    Write-Output ('chk:' + $alive2 + ':' + [long]$par2 + ':' + $vis2)
                  }
      'findcon'   {
                    # 按标题子串找控制台窗口（含隐藏的 —— Get-Process MainWindowHandle 对隐藏窗口返回 0，必须走 EnumWindows）
                    $script:conWant = [string]$p[1]
                    $script:conH = [IntPtr]::Zero
                    $script:conV = 0
                    $cb = [OHWin+EnumProc]{
                      param($h, $l)
                      $cls = New-Object System.Text.StringBuilder 256
                      [OHWin]::GetClassName($h, $cls, 256) | Out-Null
                      if ($cls.ToString() -ne 'ConsoleWindowClass') { return $true }
                      $txt = New-Object System.Text.StringBuilder 512
                      [OHWin]::GetWindowText($h, $txt, 512) | Out-Null
                      if ($txt.ToString().Contains($script:conWant)) {
                        $script:conH = $h
                        $script:conV = if ([OHWin]::IsWindowVisible($h)) { 1 } else { 0 }
                        return $false
                      }
                      return $true
                    }
                    [OHWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
                    Write-Output ('con:' + [long]$script:conH + ':' + $script:conV)
                  }
      'findconpid' {
                    # 按进程树找控制台窗口（TUI 程序会改掉控制台标题，标题匹配存在竞态）：
                    # hostPid 两代内的子孙进程拥有的 ConsoleWindowClass，优先可见/有面积的
                    $hostPid2 = [int]$p[1]
                    $rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
                    $script:cpids = @{}
                    $script:cpids[$hostPid2] = 1
                    foreach ($r0 in $rows) { if ($script:cpids.ContainsKey([int]$r0.ParentProcessId)) { $script:cpids[[int]$r0.ProcessId] = 1 } }
                    foreach ($r0 in $rows) { if ($script:cpids.ContainsKey([int]$r0.ParentProcessId)) { $script:cpids[[int]$r0.ProcessId] = 1 } }
                    $script:conFallback = [IntPtr]::Zero
                    $script:conBest = [IntPtr]::Zero
                    $cb = [OHWin+EnumProc]{
                      param($h, $l)
                      $wpid = 0
                      [OHWin]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
                      if (-not $script:cpids.ContainsKey([int]$wpid)) { return $true }
                      $cls = New-Object System.Text.StringBuilder 128
                      [OHWin]::GetClassName($h, $cls, 128) | Out-Null
                      if ($cls.ToString() -ne 'ConsoleWindowClass') { return $true }
                      $r = New-Object OHWin+RECT
                      [OHWin]::GetWindowRect($h, [ref]$r) | Out-Null
                      $w = [int]$r.Right - [int]$r.Left
                      $ht = [int]$r.Bottom - [int]$r.Top
                      if ($script:conFallback -eq [IntPtr]::Zero) { $script:conFallback = $h }
                      if (($w -gt 100 -and $ht -gt 60) -or [OHWin]::IsWindowVisible($h)) { $script:conBest = $h; return $false }
                      return $true
                    }
                    $script:conPidHit = [IntPtr]::Zero
                    [OHWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
                    $res = if ($script:conBest -ne [IntPtr]::Zero) { $script:conBest } else { $script:conFallback }
                    Write-Output ('hwnd:' + [long]$res)
                  }
      'findnames' {
                    # 按进程名找主窗口（含隐藏的）。Electron 应用有多个同名子进程和若干同尺寸辅助顶层窗口
                    # （Chrome_WidgetWin_0 / IME / Mode Indicator 等），不能取第一个也不能只按面积：
                    # 过滤噪声类 + 排除有父窗口的（IME）+ 给「有标题栏样式」加权，才能稳定命中真主窗口。
                    # 注意：EnumWindows 委托回调里只能读 $script: 作用域变量，普通局部变量在回调中不可见
                    $script:nwant = ([string]$p[1]).Split(',')
                    # 进程表缓存 1.2s：冷启动高频轮询时 EnumWindows 才是主体，
                    # Get-Process 全表（约 200-400ms）按需刷新，避免把桥的命令队列打满
                    $tick2 = [Environment]::TickCount
                    if (-not $script:pmapTs -or ($tick2 - $script:pmapTs) -gt 1200) {
                      $script:pmap = @{}
                      Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $script:pmap[[int]$_.Id] = $_.ProcessName }
                      $script:pmapTs = $tick2
                    }
                    $script:cands = New-Object System.Collections.ArrayList
                    $cb = [OHWin+EnumProc]{
                      param($h, $l)
                      $wpid = 0
                      [OHWin]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
                      if ($wpid -eq 0) { return $true }
                      $name = $script:pmap[[int]$wpid]
                      if (-not $name -or $script:nwant -notcontains $name) { return $true }
                      $cls = New-Object System.Text.StringBuilder 128
                      [OHWin]::GetClassName($h, $cls, 128) | Out-Null
                      $cs = $cls.ToString()
                      # Chromium/系统辅助窗口：不可见或瞬态，绝不可能是主窗口
                      if ($cs -eq 'Chrome_WidgetWin_0' -or $cs -eq 'IME' -or $cs -eq 'MSCTFIME UI' -or
                          $cs -eq 'Electron_SystemPreferencesHostWindow' -or $cs -eq 'Base_PowerMessageWindow' -or
                          $cs -eq 'crashpad_SessionEndWatcher' -or $cs -eq 'ConsoleWindowClass' -or $cs -eq 'CASCADIA_HOSTING_WINDOW_CLASS') { return $true }
                      # 有父窗口的（输入法等）跳过
                      if ([OHWin]::GetParent($h) -ne [IntPtr]::Zero) { return $true }
                      $r = New-Object OHWin+RECT
                      [OHWin]::GetWindowRect($h, [ref]$r) | Out-Null
                      $w = [int]$r.Right - [int]$r.Left
                      $ht = [int]$r.Bottom - [int]$r.Top
                      $score = 0
                      if ([OHWin]::IsWindowVisible($h)) { $score += 100000 }
                      # WS_CAPTION：真实应用主窗口（附着时才被我们剥掉）；弹层/指示器没有
                      if (([OHWin]::GetWindowLong($h, -16) -band 0x00C00000) -ne 0) { $score += 200000 }
                      if ($w -gt 200 -and $ht -gt 150) { $score += 50000 }
                      $score += $w * $ht
                      $txt = New-Object System.Text.StringBuilder 512
                      [OHWin]::GetWindowText($h, $txt, 512) | Out-Null
                      if ($txt.ToString().Length -gt 0) { $score += 10000 }
                      [void]$script:cands.Add(@([long]$h, $score))
                      return $true
                    }
                    [OHWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
                    $best = [IntPtr]::Zero
                    $bestScore = -1
                    foreach ($c in $script:cands) {
                      if ($c[1] -gt $bestScore) { $bestScore = $c[1]; $best = [IntPtr]$c[0] }
                    }
                    Write-Output ('hwnd:' + [long]$best)
                  }
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
