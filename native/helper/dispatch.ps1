$script:devtoolsHttpClient = $null

function Test-ChromiumProfileLocked {
  param([string]$ProfileDir)
  if (-not $ProfileDir) { return $false }
  $lockPath = Join-Path $ProfileDir 'lockfile'
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $false }

  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    return $false
  } catch [System.IO.IOException] {
    return $true
  } catch [System.UnauthorizedAccessException] {
    # Treat an unreadable lock as potentially active; callers can fall back to
    # the slower process/command-line check before making a destructive choice.
    return $true
  } finally {
    if ($stream) { try { $stream.Dispose() } catch { } }
  }
}

function Get-DevToolsHttpClient {
  if ($script:devtoolsHttpClient) { return $script:devtoolsHttpClient }
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromMilliseconds(1000)
  $script:devtoolsHttpClient = $client
  return $client
}

function Test-DevToolsEndpoint {
  param([int]$Port)
  $response = $null
  try {
    $client = Get-DevToolsHttpClient
    $response = $client.GetAsync("http://127.0.0.1:$Port/json/version").GetAwaiter().GetResult()
    return [bool]$response.IsSuccessStatusCode
  } catch {
    return $false
  } finally {
    if ($response) { try { $response.Dispose() } catch { } }
  }
}

function Get-DevToolsJson {
  param([string]$Uri)
  $response = $null
  try {
    $client = Get-DevToolsHttpClient
    $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "DevTools HTTP $([int]$response.StatusCode)" }
    $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return $raw | ConvertFrom-Json
  } finally {
    if ($response) { try { $response.Dispose() } catch { } }
  }
}

function Invoke-DevToolsGet {
  param([string]$Uri)
  $response = $null
  try {
    $client = Get-DevToolsHttpClient
    $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
    return [bool]$response.IsSuccessStatusCode
  } catch {
    return $false
  } finally {
    if ($response) { try { $response.Dispose() } catch { } }
  }
}

function Split-AppCommand {
  # Split an open_app name like 'notepad.exe C:\foo.txt' or
  # '"C:\Program Files\App\app.exe" --flag "some arg"' into FilePath + ArgumentList.
  # Returns @(filePath, argumentList).
  param([string]$Name)
  $trimmed = ([string]$Name).Trim()
  if (-not $trimmed) { return @($trimmed, @()) }

  # whitespace tokenizer that respects double quotes
  $tokens = New-Object System.Collections.Generic.List[string]
  $sb = ''
  $inQuote = $false
  foreach ($ch in $trimmed.ToCharArray()) {
    if ($ch -eq '"') {
      if ($inQuote) { if ($sb) { $tokens.Add($sb); $sb = '' }; $inQuote = $false }
      else { $inQuote = $true }
    } elseif ($ch -eq ' ' -and -not $inQuote) {
      if ($sb) { $tokens.Add($sb); $sb = '' }
    } else {
      $sb += $ch
    }
  }
  if ($sb) { $tokens.Add($sb) }

  if ($tokens.Count -eq 0) { return @($trimmed, @()) }

  $filePath = $tokens[0]
  $argList = @()
  if ($tokens.Count -gt 1) { $argList = @($tokens.GetRange(1, $tokens.Count - 1).ToArray()) }

  # unquoted path containing spaces: extend the file token while the joined prefix exists on disk
  if ($tokens.Count -gt 1 -and -not (Test-Path $filePath)) {
    for ($i = 2; $i -le $tokens.Count; $i++) {
      $candidate = ($tokens.GetRange(0, $i).ToArray() -join ' ')
      if (Test-Path $candidate) {
        $filePath = $candidate
        if ($i -lt $tokens.Count) { $argList = @($tokens.GetRange($i, $tokens.Count - $i).ToArray()) } else { $argList = @() }
        break
      }
    }
  }
  # bare executable name without a path/extension: Start-Process fails on this machine's
  # restricted lookup ("system cannot find all information required") — resolve the real
  # path on PATH and retry with the .exe suffix so `open_app { name: "notepad" }` works
  if (-not (Test-Path $filePath) -and $filePath -notmatch '[\\/\.]') {
    try {
      $resolved = (Get-Command -Name "$filePath.exe" -ErrorAction Stop).Source
      if ($resolved) { $filePath = $resolved }
    } catch { }
  }
  return @($filePath, $argList)
}

function Assert-ForegroundTarget {
  param($Win)
  [DshWin32]::ForceForeground($Win.Hwnd)
  Start-Sleep -Milliseconds 150
  $foreground = [DshWin32]::GetForegroundWindow()
  $focused = ($foreground -eq $Win.Hwnd -or [DshWin32]::IsChild($Win.Hwnd, $foreground))
  if (-not $focused) {
    # SendInput has no HWND target. Continuing after a failed activation would
    # deliver real input to whichever app the user is actually using.
    throw "foreground_activation_unconfirmed: target hwnd $($Win.Hwnd.ToInt64()) did not become foreground; no real input was sent"
  }
  return $true
}

function Get-ClipboardTextSafe {
  if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -eq [System.Threading.ApartmentState]::STA) {
    for ($i = 0; $i -lt 10; $i++) {
      try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          return [System.Windows.Forms.Clipboard]::GetText()
        }
        return ''
      } catch {
        Start-Sleep -Milliseconds 50
      }
    }
    return [System.Windows.Forms.Clipboard]::GetText()
  } else {
    $rs = $null; $ps = $null
    try {
      $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
      $rs.ApartmentState = [System.Threading.ApartmentState]::STA
      $rs.Open()
      $ps = [System.Management.Automation.PowerShell]::Create()
      $ps.Runspace = $rs
      $null = $ps.AddScript({
        Add-Type -AssemblyName System.Windows.Forms
        for ($i = 0; $i -lt 10; $i++) {
          try {
            if ([System.Windows.Forms.Clipboard]::ContainsText()) {
              return [System.Windows.Forms.Clipboard]::GetText()
            }
            return ''
          } catch {
            Start-Sleep -Milliseconds 50
          }
        }
        return [System.Windows.Forms.Clipboard]::GetText()
      })
      $out = $ps.Invoke()
      if ($out -and $out.Count -gt 0) { return [string]$out[0] }
      return ''
    } finally {
      if ($null -ne $ps) { $ps.Dispose() }
      if ($null -ne $rs) { $rs.Dispose() }
    }
  }
}

function Set-ClipboardTextSafe {
  param([string]$Text)
  if ($null -eq $Text) { $Text = '' }
  if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -eq [System.Threading.ApartmentState]::STA) {
    for ($i = 0; $i -lt 10; $i++) {
      try {
        if ($Text.Length -eq 0) {
          [System.Windows.Forms.Clipboard]::Clear()
        } else {
          [System.Windows.Forms.Clipboard]::SetText($Text)
        }
        return
      } catch {
        Start-Sleep -Milliseconds 50
      }
    }
    if ($Text.Length -eq 0) {
      [System.Windows.Forms.Clipboard]::Clear()
    } else {
      [System.Windows.Forms.Clipboard]::SetText($Text)
    }
  } else {
    $rs = $null; $ps = $null
    try {
      $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
      $rs.ApartmentState = [System.Threading.ApartmentState]::STA
      $rs.Open()
      $ps = [System.Management.Automation.PowerShell]::Create()
      $ps.Runspace = $rs
      $null = $ps.AddScript({
        param($t)
        Add-Type -AssemblyName System.Windows.Forms
        for ($i = 0; $i -lt 10; $i++) {
          try {
            if ($t.Length -eq 0) {
              [System.Windows.Forms.Clipboard]::Clear()
            } else {
              [System.Windows.Forms.Clipboard]::SetText($t)
            }
            return
          } catch {
            Start-Sleep -Milliseconds 50
          }
        }
        if ($t.Length -eq 0) {
          [System.Windows.Forms.Clipboard]::Clear()
        } else {
          [System.Windows.Forms.Clipboard]::SetText($t)
        }
      }).AddArgument($Text)
      $null = $ps.Invoke()
    } finally {
      if ($null -ne $ps) { $ps.Dispose() }
      if ($null -ne $rs) { $rs.Dispose() }
    }
  }
}

function Invoke-MouseButtonAction {
  param([bool]$IsDown, $Result)
  $Action = if ($IsDown) { 'mouse_down' } else { 'mouse_up' }
  $button = Get-PayloadValue 'button'
  if (-not $button) { $button = 'left' }
  $button = ([string]$button).ToLowerInvariant()
  if ($button -notin @('left', 'right', 'middle', 'back', 'forward')) {
    throw "invalid mouse button: $button (expected 'left', 'right', 'middle', 'back', or 'forward')"
  }
  $app = Get-PayloadValue 'app'
  $rawX = Get-PayloadValue 'x'
  $rawY = Get-PayloadValue 'y'
  $dispatch = Get-Dispatch
  $win = $null
  if ($app) {
    $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
    if ($dispatch -eq 'foreground') {
      $Result.focus_ok = Assert-ForegroundTarget -Win $win
    }
  }

  if ($null -ne $rawX -and $null -ne $rawY) {
    $x = [int]$rawX
    $y = [int]$rawY
    if ($win) {
      $sx = $win.Rect.Left + $x
      $sy = $win.Rect.Top + $y
    } else {
      $sx = $x
      $sy = $y
    }
  } else {
    $cur = [System.Windows.Forms.Cursor]::Position
    $sx = [int]$cur.X
    $sy = [int]$cur.Y
  }

  Notify-Cursor -X $sx -Y $sy -Label ($Action + ' ' + $button)

  if ($dispatch -eq 'background') {
    $h = [IntPtr]::Zero
    if ($win) {
      # app-scoped: target-window tree lookup — occluding windows can never intercept
      # the delivery (old code preferred the screen-level hwnd, i.e. the occluder)
      $h = Find-TargetHwndAt -Hwnd $win.Hwnd -X $sx -Y $sy -Win $win
    } else {
      $pt = New-Object System.Windows.Point($sx, $sy)
      $wEl = $null
      try { $wEl = [System.Windows.Automation.AutomationElement]::FromPoint($pt) } catch { }
      for ($i = 0; $i -lt 24 -and $null -ne $wEl; $i++) {
        $nh = $wEl.Current.NativeWindowHandle
        if ($nh -ne 0) { $h = [IntPtr]$nh; break }
        $wEl = Get-UiaParent $wEl
      }
      if ($h -eq [IntPtr]::Zero) {
        $p = New-Object DshWin32+POINT; $p.X = $sx; $p.Y = $sy
        $h = [DshWin32]::WindowFromPoint($p)
      }
    }
    if ($h -ne [IntPtr]::Zero) {
      $msg = 0
      $wParam = [IntPtr]::Zero
      switch ($button) {
        'left' {
          if ($IsDown) { $msg = 0x0201; $wParam = [IntPtr]0x0001 }
          else { $msg = 0x0202; $wParam = [IntPtr]0x0000 }
        }
        'right' {
          if ($IsDown) { $msg = 0x0204; $wParam = [IntPtr]0x0002 }
          else { $msg = 0x0205; $wParam = [IntPtr]0x0000 }
        }
        'middle' {
          if ($IsDown) { $msg = 0x0207; $wParam = [IntPtr]0x0010 }
          else { $msg = 0x0208; $wParam = [IntPtr]0x0000 }
        }
        'back' {
          if ($IsDown) { $msg = 0x020B; $wParam = [IntPtr]0x00010000 }
          else { $msg = 0x020C; $wParam = [IntPtr]0x00010000 }
        }
        'forward' {
          if ($IsDown) { $msg = 0x020B; $wParam = [IntPtr]0x00020000 }
          else { $msg = 0x020C; $wParam = [IntPtr]0x00020000 }
        }
      }
      $cpt = [DshWin32]::ScreenToClientPoint($h, $sx, $sy)
      $lParam = [IntPtr](($cpt.Y -band 0xFFFF) -shl 16 -bor ($cpt.X -band 0xFFFF))
      $res = [IntPtr]::Zero
      $null = [DshWin32]::SendMessageTimeout($h, $msg, $wParam, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
      $Result.method = 'wm_message'
      $Result.target_hwnd = $h.ToInt64()
      $Result.button = $button
      $Result.position = @{ x = $sx; y = $sy }
      $Result.message = "$Action ($button) sent via window message to hwnd $($h.ToInt64()) at ($sx, $sy)"
    } else {
      $Result.background_unavailable = $true
      $Result.message = "${Action}: no target window found at ($sx, $sy); use dispatch=foreground."
    }
  } else {
    if ($IsDown) {
      [DshWin32]::MouseDown($sx, $sy, $button)
    } else {
      [DshWin32]::MouseUp($sx, $sy, $button)
    }
    $Result.method = 'send_input'
    $Result.button = $button
    $Result.position = @{ x = $sx; y = $sy }
    $Result.message = "$Action ($button) at screen ($sx, $sy)"
  }
}

# ---------------------------------------------------------------- shared action dispatch
# Both the one-shot path and the -Server daemon call this; the switch body is
# unchanged. Returns the reply hashtable (plus any stray pipeline output that
# leaked inside dispatch, which callers drop).
function Invoke-ActionRequest {
  param([string]$Action, $Payload)
  $script:payload = $Payload
  $result = @{ ok = $true; action = $Action; message = '' }
  $script:autoChosenHwnd = $null
  $prevUserFg = [DshWin32]::GetForegroundWindow()
  $dispatchMode = Get-Dispatch

  try {
    switch ($Action) {
    'list_apps' {
      $wins = @([DshWin32]::EnumWindowsList())
      $byPid = @{}
      $procCache = @{}
      foreach ($w in $wins) {
        if ($w.Rect.Left -lt -10000 -or $w.Rect.Top -lt -10000) { continue }
        if (-not $byPid.ContainsKey($w.Pid)) {
          $name = Get-ProcessNameFast -ProcessId $w.Pid -Cache $procCache
          $identity = Get-ProcessIdentityFast -ProcessId $w.Pid
          $byPid[$w.Pid] = @{ pid = $w.Pid; name = $name; identity = $identity; windows = New-Object System.Collections.ArrayList }
        }
        $null = $byPid[$w.Pid].windows.Add((Get-WindowInfo $w -IncludeIdentity $false))
      }
      $result.apps = @($byPid.Values)
      $result.message = "Found $($byPid.Count) apps / $($wins.Count) windows"
    }

    'get_app_identity' {
      $app = [string](Get-PayloadValue 'app')
      $hwndVal = Get-PayloadValue 'hwnd'
      $hwnd = if ($hwndVal) { [int64]$hwndVal } else { 0 }
      $targetPid = [uint32]0
      if ($hwnd -gt 0 -or $app) {
        if ($app -match '^\d+$' -and $hwnd -le 0) {
          $targetPid = [uint32]$app
          try { $null = [System.Diagnostics.Process]::GetProcessById([int]$targetPid) } catch { throw "app_not_found: pid $targetPid" }
        } else {
          $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index')) -Hwnd $hwnd
          $targetPid = [uint32]$win.Pid
        }
      } else {
        throw 'get_app_identity requires app, pid-as-app, or hwnd'
      }
      $verify = Get-PayloadValue 'verify_signature'
      if ($null -eq $verify) { $verify = $true }
      $identity = Get-ProcessIdentityFast -ProcessId $targetPid -Detailed $true -VerifySignature ([bool]$verify)
      $result.identity = $identity
      $result.pid = $targetPid
      $result.process_name = $identity.process_name
      $result.message = "Resolved app identity for pid $targetPid ($($identity.process_name))"
    }

    'get_window_state' {
      $app = Get-PayloadValue 'app'
      $idx = [int](Get-PayloadValue 'window_index')
      $shot = Get-PayloadValue 'screenshot'
      if ($null -eq $shot) { $shot = $true }
      $withText = Get-PayloadValue 'include_text'
      if ($null -eq $withText) { $withText = $false }
      $st = Do-AppState -App $app -WindowIndex $idx -WithScreenshot ([bool]$shot) -WithText ([bool]$withText) -Dispatch (Get-Dispatch)
      $result.window = $st.window
      $result.snapshot_id = $st.snapshot_id
      $result.screenshot_id = $st.screenshot_id
      $result.observed_at = $st.observed_at
      $result.screenshot = $st.screenshot
      $result.elements = $st.elements
      $result.element_count = $st.element_count
      $result.accessibility_status = $st.accessibility_status
      $result.accessibility_revision = $st.accessibility_revision
      $result.accessibility_delta = $st.accessibility_delta
      $result.document_text = $st.document_text
      $result.note = $st.note
      $result.accessibility = if ([bool]$withText) {
        # Match the native Computer Use presentation: a compact, copyable tree
        # for model reasoning while retaining the richer `elements` array for
        # DSH callers that need structured fields.
        $treeLines = @($st.elements | ForEach-Object {
          $line = "[$($_.index)] $($_.role): $($_.name)"
          if ($_.value) { $line += " = $($_.value)" }
          $line
        })
        @{ status = $st.accessibility_status; revision = $st.accessibility_revision; delta = $st.accessibility_delta; tree = ($treeLines -join "`n"); document_text = $st.document_text; focused_element = $st.focused_element; selected_text = $st.selected_text; selected_elements = $st.selected_elements }
      } else { $null }
      $result.dispatch = (Get-Dispatch)
      $result.message = "State captured for '$app' ($($st.element_count) elements)"
      if ($st.screenshot -and $st.screenshot.error) { $result.message += ' [' + $st.screenshot.error + ']' }
    }

    'click' {
      $app = Get-PayloadValue 'app'
      $rawElement = Get-PayloadValue 'element'
      $rawX = Get-PayloadValue 'x'; $rawY = Get-PayloadValue 'y'
      $button = Get-PayloadValue 'button'
      if (-not $button) { $button = 'left' }
      $button = ([string]$button).ToLowerInvariant()
      if ($button -notin @('left', 'right', 'middle', 'back', 'forward')) {
        throw "invalid mouse button: $button (expected 'left', 'right', 'middle', 'back', or 'forward')"
      }
      $clickCount = 1
      $rawCount = Get-PayloadValue 'click_count'
      if ($null -ne $rawCount) {
        $clickCount = [int]$rawCount
        if ($clickCount -lt 1) { $clickCount = 1 }
        if ($clickCount -gt 3) { $clickCount = 3 }
      }
      $dispatch = Get-Dispatch
      $rawMods = [string](Get-PayloadValue 'modifiers')
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') { $result.focus_ok = Assert-ForegroundTarget -Win $win }
        $r = $win.Rect
      }
      Assert-ScreenshotBinding -Hwnd $(if ($win) { $win.Hwnd } else { [IntPtr]::Zero })
      $el = $null
      $expectedName = [string](Get-PayloadValue 'expected_name')
      if ($null -ne $rawElement) {
        if (-not $win -or [string]::IsNullOrWhiteSpace([string]$rawElement) -or [int]$rawElement -lt 1) { throw 'invalid_element: click element requires app and a positive index' }
        $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index ([int]$rawElement)
        $er = $el.Current.BoundingRectangle
        if ($null -eq $er -or $er.IsEmpty -or $er.Width -le 0 -or $er.Height -le 0) { throw 'target_validation_failed: invalid element rectangle' }
        $pt = Resolve-ClickPoint -RawX ($er.X + $er.Width / 2) -RawY ($er.Y + $er.Height / 2) -Win $win -Space screen
        Assert-ClickTarget -Element $el -Hwnd $win.Hwnd -X $pt[0] -Y $pt[1] -ExpectedName $expectedName
        $result.element = [int]$rawElement
      } else {
        $pt = Resolve-ClickPoint -RawX $rawX -RawY $rawY -Win $win -Space ([string](Get-PayloadValue 'coordinate_space'))
        if ($win -and $dispatch -eq 'background' -and [string]::IsNullOrWhiteSpace($expectedName)) {
          throw 'target_validation_required: background app coordinate click requires expected_name; call get_window_state and use click with element_index'
        }
      }
      $sx = $pt[0]; $sy = $pt[1]

      $label = 'click'
      if ($clickCount -eq 2) { $label = 'double-click' }
      elseif ($clickCount -eq 3) { $label = 'triple-click' }
      if ($button -ne 'left') { $label = "$button $label" }
      if ($dispatch -eq 'background') {
        Notify-Cursor -X $sx -Y $sy -Label $label
        if ($button -eq 'left' -and $clickCount -eq 1) {
          if ($rawMods) {
            if ($win) {
              if ($null -eq $el) { $el = (Find-TargetHitsAt -Hwnd $win.Hwnd -X $sx -Y $sy).best }
              Assert-ClickTarget -Element $el -Hwnd $win.Hwnd -X $sx -Y $sy -ExpectedName $expectedName
              $h = [IntPtr]$el.Current.NativeWindowHandle
              if ($h -eq [IntPtr]::Zero) { throw 'background_unavailable: validated modifier target has no native handle; use dispatch=foreground' }
              if ($h -ne $win.Hwnd -and -not [DshWin32]::IsChild($win.Hwnd, $h)) { throw 'target_validation_failed: native handle is outside target window' }
            } else {
              $h = Find-BackgroundHwndAt -Sx $sx -Sy $sy -Win $win
            }
            if ($h -eq [IntPtr]::Zero) { throw 'background_unavailable: no validated native window for modifier click' }
            Send-BackgroundMouseButton -Hwnd $h -Sx $sx -Sy $sy -Button $button -Count $clickCount -Modifiers $rawMods
            $result.method = 'wm_message_with_modifiers'
            $result.target_hwnd = $h.ToInt64()
            $result.modifiers = $rawMods
            $result.hit_name = if ($el) { $el.Current.Name } else { $null }
            $result.message = "Background modifier click sent to hwnd $($h.ToInt64())"
          } elseif ($win) {
            # app-scoped: aim at the TARGET window's own tree — physical occlusion by
            # other windows does not affect delivery; UIA pattern hits still take
            # priority over bare WM messages
            $hit = Invoke-FromPointInWindow -Hwnd $win.Hwnd -X $sx -Y $sy -ExpectedName $expectedName -Element $el
            if ($hit.ok) {
              $result.method = 'uia_window_hit_' + $hit.method
              $result.hit_name = $hit.name
              $result.message = "Background click at ($sx, $sy) -> $($hit.method) on '$($hit.name)' (target-window tree; occlusion-immune)"
            } else {
              throw 'target_validation_failed: background click was not confirmed; no fallback attempted'
            }
          } else {
            # global click (no app): screen-level semantics unchanged
            $hit = Invoke-FromPoint -X $sx -Y $sy
            if ($hit.ok) {
              $result.method = 'uia_hit_' + $hit.method
              $result.hit_name = $hit.name
              $result.message = "Background click at ($sx, $sy) -> $($hit.method) on '$($hit.name)'"
            } else {
              $result.background_unavailable = $true
              $result.message = "Background click at ($sx, $sy): no invokable/toggle/selectable control at that point (canvas or coordinate-text click). Use dispatch=foreground for a real click, or click with element_index."            }
          }
        } else {
          # right/middle clicks and multi-clicks: standard WM click sequence;
          # app-scoped lookups must never hit the screen-level occluder
          if ($win) {
            if ($null -eq $el) { $el = (Find-TargetHitsAt -Hwnd $win.Hwnd -X $sx -Y $sy).best }
            Assert-ClickTarget -Element $el -Hwnd $win.Hwnd -X $sx -Y $sy -ExpectedName $expectedName
            $h = [IntPtr]$el.Current.NativeWindowHandle
            if ($h -eq [IntPtr]::Zero) { throw 'background_unavailable: validated target has no native handle; use click with element_index' }
            if ($h -ne $win.Hwnd -and -not [DshWin32]::IsChild($win.Hwnd, $h)) { throw 'target_validation_failed: native handle is outside target window' }
            Assert-ClickTarget -Element $el -Hwnd $win.Hwnd -X $sx -Y $sy -ExpectedName $expectedName
          } else {
            $h = Find-BackgroundHwndAt -Sx $sx -Sy $sy -Win $win
          }
          if ($h -ne [IntPtr]::Zero) {
            Send-BackgroundMouseButton -Hwnd $h -Sx $sx -Sy $sy -Button $button -Count $clickCount -Modifiers $rawMods
            $result.method = 'wm_message'
            $result.target_hwnd = $h.ToInt64()
            if ($rawMods) { $result.method = 'wm_message_with_modifiers'; $result.modifiers = $rawMods }
            $result.message = "Background $label sent via window message to hwnd $($h.ToInt64()) at ($sx, $sy)"
          } else {
            $result.background_unavailable = $true
            $result.message = "Background $label at ($sx, $sy): no target window found at that point. Use dispatch=foreground."
          }
        }
        $result.clicked = @{ x = $sx; y = $sy }
      } else {
        Notify-Cursor -X $sx -Y $sy -Label $label
        if ($rawMods) { [DshWin32]::MouseClickExWithModifiers($sx, $sy, $clickCount, $button, $rawMods) }
        else { [DshWin32]::MouseClickEx($sx, $sy, $clickCount, $button) }
        $result.button = $button
        $result.click_count = $clickCount
        if ($rawMods) { $result.modifiers = $rawMods }
        $result.message = "$label at screen ($sx, $sy)"
        $result.clicked = @{ x = $sx; y = $sy }
      }
    }

    'set_value' {
      $app = Get-PayloadValue 'app'
      $element = [int](Get-PayloadValue 'element')
      $value = Get-PayloadValue 'value'
      $dispatch = Get-Dispatch
      $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
      if ($dispatch -eq 'foreground') {
        $result.focus_ok = Assert-ForegroundTarget -Win $win
      }
      $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index $element
      Assert-ConsequenceConfirmation -Element $el
      Assert-SensitiveConfirmation -Element $el
      $cap = Get-BackgroundCapabilityRecord -Hwnd $win.Hwnd -Element $el
      if ($dispatch -eq 'background' -and $cap -and $cap.ContainsKey('value') -and -not [bool]$cap.value) {
        $result.background_unavailable = $true
        $result.method = 'capability_cache'
        $result.message = "Element $element is already known not to support ValuePattern; background set_value unavailable without retrying the unsupported path."
        break
      }
      $vp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        Set-BackgroundCapability -Hwnd $win.Hwnd -Element $el -Name 'value' -Supported $true
        if ($dispatch -eq 'background') {
          $pt = Get-OverlayPoint-Element -Element $el -Win $win
          if ($pt) { Notify-Cursor -X $pt[0] -Y $pt[1] -Label 'set_value' }
        }
        $vp.SetValue($value)
        # read back so outcome becomes 'verified' instead of an unproven 'dispatched'
        $result.verified = ([string]$vp.Current.Value -ceq [string]$value)
        $result.method = 'value_pattern'
        if ($result.verified) {
          $result.message = "Set element $element value and read it back"
        } else {
          # A control may reject or normalize SetValue. The mutation was
          # attempted, but its final value is not the requested value, so it is
          # unsafe to report a completed write or invite an automatic retry.
          $result.ok = $false
          $result.error_code = 'value_verification_failed'
          $result.needs_observation = $true
          $result.message = "Set element $element value, but readback differed; inspect current state before deciding what to do next"
        }
      } elseif ($dispatch -eq 'background') {
        Set-BackgroundCapability -Hwnd $win.Hwnd -Element $el -Name 'value' -Supported $false
        $result.background_unavailable = $true
        $result.method = 'capability_cache_update'
        $result.message = "Element $element has no ValuePattern; cached this unsupported background path until the next observation refresh."
      } else {
        $el.SetFocus()
        Start-Sleep -Milliseconds 100
        [DshWin32]::TypeText($value)
        $result.method = 'focus_type'
        $result.message = 'Focused element and typed value (unverified)'
      }
    }

    'type_text' {
      $app = Get-PayloadValue 'app'
      $text = Get-PayloadValue 'text'
      $dispatch = Get-Dispatch
      if ($dispatch -eq 'background' -and -not $app) {
        throw 'target_required: background type requires app; global SendInput requires dispatch=foreground'
      }
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') {
          $result.focus_ok = Assert-ForegroundTarget -Win $win
        }
        $pt = Get-OverlayPoint-WindowCenter $win
        $cx = $pt[0]; $cy = $pt[1]
        if ($dispatch -eq 'background') {
          $h = [IntPtr]::Zero
          $rawElement = Get-PayloadValue 'element'
          $tel = $null
          if ($null -ne $rawElement) {
            # explicit element target: when it maps to a native HWND, WM_CHAR goes
            # straight there (skips Find-TextInputHwnd); otherwise fall through
            $tel = Find-ElementByIndex -Hwnd $win.Hwnd -Index ([int]$rawElement)
            Assert-SensitiveConfirmation -Element $tel
            $expectedName = Get-PayloadValue 'expected_name'
            if ($null -ne $expectedName -and $tel.Current.Name -cne [string]$expectedName) {
              throw 'target_mismatch: input element name changed; refresh get_app_state'
            }
            $tnh = $tel.Current.NativeWindowHandle
            if ($tnh -ne 0) { $h = [IntPtr]$tnh }
          }
          if ($h -eq [IntPtr]::Zero) { $h = Find-TextInputHwnd $win.Hwnd }
          if ($h -eq [IntPtr]::Zero) {
            if ($null -ne $tel) {
              # Chromium's contenteditable editor is exposed by UIA but has no
              # native edit HWND. After validating the live editor hit, click the
              # renderer child and deliver WM_CHAR there. This keeps the path
              # background-only while refusing any displaced/virtualized target.
              $validated = Resolve-ValidatedElementHit -Hwnd $win.Hwnd -Element $tel
              $renderHwnd = Find-ChromiumRenderHwnd -Hwnd $win.Hwnd
              if ($renderHwnd -eq [IntPtr]::Zero) {
                throw 'background_unavailable: validated editor has no Chromium renderer HWND; use browser_type or dispatch=foreground'
              }
              Notify-Cursor -X $validated.x -Y $validated.y -Label ('focus editor + type ' + $text.Length + ' chars')
              Send-BackgroundMouseButton -Hwnd $renderHwnd -Sx $validated.x -Sy $validated.y -Button 'left' -Count 1
              Start-Sleep -Milliseconds 60
              Send-BackgroundText -Hwnd $renderHwnd -Text $text
              $result.method = 'wm_char_chromium_renderer'
              $result.target_hwnd = $renderHwnd.ToInt64()
              $result.clicked = @{ x = $validated.x; y = $validated.y }
              $result.message = "Delivered $($text.Length) chars via WM_CHAR to Chromium renderer hwnd $($renderHwnd.ToInt64()) after validated editor click"
              break
            }
            # ValuePattern.SetValue replaces a field. `type` must preserve its
            # append-at-caret semantics, so never substitute set_value here.
            $result.background_unavailable = $true
            $result.message = "type: no verified editable HWND in '$app'; use set_value for deliberate replacement or dispatch=foreground."
            break
          }
          Notify-Cursor -X $cx -Y $cy -Label ("type " + $text.Length + ' chars')
          Send-BackgroundText -Hwnd $h -Text $text
          $result.method = 'wm_char'
          $result.target_hwnd = $h.ToInt64()
          $result.message = "Delivered $($text.Length) chars via WM_CHAR to hwnd $($h.ToInt64()) (verify with get_app_state)"
          break
        }
      }
      [DshWin32]::TypeText($text)
      $result.message = "Typed $($text.Length) characters"
    }

    'press_key' {
      $app = Get-PayloadValue 'app'
      $rawKey = Get-PayloadValue 'key'
      $rawMods = Get-PayloadValue 'modifiers'
      $chord = Parse-KeyChord -RawKey $rawKey -RawModifiers $rawMods
      $key = $chord.Key
      $mods = $chord.Modifiers
      $dispatch = Get-Dispatch
      if ($dispatch -eq 'background' -and -not $app) {
        throw 'target_required: background key requires app; global SendInput requires dispatch=foreground'
      }
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') {
          $result.focus_ok = Assert-ForegroundTarget -Win $win
        }
      }
      if ($dispatch -eq 'background' -and $null -ne $win) {
        $h = Find-TextInputHwnd $win.Hwnd
        $postKey = $false
        if ($h -eq [IntPtr]::Zero) {
          # Chromium has no native edit HWND. Its renderer child is the exact
          # app-scoped recipient for a focused editor's Ctrl+Return/accelerator;
          # only fall back to the top-level window when no renderer exists.
          $h = Find-ChromiumRenderHwnd -Hwnd $win.Hwnd
          if ($h -ne [IntPtr]::Zero) { $postKey = $true } else { $h = $win.Hwnd }
        }
        $pt = Get-OverlayPoint-WindowCenter $win
        Notify-Cursor -X $pt[0] -Y $pt[1] -Label ('key ' + $key)
        Send-BackgroundKey -Hwnd $h -Key $key -Modifiers $mods -Async:$postKey
        $result.method = 'wm_key'
        if ($postKey) { $result.async = $true }
        $result.message = "Sent $key (wm_key) to hwnd $($h.ToInt64()); accelerator/menu handling is app-dependent"
        break
      }
      [DshWin32]::KeyChord($key, $mods)
      $result.message = "Pressed $key"
    }

    'scroll' {
      $app = Get-PayloadValue 'app'
      $x = [int](Get-PayloadValue 'x')
      $y = [int](Get-PayloadValue 'y')
      $amount = [int](Get-PayloadValue 'amount')
      $rawMods = [string](Get-PayloadValue 'modifiers')
      if ($amount -le 0) { $amount = 3 }
      $dir = Get-PayloadValue 'direction'
      if (-not $dir) { $dir = 'down' }
      $down = ($dir -ne 'up')
      $horizontal = ($dir -eq 'left' -or $dir -eq 'right')
      $right = ($dir -eq 'right')
      $dispatch = Get-Dispatch
      if ($dispatch -eq 'background' -and $rawMods) { throw 'background_unavailable: modifier scroll needs dispatch=foreground because UIA scroll patterns do not carry keyboard state' }
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') { $result.focus_ok = Assert-ForegroundTarget -Win $win }
        $r = $win.Rect
        $sx = $r.Left + $x; $sy = $r.Top + $y
      } else {
        $sx = $x; $sy = $y
      }
      Assert-ScreenshotBinding -Hwnd $(if ($win) { $win.Hwnd } else { [IntPtr]::Zero })
      if ($dispatch -eq 'background') {
        Notify-Cursor -X $sx -Y $sy -Label ('scroll ' + $dir)
        $pt = New-Object System.Windows.Point($sx, $sy)
        if ($horizontal) {
          # horizontal scroll: ScrollPattern (horizontal axis) first, then WM_MOUSEHWHEEL
          # (0x020E, wParam delta positive = scroll right). With an app target,
          # inspect that window's own tree first so an occluding foreground window
          # can never make a spreadsheet/timeline appear unscrollable.
          $done = $false
          if ($win) {
            $el = (Find-TargetHitsAt -Hwnd $win.Hwnd -X $sx -Y $sy).best
            if ($null -eq $el) {
              try { $el = [System.Windows.Automation.AutomationElement]::FromHandle($win.Hwnd) } catch { $el = $null }
            }
          } else {
            $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
          }
          for ($i = 0; $i -lt 16 -and $null -ne $el; $i++) {
            if ($win -and -not (Test-ElementInWindow -Element $el -Hwnd $win.Hwnd)) { break }
            $resolvedPattern = if ($win) { Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'scroll' -Pattern ([System.Windows.Automation.ScrollPattern]::Pattern) } else { $null }
            $scp = $null
            $hasScroll = if ($resolvedPattern) { [bool]$resolvedPattern.supported } else { $el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$scp) }
            if ($hasScroll) {
              if ($resolvedPattern) { $scp = $resolvedPattern.pattern }
              $none = [System.Windows.Automation.ScrollAmount]::NoAmount
              for ($n = 0; $n -lt $amount; $n++) { if ($right) { $scp.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, $none) } else { $scp.Scroll([System.Windows.Automation.ScrollAmount]::LargeDecrement, $none) } }
              $result.method = 'scroll_pattern'; $done = $true; break
            }
            $el = Get-UiaParent $el
          }
          if (-not $done -and $win) {
            $h = Find-TargetHwndAt -Hwnd $win.Hwnd -X $sx -Y $sy -Win $win
            if ($h -ne [IntPtr]::Zero) {
              $delta = $amount * 120
              if (-not $right) { $delta = -$delta }
              $wParam = [IntPtr]($delta -shl 16)
              $client = [DshWin32]::ScreenToClientPoint($h, $sx, $sy)
              $lParam = [IntPtr](($client.Y -band 0xFFFF) -shl 16 -bor ($client.X -band 0xFFFF))
              $res = [IntPtr]::Zero
              $null = [DshWin32]::SendMessageTimeout($h, 0x020E, $wParam, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
              $result.method = 'wm_mousehwheel_target'
              $result.message = "Scrolled $dir x$amount via WM_MOUSEHWHEEL to verified target hwnd $($h.ToInt64())"
            } else {
              $result.background_unavailable = $true
              $result.message = 'scroll: target window has neither ScrollPattern nor a verified native HWND at the requested point'
            }
          } elseif (-not $done) {
            $h = [IntPtr]::Zero
            $wEl = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
            for ($i = 0; $i -lt 24 -and $null -ne $wEl; $i++) {
              $nh = $wEl.Current.NativeWindowHandle
              if ($nh -ne 0) { $h = [IntPtr]$nh; break }
              $wEl = Get-UiaParent $wEl
            }
            if ($h -eq [IntPtr]::Zero -and $win) { $h = $win.Hwnd }
            if ($h -ne [IntPtr]::Zero) {
              $delta = $amount * 120
              if (-not $right) { $delta = -$delta }
              $wParam = [IntPtr]($delta -shl 16)
              $lParam = [IntPtr](($sy -band 0xFFFF) -shl 16 -bor ($sx -band 0xFFFF))
              $res = [IntPtr]::Zero
              $null = [DshWin32]::SendMessageTimeout($h, 0x020E, $wParam, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
              $result.method = 'wm_mousehwheel'
              $result.message = "Scrolled $dir x$amount via WM_MOUSEHWHEEL to hwnd $($h.ToInt64())"
            } else {
              $result.background_unavailable = $true
              $result.message = 'scroll: no window under the point; nothing to scroll'
            }
          } else {
            $result.message = "Scrolled $dir x$amount via $($result.method)"
          }
        } else {
          $done = $false
          # Primary: hit the TARGET window's own document via FromHandle - immune to window occlusion
          if ($win) {
            $winEl = $null
            try { $winEl = [System.Windows.Automation.AutomationElement]::FromHandle($win.Hwnd) } catch { $winEl = $null }
            if ($winEl) {
              $docCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
              $doc = $winEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCond)
              $dscp = $null
              $docScroll = if ($doc) { Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $doc -Name 'scroll' -Pattern ([System.Windows.Automation.ScrollPattern]::Pattern) } else { $null }
              if ($docScroll -and $docScroll.supported) {
                $dscp = $docScroll.pattern
                $none = [System.Windows.Automation.ScrollAmount]::NoAmount
                for ($n = 0; $n -lt $amount; $n++) { if ($down) { $dscp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeIncrement) } else { $dscp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeDecrement) } }
                $result.method = 'scroll_pattern'; $done = $true
                $result.message = "Scrolled $dir x$amount via ScrollPattern on target window document"
              }
            }
          }
          if (-not $done) {
            if ($win) {
              $el = (Find-TargetHitsAt -Hwnd $win.Hwnd -X $sx -Y $sy).best
              if ($null -eq $el) { try { $el = [System.Windows.Automation.AutomationElement]::FromHandle($win.Hwnd) } catch { $el = $null } }
            } else {
              $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
            }
            for ($i = 0; $i -lt 16 -and $null -ne $el; $i++) {
              if ($win -and -not (Test-ElementInWindow -Element $el -Hwnd $win.Hwnd)) { break }
              $resolvedRange = if ($win) { Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'range_value' -Pattern ([System.Windows.Automation.RangeValuePattern]::Pattern) } else { $null }
              $rvp = $null
              $hasRange = if ($resolvedRange) { [bool]$resolvedRange.supported } else { $el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$rvp) }
              if ($hasRange) {
                if ($resolvedRange) { $rvp = $resolvedRange.pattern }
                for ($n = 0; $n -lt $amount; $n++) { if ($down) { $rvp.SmallIncrement() } else { $rvp.SmallDecrement() } }
                $result.method = 'range_value'; $done = $true; break
              }
              $resolvedScroll = if ($win) { Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'scroll' -Pattern ([System.Windows.Automation.ScrollPattern]::Pattern) } else { $null }
              $scp = $null
              $hasScroll = if ($resolvedScroll) { [bool]$resolvedScroll.supported } else { $el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$scp) }
              if ($hasScroll) {
                if ($resolvedScroll) { $scp = $resolvedScroll.pattern }
                $none = [System.Windows.Automation.ScrollAmount]::NoAmount
                for ($n = 0; $n -lt $amount; $n++) { if ($down) { $scp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeIncrement) } else { $scp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeDecrement) } }
                $result.method = 'scroll_pattern'; $done = $true; break
              }
              $el = Get-UiaParent $el
            }
          }
          if (-not $done) {
            $h = [IntPtr]::Zero
            if ($win) {
              $h = Find-TargetHwndAt -Hwnd $win.Hwnd -X $sx -Y $sy -Win $win
            } else {
              $wEl = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
              for ($i = 0; $i -lt 24 -and $null -ne $wEl; $i++) {
                $nh = $wEl.Current.NativeWindowHandle
                if ($nh -ne 0) { $h = [IntPtr]$nh; break }
                $wEl = Get-UiaParent $wEl
              }
            }
            if ($h -ne [IntPtr]::Zero) {
              $delta = $amount * 120
              if ($down) { $delta = -$delta }
              $wParam = [IntPtr]($delta -shl 16)
              $client = [DshWin32]::ScreenToClientPoint($h, $sx, $sy)
              $lParam = [IntPtr](($client.Y -band 0xFFFF) -shl 16 -bor ($client.X -band 0xFFFF))
              $res = [IntPtr]::Zero
              $null = [DshWin32]::SendMessageTimeout($h, 0x020A, $wParam, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
              $result.method = if ($win) { 'wm_mousewheel_target' } else { 'wm_mousewheel' }
              $result.message = "Scrolled $dir x$amount via WM_MOUSEWHEEL to hwnd $($h.ToInt64())"
            } else {
              $result.background_unavailable = $true
              $result.message = if ($win) { 'scroll: target window has neither a usable UIA scroll path nor a verified native HWND at the requested point' } else { 'scroll: no window under the point; nothing to scroll' }
            }
          } else {
            $result.message = "Scrolled $dir x$amount via $($result.method)"
          }
        }
      } else {
        if ($horizontal) {
          if ($rawMods) { [DshWin32]::ScrollHWithModifiers($sx, $sy, $amount, $right, $rawMods) }
          else { [DshWin32]::ScrollH($sx, $sy, $amount, $right) }
        } else {
          if ($rawMods) { [DshWin32]::ScrollWithModifiers($sx, $sy, $amount, $down, $rawMods) }
          else { [DshWin32]::Scroll($sx, $sy, $amount, $down) }
        }
        if ($rawMods) { $result.modifiers = $rawMods }
        $result.message = "Scrolled $dir x$amount at ($sx, $sy)"
      }
    }

    'drag' {
      $app = Get-PayloadValue 'app'
      $dispatch = Get-Dispatch
      $rawMods = [string](Get-PayloadValue 'modifiers')
      $rawPath = Get-PayloadValue 'path'
      $hasPath = ($rawPath -is [System.Collections.IEnumerable] -and $rawPath -isnot [string])
      $pathXs = @(); $pathYs = @()
      if ($hasPath) {
        foreach ($point in @($rawPath)) {
          $px = 0.0; $py = 0.0
          $isObjectPoint = ($point -is [System.Collections.IDictionary]) -or
            ($null -ne $point -and $null -ne $point.PSObject.Properties['x'] -and $null -ne $point.PSObject.Properties['y'])
          if ($isObjectPoint) {
            if (-not [double]::TryParse([string]$point.x, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$px) -or
                -not [double]::TryParse([string]$point.y, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$py)) { throw 'invalid drag path: coordinates must be numbers' }
          } else {
            if ($point -isnot [System.Collections.IEnumerable] -or $point -is [string] -or @($point).Count -lt 2) { throw 'invalid drag path: every point must be [x,y] or {x,y}' }
            if (-not [double]::TryParse([string]@($point)[0], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$px) -or
                -not [double]::TryParse([string]@($point)[1], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$py)) { throw 'invalid drag path: coordinates must be numbers' }
          }
          if ([double]::IsNaN($px) -or [double]::IsInfinity($px) -or [double]::IsNaN($py) -or [double]::IsInfinity($py)) { throw 'invalid drag path: coordinates must be finite' }
          $pathXs += [int]$px; $pathYs += [int]$py
        }
        if ($pathXs.Count -lt 2) { throw 'invalid drag path: at least two points required' }
      }
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') { $result.focus_ok = Assert-ForegroundTarget -Win $win }
        $r = $win.Rect
      }
      Assert-ScreenshotBinding -Hwnd $(if ($win) { $win.Hwnd } else { [IntPtr]::Zero })
      $fx = [int](Get-PayloadValue 'from_x'); $fy = [int](Get-PayloadValue 'from_y')
      $tx = [int](Get-PayloadValue 'to_x'); $ty = [int](Get-PayloadValue 'to_y')
      if ($win) {
        $fx += $r.Left; $fy += $r.Top; $tx += $r.Left; $ty += $r.Top
        if ($hasPath) {
          for ($pi = 0; $pi -lt $pathXs.Count; $pi++) { $pathXs[$pi] += $r.Left; $pathYs[$pi] += $r.Top }
        }
      }
      if ($dispatch -eq 'background') {
        Notify-Cursor -X $fx -Y $fy -Label 'drag'
        $pt = New-Object System.Windows.Point($fx, $fy)
        $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
        $tp = $null
        $moved = $false
        for ($i = 0; $i -lt 8 -and $null -ne $el; $i++) {
          if ($el.TryGetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern, [ref]$tp) -and $tp.Current.CanMove) {
            $rc = $el.Current.BoundingRectangle
            $newX = $rc.X + ($tx - $fx)
            $newY = $rc.Y + ($ty - $fy)
            $tp.Move($newX, $newY)
            $result.method = 'transform_move'
            $result.message = 'Dragged element via TransformPattern.Move (background)'
            $moved = $true
            break
          }
          $el = Get-UiaParent $el
        }
        if (-not $moved) {
          $result.background_unavailable = $true
          $result.message = 'drag: no movable (TransformPattern) element at the start point; background drag unavailable. Use dispatch=foreground (real input).'
        }
        if ($hasPath) { $result.path_points = $pathXs.Count; $result.path_mode = 'transform_endpoint_delta' }
      } else {
        if ($hasPath) {
          if ($rawMods) { [DshWin32]::DragPathWithModifiers([int[]]$pathXs, [int[]]$pathYs, $rawMods) }
          else { [DshWin32]::DragPath([int[]]$pathXs, [int[]]$pathYs) }
          $result.path_points = $pathXs.Count
          $result.method = if ($rawMods) { 'send_input_drag_path_with_modifiers' } else { 'send_input_drag_path' }
          if ($rawMods) { $result.modifiers = $rawMods }
          $result.message = "Dragged ordered path with $($pathXs.Count) points"
        } else {
          [DshWin32]::Drag($fx, $fy, $tx, $ty)
          $result.message = "Dragged ($fx,$fy) -> ($tx,$ty)"
        }
      }
    }

    'read_clipboard' {
      $text = Get-ClipboardTextSafe
      $result.text = $text
      $result.message = "Clipboard read ($($text.Length) chars)"
    }

    'write_clipboard' {
      $text = Get-PayloadValue 'text'
      if ($null -eq $text) { $text = '' } else { $text = [string]$text }
      Set-ClipboardTextSafe -Text $text
      $len = if ($text) { $text.Length } else { 0 }
      $result.length = $len
      $result.message = "Clipboard updated ($len chars)"
    }

    'list_displays' {
      $screens = [System.Windows.Forms.Screen]::AllScreens
      $displays = @()
      $idx = 1
      foreach ($s in $screens) {
        $displays += @{
          index = $idx
          id = [string]$s.DeviceName
          primary = [bool]$s.Primary
          bounds = @{
            x = [int]$s.Bounds.X
            y = [int]$s.Bounds.Y
            width = [int]$s.Bounds.Width
            height = [int]$s.Bounds.Height
          }
          working_area = @{
            x = [int]$s.WorkingArea.X
            y = [int]$s.WorkingArea.Y
            width = [int]$s.WorkingArea.Width
            height = [int]$s.WorkingArea.Height
          }
        }
        $idx++
      }
      $result.display_count = $screens.Length
      $result.displays = $displays
      $result.message = "Found $($screens.Length) display(s)"
    }

    'mouse_down' {
      Invoke-MouseButtonAction -IsDown $true -Result $result
    }

    'mouse_up' {
      Invoke-MouseButtonAction -IsDown $false -Result $result
    }

    'hold_key' {
      $app = Get-PayloadValue 'app'
      $rawKey = Get-PayloadValue 'key'
      if (-not $rawKey) { throw "hold_key requires 'key' parameter" }
      $rawMods = Get-PayloadValue 'modifiers'
      $chord = Parse-KeyChord -RawKey $rawKey -RawModifiers $rawMods
      $key = $chord.Key
      $mods = $chord.Modifiers
      $rawDur = Get-PayloadValue 'duration_ms'
      $dur = if ($null -eq $rawDur) { 500 } else { [int]$rawDur }
      if ($dur -lt 50) { $dur = 50 }
      if ($dur -gt 10000) { $dur = 10000 }
      $dispatch = Get-Dispatch
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') {
          $result.focus_ok = Assert-ForegroundTarget -Win $win
        }
      }
      if ($dispatch -eq 'background' -and $null -ne $win) {
        $h = Find-TextInputHwnd $win.Hwnd
        if ($h -eq [IntPtr]::Zero) {
          $h = $win.Hwnd
        }
        $pt = Get-OverlayPoint-WindowCenter $win
        Notify-Cursor -X $pt[0] -Y $pt[1] -Label ('hold_key ' + $key + ' ' + $dur + 'ms')
        Send-BackgroundHoldKey -Hwnd $h -Key $key -Modifiers $mods -DurationMs $dur
        $result.method = 'wm_key'
        $result.key = $key
        $result.duration_ms = $dur
        $result.modifiers = $mods
        $result.message = "Held $key for ${dur}ms (wm_key) to hwnd $($h.ToInt64())"
        break
      }
      [DshWin32]::HoldKey($key, $mods, $dur)
      $result.key = $key
      $result.duration_ms = $dur
      $result.modifiers = $mods
      $result.message = "Held $key for ${dur}ms"
    }

    'launch_app' {
      $name = Get-PayloadValue 'name'
      if (-not $name) { throw 'launch_app requires name' }
      # Capture the desktop before launch.  Store only HWNDs: this lets us safely
      # recognize a single, newly-created top-level window when an activation
      # protocol delegates from a short-lived launcher process to a UWP/packaged
      # app.  We never select an already-open user window by this fallback.
      $preLaunchHwnds = @([DshWin32]::EnumWindowsList() | ForEach-Object { $_.Hwnd.ToInt64() })
      # support arguments after the executable (quoted or unquoted):
      # 'notepad.exe C:\foo.txt', '"C:\Program Files\App\app.exe" --flag value'
      $cmd = Split-AppCommand -Name ([string]$name)
      $filePath = $cmd[0]
      $argList = @($cmd[1])
      $initialUrl = Get-PayloadValue 'url'
      if ($initialUrl) {
        if ($initialUrl -notmatch '^https?://') { throw 'launch_app url must use http or https' }
        $argList += [string]$initialUrl
      }

      # Browser profile isolation: When launching Chromium browsers (msedge, chrome, brave),
      # force a dedicated --user-data-dir so AI browsing NEVER pollutes the user's personal
      # Edge profile, window placement, or cookies!
      $baseExe = [System.IO.Path]::GetFileNameWithoutExtension($filePath).ToLowerInvariant()
      $isChromiumBrowser = ($baseExe -in @('msedge', 'chrome', 'brave', 'chromium', 'vivaldi'))
      # Command hosts frequently create a short-lived console HWND before
      # handing work to the actual application.  Treat them as launchers so a
      # transient console can never be returned as the user's target.
      $isLikelyLauncher = ($baseExe -in @('cmd', 'powershell', 'pwsh', 'wscript', 'cscript'))
      $headless = [bool](Get-PayloadValue 'headless')
      if ($headless -and -not $isChromiumBrowser) { throw 'headless is supported only for Chromium browsers' }
      if ($isChromiumBrowser) {
        $hasUserDataDir = $false
        $debugProfileDir = $null
        foreach ($a in $argList) {
          if ($a -match '^--user-data-dir[= ](.+)$') {
            $hasUserDataDir = $true
            $debugProfileDir = $Matches[1].Trim().Trim('"')
            break
          }
        }
        if (-not $hasUserDataDir) {
          $aiProfileDir = Join-Path $env:LOCALAPPDATA 'dsh-cua\browser-profile'
          if ($headless) {
            # BR-02 hygiene: per-launch temp profile; age out abandoned dirs
            # (older than 24h, not owned by any running browser process) so the
            # TEMP root does not accumulate one folder per headless run.
            try {
              Get-ChildItem $env:TEMP -Directory -Filter 'pc-pilot-headless-*' -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-24) } |
                ForEach-Object {
                  $dirPath = $_.FullName
                  if (-not (Test-ChromiumProfileLocked -ProfileDir $dirPath)) {
                    Remove-Item -LiteralPath $dirPath -Recurse -Force -ErrorAction SilentlyContinue
                  }
                } | Out-Null
            } catch { }
            $aiProfileDir = Join-Path $env:TEMP ("pc-pilot-headless-" + [guid]::NewGuid().ToString('N'))
          }
          if (-not (Test-Path $aiProfileDir)) { New-Item -ItemType Directory -Path $aiProfileDir -Force | Out-Null }
           $argList += "--user-data-dir=`"$aiProfileDir`""
           $argList += "--no-first-run"
           $argList += "--no-default-browser-check"
           $argList += '--disable-session-crashed-bubble'
          $debugProfileDir = $aiProfileDir
        }
        $hasRemoteDebugging = $false
        if ($headless -and $debugProfileDir -and (Test-ChromiumProfileLocked -ProfileDir $debugProfileDir)) {
          # Fresh/idle profiles need no process scan. Only pay the CIM cost when
          # Chromium's own lock proves that some browser process is using this
          # profile, preserving the headed-vs-headless distinction below.
          $profilePattern = '--user-data-dir=(?:"' + [regex]::Escape($debugProfileDir) + '"|' + [regex]::Escape($debugProfileDir) + ')(?:\s|$)'
          $existingHeaded = @(Get-CimInstance Win32_Process -Filter "Name='$baseExe.exe'" | Where-Object {
            $_.CommandLine -match $profilePattern -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--headless(?:=|\s|$)'
          })
          if ($existingHeaded.Count -gt 0) { throw 'profile_busy: headless launch refused because this profile is running with desktop windows' }
        }
        foreach ($a in $argList) { if ($a -match '^--remote-debugging-port') { $hasRemoteDebugging = $true; break } }
        if ($debugProfileDir -and -not $hasRemoteDebugging) {
          $argList += '--remote-debugging-address=127.0.0.1'
          $argList += '--remote-debugging-port=0'
        }
        if ($headless) { $argList += '--headless=new' }
      }

      # Background launch contract: create a normally renderable window without activating
      # it.  ShellExecuteEx(SW_SHOWNOACTIVATE) preserves WGC/UIA rendering better than
      # a minimized window while the universal foreground guard below prevents a
      # misbehaving app from stealing the user's active work.
      $foregroundLaunch = ([bool](Get-PayloadValue 'activate') -or (Get-Dispatch) -eq 'foreground')
      $style = if ($foregroundLaunch) { 'Normal' } else { 'NoActivate' }
      $launchDisposition = if ($foregroundLaunch) { 'foreground' } else { 'background behind active work' }
      # Registered Windows activation protocols such as ms-settings:display are
      # valid launch targets. A Windows drive path begins with the same "C:" shape
      # as a URI scheme, so only treat it as a protocol when the colon is not
      # followed by a slash.
      $isActivationProtocol = $filePath -match '^[A-Za-z][A-Za-z0-9+.-]*:(?![\\/])'
      if ($foregroundLaunch) {
        $proc = if ($isActivationProtocol) {
          Start-Process -FilePath explorer.exe -ArgumentList $filePath -WindowStyle Normal -PassThru
        } elseif ($argList.Count -gt 0) {
          Start-Process -FilePath $filePath -ArgumentList $argList -WindowStyle Normal -PassThru
        } else {
          Start-Process -FilePath $filePath -WindowStyle Normal -PassThru
        }
      } else {
        $launchArgs = if ($argList.Count -gt 0) { [string]::Join(' ', [string[]]$argList) } else { '' }
        $launchPid = [DshWin32]::LaunchShellSilent($filePath, $launchArgs)
        # ShellExecuteEx may successfully route an activation to an existing
        # process without returning a process handle. Keep pid=0 in that case;
        # the bounded delegated-window resolver below will identify the actual HWND.
        $proc = [pscustomobject]@{ Id = [int]$launchPid }
      }
      $result.message = "Started $filePath ($($argList.Count) argument(s)) (launched $style; $launchDisposition)"
      $result.pid = $proc.Id
      if ($isActivationProtocol) { $result.activation_protocol = $filePath }
      if ($debugProfileDir) {
        $activePort = Join-Path $debugProfileDir 'DevToolsActivePort'
        $browserReady = $false
        # A fresh Edge profile can take materially longer than the old 5s probe
        # budget to initialize its DevTools listener. Keep this bounded below the
        # helper's 20s launch deadline, rather than declaring a live browser
        # unknown and inviting the caller to create another one.
        $browserReadyDeadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not $browserReady -and [DateTime]::UtcNow -lt $browserReadyDeadline) {
          Start-Sleep -Milliseconds 50
          try {
            $lines = @(Get-Content -LiteralPath $activePort -ErrorAction Stop)
            if ($lines.Count -ge 2 -and $lines[0] -match '^\d+$' -and $lines[1] -match '^/devtools/browser/[A-Za-z0-9-]+$') {
              $port = [int]$lines[0]
              if (Test-DevToolsEndpoint -Port $port) {
                $result.browser_endpoint = "ws://127.0.0.1:$port$($lines[1])"
                $result.browser_profile_owned = $true
                $browserReady = $true
              }
            }
          } catch { }
        }
      }
      if ($headless) {
        if (-not $result.browser_endpoint) { throw 'browser_not_ready: no DevTools endpoint; do not retry launch blindly' }
        # REAL-06: a fresh profile opens the vendor welcome tab (edge://welcome-*)
        # alongside whatever the AI opens next, and it is pure tab-list noise.
        # The DevTools HTTP endpoint can close it without a WebSocket client.
        try {
          if ($lines -and $lines.Count -ge 2) {
            $httpBase = "http://127.0.0.1:$($lines[0])"
            $tabs = @(Get-DevToolsJson -Uri "$httpBase/json/list")
            foreach ($t in $tabs) {
              if ($t.url -and $t.id -and $t.url -match '^(edge|chrome)://welcome') {
                $null = Invoke-DevToolsGet -Uri "$httpBase/json/close/$($t.id)"
              }
            }
          }
        } catch { }
        $result.headless = $true
        $result.message = 'Headless browser endpoint ready; use browser_open to obtain an exact tab, then browser_state to verify its URL'
        break
      }
      # Resolve the real top-level window. Chromium's launcher often returns a
      # short-lived broker PID, so a single 80 ms lookup is inherently racy.
      $wins = @()
      # Command hosts and activation protocols are brokers by definition: any
      # window owned by their Start-Process PID is discarded below, so spending
      # up to 3s waiting for such a window only adds latency. Go straight to the
      # delegated-window resolver for those launch shapes.
      if (-not $isLikelyLauncher -and -not $isActivationProtocol) {
        for ($attempt = 0; $attempt -lt 60 -and $wins.Count -eq 0; $attempt++) {
          Start-Sleep -Milliseconds 50
          $wins = @([DshWin32]::EnumWindowsList() | Where-Object { $_.Pid -eq $proc.Id })
        }
      }
      # A protocol is also routed through Explorer, which may be the user's
      # long-running shell process.  Never return one of its existing windows
      # as though it were the newly activated target.
      if ($isLikelyLauncher -or $isActivationProtocol) { $wins = @() }
      # Chromium may hand the URL to an already-running browser process for the
      # same isolated profile. In that case Start-Process returns a short-lived
      # broker PID with no window, so resolve the real profile-owned window before
      # returning the target identity.
      if ($wins.Count -eq 0 -and $debugProfileDir) {
        $profilePids = @(
          Get-CimInstance Win32_Process -Filter "Name='$baseExe.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like "*$debugProfileDir*" } |
            Select-Object -ExpandProperty ProcessId
        )
        if ($profilePids.Count -gt 0) {
          $wins = @([DshWin32]::EnumWindowsList() | Where-Object { $profilePids -contains $_.Pid })
          if ($wins.Count -gt 0) {
            $proc = Get-Process -Id $wins[0].Pid -ErrorAction SilentlyContinue
            $result.pid = $wins[0].Pid
            $result.reused_browser_process = $true
          }
        }
      }
      if ($debugProfileDir) {
        # Chromium can expose a session-restore prompt before the real page
        # window. Prefer the largest profile-owned top-level window and reject
        # recovery/broker prompts when returning the launch HWND.
        $ownedPids = @($proc.Id)
        $ownedPids += @(Get-CimInstance Win32_Process -Filter "Name='$baseExe.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -and $_.CommandLine -like "*$debugProfileDir*" } |
          Select-Object -ExpandProperty ProcessId)
        $preferred = @([DshWin32]::EnumWindowsList() | Where-Object {
          ($ownedPids -contains $_.Pid) -and
          $_.Title -notmatch '(?i)restore|recovery|恢复页面|恢复会话' -and
          ($_.Rect.Right - $_.Rect.Left) -ge 600 -and ($_.Rect.Bottom - $_.Rect.Top) -ge 400
        } | Sort-Object @{Expression={($_.Rect.Right-$_.Rect.Left)*($_.Rect.Bottom-$_.Rect.Top)};Descending=$true})
        if ($preferred.Count -gt 0) { $wins = $preferred }
      }
      $resolvedWindow = $null
      if ($wins.Count -gt 0) {
        $result.hwnd = $wins[0].Hwnd.ToInt64()
        $resolvedWindow = $wins[0]
        # A persistent profile may still contain Chrome's session-restore
        # bubble even with the startup flag. Dismiss only the small popup close
        # button inside this exact owned window before returning control.
        try {
          $root = [System.Windows.Automation.AutomationElement]::FromHandle($wins[0].Hwnd)
          foreach ($candidate in @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))) {
            $cr = $candidate.Current.BoundingRectangle
            if ($candidate.Current.NativeWindowHandle -ne 0 -and $cr.Width -le 500 -and $cr.Height -le 400 -and $cr.X -gt ($wins[0].Rect.Left + 600) -and $cr.Y -gt ($wins[0].Rect.Top + 80)) {
              [DshWin32]::PostMessage([IntPtr]$candidate.Current.NativeWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
              break
            }
            if ($cr.Width -le 60 -and $cr.Height -le 60 -and $cr.X -gt ($wins[0].Rect.Left + 600) -and $cr.Y -gt ($wins[0].Rect.Top + 80)) {
              $ip = $null
              if ($candidate.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); break }
            }
          }
        } catch { }
      } elseif (-not $isChromiumBrowser) {
        # Some real Windows apps (notably packaged/UWP apps) receive activation
        # through a broker.  The PID returned by Start-Process then owns no
        # window even though a new app window appears.  Adopt it only when the
        # settled desktop delta has exactly one viable candidate; otherwise leave
        # the identity unresolved rather than risking a user's pre-existing
        # window.  In particular, do not stop at the first delta: command hosts
        # can briefly create a console before the delegated app appears.
        $delegated = @()
        $delegatedProcessCache = @{}
        $stableDelegatedHwnd = 0L
        $stableDelegatedPolls = 0
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
          Start-Sleep -Milliseconds 50
          $delegated = @([DshWin32]::EnumWindowsList() | Where-Object {
            $candidateProcess = if ($isLikelyLauncher) { Get-ProcessNameFast -ProcessId $_.Pid -Cache $delegatedProcessCache } else { '' }
            $candidateTitle = ([string]$_.Title).Trim()
            # A command host can also be the process that owns a genuine GUI
            # (for example a script-hosted WinForms app), so reject only its
            # recognizable console window rather than every PowerShell process.
            $candidateIsConsoleHost = $candidateProcess -in @('cmd', 'WindowsTerminal', 'OpenConsole', 'conhost') -or (
              ($candidateProcess -in @('powershell', 'pwsh')) -and $candidateTitle -match '(?i)^(Windows PowerShell|PowerShell|管理员:|Administrator:)'
            )
            ($preLaunchHwnds -notcontains $_.Hwnd.ToInt64()) -and $_.Title -and
            -not $_.Minimized -and ($_.Rect.Right - $_.Rect.Left) -ge 50 -and
            ($_.Rect.Bottom - $_.Rect.Top) -ge 32 -and
            (-not $isLikelyLauncher -or -not $candidateIsConsoleHost)
          })

          # For command-host launchers the console-shaped transient windows are
          # already excluded above. Once one GUI HWND remains unchanged for six
          # consecutive polls (300 ms), waiting out the full 3 s budget adds no
          # identity confidence. Protocol/UWP launches keep the full settle
          # window because they may show a splash HWND before the real window.
          if ($isLikelyLauncher -and $delegated.Count -eq 1) {
            $candidateHwnd = $delegated[0].Hwnd.ToInt64()
            if ($candidateHwnd -eq $stableDelegatedHwnd) { $stableDelegatedPolls++ }
            else { $stableDelegatedHwnd = $candidateHwnd; $stableDelegatedPolls = 1 }
            if ($stableDelegatedPolls -ge 6) { break }
          } else {
            $stableDelegatedHwnd = 0L
            $stableDelegatedPolls = 0
          }
        }
        if ($delegated.Count -eq 1) {
          $result.hwnd = $delegated[0].Hwnd.ToInt64()
          $result.pid = $delegated[0].Pid
          $resolvedWindow = $delegated[0]
          $result.delegated_launch = $true
          $result.message += '; resolved one newly-created delegated app window'
        } elseif ($delegated.Count -gt 1) {
          $result.window_unavailable = $true
          $result.message += '; launch created multiple windows, so no window was selected (use list_windows)'
        } else {
          $result.window_unavailable = $true
          $result.message += '; launcher returned no top-level window (use list_windows to select an existing or late window)'
        }
      }
      if ($resolvedWindow) {
        # Background launches must remain renderable for WGC/UIA while staying out
        # of the user's way. Show without activation, demote in Z-order, then
        # refresh the returned geometry so callers never inherit a minimized rect.
        if (-not $foregroundLaunch) {
          try {
            [DshWin32]::ShowWindow($resolvedWindow.Hwnd, [DshWin32]::SW_SHOWNOACTIVATE) | Out-Null
            $result.background_demoted = [bool]([DshWin32]::PushWindowToBottom($resolvedWindow.Hwnd))
            $settled = $null
            for ($settleAttempt = 0; $settleAttempt -lt 16; $settleAttempt++) {
              Start-Sleep -Milliseconds 25
              $matches = @([DshWin32]::EnumWindowsList() | Where-Object { $_.Hwnd -eq $resolvedWindow.Hwnd })
              if ($matches.Count -gt 0) {
                $candidate = $matches[0]
                if (-not $candidate.Minimized -and $candidate.Rect.Left -ge -10000 -and $candidate.Rect.Top -ge -10000 -and
                    $candidate.Rect.Right -gt $candidate.Rect.Left -and $candidate.Rect.Bottom -gt $candidate.Rect.Top) {
                  $settled = $candidate
                  break
                }
              }
            }
            if ($settled) {
              $resolvedWindow = $settled
              $result.background_window_ready = $true
              $result.message += '; background window kept renderable without activation and placed behind active work'
            } else {
              $result.background_window_ready = $false
              $result.needs_observation = $true
              $result.message += '; background window launch completed but normal renderable geometry was not confirmed yet'
            }
          } catch {
            $result.background_window_ready = $false
            $result.needs_observation = $true
            $result.message += '; background window placement could not be confirmed yet'
          }
        }

        # A launch result is immediately reusable by the next Computer Use
        # action. Return fresh geometry and the same verified id/app object as
        # get_window instead of making callers re-discover a window we identified.
        $result.process_name = Get-ProcessNameFast -ProcessId $resolvedWindow.Pid -Cache $null
        $result.window = Get-WindowInfo $resolvedWindow
        if ($foregroundLaunch) {
          # Normal Start-Process does not guarantee foreground ownership under
          # Windows' focus-stealing rules. The explicit activate/foreground opt-in
          # uses the same verified activation path as activate_window.
          [DshWin32]::ForceForeground($resolvedWindow.Hwnd)
          $fgHwnd = [DshWin32]::GetForegroundWindow()
          $result.activated = [bool]($fgHwnd -eq $resolvedWindow.Hwnd -or [DshWin32]::IsChild($resolvedWindow.Hwnd, $fgHwnd))
          if (-not $result.activated) {
            $result.ok = $false
            $result.error_code = 'foreground_activation_unconfirmed'
            $result.needs_observation = $true
            $result.launch_succeeded = $true
            $result.message += '; foreground activation could not be confirmed, but the app launch completed—do not retry launch; observe the returned window'
          }
        }
      }
    }

    'mouse_move' {
      $app = Get-PayloadValue 'app'
      $x = [int](Get-PayloadValue 'x')
      $y = [int](Get-PayloadValue 'y')
      $rawMods = [string](Get-PayloadValue 'modifiers')
      $dispatch = Get-Dispatch
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        $r = $win.Rect
        if ($x -ge $r.Left -and $x -le $r.Right -and $y -ge $r.Top -and $y -le $r.Bottom) {
          $sx = $x; $sy = $y
        } elseif ($x -gt 0 -or $y -gt 0) {
          $sx = $r.Left + $x; $sy = $r.Top + $y
        } else {
          $c = Get-OverlayPoint-WindowCenter $win; $sx = $c[0]; $sy = $c[1]
        }
      } else {
        $sx = $x; $sy = $y
      }
      Assert-ScreenshotBinding -Hwnd $(if ($win) { $win.Hwnd } else { [IntPtr]::Zero })
      if ($dispatch -eq 'background') {
        if ($rawMods) { throw 'background_unavailable: modifier mouse_move needs dispatch=foreground' }
        # synthetic cursor only: the user's real mouse is never moved in background
        Notify-Cursor -X $sx -Y $sy -Label 'move'
        $result.method = 'overlay_cursor'
        $result.position = @{ x = $sx; y = $sy }
        $result.message = "mouse_move: synthetic cursor shown at ($sx, $sy); the real mouse was NOT moved (use dispatch=foreground to move it)"
      } else {
        if ($rawMods) { [DshWin32]::MouseMoveWithModifiers($sx, $sy, $rawMods) }
        else { [DshWin32]::MouseMove($sx, $sy) }
        $result.method = 'send_input'
        if ($rawMods) { $result.modifiers = $rawMods }
        $result.position = @{ x = $sx; y = $sy }
        $result.message = "Moved the real mouse cursor to ($sx, $sy)"
      }
    }

    'activate_window' {
      $app = Get-PayloadValue 'app'
      $idx = [int](Get-PayloadValue 'window_index')
      $hwndVal = Get-PayloadValue 'hwnd'
      $hwnd = if ($hwndVal) { [int64]$hwndVal } else { 0 }
      $win = Resolve-TargetWindow -App $app -Index $idx -Hwnd $hwnd
      $activated = Assert-ForegroundTarget -Win $win
      $result.hwnd = $win.Hwnd.ToInt64()
      $result.title = $win.Title
      $result.activated = [bool]$activated
      $result.message = "Activated window '$($win.Title)' (hwnd=$($win.Hwnd.ToInt64()), activated=$activated)"
    }

    'close_window' {
      $app = Get-PayloadValue 'app'
      $idx = [int](Get-PayloadValue 'window_index')
      $hwndVal = Get-PayloadValue 'hwnd'
      $hwnd = if ($hwndVal) { [int64]$hwndVal } else { 0 }
      $win = Resolve-TargetWindow -App $app -Index $idx -Hwnd $hwnd
      $targetHwnd = $win.Hwnd
      $title = $win.Title
      $sendOk = [DshWin32]::CloseWindowGracefully($targetHwnd, 3000)
      for ($i = 0; $i -lt 10; $i++) {
        if (-not [DshWin32]::IsWindow($targetHwnd)) { break }
        Start-Sleep -Milliseconds 50
      }
      $closed = -not [DshWin32]::IsWindow($targetHwnd)
      $result.hwnd = $targetHwnd.ToInt64()
      $result.title = $title
      $result.close_dispatched = [bool]$sendOk
      $result.closed = [bool]$closed
      if ($closed) {
        $result.message = "Closed window '$title' (hwnd=$($targetHwnd.ToInt64()))"
      } else {
        # WM_CLOSE may have triggered a save/confirmation prompt or been
        # rejected. The request reached the window, but the lifecycle outcome
        # remains unknown and must never be reported as successful cleanup.
        $result.ok = $false
        $result.error_code = 'window_close_unconfirmed'
        $result.needs_observation = $true
        $result.message = "Close request was sent to '$title', but the window remained open; inspect it before retrying"
      }
    }

    'get_window' {
      $app = Get-PayloadValue 'app'
      $idx = [int](Get-PayloadValue 'window_index')
      $hwndVal = Get-PayloadValue 'hwnd'
      $hwnd = if ($hwndVal) { [int64]$hwndVal } else { 0 }
      $win = Resolve-TargetWindow -App $app -Index $idx -Hwnd $hwnd
      $rect = [DshWin32]::GetDwmRect($win.Hwnd)
      $pname = Get-ProcessNameFast -ProcessId $win.Pid -Cache $null
      $identity = Get-ProcessIdentityFast -ProcessId $win.Pid
      $isMin = [DshWin32]::IsIconic($win.Hwnd)
      $sb = New-Object System.Text.StringBuilder(512)
      $null = [DshWin32]::GetWindowText($win.Hwnd, $sb, 512)
      $title = $sb.ToString()
      $rectObj = @{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
      $winInfo = @{
        id = $win.Hwnd.ToInt64()
        app = $pname
        hwnd = $win.Hwnd.ToInt64()
        title = $title
        pid = $win.Pid
        process_name = $pname
        app_identity = $identity
        rect = $rectObj
        minimized = [bool]$isMin
        foreground = (-not $isMin -and ([DshWin32]::GetForegroundWindow() -eq $win.Hwnd))
      }
      $result.window = $winInfo
      $result.hwnd = $win.Hwnd.ToInt64()
      $result.title = $title
      $result.pid = $win.Pid
      $result.process_name = $pname
      $result.app_identity = $identity
      $result.rect = $rectObj
      $result.minimized = [bool]$isMin
      $result.message = "Window metadata for '$title' (hwnd=$($win.Hwnd.ToInt64()), pid=$($win.Pid))"
    }

    'list_windows' {
      $app = Get-PayloadValue 'app'
      $cand = Get-CandidateWindows -App ([string]$app)
      $infos = @()
      foreach ($w in $cand) { $infos += (Get-WindowInfo $w) }
      $result.windows = $infos
      $result.window_count = $cand.Count
      if ($app) {
        $result.message = "Found $($cand.Count) window(s) matching '$app'"
      } else {
        $result.message = "Found $($cand.Count) window(s)"
      }
    }

    'cursor_position' {
      $cur = [System.Windows.Forms.Cursor]::Position
      $px = [int]$cur.X; $py = [int]$cur.Y
      $screens = [System.Windows.Forms.Screen]::AllScreens
      $dispIdx = 0
      for ($i = 0; $i -lt $screens.Length; $i++) {
        $b = $screens[$i].Bounds
        if ($px -ge $b.X -and $px -lt ($b.X + $b.Width) -and $py -ge $b.Y -and $py -lt ($b.Y + $b.Height)) {
          $dispIdx = $i + 1
          break
        }
      }
      if ($dispIdx -eq 0) { $dispIdx = 1 }
      $result.position = @{ x = $px; y = $py }
      $result.display = $dispIdx
      $result.primary = [bool]$screens[$dispIdx - 1].Primary
      $result.message = "Cursor at ($px, $py) on display $dispIdx"
    }

    'wait' {
      $rawDur = Get-PayloadValue 'duration_s'
      $dur = if ($null -eq $rawDur) { 1 } else { [double]$rawDur }
      if ($dur -lt 0) { $dur = 0 }
      if ($dur -gt 30) { $dur = 30 }
      $waitFor = ([string](Get-PayloadValue 'wait_for')).Trim().ToLowerInvariant()
      if ($waitFor) {
        if ($waitFor -notin @('accessibility_present', 'accessibility_available')) {
          throw "wait_for must be accessibility_present or accessibility_available (got '$waitFor')"
        }
        $app = Get-PayloadValue 'app'
        $hasHwnd = [int64](Get-PayloadValue 'hwnd') -gt 0
        if (-not $app -and -not $hasHwnd) { throw 'wait_for accessibility requires app or window' }
        # Poll the exact target's UIA tree without a screenshot or foreground
        # activation. This handles packaged/WinUI startup races while keeping
        # an absent provider explicit; it never manufactures an action snapshot.
        $started = [Diagnostics.Stopwatch]::StartNew()
        $ready = $false; $status = 'unavailable'; $count = 0
        do {
          $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
          $tree = Get-AccessibilityTree $win.Hwnd -WinRect $win.Rect
          $count = $tree.Count
          $status = if ($count -eq 0) { 'unavailable' } elseif ($count -le 2) { 'partial' } else { 'available' }
          $ready = if ($waitFor -eq 'accessibility_present') { $status -ne 'unavailable' } else { $status -eq 'available' }
          if ($ready -or $started.Elapsed.TotalSeconds -ge $dur) { break }
          $remainingMs = [Math]::Max(0, [int]($dur * 1000 - $started.ElapsedMilliseconds))
          if ($remainingMs -le 0) { break }
          Start-Sleep -Milliseconds ([Math]::Min(250, $remainingMs))
        } while ($true)
        $result.wait_for = $waitFor; $result.ready = $ready
        $result.accessibility_status = $status; $result.element_count = $count
        $result.duration_s = [Math]::Round($started.Elapsed.TotalSeconds, 3)
        if (-not $ready) {
          $result.ok = $false; $result.outcome = 'not_executed'
          $result.error_code = 'wait_condition_timeout'; $result.retry_safe = $true
          $result.message = "Timed out waiting $($result.duration_s)s for $waitFor (last accessibility status: $status, $count element(s))"
        } else {
          $result.message = "Accessibility condition '$waitFor' satisfied after $($result.duration_s)s ($status, $count element(s))"
        }
      } else {
        # Start-Sleep -Seconds is int-typed in PS 5.1 — use Milliseconds so fractional durations work
        Start-Sleep -Milliseconds ([int]($dur * 1000))
        $result.duration_s = $dur
        $result.message = "Waited $dur second(s)"
      }
    }

    'screenshot' {
      $dir = Join-Path $env:TEMP 'dsh-cua'
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $screens = [System.Windows.Forms.Screen]::AllScreens
      $disp = [int](Get-PayloadValue 'display')
      if ($disp -le 0) {
        # fall back to the display.state file written by switch_display, then the primary
        $stateFile = Join-Path $dir 'display.state'
        if (Test-Path $stateFile) {
          try { $disp = [int]((Get-Content $stateFile -Raw).Trim()) } catch { $disp = 0 }
        }
      }
      if ($disp -le 0) { $disp = 1 }
      if ($disp -gt $screens.Length) { throw "display index out of range: $disp (1..$($screens.Length))" }
      $bounds = $screens[$disp - 1].Bounds
      $rx = [int]$bounds.X; $ry = [int]$bounds.Y
      $rw = [int]$bounds.Width; $rh = [int]$bounds.Height
      $rawX = Get-PayloadValue 'x'
      $rawY = Get-PayloadValue 'y'
      $rawW = Get-PayloadValue 'width'
      $rawH = Get-PayloadValue 'height'
      if ($null -ne $rawX) { $rx = [int]$rawX }
      if ($null -ne $rawY) { $ry = [int]$rawY }
      if ($null -ne $rawW) { $rw = [int]$rawW }
      if ($null -ne $rawH) { $rh = [int]$rawH }
      # intersect the requested region with the display bounds and clamp
      $ix = [Math]::Max($rx, $bounds.X)
      $iy = [Math]::Max($ry, $bounds.Y)
      $ir = [Math]::Min($rx + $rw, $bounds.X + $bounds.Width)
      $ib = [Math]::Min($ry + $rh, $bounds.Y + $bounds.Height)
      $iw = $ir - $ix; $ih = $ib - $iy
      if ($iw -lt 1 -or $ih -lt 1) { throw "screenshot: requested region does not intersect display $disp bounds" }
      $bmp = New-Object System.Drawing.Bitmap($iw, $ih)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($ix, $iy, 0, 0, (New-Object System.Drawing.Size($iw, $ih)))
      $g.Dispose()
      $path = Join-Path $dir ("disp-{0}.png" -f ([guid]::NewGuid().ToString('N')))
      $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      # ponytail: GUID disp files are unbounded — keep newest 50, same policy as shot-*.png
      Get-ChildItem $dir -Filter 'disp-*.png' -ea SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 50 | Remove-Item -Force -ea SilentlyContinue
      $result.path = $path
      $result.screenshot_id = [guid]::NewGuid().ToString('N')
      $result.width = $iw
      $result.height = $ih
       $result.rect = @{ x = $ix; y = $iy; width = $iw; height = $ih }
       $result.display = $disp
       $result.viewport = @{ coordinate_space = 'screen'; display = $disp; x = $ix; y = $iy; width = $iw; height = $ih; scale = 1 }
       $script:lastScreenshot = @{ id = $result.screenshot_id; hwnd = [IntPtr]::Zero; rect = $null; created = [DateTime]::UtcNow }
       $result.message = "Screenshot of display $disp captured ($iw x $ih) at screen ($ix, $iy)"
    }

    'switch_display' {
      $screens = [System.Windows.Forms.Screen]::AllScreens
      $disp = [int](Get-PayloadValue 'display')
      if ($disp -lt 1 -or $disp -gt $screens.Length) { throw "display index out of range: $disp (1..$($screens.Length))" }
      $dir = Join-Path $env:TEMP 'dsh-cua'
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Set-Content -Path (Join-Path $dir 'display.state') -Value ([string]$disp) -Encoding ascii
      $b = $screens[$disp - 1].Bounds
      $result.display = $disp
      $result.bounds = @{ x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height }
      $result.message = "Active display set to $disp ($($b.Width) x $($b.Height) at ($($b.X), $($b.Y))); screenshots default to it until changed"
    }

    'zoom' {
      $dir = Join-Path $env:TEMP 'dsh-cua'
      $srcPath = [string](Get-PayloadValue 'path')
      if (-not $srcPath) {
        # default source: newest shot-*.png or disp-*.png in %TEMP%\dsh-cua
        $cands = @(Get-ChildItem $dir -Filter '*.png' -ea SilentlyContinue | Where-Object { $_.Name -like 'shot-*.png' -or $_.Name -like 'disp-*.png' } | Sort-Object LastWriteTime -Descending)
        if ($cands.Count -eq 0) { throw 'zoom: no source screenshot; run get_app_state or screenshot first' }
        $srcPath = $cands[0].FullName
      }
      if (-not (Test-Path $srcPath)) { throw "zoom: source screenshot not found: $srcPath" }
      $rx = Safe-Int (Get-PayloadValue 'x')
      $ry = Safe-Int (Get-PayloadValue 'y')
      $rw = Safe-Int (Get-PayloadValue 'width')
      $rh = Safe-Int (Get-PayloadValue 'height')
      if ($rw -le 0 -or $rh -le 0) { throw 'zoom: width and height are required (crop size in pixels of the source image)' }
      $src = New-Object System.Drawing.Bitmap($srcPath)
      $sw = $src.Width; $sh = $src.Height
      # clamp the crop region into the source image; width/height stay >= 1
      $ix = [Math]::Max(0, [Math]::Min($rx, $sw - 1))
      $iy = [Math]::Max(0, [Math]::Min($ry, $sh - 1))
      $iw = [Math]::Max(1, [Math]::Min($rw, $sw - $ix))
      $ih = [Math]::Max(1, [Math]::Min($rh, $sh - $iy))
      $rect = New-Object System.Drawing.Rectangle($ix, $iy, $iw, $ih)
      $crop = $src.Clone($rect, $src.PixelFormat)
      $src.Dispose()
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $outPath = Join-Path $dir ("zoom-{0}.png" -f ([guid]::NewGuid().ToString('N')))
      $crop.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $crop.Dispose()
      # ponytail: GUID zoom files are unbounded — keep newest 50
      Get-ChildItem $dir -Filter 'zoom-*.png' -ea SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 50 | Remove-Item -Force -ea SilentlyContinue
      $result.path = $outPath
      $result.width = $iw
      $result.height = $ih
      $result.source_path = $srcPath
      $result.message = "Zoomed ${iw}x${ih} crop at ($ix, $iy) from $srcPath"
    }

    'perform_secondary_action' {
      $app = Get-PayloadValue 'app'
      $element = [int](Get-PayloadValue 'element')
      $perform = ([string](Get-PayloadValue 'secondary_action')).Trim().ToLowerInvariant()
      $supportedPerforms = 'invoke, press, click, toggle, switch, select, add_to_selection, remove_from_selection, expand, collapse, focus, set_focus, scroll_up, scroll_down, scroll_left, scroll_right'
      $dispatch = Get-Dispatch
      $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
      if ($dispatch -eq 'foreground') {
        $result.focus_ok = Assert-ForegroundTarget -Win $win
      }
      $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index $element
      Assert-ConsequenceConfirmation -Element $el
      if ($dispatch -eq 'background') {
        $pt = Get-OverlayPoint-Element -Element $el -Win $win
        if ($pt) {
          Notify-Cursor -X $pt[0] -Y $pt[1] -Label ('perform ' + $perform)
        }
      }
      if (-not $perform) {
        throw "perform_secondary_action requires 'secondary_action' (supported: $supportedPerforms)"
      }
      if ($perform -in @('invoke', 'press', 'click')) {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'invoke' -Pattern ([System.Windows.Automation.InvokePattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support InvokePattern; unsupported background path cached."; break }
          throw "element $element does not support InvokePattern; cannot perform '$perform'"
        }
        $ip = $resolvedPattern.pattern
        $ip.Invoke()
        $result.method = 'invoke_pattern'
        $result.message = "Performed '$perform' on element $element via InvokePattern"
      } elseif ($perform -in @('toggle', 'switch')) {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'toggle' -Pattern ([System.Windows.Automation.TogglePattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support TogglePattern; unsupported background path cached."; break }
          throw "element $element does not support TogglePattern; cannot perform '$perform'"
        }
        $tog = $resolvedPattern.pattern
        $tog.Toggle()
        $result.method = 'toggle_pattern'
        $result.message = "Performed '$perform' on element $element via TogglePattern"
      } elseif ($perform -eq 'select') {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'selection' -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support SelectionItemPattern; unsupported background path cached."; break }
          throw "element $element does not support SelectionItemPattern; cannot perform '$perform'"
        }
        $sel = $resolvedPattern.pattern
        $sel.Select()
        $result.method = 'selection_pattern'
        $result.message = "Performed '$perform' on element $element via SelectionItemPattern"
      } elseif ($perform -eq 'add_to_selection') {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'selection' -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support SelectionItemPattern; unsupported background path cached."; break }
          throw "element $element does not support SelectionItemPattern; cannot perform '$perform'"
        }
        $sel = $resolvedPattern.pattern
        $sel.AddToSelection()
        $result.method = 'selection_pattern'
        $result.message = "Performed '$perform' on element $element via SelectionItemPattern"
      } elseif ($perform -eq 'remove_from_selection') {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'selection' -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support SelectionItemPattern; unsupported background path cached."; break }
          throw "element $element does not support SelectionItemPattern; cannot perform '$perform'"
        }
        $sel = $resolvedPattern.pattern
        $sel.RemoveFromSelection()
        $result.method = 'selection_pattern'
        $result.message = "Performed '$perform' on element $element via SelectionItemPattern"
      } elseif ($perform -eq 'expand') {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'expand_collapse' -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support ExpandCollapsePattern; unsupported background path cached."; break }
          throw "element $element does not support ExpandCollapsePattern; cannot perform '$perform'"
        }
        $exp = $resolvedPattern.pattern
        $exp.Expand()
        $result.method = 'expand_pattern'
        $result.message = "Performed '$perform' on element $element via ExpandCollapsePattern"
      } elseif ($perform -eq 'collapse') {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'expand_collapse' -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support ExpandCollapsePattern; unsupported background path cached."; break }
          throw "element $element does not support ExpandCollapsePattern; cannot perform '$perform'"
        }
        $exp = $resolvedPattern.pattern
        $exp.Collapse()
        $result.method = 'expand_pattern'
        $result.message = "Performed '$perform' on element $element via ExpandCollapsePattern"
      } elseif ($perform -in @('focus', 'set_focus')) {
        $el.SetFocus()
        $result.method = 'set_focus'
        $result.message = "Focused element $element"
      } elseif ($perform -in @('scroll_up', 'scroll_down', 'scroll_left', 'scroll_right')) {
        $resolvedPattern = Resolve-BackgroundPattern -Hwnd $win.Hwnd -Element $el -Name 'scroll' -Pattern ([System.Windows.Automation.ScrollPattern]::Pattern)
        if (-not $resolvedPattern.supported) {
          if ($dispatch -eq 'background') { $result.background_unavailable = $true; $result.method = if ($resolvedPattern.cached) { 'capability_cache' } else { 'capability_cache_update' }; $result.message = "Element $element does not support ScrollPattern; unsupported background path cached."; break }
          throw "element $element does not support ScrollPattern; cannot perform '$perform'"
        }
        $scp = $resolvedPattern.pattern
        $none = [System.Windows.Automation.ScrollAmount]::NoAmount
        if ($perform -eq 'scroll_up') { $scp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeDecrement) }
        elseif ($perform -eq 'scroll_down') { $scp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeIncrement) }
        elseif ($perform -eq 'scroll_left') { $scp.Scroll([System.Windows.Automation.ScrollAmount]::LargeDecrement, $none) }
        else { $scp.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, $none) }
        $result.method = 'scroll_pattern'
        $result.message = "Performed '$perform' on element $element via ScrollPattern"
      } else {
        throw "unknown perform '$perform' (supported: $supportedPerforms)"
      }
    }

    'select_text' {
      $app = Get-PayloadValue 'app'
      $element = [int](Get-PayloadValue 'element')
      $start = [int](Get-PayloadValue 'start')
      if ($start -lt 0) { $start = 0 }
      $rawLen = Get-PayloadValue 'length'
      $len = if ($null -eq $rawLen) { 0 } else { [int]$rawLen }
      if ($len -lt 0) { $len = 0 }
      $dispatch = Get-Dispatch
      $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
      if ($dispatch -eq 'foreground') {
        $result.focus_ok = Assert-ForegroundTarget -Win $win
      }
      $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index $element
      $tp = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
        if ($dispatch -eq 'background') {
          $result.background_unavailable = $true
          $result.message = "select_text: element $element has no TextPattern; background text selection unavailable. Use dispatch=foreground."
        } else {
          throw "element $element does not support TextPattern; cannot select text"
        }
      } else {
        $doc = $tp.DocumentRange
        # collapse the range at the document start: pull the End endpoint all the way
        # back (MoveEndpointByUnit clamps, endpoints never cross)
        $null = $doc.MoveEndpointByUnit([System.Windows.Automation.TextPatternRangeEndpoint]::End, [System.Windows.Automation.TextUnit]::Character, -1000000000)
        # advance Start to the requested offset (the range is degenerate; Move shifts it)
        if ($start -gt 0) { $null = $doc.Move([System.Windows.Automation.TextUnit]::Character, $start) }
        if ($len -gt 0) {
          $null = $doc.MoveEndpointByUnit([System.Windows.Automation.TextPatternRangeEndpoint]::End, [System.Windows.Automation.TextUnit]::Character, $len)
        }
        $doc.Select()
        $grab = $len + 32
        if ($len -le 0) { $grab = 64 }
        $selText = $doc.GetText($grab)
        $result.method = 'text_pattern'
        $result.selected_text = $selText
        $result.start = $start
        $result.length = $len
        if ($len -gt 0) {
          $result.message = "Selected $len char(s) from offset $start (recovered $($selText.Length))"
          if ($selText.Length -ne $len) { $result.message += '; provider returned a different char count than requested (TextUnit semantics vary by UIA provider)' }
        } else {
          $result.message = "Caret placed at offset $start (length 0)"
        }
      }
    }


    default {
      throw "unknown action: $Action"
    }
  }
}
catch {
  $result.ok = $false
  $result.message = "$($_.Exception.Message)"
}
finally {
  # A state-derived input is single-use, including a failed/uncertain attempt.
  # A helper restart also discards the cache: never remap an old index by rescanning.
  if ($Action -notin @('get_window_state', 'get_window', 'list_apps', 'list_windows', 'list_displays', 'screenshot', 'zoom', 'cursor_position', 'read_clipboard', 'wait')) {
    $script:observation = $null
    $script:lastScreenshot = $null
    $script:cachedElements = $null
    $script:cachedIdentities = $null
  }
  # Universal non-intrusive background guard: In background dispatch mode, the user's active window must NEVER be stolen!
  # If the target app (e.g. Edge/Chromium UIA Invoke, WM messages) activates itself,
  # immediately demote the target window to bottom and restore the user's active window!
  $foregroundLaunchRequested = ($Action -eq 'launch_app' -and [bool](Get-PayloadValue 'activate'))
  if ($dispatchMode -eq 'background' -and -not $foregroundLaunchRequested -and $Action -notin @('activate_window') -and $prevUserFg -ne [IntPtr]::Zero) {
    $curFg = [DshWin32]::GetForegroundWindow()
    if ($curFg -ne [IntPtr]::Zero -and $curFg -ne $prevUserFg) {
      [DshWin32]::PushWindowToBottom($curFg) | Out-Null
      try { [DshWin32]::ForceForeground($prevUserFg) } catch { }
    }
  }
}

  # REAL-03: when Resolve-TargetWindow auto-picked a window among several pid
  # candidates, surface the chosen handle so the caller can re-target exactly
  # (hwnd/window_index) without another list_windows round-trip.
  if ($script:autoChosenHwnd -and $result.ok) {
    $result.chosen_hwnd = $script:autoChosenHwnd.hwnd
    $result.chosen_title = $script:autoChosenHwnd.title
    $result.chosen_candidates = $script:autoChosenHwnd.candidates
    $result.message += " (auto-selected hwnd $($script:autoChosenHwnd.hwnd) '$($script:autoChosenHwnd.title)' among $($script:autoChosenHwnd.candidates) windows; pass hwnd/window_index to target a specific one)"
  }
  $script:autoChosenHwnd = $null

  if ($result.background_unavailable) { $result.ok = $false }
  if ($result.ok -and $result.method) {
    $result.outcome = if ($result.verified) { 'verified' } else { 'dispatched' }
    $result.needs_observation = -not [bool]$result.verified
  } elseif (-not $result.ok) {
    $result.outcome = 'unknown'
    if ($result.error_code -eq 'wait_condition_timeout') {
      # This is an observed, bounded read-only condition failure, not an
      # ambiguous transport or input outcome. Preserve its retry-safe meaning.
      $result.outcome = 'not_executed'
    } elseif ($result.message -match '^(snapshot_required|stale_snapshot|stale_screenshot|target_required|target_mismatch|ambiguous_window|app_not_found|window_not_found|element_not_found|background_unavailable|target_read_only|foreground_activation_unconfirmed):') {
      $result.error_code = $Matches[1]
      $result.outcome = 'not_executed'
    }
  }
  return $result
}

function Write-DaemonReply {
  param([int]$Id, $Reply)
  if ($Reply -is [hashtable]) { $Reply.id = $Id }
  else { $Reply = @{ id = $Id; ok = $false; action = ''; message = 'invalid reply object' } }
  # single-line JSON, always: compress, then strip any residual newline
  $json = ($Reply | ConvertTo-Json -Compress -Depth 10) -replace "(`r|`n)", ' '
  [PcPilotDeadline]::WriteReply($json + [Environment]::NewLine)
}

# ---------------------------------------------------------------- daemon mode (-Server)
if ($Server) {
  # keep the JSONL stdout stream clean: silence Write-Host/information records
  $InformationPreference = 'SilentlyContinue'
  # Simple loop: blocking ReadLine -> dispatch -> reply. No idle exit here —
  # Console.In.Peek() blocks on a redirected pipe and the old async-read poll
  # was proven to never run the idle check (judge: helper alive at 330s), so
  # idle lifecycle is owned by the node side instead. Exit on
  # EOF (stdin closed by node) or process kill.
  while ($true) {
    $line = $null
    try { $line = [PcPilotDeadline]::ReadUtf8Line() } catch { break }
    if ($null -eq $line) { break }   # stdin closed -> exit cleanly
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }
    $req = $null
    $reqId = 0
    try { $req = $trimmed | ConvertFrom-Json } catch { $req = $null }
    if ($null -eq $req -or -not $req.action) {
      Write-DaemonReply -Id $reqId -Reply @{ ok = $false; action = ''; message = 'invalid request' }
      continue
    }
    if ($req.PSObject.Properties['id']) { try { $reqId = [int]$req.id } catch { $reqId = 0 } }
    $reply = Invoke-ActionRequest -Action ([string]$req.action) -Payload $req
    # one failed action must never kill the daemon: try/catch inside
    # Invoke-ActionRequest already converts exceptions to ok:false replies;
    # here we only drop stray pipeline output (last object is the real reply)
    if ($reply -is [System.Array] -and $reply.Count -gt 0) { $reply = $reply[$reply.Count - 1] }
    Write-DaemonReply -Id $reqId -Reply $reply
  }
  [Console]::Out.Flush()
  exit 0
}

# ---------------------------------------------------------------- one-shot fallback (no -Server)
# Guard for dot-sourcing (tests load this file to reuse DshWin32) AND for stray
# no-arg runs: without an action there is nothing to run — exit BEFORE touching
# stdin, so a redirected-but-open stdin can never block us at ReadToEnd.
if (-not $Server -and -not $Action) { exit 0 }

if (-not $Server) {
  if (-not $PSBoundParameters.ContainsKey('TimeoutMs')) {
    if ($Action -eq 'wait') { $TimeoutMs = 40000 }
  }
  $deadlineReply = @{ ok = $false; action = $Action; error_code = 'action_timeout'; outcome = 'unknown'; retry_safe = $false; message = 'Helper deadline exceeded; observe state before deciding whether to retry' } | ConvertTo-Json -Compress
  [PcPilotDeadline]::Start($TimeoutMs, $deadlineReply)
}

$script:payload = $null
$rawJson = ''
try {
  # Explicit JSON must not wait for an unrelated inherited/open input pipe.
  if ($PayloadStdin -or (-not $PSBoundParameters.ContainsKey('PayloadJson') -and [Console]::IsInputRedirected)) {
    $rawJson = [PcPilotDeadline]::ReadUtf8ToEnd()
  }
  if ((-not $rawJson) -and $PayloadJson) {
    $rawJson = $PayloadJson
  }
  if ($rawJson -and $rawJson.Trim().Length -gt 0) {
    $script:payload = $rawJson | ConvertFrom-Json
  }
} catch {
  $invalidReply = @{ ok = $false; action = $Action; message = "Invalid JSON payload: $($_.Exception.Message)" } | ConvertTo-Json -Compress
  [PcPilotDeadline]::WriteReply($invalidReply)
  exit 0
}

$out = Invoke-ActionRequest -Action $Action -Payload $script:payload
if ($out -is [System.Array] -and $out.Count -gt 0) { $out = $out[$out.Count - 1] }
[PcPilotDeadline]::WriteReply(($out | ConvertTo-Json -Depth 10 -Compress))
