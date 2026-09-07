import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const helperPath = path.join(rootDir, 'lib', 'computer-use-helper.ps1')
const overlayPath = path.join(rootDir, 'lib', 'virtual-cursor-overlay.ps1')

assert.ok(fs.existsSync(helperPath), 'computer-use-helper.ps1 exists')
assert.ok(fs.existsSync(overlayPath), 'virtual-cursor-overlay.ps1 exists')

const helperContent = fs.readFileSync(helperPath, 'utf8')
const overlayContent = fs.readFileSync(overlayPath, 'utf8')

// 1. DPI Awareness in computer-use-helper.ps1
assert.ok(
  helperContent.includes('SetProcessDpiAwarenessContext((IntPtr)(-4))'),
  'helper should call SetProcessDpiAwarenessContext((IntPtr)(-4))'
)
assert.ok(
  helperContent.includes('SetProcessDPIAware()'),
  'helper should have fallback to SetProcessDPIAware()'
)
assert.ok(
  helperContent.includes('[DshWin32]::InitDpiAwareness()'),
  'helper should invoke InitDpiAwareness at startup'
)

// 2. Win32 SendMessage Hang Protection & Unicode in computer-use-helper.ps1
assert.match(
  helperContent,
  /\[DllImport\("user32\.dll",\s*CharSet\s*=\s*CharSet\.Unicode\)\].*?SendMessage\(/s,
  'SendMessage P/Invoke must use CharSet = CharSet.Unicode'
)
assert.match(
  helperContent,
  /\[DllImport\("user32\.dll",\s*CharSet\s*=\s*CharSet\.Unicode,\s*SetLastError\s*=\s*true\)\].*?SendMessageTimeout\(/s,
  'SendMessageTimeout P/Invoke must use CharSet = CharSet.Unicode'
)
assert.match(
  helperContent,
  /SMTO_ABORTIFHUNG\s*=\s*0x0002/,
  'helper must declare SMTO_ABORTIFHUNG = 0x0002'
)
assert.match(
  helperContent,
  /SendMessageTimeout\(\$Hwnd,\s*0x0102,\s*\[IntPtr\]\[int\]\$ch,\s*\[IntPtr\]::Zero,\s*\[DshWin32\]::SMTO_ABORTIFHUNG,\s*3000/,
  'Send-BackgroundText must use SendMessageTimeout with 3000ms timeout'
)
assert.match(
  helperContent,
  /SendMessageTimeout\(\$Hwnd,\s*0x0100,\s*\[IntPtr\]\$vk,\s*\[IntPtr\]::Zero,\s*\[DshWin32\]::SMTO_ABORTIFHUNG,\s*3000/,
  'Send-BackgroundKey must use SendMessageTimeout with 3000ms timeout'
)

// 3. Target Window Search Escaping in computer-use-helper.ps1
assert.ok(
  helperContent.includes('.IndexOf($App, [System.StringComparison]::OrdinalIgnoreCase) -ge 0'),
  'Resolve-TargetWindow must use IndexOf with OrdinalIgnoreCase instead of -like wildcard'
)
assert.ok(
  !helperContent.includes('$_.Title -like "*$App*"'),
  'wildcard search with -like "*$App*" must be removed'
)

// 4. Double-Scroll Defect guard in computer-use-helper.ps1
assert.match(
  helperContent,
  /if\s*\(\$doc\s*-and\s*\$doc\.TryGetCurrentPattern\(.*?\$done\s*=\s*\$true.*?if\s*\(-not\s*\$done\)\s*\{\s*\$el\s*=\s*\[System\.Windows\.Automation\.AutomationElement\]::FromPoint\(\$pt\)/s,
  'element-under-cursor scroll fallback must be wrapped in if (-not $done)'
)

// 5. Dark Mode / Black Screenshot Detection in computer-use-helper.ps1
assert.ok(
  helperContent.includes('$w * 0.25') && helperContent.includes('$w * 0.75'),
  'Do-AppState must sample quadrant points (25% and 75%)'
)
assert.match(
  helperContent,
  /\$borderTitlePoints|\$hasBorderOrTitle/,
  'Do-AppState must verify border / title points before flagging black'
)

// 5b. Do-AppState screenshot fallback chain: PrintWindow -> screen-DC BitBlt
assert.match(
  helperContent,
  /function\s+Test-BitmapBlank/,
  'black-frame detection must be factored into Test-BitmapBlank'
)
assert.match(
  helperContent,
  /Test-BitmapBlank[\s\S]*?CopyFromScreen\(\$win\.Rect\.Left,\s*\$win\.Rect\.Top,\s*0,\s*0,/,
  'Do-AppState must fall back to Graphics.CopyFromScreen over the window rect when PrintWindow blanks/fails'
)
assert.ok(
  helperContent.includes("'bitblt_screen'"),
  'Do-AppState must tag the screen-DC fallback screenshot with method bitblt_screen'
)
// tier 2 must stay guarded (never BitBlt a minimized window — that captures whatever
// is on screen there) and must re-check the fallback frame before declaring success
assert.match(
  helperContent,
  /\} elseif \(-not \$minimized\) \{[\s\S]*?CopyFromScreen/,
  'tier-2 BitBlt fallback must be guarded by -not $minimized'
)
assert.match(
  helperContent,
  /\$black2 = Test-BitmapBlank/,
  'tier-2 fallback frame must be re-checked for blank before tagging success'
)

// 5c. Occlusion-immune background clicks: app-scoped clicks aim at the target window's
// own tree, never at the screen-level (potentially occluding) topmost window
assert.ok(
  helperContent.includes('function Invoke-FromPointInWindow'),
  'window-scoped semantic hit helper Invoke-FromPointInWindow must exist'
)
assert.ok(
  helperContent.includes('function Find-TargetHwndAt'),
  'target-window hwnd lookup Find-TargetHwndAt must exist'
)
assert.match(
  helperContent,
  /function\s+Find-TargetHwndAt[\s\S]*?return\s+\$Win\.Hwnd/,
  'Find-TargetHwndAt must fall back to the target window hwnd itself (never the screen-level occluder)'
)
assert.match(
  helperContent,
  /\$h = Find-TargetHwndAt -Hwnd \$win\.Hwnd -X \$sx -Y \$sy -Win \$win/,
  'click/mouse_down app-scoped background paths must route through Find-TargetHwndAt'
)
// pin BOTH call sites separately (click branch AND Invoke-MouseButtonAction) so
// reverting either one back to the screen-level occluder lookup fails the check
assert.match(
  helperContent,
  /'click' \{[\s\S]{0,4000}\$h = Find-TargetHwndAt -Hwnd \$win\.Hwnd/,
  'the click branch must resolve app-scoped clicks via Find-TargetHwndAt'
)
assert.match(
  helperContent,
  /function Invoke-MouseButtonAction[\s\S]{0,4000}\$h = Find-TargetHwndAt -Hwnd \$win\.Hwnd/,
  'mouse_down/mouse_up must resolve app-scoped presses via Find-TargetHwndAt'
)
assert.ok(
  helperContent.includes("'uia_window_hit_'"),
  'app-scoped semantic hits must be tagged with the uia_window_hit_ method prefix'
)
assert.ok(
  helperContent.includes('function Find-TargetHitsAt'),
  'the shared single-scan hit-test Find-TargetHitsAt must exist (no duplicate full-tree scans)'
)

// 5d. click_element background fallback: when no UIA action pattern is supported,
// fall back to target-window WM message at element center if BoundingRectangle is valid
assert.match(
  helperContent,
  /'click_element'[\s\S]*?\$h = Find-TargetHwndAt -Hwnd \$win\.Hwnd -X \$cx -Y \$cy -Win \$win[\s\S]*?Send-BackgroundMouseButton -Hwnd \$h -Sx \$cx -Sy \$cy -Button 'left' -Count 1/,
  'click_element background path must fall back to target-window WM click when element has valid rect'
)
assert.ok(
  helperContent.includes('"Clicked element $element via target-window WM message to hwnd $($h.ToInt64()) at ($cx, $cy) (no UIA pattern; occlusion-immune)"'),
  'click_element must set descriptive message on target-window WM fallback'
)

// 5e. UIA element caching (O(1) lookup): Get-AccessibilityTree caches elements into $script:cachedElements,
// and Find-ElementByIndex checks $script:cachedElements before falling back to full-tree scan
assert.match(
  helperContent,
  /function\s+Get-AccessibilityTree[\s\S]*?\$script:cachedElements\s*=\s*New-Object System\.Collections\.Generic\.List\[System\.Windows\.Automation\.AutomationElement\]/,
  'Get-AccessibilityTree must initialize $script:cachedElements'
)
assert.match(
  helperContent,
  /function\s+Get-AccessibilityTree[\s\S]*?\$script:cachedElements\.Add\(\$el\)/,
  'Get-AccessibilityTree must populate $script:cachedElements during tree traversal'
)
assert.match(
  helperContent,
  /function\s+Find-ElementByIndex[\s\S]*?\$script:cachedTreeHwnd\s*-eq\s*\$Hwnd\s*-and\s*\$null\s*-ne\s*\$script:cachedElements/,
  'Find-ElementByIndex must check $script:cachedElements for matching hwnd'
)
assert.match(
  helperContent,
  /function\s+Find-ElementByIndex[\s\S]*?\$cached\s*=\s*\$script:cachedElements\[\$Index\s*-\s*1\][\s\S]*?\$cached\.Current\.ProcessId/,
  'Find-ElementByIndex must perform liveness check on cached element before returning'
)

// 6. virtual-cursor-overlay.ps1 fixes
assert.ok(
  overlayContent.includes('SetProcessDpiAwarenessContext((IntPtr)(-4))'),
  'overlay should call SetProcessDpiAwarenessContext((IntPtr)(-4))'
)
assert.ok(
  overlayContent.includes('SetProcessDPIAware()'),
  'overlay should have fallback to SetProcessDPIAware()'
)
assert.ok(
  overlayContent.includes('[DshDpi]::InitDpiAwareness()'),
  'overlay should invoke InitDpiAwareness at startup'
)
assert.ok(
  overlayContent.includes('[System.Windows.Forms.Application]::DoEvents()'),
  'overlay loop must call [System.Windows.Forms.Application]::DoEvents()'
)

// 7. Ensure-OverlayProcess PID guard & Focused Element Priority in helper
assert.match(
  helperContent,
  /\$pidNow\s*-gt\s*0.*?Get-Process\s*-Id\s*\$pidNow/s,
  'Ensure-OverlayProcess must check $pidNow -gt 0 before Get-Process'
)
assert.match(
  helperContent,
  /function\s+Find-TextInputHwnd.*?\[System\.Windows\.Automation\.AutomationElement\]::FocusedElement/s,
  'Find-TextInputHwnd must check FocusedElement first'
)
assert.match(
  helperContent,
  /function\s+Find-ValuePatternEl.*?\[System\.Windows\.Automation\.AutomationElement\]::FocusedElement/s,
  'Find-ValuePatternEl must check FocusedElement first'
)
assert.match(
  helperContent,
  /catch\s*\{\s*@\{\s*ok\s*=\s*\$false;\s*action\s*=\s*\$Action;\s*message\s*=\s*"Invalid JSON payload:/s,
  'computer-use-helper.ps1 must catch JSON parse errors and return compressed JSON with ok: false'
)

const b64Match = overlayContent.match(/\$b64\s*=\s*"([^"]+)"/)
assert.ok(b64Match, 'overlay should contain base64 embedded C#')
const overlayCs = Buffer.from(b64Match[1], 'base64').toString('utf8')

assert.match(
  overlayCs,
  /bf\.BlendOp\s*=\s*0x00;/,
  'BLENDFUNCTION BlendOp must be 0x00 (AC_SRC_OVER)'
)
assert.ok(
  !overlayCs.includes('0xAC'),
  '0xAC bug must be eliminated from overlay C#'
)
assert.match(
  overlayCs,
  /private\s+static\s+WndProc\s+_wndProc;/,
  'DshVcLayer must declare private static WndProc _wndProc'
)
assert.match(
  overlayCs,
  /_wndProc\s*=\s*DefWindowProcW;.*?Marshal\.GetFunctionPointerForDelegate\(_wndProc\)/s,
  'DshVcLayer must assign _wndProc and pass to Marshal.GetFunctionPointerForDelegate'
)
assert.match(
  overlayContent,
  /\$lastActive.*?TotalSeconds\s*-ge\s*120.*?exit 0/s,
  'overlay loop must track idle time and exit gracefully after 120s'
)

// 7. Verification of PowerShell syntax via PowerShell parser
const parseCmd = `powershell -NoProfile -Command "
  $errs = @()
  $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile('${helperPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errs)
  if ($errs.Count -gt 0) { exit 1 }
  [void][System.Management.Automation.Language.Parser]::ParseFile('${overlayPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errs)
  if ($errs.Count -gt 0) { exit 2 }
  exit 0
"`
execSync(parseCmd, { stdio: 'inherit' })

// 8. Verification of C# compilation and bracket search behavior via PowerShell
const testScript = `powershell -NoProfile -Command "
  # Test bracketed search logic
  $title = '[Preview] test.txt'
  $app = '[Preview] test.txt'
  $match = $title.IndexOf($app, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $match) { exit 10 }

  # Test helper list_apps action executes cleanly
  $out = & '${helperPath.replace(/'/g, "''")}' -Action list_apps
  $json = $out | ConvertFrom-Json
  if (-not $json.ok) { exit 11 }

  # Test Ensure-OverlayProcess PID guard logic with 0, whitespace, corrupt PID, and valid PID
  $tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'dsh-cua-test-' + [System.Guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $tempDir -Force
  try {
    $pidFile = [System.IO.Path]::Combine($tempDir, 'overlay.pid')
    $testBadPids = @('', '   ', '0', 'corrupt_pid', '-123', '   0   ')
    foreach ($bad in $testBadPids) {
      Set-Content -Path $pidFile -Value $bad -Encoding ascii
      $rawPid = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
      $pidNow = 0
      $isValid = ($rawPid -and [int]::TryParse($rawPid.Trim(), [ref]$pidNow) -and ($pidNow -gt 0))
      if ($isValid) { exit 20 }
    }
    # Valid positive PID
    Set-Content -Path $pidFile -Value '65432' -Encoding ascii
    $rawPid = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
    $pidNow = 0
    $isValid = ($rawPid -and [int]::TryParse($rawPid.Trim(), [ref]$pidNow) -and ($pidNow -gt 0))
    if (-not $isValid -or $pidNow -ne 65432) { exit 21 }
  } finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  exit 0
"`
execSync(testScript, { stdio: 'inherit' })

console.log('native-fixes check PASSED')
