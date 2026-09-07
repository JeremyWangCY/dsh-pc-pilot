import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const overlayPath = path.join(rootDir, 'lib', 'virtual-cursor-overlay.ps1')
assert.ok(fs.existsSync(overlayPath), 'virtual-cursor-overlay.ps1 must exist')

const overlayContent = fs.readFileSync(overlayPath, 'utf8')

// 1. Static assertions on virtual-cursor-overlay.ps1
assert.ok(
  overlayContent.includes('SetProcessDpiAwarenessContext((IntPtr)(-4))'),
  'overlay should configure Per-Monitor V2 DPI awareness'
)
assert.ok(
  overlayContent.includes('SetProcessDPIAware()'),
  'overlay should have fallback to SetProcessDPIAware'
)
assert.ok(
  overlayContent.includes('[DshDpi]::InitDpiAwareness()'),
  'overlay should invoke InitDpiAwareness at startup'
)
assert.ok(
  overlayContent.includes('[System.Windows.Forms.Application]::DoEvents()'),
  'overlay message loop must call DoEvents'
)

const b64Match = overlayContent.match(/\$b64\s*=\s*"([^"]+)"/)
assert.ok(b64Match, 'overlay should contain base64 embedded C#')
const overlayCs = Buffer.from(b64Match[1], 'base64').toString('utf8')

assert.ok(
  overlayCs.includes('SmoothingMode.AntiAlias'),
  'C# rendering code must use SmoothingMode.AntiAlias'
)
assert.ok(
  overlayCs.includes('PixelOffsetMode.HighQuality'),
  'C# rendering code must use PixelOffsetMode.HighQuality'
)
assert.ok(
  overlayCs.includes('PixelFormat.Format32bppPArgb'),
  'C# rendering code must render onto 32bpp Premultiplied ARGB surface'
)
assert.match(
  overlayCs,
  /bf\.BlendOp\s*=\s*0x00;/,
  'BLENDFUNCTION BlendOp must be 0x00 (AC_SRC_OVER)'
)
assert.match(
  overlayCs,
  /bf\.AlphaFormat\s*=\s*1;/,
  'BLENDFUNCTION AlphaFormat must be 1 (AC_SRC_ALPHA)'
)
assert.match(
  overlayCs,
  /private\s+static\s+WndProc\s+_wndProc;/,
  'DshVcLayer must declare rooted private static WndProc _wndProc'
)
assert.match(
  overlayCs,
  /_wndProc\s*=\s*DefWindowProcW;.*?Marshal\.GetFunctionPointerForDelegate\(_wndProc\)/s,
  'DshVcLayer must assign _wndProc and pass to Marshal.GetFunctionPointerForDelegate'
)
assert.ok(
  overlayCs.includes('public static void Cleanup()'),
  'DshVcLayer must include resource cleanup method'
)

// 2. Functional rendering test via PowerShell
const sampleDir = path.join(os.tmpdir(), 'dsh-cua')
if (!fs.existsSync(sampleDir)) {
  fs.mkdirSync(sampleDir, { recursive: true })
}
const samplePng = path.join(sampleDir, 'rendered-cursor.png')

const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Extract and compile C# from virtual-cursor-overlay.ps1
$overlaySrc = Get-Content -Path '${overlayPath.replace(/'/g, "''")}' -Raw
if ($overlaySrc -match '\\$b64\\s*=\\s*"([^"]+)"') {
  $csCode = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($matches[1]))
} else {
  Write-Error "No b64 found"
  exit 1
}

$tempCs = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'dsh-test-vc-' + [System.Guid]::NewGuid().ToString('N') + '.cs')
[System.IO.File]::WriteAllText($tempCs, $csCode, [System.Text.Encoding]::UTF8)

try {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    Add-Type -Path $tempCs -ReferencedAssemblies "System.Drawing.Common", "System.Drawing.Primitives"
  } else {
    Add-Type -Path $tempCs -ReferencedAssemblies "System.Drawing"
  }
} finally {
  Remove-Item $tempCs -Force -ErrorAction SilentlyContinue
}

# Render cursor bitmap
$bmp = [DshVcLayer]::RenderBitmap()

# Save sample image
$outPng = '${samplePng.replace(/\\/g, '/').replace(/'/g, "''")}'
[DshVcLayer]::SaveSampleImage($outPng)

# Pixel analysis
$bodyPoints = @(
  @{x = 38; y = 42},
  @{x = 38; y = 45},
  @{x = 39; y = 45},
  @{x = 40; y = 45},
  @{x = 41; y = 45},
  @{x = 40; y = 48}
)
$bodyPixels = @()
foreach ($pt in $bodyPoints) {
  $c = $bmp.GetPixel($pt.x, $pt.y)
  $bodyPixels += @{ x = $pt.x; y = $pt.y; r = $c.R; g = $c.G; b = $c.B; a = $c.A }
}

# Scanline across left edge at Y = 45 from X = 30 to X = 42
$xGlow = -1
$xWhite = -1
for ($x = 30; $x -le 42; $x++) {
  $c = $bmp.GetPixel($x, 45)
  if ($c.R -lt 50 -and $c.B -gt 100) { $xGlow = $x }
  if ($c.R -gt 245 -and $c.G -gt 245 -and $c.B -gt 245 -and $xWhite -eq -1) { $xWhite = $x }
}
$transitionWidth = $xWhite - $xGlow

# Glow sample at (24, 38)
$glowC = $bmp.GetPixel(24, 38)
$glowPixel = @{ r = $glowC.R; g = $glowC.G; b = $glowC.B; a = $glowC.A }

# Border sample at (35, 45)
$borderC = $bmp.GetPixel(35, 45)
$borderPixel = @{ r = $borderC.R; g = $borderC.G; b = $borderC.B; a = $borderC.A }

$report = @{
  width = $bmp.Width
  height = $bmp.Height
  pixelFormat = $bmp.PixelFormat.ToString()
  bodyPixels = $bodyPixels
  transitionWidth = $transitionWidth
  xGlow = $xGlow
  xWhite = $xWhite
  glowPixel = $glowPixel
  borderPixel = $borderPixel
}

$bmp.Dispose()
$report | ConvertTo-Json -Compress
`

const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const psExe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const rawOutput = execFileSync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
  encoding: 'utf8',
  timeout: 15000,
}).trim()

const result = JSON.parse(rawOutput)

// Asserts that virtual-cursor-overlay.ps1 compiles and renders a valid 32bpp bitmap
assert.equal(result.width, 96, 'Bitmap width must be 96')
assert.equal(result.height, 96, 'Bitmap height must be 96')
assert.equal(result.pixelFormat, 'Format32bppPArgb', 'Bitmap must be 32bpp Premultiplied ARGB')

// Asserts that the cursor body has crisp white pixels (R>245, G>245, B>245, A>240)
assert.ok(result.bodyPixels.length >= 5, 'Must have at least 5 body sample points')
for (const p of result.bodyPixels) {
  assert.ok(
    p.r > 245 && p.g > 245 && p.b > 245 && p.a > 240,
    `Cursor body pixel at (${p.x}, ${p.y}) must be crisp white (R>245, G>245, B>245, A>240): got R=${p.r}, G=${p.g}, B=${p.b}, A=${p.a}`
  )
}

// Asserts that the edge transition is sharp (< 2 pixels width)
assert.ok(
  result.transitionWidth < 2,
  `Edge transition width must be sharp (< 2 pixels width): got ${result.transitionWidth} (xGlow=${result.xGlow}, xWhite=${result.xWhite})`
)

// Asserts radial blue glow is present around the tip
assert.ok(
  result.glowPixel.b > 80 && result.glowPixel.r < 50 && result.glowPixel.a > 10,
  `Glow pixel at (24, 38) should be soft blue: got R=${result.glowPixel.r}, G=${result.glowPixel.g}, B=${result.glowPixel.b}, A=${result.glowPixel.a}`
)

// Asserts sample PNG is generated and exists on disk
assert.ok(fs.existsSync(samplePng), `Sample PNG must exist at ${samplePng}`)
const stats = fs.statSync(samplePng)
assert.ok(stats.size > 500, `Sample PNG should have valid size, got ${stats.size} bytes`)

console.log('cursor-render check PASSED')
