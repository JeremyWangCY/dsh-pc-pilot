$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PillProbe {
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls,string title);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$seen = $false; $hiddenAfter = $false
$foreground = [PillProbe]::GetForegroundWindow()
$focusStable = $true
$watch = [Diagnostics.Stopwatch]::StartNew()
Write-Output 'READY'
while ($watch.ElapsedMilliseconds -lt 8500) {
  $h = [PillProbe]::FindWindow('DshStatusPillCls', $null)
  $visible = $h -ne [IntPtr]::Zero -and [PillProbe]::IsWindowVisible($h)
  if ($visible) { $seen = $true }
  if ($seen -and -not $visible) { $hiddenAfter = $true }
  if ([PillProbe]::GetForegroundWindow() -ne $foreground) { $focusStable = $false }
  Start-Sleep -Milliseconds 80
}
@{ seen = $seen; hidden_after = $hiddenAfter; foreground_stable = $focusStable } | ConvertTo-Json -Compress
