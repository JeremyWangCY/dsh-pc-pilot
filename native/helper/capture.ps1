function Test-BitmapBlank {
  # True when the sampled quadrant points AND the border/title points are all pure
  # black — the PrintWindow / screen-DC signature of DirectComposition/UWP/
  # hardware-accelerated frames. Small bitmaps (<= 4px) are never flagged.
  param($bmp, [int]$w, [int]$h)
  if ($w -le 4 -or $h -le 4) { return $false }
  $samplePoints = @(
    @{ X = [int]($w * 0.5);  Y = [int]($h * 0.5) },
    @{ X = [int]($w * 0.25); Y = [int]($h * 0.25) },
    @{ X = [int]($w * 0.75); Y = [int]($h * 0.25) },
    @{ X = [int]($w * 0.25); Y = [int]($h * 0.75) },
    @{ X = [int]($w * 0.75); Y = [int]($h * 0.75) }
  )
  foreach ($pt in $samplePoints) {
    $px = $bmp.GetPixel($pt.X, $pt.Y)
    if ($px.R -ne 0 -or $px.G -ne 0 -or $px.B -ne 0) { return $false }
  }
  $borderTitlePoints = @(
    @{ X = [int]($w * 0.5);  Y = [Math]::Min($h - 1, 10) },
    @{ X = [int]($w * 0.25); Y = [Math]::Min($h - 1, 10) },
    @{ X = [int]($w * 0.75); Y = [Math]::Min($h - 1, 10) },
    @{ X = [Math]::Max(0, $w - 15); Y = [Math]::Min($h - 1, 10) },
    @{ X = [Math]::Min($w - 1, 5); Y = [int]($h * 0.5) },
    @{ X = [Math]::Max(0, $w - 5); Y = [int]($h * 0.5) },
    @{ X = [int]($w * 0.5);  Y = [Math]::Max(0, $h - 5) }
  )
  foreach ($pt in $borderTitlePoints) {
    $px = $bmp.GetPixel($pt.X, $pt.Y)
    if ($px.R -ne 0 -or $px.G -ne 0 -or $px.B -ne 0) { return $false }
  }
  return $true
}

function Invoke-WgcCapture {
  # Optional .NET 8 bridge. It captures the target HWND through Windows Graphics
  # Capture, so the returned pixels belong to the target even when another window
  # is covering it. Any bridge failure is deliberately silent here: the caller
  # still has the occlusion-immune PrintWindow fallback below.
  param([IntPtr]$Hwnd, [string]$Path)
  $exe = Join-Path (Join-Path $env:TEMP 'dsh-cua-wgc') 'dsh-pc-pilot-wgc.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $safePath = ([string]$Path).Replace('"', '')
  $psi.Arguments = ('"{0}" "{1}"' -f $Hwnd.ToInt64(), $safePath)
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  try {
    if (-not $proc.Start()) { return $null }
    if (-not $proc.WaitForExit(3500)) {
      try { $proc.Kill() } catch { }
      return @{ ok = $false; error = 'wgc_timeout' }
    }
    $stdout = $proc.StandardOutput.ReadToEnd()
    $dims = [regex]::Match($stdout, '(?m)^\s*(\d+)\s+(\d+)\s*$')
    if ($proc.ExitCode -ne 0 -or -not $dims.Success -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
      return @{ ok = $false; error = 'wgc_capture_failed' }
    }
    return @{ ok = $true; width = [int]$dims.Groups[1].Value; height = [int]$dims.Groups[2].Value }
  } catch {
    return @{ ok = $false; error = 'wgc_capture_exception' }
  } finally {
    try { $proc.Dispose() } catch { }
  }
}

function Do-AppState {
  param([string]$App, [int]$WindowIndex, [bool]$WithScreenshot, [bool]$WithText, [string]$Dispatch)
  $script:observation = $null
  $win = Resolve-TargetWindow -App $App -Index $WindowIndex
  if ($Dispatch -eq 'foreground') {
    [DshWin32]::ForceForeground($win.Hwnd)
    Start-Sleep -Milliseconds 250
    $fresh = @([DshWin32]::EnumWindowsList() | Where-Object { $_.Hwnd -eq $win.Hwnd })
    if ($fresh.Count -gt 0) { $win = $fresh[0] }
  }
  $dwmRect = [DshWin32]::GetDwmRect($win.Hwnd)
  if ($dwmRect.Right -gt $dwmRect.Left -and $dwmRect.Bottom -gt $dwmRect.Top) {
    $win.Rect = $dwmRect
  }
  $shot = $null
  if ($WithScreenshot) {
    $dir = Join-Path $env:TEMP 'dsh-cua'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $path = Join-Path $dir ("shot-{0}.png" -f ([guid]::NewGuid().ToString('N')))
    $w = $win.Rect.Right - $win.Rect.Left
    $h = $win.Rect.Bottom - $win.Rect.Top
    $wgc = Invoke-WgcCapture -Hwnd $win.Hwnd -Path $path
    if ($wgc -and $wgc.ok) {
      $w = $wgc.width
      $h = $wgc.height
      $shot = @{
        path = $path
        width = $w
        height = $h
        scale = 1
        window_rect = @{ x = $win.Rect.Left; y = $win.Rect.Top }
        method = 'windows_graphics_capture'
      }
    }
    if (-not $shot) {
    # Occlusion-immune capture ONLY (no screen-DC degradation): tier 1 WGC bridge,
    # tier 2 PrintWindow multi-mode (flags 2 -> 0 -> 3). Both ask the WINDOW to
    # produce its own frame, so a covering window can never leak into the shot.
    # When neither can render (DirectComposition/UWP without WGC, or fully hung),
    # we report a legible error instead of capturing the occluder.
    $bmp = $null
    $ok = $false
    $black = $true
    foreach ($flag in @(2, 0, 3)) {
      if ($bmp) { $bmp.Dispose(); $bmp = $null }
      $bmp = New-Object System.Drawing.Bitmap([Math]::Max(1, $w), [Math]::Max(1, $h))
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      $tryOk = [DshWin32]::PrintWindow($win.Hwnd, $hdc, [uint32]$flag)
      $g.ReleaseHdc($hdc)
      $g.Dispose()
      if ($tryOk) {
        if (-not (Test-BitmapBlank $bmp $w $h)) {
          $ok = $true
          $black = $false
          break
        }
      }
    }
    if ($ok) { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) }
    # ponytail: GUID shot files are unbounded — keep newest 50, self-prunes the backlog too
    Get-ChildItem $dir -Filter 'shot-*.png' -ea SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 50 | Remove-Item -Force -ea SilentlyContinue
    if ($bmp) { $bmp.Dispose() }
    $minimized = [DshWin32]::IsIconic($win.Hwnd)
    if ($ok -and -not $black) {
      # tier 2 rendered real content (implicit method = print_window)
      $shot = @{
        path = $path
        width = $w
        height = $h
        scale = 1
        window_rect = @{ x = $win.Rect.Left; y = $win.Rect.Top }
      }
      if ($minimized) { $shot.error = 'window_minimized; screenshot is blank' }
    } elseif (-not $minimized) {
      # Both occlusion-immune tiers failed. NEVER fall back to a screen-DC copy:
      # CopyFromScreen grabs whatever is visible in the rect, i.e. possibly the
      # occluding window — that frame would masquerade as the target.
      $shot = @{
        path = $null
        width = $w
        height = $h
        scale = 1
        window_rect = @{ x = $win.Rect.Left; y = $win.Rect.Top }
        error = 'screenshot_black: WGC and PrintWindow both produced no frame; inspect capture diagnostics. No screen-copy or foreground fallback was used'
      }
    } else {
      # both tiers unavailable: minimized window (PrintWindow output is blank by definition)
      $shot = @{
        path = if ($ok) { $path } else { $null }
        width = if ($ok) { $w } else { 0 }
        height = if ($ok) { $h } else { 0 }
        scale = 1
        window_rect = @{ x = $win.Rect.Left; y = $win.Rect.Top }
        error = 'window_minimized; screenshot is blank'
      }
    }
    }
  }
  # A screenshot-only observation is the native Computer Use default.  Avoid
  # walking a potentially huge UIA tree unless the caller specifically needs
  # element indexes or document text; this keeps canvas/Chromium observations
  # responsive while preserving screenshot-id coordinate binding below.
  $tree = @()
  $docText = ''
  $focusedElement = ''
  $selectedText = ''
  $selectedElements = @()
  $script:cachedTreeHwnd = [IntPtr]::Zero
  $script:cachedElements = $null
  $script:cachedIdentities = $null
  if ($WithText) {
    $tree = Get-AccessibilityTree $win.Hwnd -WinRect $win.Rect
    # DESK-03: a freshly launched Win11 Notepad populates its UIA tree late and can
    # expose only the root pane (2 elements) for a while. One short retry turns
    # that into the full tree without a second model round-trip.
    if ($tree.Count -le 2) {
      Start-Sleep -Milliseconds 250
      $retryTree = Get-AccessibilityTree $win.Hwnd -WinRect $win.Rect
      if ($retryTree.Count -gt $tree.Count) { $tree = $retryTree }
    }
    $docText = Get-DocumentText $win.Hwnd
    $focusedElement = Get-FocusedElementText $win.Hwnd
    $selectedText = Get-SelectedText $win.Hwnd
    $selectedElements = @($tree | Where-Object { $_.selected } | ForEach-Object { "[$($_.index)] $($_.role): $($_.name)" })
  }
  $script:observation = @{ id = [guid]::NewGuid().ToString('N'); hwnd = $win.Hwnd; rect = $win.Rect; created = [DateTime]::UtcNow }
  $script:lastScreenshot = $null
  if ($shot) {
    $shot.id = $script:observation.id
    $shot.coordinate_space = 'window'
    $shot.viewport = @{ coordinate_space = 'window'; x = 0; y = 0; width = $w; height = $h; screen_x = $win.Rect.Left; screen_y = $win.Rect.Top; scale = 1 }
    $shot.trusted = (-not $shot.error)
    if ($shot.path) { $script:lastScreenshot = @{ id = $shot.id; hwnd = $win.Hwnd; rect = $win.Rect; created = $script:observation.created } }
  }
  return @{
    snapshot_id = $script:observation.id
    observed_at = $script:observation.created.ToString('o')
    window = (Get-WindowInfo $win)
    screenshot = $shot
    screenshot_id = if ($shot -and $shot.path) { $shot.id } else { $null }
    elements = $tree
    element_count = $tree.Count
    document_text = if ($docText) { $docText } else { '' }
    focused_element = if ($focusedElement) { $focusedElement } else { '' }
    selected_text = if ($selectedText) { $selectedText } else { '' }
    selected_elements = $selectedElements
    note = if ($WithText) { 'Element indexes are only valid together with this state; refresh after any UI change.' } else { 'Screenshot-only state: request include_text:true before using element_index.' }
  }
}

# ---------------------------------------------------------------- actions
