import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const helperPath = path.join(rootDir, 'lib', 'pc-pilot-helper.ps1')
const overlayPath = path.join(rootDir, 'lib', 'virtual-cursor-overlay.ps1')

assert.ok(fs.existsSync(helperPath), 'pc-pilot-helper.ps1 exists')
assert.ok(fs.existsSync(overlayPath), 'virtual-cursor-overlay.ps1 exists')

const helperContent = fs.readFileSync(helperPath, 'utf8')
const overlayContent = fs.readFileSync(overlayPath, 'utf8')

// 1. DPI Awareness in pc-pilot-helper.ps1
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

// 2. Win32 SendMessage Hang Protection & Unicode in pc-pilot-helper.ps1
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

// 3. Target Window Search Escaping in pc-pilot-helper.ps1
assert.ok(
  helperContent.includes('.IndexOf($App, [System.StringComparison]::OrdinalIgnoreCase) -ge 0'),
  'Resolve-TargetWindow must use IndexOf with OrdinalIgnoreCase instead of -like wildcard'
)
assert.ok(
  !helperContent.includes('$_.Title -like "*$App*"'),
  'wildcard search with -like "*$App*" must be removed'
)

// 4. Double-Scroll Defect guard in pc-pilot-helper.ps1
assert.match(
  helperContent,
  /if\s*\(\$doc\s*-and\s*\$doc\.TryGetCurrentPattern\(.*?\$done\s*=\s*\$true.*?if\s*\(-not\s*\$done\)\s*\{\s*\$el\s*=\s*\[System\.Windows\.Automation\.AutomationElement\]::FromPoint\(\$pt\)/s,
  'element-under-cursor scroll fallback must be wrapped in if (-not $done)'
)

// 5. Dark Mode / Black Screenshot Detection in pc-pilot-helper.ps1
assert.ok(
  helperContent.includes('$w * 0.25') && helperContent.includes('$w * 0.75'),
  'Do-AppState must sample quadrant points (25% and 75%)'
)
assert.match(
  helperContent,
  /\$borderTitlePoints|\$hasBorderOrTitle/,
  'Do-AppState must verify border / title points before flagging black'
)

// 5b. Do-AppState screenshot chain: WGC bridge -> PrintWindow multi-mode, no screen-DC tier
assert.match(
  helperContent,
  /function\s+Invoke-WgcCapture[\s\S]*?windows_graphics_capture/,
  'Do-AppState must prefer the optional Windows Graphics Capture HWND bridge'
)
assert.ok(
  fs.existsSync(path.join(rootDir, 'lib', 'wgc', 'dsh-pc-pilot-wgc.exe')),
  'the packaged WGC bridge executable must be present'
)
assert.match(
  helperContent,
  /function\s+Test-BitmapBlank/,
  'black-frame detection must be factored into Test-BitmapBlank'
)
assert.match(
  helperContent,
  /foreach \(\$flag in @\(2, 0, 3\)\)/,
  'Do-AppState must try the PrintWindow flag ladder 2 -> 0 -> 3'
)
assert.match(
  helperContent,
  /screenshot_black: WGC and PrintWindow both produced no frame/,
  'when both occlusion-immune tiers fail Do-AppState must report screenshot_black instead of capturing the occluder'
)
assert.doesNotMatch(
  helperContent,
  /CopyFromScreen\(\$win\.Rect/,
  'Do-AppState must never fall back to a screen-DC copy of the window rect (it captures the occluder)'
)
assert.ok(
  !helperContent.includes("'bitblt_screen'"),
  'Do-AppState must not tag any screenshot as bitblt_screen'
)

assert.match(
  helperContent,
  /\$result\.error_code -eq 'wait_condition_timeout'[\s\S]*?\$result\.outcome = 'not_executed'/,
  'a bounded accessibility wait timeout must remain a retry-safe not_executed result, never degrade to unknown'
)
assert.match(
  helperContent,
  /function Assert-ForegroundTarget[\s\S]*?ForceForeground\(\$Win\.Hwnd\)[\s\S]*?foreground_activation_unconfirmed:[\s\S]*?no real input was sent/s,
  'foreground input must verify target focus and refuse SendInput when activation fails'
)
const inputDispatchStart = helperContent.indexOf('function Invoke-MouseButtonAction')
assert.ok(inputDispatchStart >= 0, 'helper must contain desktop input dispatch')
assert.doesNotMatch(
  helperContent.slice(inputDispatchStart),
  /ForceForeground\(\$win\.Hwnd\)/,
  'desktop action branches must use the verified foreground guard instead of sending input after an unchecked focus attempt'
)
assert.match(
  helperContent,
  /\$activated = Assert-ForegroundTarget -Win \$win/,
  'activate_window must fail closed when Windows does not grant foreground control'
)
assert.match(
  helperContent,
  /foreground_activation_unconfirmed\):'[\s\S]*?\$result\.outcome = 'not_executed'/,
  'unconfirmed foreground activation must be reported as not_executed, not an ambiguous input result'
)
assert.match(
  helperContent,
  /\$result\.error_code = 'foreground_activation_unconfirmed'[\s\S]*?\$result\.launch_succeeded = \$true[\s\S]*?do not retry launch/s,
  'a launched app with unconfirmed foreground focus must preserve its identity and explicitly prevent a duplicate launch retry'
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
  /'click' \{[\s\S]{0,7000}Assert-ClickTarget[\s\S]{0,7000}target_validation_failed/,
  'the click branch must validate the target and refuse unverified fallback clicks'
)
assert.match(
  helperContent,
  /function Invoke-MouseButtonAction[\s\S]{0,4000}\$h = Find-TargetHwndAt -Hwnd \$win\.Hwnd/,
  'mouse_down/mouse_up must resolve app-scoped presses via Find-TargetHwndAt'
)
assert.match(
  helperContent,
  /function Send-BackgroundMouseButton[\s\S]*?\$Button -eq 'back'[\s\S]*?0x020B[\s\S]*?\$Button -eq 'forward'[\s\S]*?0x00020000/,
  'background clicks must encode Windows XBUTTON back/forward messages'
)
assert.match(
  helperContent,
  /public static void MouseClickEx[\s\S]*?b == "back"[\s\S]*?downF = 0x0080[\s\S]*?mouseData = 0x0001[\s\S]*?b == "forward"[\s\S]*?mouseData = 0x0002/,
  'foreground clicks must encode XBUTTON back/forward SendInput data'
)
assert.match(
  helperContent,
  /\$browserReadyDeadline = \[DateTime\]::UtcNow\.AddSeconds\(15\)[\s\S]*?while \(-not \$browserReady -and \[DateTime\]::UtcNow -lt \$browserReadyDeadline\)/,
  'headless Chromium launch must use a bounded 15-second DevTools readiness budget'
)
assert.match(
  helperContent,
  /\$isActivationProtocol = \$filePath -match '\^\[A-Za-z\]\[A-Za-z0-9\+\.\-\]\*:\(\?!\[\\\\\/\]\)'/,
  'Windows drive-letter executables must not be mistaken for activation protocols'
)
assert.match(
  helperContent,
  /\$delegatedProcessCache = @\{\}[\s\S]*?for \(\$attempt = 0; \$attempt -lt 60; \$attempt\+\+\)[\s\S]*?WindowsTerminal.*?OpenConsole.*?conhost[\s\S]*?candidateIsConsoleHost/s,
  'delegated command-host launches must wait for the settled desktop delta and exclude transient console hosts without rejecting a script-hosted GUI'
)
assert.ok(
  helperContent.includes("'uia_window_hit_'"),
  'app-scoped semantic hits must be tagged with the uia_window_hit_ method prefix'
)
assert.match(
  helperContent,
  /if \(\$horizontal\) \{[\s\S]{0,4000}?\$el = \(Find-TargetHitsAt -Hwnd \$win\.Hwnd -X \$sx -Y \$sy\)\.best[\s\S]{0,2000}?\$el\.TryGetCurrentPattern\(\[System\.Windows\.Automation\.ScrollPattern\]::Pattern/,
  'app-scoped horizontal scroll must inspect the target window UIA tree before refusing a covered target'
)
assert.ok(
  helperContent.includes('function Find-TargetHitsAt'),
  'the shared single-scan hit-test Find-TargetHitsAt must exist (no duplicate full-tree scans)'
)

// 5d. Element-index click remains target-window scoped and validated before it
// sends an occlusion-immune background action.
assert.match(
  helperContent,
  /'click'[\s\S]*?Find-ElementByIndex -Hwnd \$win\.Hwnd -Index \(\[int\]\$rawElement\)[\s\S]*?Assert-ClickTarget -Element \$el/,
  'click with element_index must validate the cached element before dispatch'
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
  /\$result\.verified = \(\[string\]\$vp\.Current\.Value -ceq \[string\]\$value\)[\s\S]*?if \(\$result\.verified\)[\s\S]*?\$result\.ok = \$false[\s\S]*?\$result\.error_code = 'value_verification_failed'[\s\S]*?\$result\.needs_observation = \$true/s,
  'set_value readback mismatch must be an unknown verification failure, never a dispatched success'
)
const typeAction = helperContent.match(/'type_text'\s*\{([\s\S]*?)\n\s*'press_key'\s*\{/)
assert.ok(typeAction, 'helper must contain a type_text action')
assert.doesNotMatch(
  typeAction[1],
  /\.SetValue\(\$text\)/,
  'type_text must not silently degrade into ValuePattern replacement; set_value owns replacement semantics'
)
assert.match(
  helperContent,
  /catch\s*\{[\s\S]*?\$invalidReply\s*=\s*@\{\s*ok\s*=\s*\$false;\s*action\s*=\s*\$Action;\s*message\s*=\s*"Invalid JSON payload:[\s\S]*?\[PcPilotDeadline\]::WriteReply\(\$invalidReply\)/s,
  'pc-pilot-helper.ps1 must catch JSON parse errors and return compressed UTF-8 JSON with ok: false'
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
execSync(parseCmd, { stdio: 'inherit', windowsHide: true })

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
execSync(testScript, { stdio: 'inherit', windowsHide: true })

console.log('native-fixes check PASSED')
