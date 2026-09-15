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

$script:wgcServer = $null

function Reset-WgcCaptureServer {
  if ($script:wgcServer) {
    try { if (-not $script:wgcServer.HasExited) { $script:wgcServer.Kill() } } catch { }
    try { $script:wgcServer.Dispose() } catch { }
  }
  $script:wgcServer = $null
}

function Get-WgcCaptureServer {
  $exe = Join-Path (Join-Path $env:TEMP 'dsh-cua-wgc') 'dsh-pc-pilot-wgc.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
  if ($script:wgcServer) {
    try { if (-not $script:wgcServer.HasExited) { return $script:wgcServer } } catch { }
    Reset-WgcCaptureServer
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '--server'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $false
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  try {
    if (-not $proc.Start()) { $proc.Dispose(); return $null }
    $script:wgcServer = $proc
    return $proc
  } catch {
    try { $proc.Dispose() } catch { }
    return $null
  }
}

function Invoke-WgcCapture {
  # Keep one .NET 8 WGC bridge alive for the PowerShell helper lifetime. The
  # bridge reuses a bounded capture slot (GraphicsCaptureItem + frame pool +
  # capture session) per HWND, so repeated observations avoid recreating WGC
  # state. Broken slots are evicted in the bridge; a broken bridge process is
  # discarded here and the frame falls back to PrintWindow.
  param([IntPtr]$Hwnd, [string]$Path)
  $safePath = ([string]$Path).Replace('"', '').Replace([string][char]9, '').Replace([string][char]13, '').Replace([string][char]10, '')
  $proc = Get-WgcCaptureServer
  if (-not $proc) { return $null }
  try {
    $proc.StandardInput.WriteLine(('{0}{1}{2}' -f $Hwnd.ToInt64(), [char]9, $safePath))
    $proc.StandardInput.Flush()
    # The bridge owns its bounded 2.5s frame timeout. Keep this pipe read simple
    # and synchronous; the outer PC-Pilot action timeout remains the final guard
    # if the bridge process itself becomes unhealthy.
    $line = [string]$proc.StandardOutput.ReadLine()
    if (-not $line) {
      Reset-WgcCaptureServer
      return @{ ok = $false; error = 'wgc_capture_failed'; detail = 'wgc_server_closed_pipe' }
    }
    $dims = [regex]::Match($line, '^OK\s+(\d+)\s+(\d+)$')
    if (-not $dims.Success -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
      if ($line -notmatch '^ERR\s+') { Reset-WgcCaptureServer }
      return @{ ok = $false; error = 'wgc_capture_failed'; detail = $line }
    }
    return @{ ok = $true; width = [int]$dims.Groups[1].Value; height = [int]$dims.Groups[2].Value }
  } catch {
    Reset-WgcCaptureServer
    return @{ ok = $false; error = 'wgc_capture_exception' }
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
        method = 'print_window'
      }
      if ($wgc -and -not $wgc.ok) {
        $shot.wgc_error = $wgc.error
        if ($wgc.detail) { $shot.wgc_detail = $wgc.detail }
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
  # Keep "no tree was requested" distinct from "the app exposed no usable UIA
  # descendants".  Modern WinUI/UWP apps regularly have a valid HWND and WGC
  # frame while their accessibility provider is still loading (or unavailable).
  # A plain successful response with elements:[] encouraged callers to invent
  # an element index and then fail later without a recovery direction.
  $accessibilityStatus = 'not_requested'
  $accessibilityRevision = $null
  $accessibilityDelta = $null
  $script:cachedTreeHwnd = [IntPtr]::Zero
  $script:cachedElements = $null
  $script:cachedIdentities = $null
  if ($WithText) {
    $tree = Get-AccessibilityTree $win.Hwnd -WinRect $win.Rect
    $bestCachedElements = $script:cachedElements
    $bestCachedIdentities = $script:cachedIdentities
    # DESK-03: a freshly launched Win11 Notepad (and several WinUI apps) can
    # expose only a root pane or no descendants while the first frame settles.
    # A partial tree has evidence that the provider is coming up, so allow it a
    # bounded 2s stabilization pass.  A completely absent tree is commonly a
    # permanent WinUI/UWP limitation; only probe it twice (500ms) before
    # returning the explicit unavailable diagnosis.  We retain the largest tree
    # seen, and never turn a missing provider into a fake element target.
    $needsStabilization = ($tree.Count -le 2)
    if ($tree.Count -gt 0 -and $tree.Count -le 2) {
      for ($i = 0; $i -lt $tree.Count; $i++) {
        $item = $tree[$i]
        $role = '' + $item.role
        $name = '' + $item.name
        $value = '' + $item.value
        $autoId = '' + $item.automation_id
        $hasSemanticControl = $item.invokable -or $value -or $autoId -or
          ($name -and $role -match '(?i)(Button|Edit|Text|ListItem|MenuItem|CheckBox|RadioButton|ComboBox|TabItem|Hyperlink|Slider|TreeItem)')
        if ($hasSemanticControl) { $needsStabilization = $false; break }
      }
    }
    if ($needsStabilization) {
      $retryLimit = if ($tree.Count -eq 0) { 2 } else { 8 }
      for ($attempt = 0; $attempt -lt $retryLimit -and $needsStabilization; $attempt++) {
        Start-Sleep -Milliseconds 250
        $retryTree = Get-AccessibilityTree $win.Hwnd -WinRect $win.Rect
        if ($retryTree.Count -gt $tree.Count) {
          $tree = $retryTree
          $bestCachedElements = $script:cachedElements
          $bestCachedIdentities = $script:cachedIdentities
        }

        if ($tree.Count -gt 2) {
          $needsStabilization = $false
        } elseif ($tree.Count -gt 0) {
          for ($i = 0; $i -lt $tree.Count; $i++) {
            $item = $tree[$i]
            $role = '' + $item.role
            $name = '' + $item.name
            $value = '' + $item.value
            $autoId = '' + $item.automation_id
            $hasSemanticControl = $item.invokable -or $value -or $autoId -or
              ($name -and $role -match '(?i)(Button|Edit|Text|ListItem|MenuItem|CheckBox|RadioButton|ComboBox|TabItem|Hyperlink|Slider|TreeItem)')
            if ($hasSemanticControl) { $needsStabilization = $false; break }
          }
        }
      }
    }
    $script:cachedTreeHwnd = $win.Hwnd
    $script:cachedElements = $bestCachedElements
    $script:cachedIdentities = $bestCachedIdentities
    if ($tree.Count -eq 0) { $accessibilityStatus = 'unavailable' }
    elseif ($tree.Count -le 2) { $accessibilityStatus = 'partial' }
    else { $accessibilityStatus = 'available' }
    $deltaKey = ('{0}:{1}' -f [string]$win.Hwnd.ToInt64(), [string]$win.Pid)
    $accessibilityDelta = Get-AccessibilityDelta -Key $deltaKey -Tree $tree
    $accessibilityRevision = $accessibilityDelta.revision
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
    accessibility_status = $accessibilityStatus
    accessibility_revision = $accessibilityRevision
    accessibility_delta = $accessibilityDelta
    document_text = if ($docText) { $docText } else { '' }
    focused_element = if ($focusedElement) { $focusedElement } else { '' }
    selected_text = if ($selectedText) { $selectedText } else { '' }
    selected_elements = $selectedElements
    note = if (-not $WithText) { 'Screenshot-only state: request include_text:true before using element_index.' }
      elseif ($accessibilityStatus -eq 'unavailable') { 'No usable UI Automation descendants were exposed. Wait and re-observe, or use a screenshot-bound foreground coordinate path only when the task permits it; do not invent an element_index.' }
      elseif ($accessibilityStatus -eq 'partial') { 'Only a partial UI Automation tree is available. Re-observe before relying on element indexes.' }
      else { 'Element indexes are only valid together with this state; refresh after any UI change.' }
  }
}

# ---------------------------------------------------------------- actions
