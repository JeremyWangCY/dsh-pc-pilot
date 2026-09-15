function Get-BackgroundCapabilityRecord {
  param([IntPtr]$Hwnd, $Element)
  if ($null -eq $Element -or $Hwnd -eq [IntPtr]::Zero -or $null -eq $script:windowBackgroundCapabilities) { return $null }
  try {
    $windowKey = [string]$Hwnd.ToInt64()
    if (-not $script:windowBackgroundCapabilities.ContainsKey($windowKey)) { return $null }
    $identity = Get-ElementIdentity $Element
    $map = $script:windowBackgroundCapabilities[$windowKey]
    if ($null -eq $map -or -not $map.ContainsKey($identity)) { return $null }
    return $map[$identity]
  } catch { return $null }
}

function Set-BackgroundCapability {
  param([IntPtr]$Hwnd, $Element, [string]$Name, [bool]$Supported)
  if ($null -eq $Element -or $Hwnd -eq [IntPtr]::Zero -or [string]::IsNullOrWhiteSpace($Name)) { return }
  try {
    $windowKey = [string]$Hwnd.ToInt64()
    if (-not $script:windowBackgroundCapabilities.ContainsKey($windowKey)) { $script:windowBackgroundCapabilities[$windowKey] = @{} }
    $map = $script:windowBackgroundCapabilities[$windowKey]
    $identity = Get-ElementIdentity $Element
    if (-not $map.ContainsKey($identity)) { $map[$identity] = @{} }
    $map[$identity][$Name] = $Supported
  } catch { }
}

function Resolve-BackgroundPattern {
  param([IntPtr]$Hwnd, $Element, [string]$Name, $Pattern)
  $cap = Get-BackgroundCapabilityRecord -Hwnd $Hwnd -Element $Element
  if ($cap -and $cap.ContainsKey($Name) -and -not [bool]$cap[$Name]) {
    return @{ supported = $false; cached = $true; pattern = $null }
  }
  $resolved = $null
  $supported = $false
  try { $supported = $Element.TryGetCurrentPattern($Pattern, [ref]$resolved) } catch { $supported = $false }
  Set-BackgroundCapability -Hwnd $Hwnd -Element $Element -Name $Name -Supported $supported
  return @{ supported = $supported; cached = $false; pattern = $resolved }
}

function Test-ElementInWindow {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [IntPtr]$Hwnd
  )
  if ($null -eq $Element -or $Hwnd -eq [IntPtr]::Zero) { return $false }
  try {
    $targetVal = $Hwnd.ToInt64()
    if ($Element.Current.NativeWindowHandle -eq $targetVal) { return $true }
    $elHwnd = [IntPtr]$Element.Current.NativeWindowHandle
    if ($elHwnd -ne [IntPtr]::Zero -and [DshWin32]::IsChild($Hwnd, $elHwnd)) { return $true }

    $targetPid = 0
    [void][DshWin32]::GetWindowThreadProcessId($Hwnd, [ref]$targetPid)
    if ($targetPid -ne 0 -and $Element.Current.ProcessId -ne $targetPid) { return $false }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $curr = $Element
    $hops = 0
    # max-hop guard: cyclic/deep UIA trees must not spin this walk forever
    while ($curr -and $hops -lt 32) {
      if ($curr.Current.NativeWindowHandle -eq $targetVal) { return $true }
      if ([System.Windows.Automation.Automation]::Compare($curr, $root)) { return $true }
      $curr = $walker.GetParent($curr)
      $hops++
    }
  } catch {
    return $false
  }
  return $false
}

function Find-TextInputHwnd {
  param([IntPtr]$Hwnd)
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused -and (Test-ElementInWindow -Element $focused -Hwnd $Hwnd)) {
      $curr = $focused
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $hops = 0
      # max-hop guard against cyclic/deep UIA trees
      while ($curr -and $hops -lt 32) {
        $fh = $curr.Current.NativeWindowHandle
        if ($fh -ne 0) {
          $vp = $null; $tp = $null
          if ($curr.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or
              $curr.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -or
              $curr.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
            return [IntPtr]$fh
          }
          break
        }
        $curr = $walker.GetParent($curr)
        $hops++
      }
    }
  } catch { }

  # Never substitute the first edit in the window for the user's intended field.
  # Explicit background input must use a snapshot-bound element if focus is absent.
  return [IntPtr]::Zero
}

function Find-ValuePatternEl {
  param([IntPtr]$Hwnd)
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused -and (Test-ElementInWindow -Element $focused -Hwnd $Hwnd)) {
      $vp = $null
      if ($focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        return $focused
      }
    }
  } catch { }

  # An address bar and a comment editor may both expose ValuePattern. Do not guess.
  return $null
}

function Find-FocusedEditableElement {
  param([IntPtr]$Hwnd)
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $focused -or -not (Test-ElementInWindow -Element $focused -Hwnd $Hwnd)) { return $null }
    $cur = $focused.Current
    $vp = $null; $tp = $null
    if ($cur.AutomationId -eq 'editor' -or $cur.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or
        $focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -or
        $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      return $focused
    }
  } catch { }
  return $null
}

function Find-ChromiumRenderHwnd {
  param([IntPtr]$Hwnd)
  if ($Hwnd -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  try { return [DshWin32]::FindDescendantByClass($Hwnd, 'Chrome_RenderWidgetHostHWND') } catch { return [IntPtr]::Zero }
}

function Send-BackgroundText {
  param([IntPtr]$Hwnd, [string]$Text)
  $res = [IntPtr]::Zero
  foreach ($ch in $Text.ToCharArray()) {
    if ($ch -eq [char]10) {
      $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0100, [IntPtr]13, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
      $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0102, [IntPtr]13, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
      $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0101, [IntPtr]13, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
      continue
    }
    if ($ch -eq [char]13) { continue }
    $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0102, [IntPtr][int]$ch, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
    Start-Sleep -Milliseconds 4
  }
}

function Send-BackgroundKeyMessage {
  param([IntPtr]$Hwnd, [uint32]$Message, [int]$VirtualKey, [switch]$Async)
  if ($Async) {
    if (-not [DshWin32]::PostMessage($Hwnd, $Message, [IntPtr]$VirtualKey, [IntPtr]::Zero)) {
      throw 'background_unavailable: Chromium renderer rejected the posted key message'
    }
    return
  }
  $res = [IntPtr]::Zero
  $sent = [DshWin32]::SendMessageTimeout($Hwnd, $Message, [IntPtr]$VirtualKey, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
  if ($sent -eq [IntPtr]::Zero) { throw 'input_timeout: target window did not process the background key message' }
}

function Send-BackgroundKey {
  param([IntPtr]$Hwnd, [string]$Key, [string]$Modifiers, [switch]$Async)
  $parsed = Parse-KeyChord -RawKey $Key -RawModifiers $Modifiers
  $Key = $parsed.Key
  $Modifiers = $parsed.Modifiers
  $vk = [DshWin32]::MapKey($Key)
  if ($vk -eq 0) { throw "unknown key: $Key" }
  $modVks = @()
  if ($Modifiers) {
    foreach ($part in ($Modifiers -split '[,+]')) {
      $m = $part.Trim().ToLowerInvariant()
      if ($m -in @('ctrl','control','control_l','control_r','ctrl_l','ctrl_r')) { $modVks += 0x11 }
      elseif ($m -in @('shift','shift_l','shift_r')) { $modVks += 0x10 }
      elseif ($m -in @('alt','alt_l','alt_r','option','option_l','option_r')) { $modVks += 0x12 }
      elseif ($m -in @('win','meta','super','cmd','command')) { $modVks += 0x5B }
    }
  }
  foreach ($mvk in $modVks) { Send-BackgroundKeyMessage -Hwnd $Hwnd -Message 0x0100 -VirtualKey $mvk -Async:$Async }
  Send-BackgroundKeyMessage -Hwnd $Hwnd -Message 0x0100 -VirtualKey $vk -Async:$Async
  Send-BackgroundKeyMessage -Hwnd $Hwnd -Message 0x0101 -VirtualKey $vk -Async:$Async
  for ($i = $modVks.Count - 1; $i -ge 0; $i--) { Send-BackgroundKeyMessage -Hwnd $Hwnd -Message 0x0101 -VirtualKey $modVks[$i] -Async:$Async }
}

function Send-BackgroundHoldKey {
  param([IntPtr]$Hwnd, [string]$Key, [string]$Modifiers, [int]$DurationMs)
  $parsed = Parse-KeyChord -RawKey $Key -RawModifiers $Modifiers
  $Key = $parsed.Key
  $Modifiers = $parsed.Modifiers
  $vk = [DshWin32]::MapKey($Key)
  if ($vk -eq 0) { throw "unknown key: $Key" }
  $modVks = @()
  if ($Modifiers) {
    foreach ($part in ($Modifiers -split '[,+]')) {
      $m = $part.Trim().ToLowerInvariant()
      if ($m -in @('ctrl','control','control_l','control_r','ctrl_l','ctrl_r')) { $modVks += 0x11 }
      elseif ($m -in @('shift','shift_l','shift_r')) { $modVks += 0x10 }
      elseif ($m -in @('alt','alt_l','alt_r','option','option_l','option_r')) { $modVks += 0x12 }
      elseif ($m -in @('win','meta','super','cmd','command')) { $modVks += 0x5B }
    }
  }
  $res = [IntPtr]::Zero
  foreach ($mvk in $modVks) { $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0100, [IntPtr]$mvk, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res) }
  $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0100, [IntPtr]$vk, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
  Start-Sleep -Milliseconds $DurationMs
  $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0101, [IntPtr]$vk, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
  for ($i = $modVks.Count - 1; $i -ge 0; $i--) { $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0101, [IntPtr]$modVks[$i], [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res) }
}

function Get-UiaParent {
  param([System.Windows.Automation.AutomationElement]$el)
  if ($null -eq $el) { return $null }
  return [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el)
}

function Send-BackgroundMouseButton {
  # Standard Windows click message sequence to a specific hwnd, screen coords:
  #   single: DOWN, UP
  #   double: DOWN, UP, DBLCLK, UP
  #   triple: DOWN, UP, DBLCLK, UP, DBLCLK, UP
  # (apps with CS_DBLCLKS decode the DBLCLK messages; non-double-click apps just
  # see multiple plain clicks)
  param([IntPtr]$Hwnd, [int]$Sx, [int]$Sy, [string]$Button, [int]$Count, [string]$Modifiers)
  $msgDown = 0x0201; $msgUp = 0x0202; $msgDbl = 0x0203; $wDown = 0x0001
  if ($Button -eq 'right') { $msgDown = 0x0204; $msgUp = 0x0205; $msgDbl = 0x0206; $wDown = 0x0002 }
  elseif ($Button -eq 'middle') { $msgDown = 0x0207; $msgUp = 0x0208; $msgDbl = 0x0209; $wDown = 0x0010 }
  elseif ($Button -eq 'back') { $msgDown = 0x020B; $msgUp = 0x020C; $msgDbl = 0x020D; $wDown = 0x00010000 }
  elseif ($Button -eq 'forward') { $msgDown = 0x020B; $msgUp = 0x020C; $msgDbl = 0x020D; $wDown = 0x00020000 }
  $modVks = @(); $wMods = 0
  if ($Modifiers) {
    foreach ($part in ($Modifiers -split '[,+]')) {
      $m = $part.Trim().ToLowerInvariant()
      if ($m -in @('shift','shift_l','shift_r')) { $modVks += 0x10; $wMods = $wMods -bor 0x0004 }
      elseif ($m -in @('ctrl','control','control_l','control_r','ctrl_l','ctrl_r')) { $modVks += 0x11; $wMods = $wMods -bor 0x0008 }
      elseif ($m -in @('alt','alt_l','alt_r','option','option_l','option_r')) { $modVks += 0x12 }
      elseif ($m -in @('win','meta','super','cmd','command')) { $modVks += 0x5B }
      else { throw "unsupported mouse modifier: $part" }
    }
  }
  $cpt = [DshWin32]::ScreenToClientPoint($Hwnd, $Sx, $Sy)
  $lParam = [IntPtr](($cpt.Y -band 0xFFFF) -shl 16 -bor ($cpt.X -band 0xFFFF))
  $res = [IntPtr]::Zero
  foreach ($mvk in $modVks) { $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0100, [IntPtr]$mvk, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res) }
  try {
    $wDown = $wDown -bor $wMods
    $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgDown, [IntPtr]$wDown, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
    $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgUp, [IntPtr]$wMods, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
    for ($i = 1; $i -lt $Count; $i++) {
      $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgDbl, [IntPtr]$wDown, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
      $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgUp, [IntPtr]$wMods, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
    }
  } finally {
    for ($i = $modVks.Count - 1; $i -ge 0; $i--) { $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0101, [IntPtr]$modVks[$i], [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res) }
  }
}

function Find-BackgroundHwndAt {
  # hwnd that owns the point: UIA FromPoint ancestor walk, then target window, then raw WindowFromPoint
  param([double]$Sx, [double]$Sy, $Win)
  $pt = New-Object System.Windows.Point($Sx, $Sy)
  $wEl = $null
  try { $wEl = [System.Windows.Automation.AutomationElement]::FromPoint($pt) } catch { }
  for ($i = 0; $i -lt 24 -and $null -ne $wEl; $i++) {
    $nh = $wEl.Current.NativeWindowHandle
    if ($nh -ne 0) { return [IntPtr]$nh }
    $wEl = Get-UiaParent $wEl
  }
  if ($null -ne $Win -and $Win.Hwnd -ne [IntPtr]::Zero) { return $Win.Hwnd }
  $p = New-Object DshWin32+POINT; $p.X = [int]$Sx; $p.Y = [int]$Sy
  return [DshWin32]::WindowFromPoint($p)
}

function Invoke-FromPoint {
  param([double]$X, [double]$Y)
  $pt = New-Object System.Windows.Point($X, $Y)
  $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
  for ($i = 0; $i -lt 12 -and $null -ne $el; $i++) {
    $ip = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
      $ip.Invoke(); return @{ ok = $true; method = 'invoke'; name = $el.Current.Name; rect = $el.Current.BoundingRectangle }
    }
    $tp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
      $tp.Toggle(); return @{ ok = $true; method = 'toggle'; name = $el.Current.Name; rect = $el.Current.BoundingRectangle }
    }
    $sp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) {
      $sp.Select(); return @{ ok = $true; method = 'selection'; name = $el.Current.Name; rect = $el.Current.BoundingRectangle }
    }
    $el = Get-UiaParent $el
  }
  return @{ ok = $false }
}

function Find-TargetHitsAt {
  # One shared scan over the TARGET window's own UIA tree for a screen point:
  #   best        — smallest element containing the point (any element)
  #   bestPattern — smallest element containing the point that carries an action
  #                 pattern (invoke/toggle/selection), plus that method's name
  # BoundingRectangle containment is half-open [X, X+W) x [Y, Y+H).
  # FindAll itself remains unbounded; the caller needs an external process budget.
  # Reject incomplete scans rather than dispatching a partially selected target.
  param([IntPtr]$Hwnd, [double]$X, [double]$Y)
  $hits = @{ best = $null; bestPattern = $null; method = $null }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $bestArea = -1.0
    $patArea = -1.0
    $count = 0
    foreach ($el in $children) {
      if ($count -ge $script:MAX_ELEMENTS) { throw 'target_validation_failed: hit scan exceeded element budget' }
      $count++
      $r = $el.Current.BoundingRectangle
      if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
      if ($X -lt $r.X -or $X -ge ($r.X + $r.Width) -or $Y -lt $r.Y -or $Y -ge ($r.Y + $r.Height)) { continue }
      $area = $r.Width * $r.Height
      if ($null -eq $hits.best -or $area -lt $bestArea) { $bestArea = $area; $hits.best = $el }
      $method = $null
      $ip = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $method = 'invoke' }
      else {
        $tp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) { $method = 'toggle' }
        else {
          $sp = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { $method = 'selection' }
        }
      }
      if ($null -ne $method) {
        if ($null -eq $hits.bestPattern -or $area -lt $patArea) { $patArea = $area; $hits.bestPattern = $el; $hits.method = $method }
      }
    }
  } catch { throw "target_validation_failed: hit scan failed: $($_.Exception.Message)" }
  return $hits
}

function Resolve-ClickPoint {
  param($RawX, $RawY, $Win, [string]$Space)
  foreach ($value in @($RawX, $RawY)) {
    if ($null -eq $value -or $value -is [bool] -or $value -is [array] -or [string]::IsNullOrWhiteSpace([string]$value)) {
      throw 'invalid_coordinates: click requires both x and y; use element_index for an observed element target'
    }
    $number = 0.0
    if (-not [double]::TryParse([string]$value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number) -or
        [double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt [int]::MinValue -or $number -gt [int]::MaxValue) {
      throw 'invalid_coordinates: x and y must be finite pixel coordinates'
    }
  }
  $x = [double]::Parse([string]$RawX, [Globalization.CultureInfo]::InvariantCulture)
  $y = [double]::Parse([string]$RawY, [Globalization.CultureInfo]::InvariantCulture)
  $Space = $Space.Trim().ToLowerInvariant()
  if ($Space -notin @('', 'screen', 'window')) { throw 'invalid_coordinate_space: expected screen or window' }
  if ($Space -eq 'window' -and -not $Win) { throw 'invalid_coordinate_space: window requires app' }
  if ($Win) {
    $r = $Win.Rect
    if ($null -eq $r -or $r.Right -le $r.Left -or $r.Bottom -le $r.Top) { throw 'invalid_window_rect' }
    # A target window makes x/y window-relative by default, matching the
    # computer-use window API. Do not infer coordinate space from whether a
    # point happens to lie inside the window: that heuristic makes the same
    # request mean different things after a window move.
    if ($Space -ne 'screen') {
      $x += $r.Left; $y += $r.Top
    }
    if ($x -lt $r.Left -or $x -ge $r.Right -or $y -lt $r.Top -or $y -ge $r.Bottom) { throw 'invalid_coordinates: point outside target window' }
  }
  if ($x -lt [int]::MinValue -or $x -gt [int]::MaxValue -or $y -lt [int]::MinValue -or $y -gt [int]::MaxValue) { throw 'invalid_coordinates: point out of range' }
  return @([int][Math]::Floor($x), [int][Math]::Floor($y))
}

function Assert-ClickTarget {
  param($Element, [IntPtr]$Hwnd, [double]$X, [double]$Y, [string]$ExpectedName)
  if ($null -eq $Element -or -not (Test-ElementInWindow -Element $Element -Hwnd $Hwnd)) { throw 'target_validation_failed: element is not in target window' }
  $current = $Element.Current
  if ($ExpectedName -and -not [string]::Equals($current.Name, $ExpectedName, [StringComparison]::Ordinal)) { throw 'target_validation_failed: expected_name mismatch; refresh get_window_state and use click with element_index' }
  $r = $current.BoundingRectangle
  if ($null -eq $r -or $r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { throw 'target_validation_failed: invalid element rectangle' }
  foreach ($n in @($r.X, $r.Y, $r.Width, $r.Height)) {
    if ($null -eq $n -or [double]::IsNaN($n) -or [double]::IsInfinity($n)) { throw 'target_validation_failed: nonfinite rectangle' }
  }
  if ($X -lt $r.X -or $X -ge ($r.X + $r.Width) -or $Y -lt $r.Y -or $Y -ge ($r.Y + $r.Height)) { throw 'target_validation_failed: element moved away from click point' }
  if (-not $current.IsEnabled) { throw 'target_validation_failed: element is disabled' }
}

function Resolve-ValidatedElementHit {
  # Resolve an element's current live hit before using a raw WM click. The
  # snapshot element may be a virtualized Chromium group whose reported rect is
  # stale; walk from the live hit to a matching element/ancestor and reject any
  # mismatch instead of clicking a neighboring control.
  param([IntPtr]$Hwnd, $Element)
  if ($null -eq $Element) { throw 'target_validation_failed: element is missing' }
  $r = $Element.Current.BoundingRectangle
  if ($null -eq $r -or $r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { throw 'target_validation_failed: invalid element rectangle' }
  $cx = Safe-Int ($r.X + $r.Width / 2); $cy = Safe-Int ($r.Y + $r.Height / 2)
  $hit = Find-TargetHitsAt -Hwnd $Hwnd -X $cx -Y $cy
  $cursor = $hit.best
  $matched = $null
  $expectedIdentity = Get-ElementIdentity $Element
  $expectedCurrent = $Element.Current
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $hops = 0
  while ($cursor -and $hops -lt 32) {
    $cc = $cursor.Current
    $sameIdentity = $false
    try { $sameIdentity = ((Get-ElementIdentity $cursor) -ceq $expectedIdentity) } catch { }
    $sameNamedRole = ($expectedCurrent.Name -and $cc.Name -ceq $expectedCurrent.Name -and
      $cc.ControlType.Id -eq $expectedCurrent.ControlType.Id -and $cc.AutomationId -ceq $expectedCurrent.AutomationId)
    if ($sameIdentity -or $sameNamedRole) { $matched = $cursor; break }
    $cursor = $walker.GetParent($cursor)
    $hops++
  }
  if ($null -eq $matched) { throw 'target_validation_failed: live UIA hit does not match the observed element; refresh get_app_state' }
  Assert-ClickTarget -Element $matched -Hwnd $Hwnd -X $cx -Y $cy -ExpectedName ([string]$expectedCurrent.Name)
  $native = [IntPtr]::Zero
  $cursor = $matched; $hops = 0
  while ($cursor -and $hops -lt 32) {
    $nh = $cursor.Current.NativeWindowHandle
    if ($nh -ne 0) { $native = [IntPtr]$nh; break }
    $cursor = $walker.GetParent($cursor)
    $hops++
  }
  if ($native -eq [IntPtr]::Zero) { $native = $Hwnd }
  if ($native -ne $Hwnd -and -not [DshWin32]::IsChild($Hwnd, $native)) { throw 'target_validation_failed: hit native handle is outside target window' }
  return @{ element = $matched; x = $cx; y = $cy; hwnd = $native }
}

function Invoke-FromPointInWindow {
  # Window-scoped semantic hit: fire the action pattern of the TARGET window's own
  # UIA tree element under the screen point. Occlusion semantics: with a specified
  # app, background clicks aim at the target window's tree — physical occlusion by
  # other windows does not affect delivery, and UIA pattern hits still take priority
  # over bare WM messages. Among matching elements the SMALLEST rectangle wins
  # (deepest control, mirroring Invoke-FromPoint's bottom-up walk). Same return
  # shape as Invoke-FromPoint.
  param([IntPtr]$Hwnd, [double]$X, [double]$Y, [string]$ExpectedName, $Element)
    if ($null -eq $Element -and [string]::IsNullOrWhiteSpace($ExpectedName)) {
      throw 'target_validation_required: background app coordinate click requires expected_name; call get_window_state and use click with element_index'
    }
    $best = $Element
    if ($null -eq $best) { $best = (Find-TargetHitsAt -Hwnd $Hwnd -X $X -Y $Y).bestPattern }
    Assert-ClickTarget -Element $best -Hwnd $Hwnd -X $X -Y $Y -ExpectedName $ExpectedName
    if ($null -ne $best) {
      $method = $null
      $bp = $null
      $cap = Get-BackgroundCapabilityRecord -Hwnd $Hwnd -Element $best
      $knownNoAction = ($cap -and $cap.ContainsKey('invoke') -and $cap.ContainsKey('toggle') -and $cap.ContainsKey('selection') -and
        -not [bool]$cap.invoke -and -not [bool]$cap.toggle -and -not [bool]$cap.selection)
      if ($knownNoAction) { throw 'background_unavailable: capability cache says target has no UIA invoke/toggle/selection path' }
      if (-not $cap -or -not $cap.ContainsKey('invoke') -or [bool]$cap.invoke) {
        if ($best.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$bp)) { $method = 'invoke'; Set-BackgroundCapability -Hwnd $Hwnd -Element $best -Name 'invoke' -Supported $true }
        else { Set-BackgroundCapability -Hwnd $Hwnd -Element $best -Name 'invoke' -Supported $false }
      }
      if ($null -eq $method -and (-not $cap -or -not $cap.ContainsKey('toggle') -or [bool]$cap.toggle)) {
        $bp = $null
        if ($best.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$bp)) { $method = 'toggle'; Set-BackgroundCapability -Hwnd $Hwnd -Element $best -Name 'toggle' -Supported $true }
        else { Set-BackgroundCapability -Hwnd $Hwnd -Element $best -Name 'toggle' -Supported $false }
      }
      if ($null -eq $method -and (-not $cap -or -not $cap.ContainsKey('selection') -or [bool]$cap.selection)) {
        $bp = $null
        if ($best.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$bp)) { $method = 'selection'; Set-BackgroundCapability -Hwnd $Hwnd -Element $best -Name 'selection' -Supported $true }
        else { Set-BackgroundCapability -Hwnd $Hwnd -Element $best -Name 'selection' -Supported $false }
      }
      # Revalidate after pattern lookup; never catch an action exception and retry.
      Assert-ClickTarget -Element $best -Hwnd $Hwnd -X $X -Y $Y -ExpectedName $ExpectedName
      if ($null -eq $method) { throw 'background_unavailable: target has no verified UIA action pattern; unsupported paths were cached' }
      $name = $best.Current.Name
      $rect = $best.Current.BoundingRectangle
      if ($method -eq 'invoke') { $bp.Invoke() }
      elseif ($method -eq 'toggle') { $bp.Toggle() }
      elseif ($method -eq 'selection') { $bp.Select() }
      return @{ ok = $true; method = $method; name = $name; rect = $rect }
    }
  throw 'target_validation_failed: no actionable target at point; refresh get_window_state and use click with element_index'
}

function Find-TargetHwndAt {
  # hwnd that owns the point INSIDE the target window's UIA tree: find the deepest
  # element containing the screen point, then climb to a NativeWindowHandle. NEVER
  # falls back to screen WindowFromPoint — with a specified app that would be the
  # occluding window; falls back to $Win.Hwnd itself. Callers must ScreenToClient
  # against the RETURNED hwnd (Send-BackgroundMouseButton already does).
  param([IntPtr]$Hwnd, [double]$X, [double]$Y, $Win)
  $found = [IntPtr]::Zero
  try {
    $hits = Find-TargetHitsAt -Hwnd $Hwnd -X $X -Y $Y
    $curr = $hits.best
    $root = $null
    if ($null -eq $curr) { $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd); $curr = $root }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $hops = 0
    # max-hop guard against cyclic/deep UIA trees (same style as Test-ElementInWindow)
    while ($curr -and $hops -lt 32) {
      $nh = $curr.Current.NativeWindowHandle
      if ($nh -ne 0) { $found = [IntPtr]$nh; break }
      $curr = $walker.GetParent($curr)
      $hops++
    }
  } catch { }
  if ($found -ne [IntPtr]::Zero) { return $found }
  if ($null -ne $Win -and $Win.Hwnd -ne [IntPtr]::Zero) { return $Win.Hwnd }
  return [IntPtr]::Zero
}

function Get-OverlayPoint-WindowCenter {
  param($Win)
  $cx = [int](($Win.Rect.Left + $Win.Rect.Right) / 2)
  $cy = [int](($Win.Rect.Top + $Win.Rect.Bottom) / 2)
  return @($cx, $cy)
}

function Get-OverlayPoint-Element {
  param($Element, $Win)
  if (-not $Element) {
    if ($Win) { return (Get-OverlayPoint-WindowCenter $Win) }
    return $null
  }
  try {
    $sip = $null
    if ($Element.Current.IsOffscreen -and $Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$sip)) {
      try { $sip.ScrollIntoView() } catch { }
    }
    $er = $Element.Current.BoundingRectangle
    if ($er.Width -gt 0 -and $er.Height -gt 0) {
      $cx = Safe-Int ($er.X + $er.Width / 2)
      $cy = Safe-Int ($er.Y + $er.Height / 2)
      if ($Win) {
        $wr = $Win.Rect
        if ($cx -ge $wr.Left -and $cx -le $wr.Right -and $cy -ge $wr.Top -and $cy -le $wr.Bottom) {
          return @($cx, $cy)
        }
      } elseif ($cx -gt 0 -and $cy -gt 0) {
        return @($cx, $cy)
      }
    }
  } catch { }
  if ($Win) { return (Get-OverlayPoint-WindowCenter $Win) }
  return $null
}
