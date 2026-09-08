param([long]$ParentHwnd, [long]$ChildHwnd, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$source = Get-Content "$PSScriptRoot/../src/main/embed/win32-bridge.js" -Raw
$def = [regex]::Match($source, '(?s)\$def = @"\r?\n(.*?)\r?\n"@').Groups[1].Value
$def = $def.Replace('public class OHWin {', @'
public class OHWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint t,ref INFO i);
  public struct INFO { public int size,flags; public IntPtr active,focus,capture,menu,move,caret; public RECT rect; }
'@)
Add-Type -TypeDefinition $def
[OHWin]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
if ([OHWin]::GetParent([IntPtr]$ChildHwnd) -ne [IntPtr]$ParentHwnd) { throw 'Not embedded; no input sent' }
[OHWin]::SetForegroundWindow([IntPtr]$ParentHwnd) | Out-Null
Start-Sleep -Milliseconds 600
$r = New-Object OHWin+RECT
[OHWin]::GetWindowRect([IntPtr]$ChildHwnd, [ref]$r) | Out-Null
$point = New-Object OHWin+POINT
$point.X = $r.Left + ($r.Right - $r.Left) * 0.55
$point.Y = $r.Top + ($r.Bottom - $r.Top) * 0.56
$owner = 0
[OHWin]::GetWindowThreadProcessId([IntPtr]$ChildHwnd, [ref]$owner) | Out-Null
$hitOwner = 0
$hit = [OHWin]::WindowFromPoint($point)
[OHWin]::GetWindowThreadProcessId($hit, [ref]$hitOwner) | Out-Null
if ($hitOwner -ne $owner) { throw "Hit wrong window ($hit); no input sent" }
$old = New-Object OHWin+POINT
[OHWin]::GetCursorPos([ref]$old) | Out-Null
try {
  [OHWin]::SetCursorPos($point.X, $point.Y) | Out-Null
  [OHWin]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [OHWin]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 200
  $info = New-Object OHWin+INFO
  $info.size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  [OHWin]::GetGUIThreadInfo(0, [ref]$info) | Out-Null
  $focusOwner = 0
  [OHWin]::GetWindowThreadProcessId($info.focus, [ref]$focusOwner) | Out-Null
  if ($focusOwner -ne $owner) { throw "Focus outside ZCode ($($info.focus)); no input sent" }
  [Windows.Forms.SendKeys]::SendWait('oh_input_probe')
  try {
    Start-Sleep -Milliseconds 150
    $b = New-Object Drawing.Bitmap 1920,1080
    $g = [Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen(0,0,0,0,$b.Size)
    $b.Save($OutputPath)
    $g.Dispose(); $b.Dispose()
  } finally { [Windows.Forms.SendKeys]::SendWait('{BACKSPACE 14}') }
  Write-Output "hit=$hit focus=$($info.focus) screenshot=$OutputPath"
} finally { [OHWin]::SetCursorPos($old.X,$old.Y) | Out-Null }
