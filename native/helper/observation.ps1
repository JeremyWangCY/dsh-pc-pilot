function Get-PayloadValue {
  param([string]$Name)
  if ($null -ne $script:payload -and $script:payload.PSObject.Properties[$Name]) {
    return $script:payload.$Name
  }
  return $null
}

function Get-Dispatch {
  $d = Get-PayloadValue 'dispatch'
  if (-not $d) { $d = 'background' }
  return ([string]$d).ToLowerInvariant()
}

function Get-OverlayEnabled {
  # codex-style cursor indicator: ON by default (user asked to see where the AI will click).
  # Pass overlay: false on an action to hide the indicator for that action.
  $o = Get-PayloadValue 'overlay'
  if ($null -eq $o) { return $true }
  return [bool]$o
}

if ($null -eq $script:processNameCache) { $script:processNameCache = @{} }
if ($null -eq $script:processIdentityCache) { $script:processIdentityCache = @{} }
if ($null -eq $script:fileIdentityCache) { $script:fileIdentityCache = @{} }
if ($null -eq $script:verifiedPublisherCache) { $script:verifiedPublisherCache = @{} }
if ($null -eq $script:accessibilityHistory) { $script:accessibilityHistory = @{} }
if ($null -eq $script:accessibilityRevision) { $script:accessibilityRevision = [int64]0 }

function Get-ProcessNameFast {
  param([uint32]$ProcessId, [hashtable]$Cache)
  if ($null -ne $Cache -and $Cache.ContainsKey($ProcessId)) { return $Cache[$ProcessId] }

  $name = $null
  if ($script:processNameCache.ContainsKey($ProcessId)) {
    $cached = $script:processNameCache[$ProcessId]
    try {
      if (-not $cached.process.HasExited) { $name = [string]$cached.name }
      else {
        try { $cached.process.Dispose() } catch { }
        $script:processNameCache.Remove($ProcessId)
      }
    } catch {
      try { $cached.process.Dispose() } catch { }
      $script:processNameCache.Remove($ProcessId)
    }
  }

  if (-not $name) {
    try {
      $p = [System.Diagnostics.Process]::GetProcessById([int]$ProcessId)
      $name = $p.ProcessName
      $script:processNameCache[$ProcessId] = @{ process = $p; name = $name }
    } catch { }
  }

  if (-not $name) { $name = "pid:$ProcessId" }
  if ($null -ne $Cache) { $Cache[$ProcessId] = $name }
  return $name
}

function Get-FileIdentityFast {
  param([string]$Path)
  if (-not $Path) { return @{} }
  $key = $Path.ToLowerInvariant()
  if ($script:fileIdentityCache.ContainsKey($key)) { return $script:fileIdentityCache[$key] }
  $info = [ordered]@{
    executable_path = $Path
    file_name = [System.IO.Path]::GetFileName($Path)
    product_name = ''
    product_version = ''
    file_version = ''
    company_name = ''
  }
  try {
    $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    $info.product_name = [string]$vi.ProductName
    $info.product_version = [string]$vi.ProductVersion
    $info.file_version = [string]$vi.FileVersion
    $info.company_name = [string]$vi.CompanyName
  } catch { }
  $script:fileIdentityCache[$key] = $info
  return $info
}

function Get-VerifiedPublisherFast {
  param([string]$Path)
  if (-not $Path) {
    return @{ signature_status = 'unavailable'; publisher = ''; signer_subject = ''; signer_thumbprint = '' }
  }
  $key = $Path.ToLowerInvariant()
  if ($script:verifiedPublisherCache.ContainsKey($key)) { return $script:verifiedPublisherCache[$key] }
  $verified = [ordered]@{
    signature_status = 'unknown'
    publisher = ''
    signer_subject = ''
    signer_thumbprint = ''
  }
  try {
    $sig = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
    $verified.signature_status = [string]$sig.Status
    if ($sig.SignerCertificate) {
      $verified.signer_subject = [string]$sig.SignerCertificate.Subject
      $verified.signer_thumbprint = [string]$sig.SignerCertificate.Thumbprint
      try { $verified.publisher = [string]$sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } catch { }
    }
  } catch {
    $verified.signature_status = 'unavailable'
  }
  $script:verifiedPublisherCache[$key] = $verified
  return $verified
}

function Get-ProcessIdentityFast {
  param([uint32]$ProcessId, [bool]$Detailed = $false, [bool]$VerifySignature = $false)

  $name = Get-ProcessNameFast -ProcessId $ProcessId -Cache $null
  $startTicks = [int64]0
  if ($script:processNameCache.ContainsKey($ProcessId)) {
    try { $startTicks = $script:processNameCache[$ProcessId].process.StartTime.ToUniversalTime().Ticks } catch { }
  }

  $cached = $null
  if ($script:processIdentityCache.ContainsKey($ProcessId)) {
    $candidate = $script:processIdentityCache[$ProcessId]
    if ($candidate.start_ticks -eq $startTicks -and $startTicks -ne 0) { $cached = $candidate }
    else { $script:processIdentityCache.Remove($ProcessId) }
  }

  if (-not $cached) {
    $path = ''
    try { $path = [string][DshWin32]::QueryProcessImagePath($ProcessId) } catch { }
    $aumid = ''
    try { $aumid = [string][DshWin32]::QueryProcessAumid($ProcessId) } catch { }
    $parentPid = 0
    try { $parentPid = [uint32][DshWin32]::QueryParentProcessId($ProcessId) } catch { }

    # App-tree identity follows same-process-name ancestors only. This groups
    # Chromium / Electron worker processes with their app root without collapsing
    # everything into explorer.exe or a service host, while keeping the hot path
    # free of repeated parent executable-path queries.
    $treeRoot = [uint32]$ProcessId
    $cursor = [uint32]$ProcessId
    $seen = @{}
    $selfName = $name
    for ($depth = 0; $depth -lt 32; $depth++) {
      if ($seen.ContainsKey($cursor)) { break }
      $seen[$cursor] = $true
      $ppid = 0
      try { $ppid = [uint32][DshWin32]::QueryParentProcessId($cursor) } catch { }
      if ($ppid -eq 0 -or $ppid -eq $cursor) { break }
      $parentName = ''
      try { $parentName = Get-ProcessNameFast -ProcessId $ppid -Cache $null } catch { }
      if ($selfName -and $parentName -and $parentName -ieq $selfName) {
        $treeRoot = $ppid
        $cursor = $ppid
        continue
      }
      break
    }

    $kind = if ($aumid) { 'packaged' } else { 'win32' }
    $identityKey = if ($aumid) { 'aumid:' + $aumid } elseif ($path) { 'win32:' + $path.ToLowerInvariant() } else { 'pid:' + [string]$ProcessId }
    $cached = [ordered]@{
      kind = $kind
      identity_key = $identityKey
      pid = [uint32]$ProcessId
      process_name = $name
      executable_path = $path
      file_name = if ($path) { [System.IO.Path]::GetFileName($path) } else { '' }
      aumid = $aumid
      parent_pid = [uint32]$parentPid
      process_tree_root_pid = [uint32]$treeRoot
      publisher = ''
      signature_status = 'not_checked'
      signer_subject = ''
      signer_thumbprint = ''
      details_loaded = $false
      start_ticks = $startTicks
    }
    $script:processIdentityCache[$ProcessId] = $cached
  }

  if ($Detailed -and -not $cached.details_loaded) {
    $file = Get-FileIdentityFast -Path ([string]$cached.executable_path)
    $cached.product_name = [string]$file.product_name
    $cached.product_version = [string]$file.product_version
    $cached.file_version = [string]$file.file_version
    $cached.company_name = [string]$file.company_name
    $cached.details_loaded = $true
  }

  if ($VerifySignature -and $cached.executable_path -and $cached.signature_status -eq 'not_checked') {
    $signature = Get-VerifiedPublisherFast -Path ([string]$cached.executable_path)
    $cached.signature_status = [string]$signature.signature_status
    $cached.signer_subject = [string]$signature.signer_subject
    $cached.signer_thumbprint = [string]$signature.signer_thumbprint
    if ($signature.publisher) { $cached.publisher = [string]$signature.publisher }
  }

  # Do not expose the internal PID-reuse discriminator.
  $copy = [ordered]@{}
  foreach ($key in $cached.Keys) {
    if ($key -notin @('start_ticks', 'details_loaded')) { $copy[$key] = $cached[$key] }
  }
  return $copy
}

function Get-CandidateWindows {
  # Shared candidate filtering for Resolve-TargetWindow and list_windows:
  # matches pid / window-title substring / process name, drops off-screen ghosts.
  param([string]$App)
  $wins = @([DshWin32]::EnumWindowsList())
  $filtered = $wins
  $identityKey = [string](Get-PayloadValue 'identity_key')

  if ($identityKey) {
    $identities = @{}
    foreach ($w in $wins) {
      if (-not $identities.ContainsKey($w.Pid)) {
        $identities[$w.Pid] = Get-ProcessIdentityFast -ProcessId $w.Pid
      }
    }
    $filtered = @($wins | Where-Object { [string]$identities[$_.Pid].identity_key -ieq $identityKey })
  } elseif ($App) {
    if ($App -match '^\d+$') {
      $pidMatch = [uint32]$App
      $filtered = @($wins | Where-Object { $_.Pid -eq $pidMatch })
    } else {
      $filtered = @($wins | Where-Object { $_.Title -and ($_.Title.IndexOf($App, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) })
      if ($filtered.Count -eq 0) {
        $names = @{}
        foreach ($w in $wins) {
          if (-not $names.ContainsKey($w.Pid)) {
            $names[$w.Pid] = Get-ProcessNameFast -ProcessId $w.Pid -Cache $names
          }
        }
        $filtered = @($wins | Where-Object { $names[$_.Pid] -ieq $App })
      }
    }
  }

  return @($filtered | Where-Object {
    $_.Minimized -or (
      $_.Rect.Left -ge -10000 -and $_.Rect.Top -ge -10000 -and
      ($_.Rect.Right - $_.Rect.Left) -ge 50 -and
      ($_.Rect.Bottom - $_.Rect.Top) -ge 32
    )
  })
}

function Resolve-TargetWindow {
  param([string]$App, [int]$Index, [int64]$Hwnd = 0)
  if (-not $Hwnd) {
    $hVal = Get-PayloadValue 'hwnd'
    if ($hVal) { $Hwnd = [int64]$hVal }
  }
  $target = $null
  if ($Hwnd -gt 0) {
    $wins = @([DshWin32]::EnumWindowsList())
    $found = @($wins | Where-Object { $_.Hwnd.ToInt64() -eq $Hwnd })
    if ($found.Count -gt 0) { $target = $found[0] }
    elseif ([DshWin32]::IsWindow([IntPtr]$Hwnd)) {
      $target = [DshWin32]::GetWinInfo([IntPtr]$Hwnd)
    } else {
      throw "window_not_found: hwnd $Hwnd"
    }
  } else {
    $cand = Get-CandidateWindows -App $App
    if ($cand.Count -eq 0) { throw "app_not_found: $App" }
    if ($Index -gt 0) {
      if ($Index -gt $cand.Count) { throw 'window_not_found: window_index exceeds the candidate count' }
      $target = $cand[($Index - 1)]
    } else {
      if ($cand.Count -gt 1) {
        $scored = @($cand | ForEach-Object {
          $area = [Math]::Max(0, ($_.Rect.Right - $_.Rect.Left)) * [Math]::Max(0, ($_.Rect.Bottom - $_.Rect.Top))
          $titleScore = if ($_.Title -and $_.Title.Trim().Length -gt 0) { 1000000000 } else { 0 }
          $visibleScore = if (-not $_.Minimized) { 1000000 } else { 0 }
          [PSCustomObject]@{ Win = $_; Score = $titleScore + $visibleScore + $area }
        } | Sort-Object Score -Descending)
        $best = $scored[0]
        $runner = if ($scored.Count -gt 1) { $scored[1] } else { $null }
        # Ambiguity rule: several same-titled windows of one app must be resolved
        # by exact hwnd/window_index (real duplicates, user intent unknown).
        # Differently-titled windows (e.g. two Edge windows of one pid) resolve
        # deterministically to the highest score instead of dead-ending every
        # action with ambiguous_window; the auto choice is reported back as
        # chosen_hwnd so callers can still re-target precisely.
        $stillTied = $false
        if ($runner -and ($best.Score - $runner.Score) -lt 1000) {
          $bestTitle = ([string]$best.Win.Title).Trim()
          $runnerTitle = ([string]$runner.Win.Title).Trim()
          if ($bestTitle -and $runnerTitle -and ($bestTitle -eq $runnerTitle)) { $stillTied = $true }
        }
        if ($stillTied) { throw 'ambiguous_window: choose an exact hwnd from list_windows or supply window_index' }
        $target = $best.Win
        if (-not $script:autoChosenHwnd) {
          $script:autoChosenHwnd = @{ hwnd = $target.Hwnd.ToInt64(); title = $target.Title; candidates = $cand.Count }
        }
      } else {
        $target = $cand[0]
      }
    }
  }

  if ($target) {
    $identityKey = [string](Get-PayloadValue 'identity_key')
    if ($identityKey) {
      $actualIdentity = Get-ProcessIdentityFast -ProcessId $target.Pid
      if ([string]$actualIdentity.identity_key -ine $identityKey) {
        throw 'target_validation_failed: hwnd/app does not match identity_key'
      }
    }
    Assert-Observation -Hwnd $target.Hwnd
  }
  # If target is iconic (minimized) and action is not read-only inspection (get_window),
  # silently unminimize with SW_SHOWNOACTIVATE so rect and UIA are valid without stealing focus
  if ($null -ne $target -and [DshWin32]::IsIconic($target.Hwnd)) {
    $currAct = Get-PayloadValue 'action'
    if ($currAct -notin @('get_window', 'list_windows', 'activate_window', 'close_window')) {
      if ((Get-Dispatch) -ne 'foreground') { throw 'background_unavailable: target minimized; background inspection never restores a window onto the user desktop' }
      [DshWin32]::ShowWindow($target.Hwnd, 4) | Out-Null
      [DshWin32]::SetWindowPos($target.Hwnd, [DshWin32]::HWND_BOTTOM, 0, 0, 0, 0, 0x0053) | Out-Null
      $target.Rect = [DshWin32]::GetDwmRect($target.Hwnd)
      $target.Minimized = $false
    }
  }

  return $target
}

function Parse-KeyChord {
  param([string]$RawKey, [string]$RawModifiers)
  if (-not $RawKey) { return @{ Key = ''; Modifiers = $RawModifiers } }
  $k = $RawKey.Trim()
  $mods = New-Object System.Collections.Generic.List[string]
  if ($RawModifiers) {
    foreach ($m in ($RawModifiers -split '[,+]')) {
      $mt = $m.Trim().ToLowerInvariant()
      if ($mt) { $mods.Add($mt) }
    }
  }

  $baseKey = $k
  if ($k.Length -gt 1 -and $k.Contains('+')) {
    $tokens = New-Object System.Collections.Generic.List[string]
    if ($k.EndsWith('++')) {
      $pfx = $k.Substring(0, $k.Length - 2)
      foreach ($p in ($pfx -split '\+')) { if ($p.Trim()) { $tokens.Add($p.Trim()) } }
      $tokens.Add('+')
    } else {
      foreach ($p in ($k -split '\+')) { if ($p.Trim()) { $tokens.Add($p.Trim()) } }
    }
    if ($tokens.Count -gt 1) {
      $baseKey = $tokens[$tokens.Count - 1]
      for ($i = 0; $i -lt $tokens.Count - 1; $i++) {
        $mods.Add($tokens[$i].ToLowerInvariant())
      }
    }
  }

  $normMods = New-Object System.Collections.Generic.List[string]
  foreach ($m in $mods) {
    $norm = switch -Regex ($m) {
      '^(ctrl|control|control_l|control_r|ctrl_l|ctrl_r)$' { 'ctrl' }
      '^(shift|shift_l|shift_r)$' { 'shift' }
      '^(alt|alt_l|alt_r|option|option_l|option_r)$' { 'alt' }
      '^(win|meta|super|cmd|command)$' { 'win' }
      default { $m }
    }
    if (-not $normMods.Contains($norm)) { $normMods.Add($norm) }
  }

  $bkLower = $baseKey.ToLowerInvariant()
  $normBase = switch ($bkLower) {
    { $_ -in 'return', 'enter' } { 'return' }
    { $_ -in 'esc', 'escape' } { 'escape' }
    { $_ -in 'space', 'spacebar' } { 'space' }
    { $_ -in 'period', 'dot' } { '.' }
    'comma' { ',' }
    'semicolon' { ';' }
    'slash' { '/' }
    'backslash' { '\' }
    { $_ -in 'minus', 'dash' } { '-' }
    { $_ -in 'control_l', 'control_r', 'ctrl_l', 'ctrl_r' } { 'ctrl' }
    { $_ -in 'alt_l', 'alt_r' } { 'alt' }
    { $_ -in 'shift_l', 'shift_r' } { 'shift' }
    default { $baseKey }
  }

  return @{
    Key = $normBase
    Modifiers = ($normMods -join ',')
  }
}

function Get-WindowInfo {
  param($Win, [bool]$IncludeIdentity = $true)
  $app = Get-ProcessNameFast -ProcessId $Win.Pid -Cache $null
  $info = @{
    id = $Win.Hwnd.ToInt64()
    app = $app
    hwnd = $Win.Hwnd.ToInt64()
    pid = $Win.Pid
    process_name = $app
    title = $Win.Title
    foreground = $Win.Foreground
    minimized = [bool]$Win.Minimized
    rect = @{ x = $Win.Rect.Left; y = $Win.Rect.Top; width = ($Win.Rect.Right - $Win.Rect.Left); height = ($Win.Rect.Bottom - $Win.Rect.Top) }
  }
  if ($IncludeIdentity) {
    $info.app_identity = Get-ProcessIdentityFast -ProcessId $Win.Pid
  }
  return $info
}

function Safe-Int {
  param($v)
  if ($null -eq $v) { return 0 }
  $d = [double]$v
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 0 }
  return [int]$d
}

function Get-StableElementId {
  param($Element)
  try {
    $cur = $Element.Current
    $runtime = [string]($Element.GetRuntimeId() -join '.')
    if ($runtime) { return ('uia:{0}:{1}' -f [string]$cur.ProcessId, $runtime) }
    return ('uiaf:{0}:{1}:{2}:{3}:{4}' -f [string]$cur.ProcessId,
      [string]$cur.NativeWindowHandle, [string]$cur.AutomationId,
      [string]$cur.ControlType.Id, [string]$cur.Name)
  } catch {
    return ''
  }
}

function Get-AccessibilitySummary {
  param($Item)
  if ($null -eq $Item) { return $null }
  return [ordered]@{
    element_id = [string]$Item.element_id
    index = [int]$Item.index
    role = [string]$Item.role
    name = [string]$Item.name
    value = [string]$Item.value
    automation_id = [string]$Item.automation_id
    enabled = [bool]$Item.enabled
    offscreen = [bool]$Item.offscreen
    invokable = [bool]$Item.invokable
    selected = [bool]$Item.selected
    native_window_handle = [int64]$Item.native_window_handle
    rect = ('{0},{1},{2},{3}' -f [int]$Item.rect.x, [int]$Item.rect.y, [int]$Item.rect.width, [int]$Item.rect.height)
  }
}

function Get-AccessibilityDelta {
  param([string]$Key, $Tree)
  $script:accessibilityRevision = [int64]$script:accessibilityRevision + 1
  $revision = [int64]$script:accessibilityRevision
  $previous = $script:accessibilityHistory[$Key]
  $current = @{}
  foreach ($item in $Tree) {
    $id = [string]$item.element_id
    if (-not $id) { continue }
    $current[$id] = Get-AccessibilitySummary $item
  }

  $added = New-Object System.Collections.Generic.List[object]
  $removed = New-Object System.Collections.Generic.List[object]
  $changed = New-Object System.Collections.Generic.List[object]
  $unchanged = 0
  $reset = ($null -eq $previous)

  if (-not $reset) {
    foreach ($id in $current.Keys) {
      $now = $current[$id]
      $before = $previous.items[$id]
      if ($null -eq $before) {
        $added.Add([ordered]@{ element_id = $id; index = $now.index; role = $now.role; name = $now.name })
        continue
      }
      $fields = New-Object System.Collections.Generic.List[string]
      foreach ($field in @('role','name','value','automation_id','enabled','offscreen','invokable','selected','native_window_handle','rect')) {
        if ([string]$now[$field] -cne [string]$before[$field]) { $fields.Add($field) }
      }
      if ($fields.Count -gt 0) {
        $changed.Add([ordered]@{ element_id = $id; index = $now.index; fields = $fields.ToArray() })
      } else {
        $unchanged++
      }
    }
    foreach ($id in $previous.items.Keys) {
      if (-not $current.ContainsKey($id)) {
        $before = $previous.items[$id]
        $removed.Add([ordered]@{ element_id = $id; role = $before.role; name = $before.name })
      }
    }
  }

  $script:accessibilityHistory[$Key] = @{
    revision = $revision
    items = $current
    updated = [DateTime]::UtcNow
  }
  if ($script:accessibilityHistory.Count -gt 32) {
    foreach ($oldKey in @($script:accessibilityHistory.Keys)) {
      if ($oldKey -cne $Key) { $script:accessibilityHistory.Remove($oldKey) }
      if ($script:accessibilityHistory.Count -le 16) { break }
    }
  }

  return [ordered]@{
    revision = $revision
    base_revision = if ($reset) { $null } else { [int64]$previous.revision }
    reset = $reset
    added = $added.ToArray()
    removed = $removed.ToArray()
    changed = $changed.ToArray()
    unchanged_count = $unchanged
  }
}

function Get-AccessibilityTree {
  param([IntPtr]$Hwnd, [int]$MaxElements = $script:MAX_ELEMENTS, $WinRect = $null)
  $script:cachedTreeHwnd = $Hwnd
  $script:cachedElements = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
  $script:cachedIdentities = New-Object System.Collections.Generic.List[string]
  if ($null -eq $WinRect -and $Hwnd -ne [IntPtr]::Zero) {
    try { $WinRect = [DshWin32]::GetRect($Hwnd) } catch { }
  }
  $aeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
  $children = $aeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $out = New-Object System.Collections.Generic.List[object]
  $count = 0
  foreach ($el in $children) {
    if ($count -ge $MaxElements) { break }
    $count++
    $script:cachedElements.Add($el)
    $script:cachedIdentities.Add((Get-ElementIdentity $el))
    $stableId = Get-StableElementId $el
    $cur = $el.Current
    $rect = $cur.BoundingRectangle
    $name = $cur.Name
    $autoId = $cur.AutomationId
    $value = ''
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      try { $value = $vp.Current.Value } catch { }
    }
    if (($name -eq '') -and ($autoId -eq '') -and ($value -eq '') -and ($rect.Width -le 0 -or $rect.Height -le 0)) { continue }
    $invoke = $false
    $ip = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $invoke = $true }
    $selected = $false
    $selectionItem = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionItem)) {
      try { $selected = [bool]$selectionItem.Current.IsSelected } catch { }
    }
    $relX = if ($null -ne $WinRect) { Safe-Int ($rect.X - $WinRect.Left) } else { Safe-Int $rect.X }
    $relY = if ($null -ne $WinRect) { Safe-Int ($rect.Y - $WinRect.Top) } else { Safe-Int $rect.Y }
    $item = [ordered]@{
      index = $count
      element_id = $stableId
      role = $cur.ControlType.ProgrammaticName
      name = if ($name) { $name } else { '' }
      value = if ($value) { $value } else { '' }
      automation_id = if ($autoId) { $autoId } else { '' }
      enabled = $cur.IsEnabled
      offscreen = $cur.IsOffscreen
      invokable = $invoke
      selected = $selected
      native_window_handle = [int64]$cur.NativeWindowHandle
      rect = @{ x = $relX; y = $relY; width = (Safe-Int $rect.Width); height = (Safe-Int $rect.Height) }
      screen_rect = @{ x = (Safe-Int $rect.X); y = (Safe-Int $rect.Y); width = (Safe-Int $rect.Width); height = (Safe-Int $rect.Height) }
    }
    $out.Add($item)
  }
  # The comma keeps the List intact: a bare `return $out` unrolls a single-item
  # list into a scalar, so a one-element window would report elements as an object
  # and element_count as its key count (.Count on a dictionary).
  return ,$out
}

function Find-ElementByIndex {
  param([IntPtr]$Hwnd, [int]$Index)
  Assert-Observation -Hwnd $Hwnd -Required
  if ($script:cachedTreeHwnd -eq $Hwnd -and $null -ne $script:cachedElements -and $Index -ge 1 -and $Index -le $script:cachedElements.Count) {
    $cached = $script:cachedElements[$Index - 1]
    try {
      $null = $cached.Current.ProcessId
      if ((Get-ElementIdentity $cached) -cne $script:cachedIdentities[$Index - 1]) {
        throw 'stale_snapshot: element identity or geometry changed; refresh get_app_state'
      }
      return $cached
    } catch { throw 'stale_snapshot: observed element is no longer valid; refresh get_app_state' }
  }
  throw "element_not_found: index $Index was not in this observation; refresh get_app_state"
}

function Get-ElementIdentity {
  param($Element)
  $c = $Element.Current
  $r = $c.BoundingRectangle
  return (@([string]($Element.GetRuntimeId() -join '.'), [string]$c.ProcessId,
    [string]$c.Name, [string]$c.AutomationId, [string]$c.ControlType.Id,
    [string]$c.IsEnabled, [string]$c.IsOffscreen,
    [string]$r.X, [string]$r.Y, [string]$r.Width, [string]$r.Height) | ConvertTo-Json -Compress)
}

function Assert-Observation {
  param([IntPtr]$Hwnd, [switch]$Required)
  $id = Get-PayloadValue 'snapshot_id'
  if (-not $id) {
    if ($Required) { throw 'snapshot_required: pass snapshot_id from the latest get_app_state' }
    return
  }
  if (-not $script:observation -or $id -cne $script:observation.id -or
      $Hwnd -ne $script:observation.hwnd -or
      ([DateTime]::UtcNow - $script:observation.created).TotalSeconds -gt 60) {
    throw 'stale_snapshot: snapshot expired, consumed, or belongs to another window; refresh get_app_state'
  }
  $r = [DshWin32]::GetDwmRect($Hwnd)
  $previous = $script:observation.rect
  if ($r.Left -ne $previous.Left -or $r.Top -ne $previous.Top -or
      $r.Right -ne $previous.Right -or $r.Bottom -ne $previous.Bottom) {
    throw 'stale_snapshot: window moved or resized; refresh get_app_state'
  }
}

function Assert-ScreenshotBinding {
  param([IntPtr]$Hwnd)
  $id = Get-PayloadValue 'screenshot_id'
  if (-not $id) { return }
  $shot = $script:lastScreenshot
  if (-not $shot -or $id -cne $shot.id -or ([DateTime]::UtcNow - $shot.created).TotalSeconds -gt 60) {
    throw 'stale_screenshot: screenshot_id expired, consumed, or was not produced by this host'
  }
  if ($Hwnd -ne [IntPtr]::Zero -and $shot.hwnd -ne [IntPtr]::Zero -and $Hwnd -ne $shot.hwnd) {
    throw 'stale_screenshot: screenshot_id belongs to another window'
  }
  if ($Hwnd -ne [IntPtr]::Zero -and $shot.hwnd -eq $Hwnd -and $shot.rect) {
    $r = [DshWin32]::GetDwmRect($Hwnd)
    if ($r.Left -ne $shot.rect.Left -or $r.Top -ne $shot.rect.Top -or $r.Right -ne $shot.rect.Right -or $r.Bottom -ne $shot.rect.Bottom) {
      throw 'stale_screenshot: target window moved or resized; refresh screenshot/state'
    }
  }
}

function Assert-ConsequenceConfirmation {
  param($Element)
  return
}

function Assert-SensitiveConfirmation {
  param($Element)
  return
}

function Get-DocumentText {
  param([IntPtr]$Hwnd, [int]$MaxLen = 3000)
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    $tp = $null
    if ($root.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      return $tp.DocumentRange.GetText($MaxLen)
    }
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
      $t2 = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$t2)) {
        return $t2.DocumentRange.GetText($MaxLen)
      }
      $v2 = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$v2)) {
        $v = $v2.Current.Value
        if ($v) { return $v }
      }
    }
  } catch { }
  return ''
}

function Get-FocusedElementText {
  param([IntPtr]$Hwnd)
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused) { return '' }
    $cur = $focused.Current
    $index = 0
    if ($null -ne $script:cachedElements) {
      $focusedId = [string]($focused.GetRuntimeId() -join '.')
      for ($i = 0; $i -lt $script:cachedElements.Count; $i++) {
        if ([string]($script:cachedElements[$i].GetRuntimeId() -join '.') -ceq $focusedId) {
          $index = $i + 1
          break
        }
      }
    }
    # A focus outside this window must not be reported as target context. A
    # provider may expose zero NativeWindowHandle, but an indexed match proves
    # it came from the tree we just captured.
    $native = [IntPtr]$cur.NativeWindowHandle
    if ($index -eq 0 -and $native -ne [IntPtr]::Zero -and $native -ne $Hwnd -and -not [DshWin32]::IsChild($Hwnd, $native)) { return '' }
    if ($index -eq 0 -and $native -eq [IntPtr]::Zero) { return '' }
    $label = "$($cur.ControlType.ProgrammaticName): $($cur.Name)"
    return if ($index -gt 0) { "[$index] $label" } else { $label }
  } catch { return '' }
}

function Get-SelectedText {
  param([IntPtr]$Hwnd, [int]$MaxLen = 3000)
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    $candidates = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    $candidates.Add($root)
    $descendants = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $descendants.Count; $i++) { $candidates.Add($descendants[$i]) }
    foreach ($element in $candidates) {
      $pattern = $null
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { continue }
      $selection = @($pattern.GetSelection())
      if ($selection.Count -gt 0) {
        $text = $selection[0].GetText($MaxLen)
        if ($text) { return $text }
      }
    }
  } catch { }
  return ''
}

# ---------------------------------------------------------------- overlay + background dispatch

function Ensure-OverlayProcess {
  # ponytail: pid-marker check; races only duplicate a harmless overlay instance
  $dir = Join-Path $env:TEMP 'dsh-cua'
  $pidFile = Join-Path $dir 'overlay.pid'
  if (Test-Path $pidFile) {
    $rawPid = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
    $pidNow = 0
    if ($rawPid -and [int]::TryParse($rawPid.Trim(), [ref]$pidNow) -and ($pidNow -gt 0)) {
      $p = Get-Process -Id $pidNow -ErrorAction SilentlyContinue
      if ($p) { return }
    }
  }
  $ov = Join-Path $PSScriptRoot 'virtual-cursor-overlay.ps1'
  if (-not (Test-Path $ov)) { return }
  Start-HiddenPowershell -ScriptPath $ov | Out-Null
}

# start a headless powershell child; CreateNoWindow avoids the brief conhost
# flash that Start-Process -WindowStyle Hidden can show on some machines
function Start-HiddenPowershell {
  param([string]$ScriptPath)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return [System.Diagnostics.Process]::Start($psi)
}

function Write-CursorState {
  param([int]$X, [int]$Y, [string]$Label, [bool]$Show)
  if (-not $Show) { $Label = 'hidden' }
  $dir = Join-Path $env:TEMP 'dsh-cua'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $state = @{ x = $X; y = $Y; label = $Label; ts = $ts; show = $Show } | ConvertTo-Json -Compress
  $statePath = Join-Path $dir 'cursor.state'
  for ($i = 0; $i -lt 8; $i++) {
    try {
      [System.IO.File]::WriteAllText($statePath, $state, [System.Text.Encoding]::ASCII)
      break
    } catch {
      Start-Sleep -Milliseconds 15
    }
  }
}

function Ensure-StatusbarProcess {
  # ponytail: pid-marker check; races only duplicate a harmless status pill
  $dir = Join-Path $env:TEMP 'dsh-cua'
  $pidFile = Join-Path $dir 'statusbar.pid'
  if (Test-Path $pidFile) {
    $rawPid = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
    $pidNow = 0
    if ($rawPid -and [int]::TryParse($rawPid.Trim(), [ref]$pidNow) -and ($pidNow -gt 0)) {
      $p = Get-Process -Id $pidNow -ErrorAction SilentlyContinue
      if ($p) { return }
    }
  }
  $sb = Join-Path $PSScriptRoot 'pcpilot-statusbar.ps1'
  if (-not (Test-Path $sb)) { return }
  Start-HiddenPowershell -ScriptPath $sb | Out-Null
}

function Write-StatusState {
  # top-center frosted status pill: "PC-Pilot 运行中" + breathing green dot.
  # The pill polls this file: fresh (<=4s) + show -> visible; stale -> hidden.
  param([bool]$Show)
  $dir = Join-Path $env:TEMP 'dsh-cua'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $state = @{ ts = $ts; show = $Show } | ConvertTo-Json -Compress
  $statePath = Join-Path $dir 'status.state'
  for ($i = 0; $i -lt 8; $i++) {
    try {
      [System.IO.File]::WriteAllText($statePath, $state, [System.Text.Encoding]::ASCII)
      break
    } catch {
      Start-Sleep -Milliseconds 15
    }
  }
}

function Notify-Cursor {
  param([int]$X, [int]$Y, [string]$Label)
  $on = Get-OverlayEnabled
  if ($on) { Ensure-OverlayProcess; Ensure-StatusbarProcess }
  Write-CursorState -X $X -Y $Y -Label $Label -Show $on
  Write-StatusState -Show $on
}
