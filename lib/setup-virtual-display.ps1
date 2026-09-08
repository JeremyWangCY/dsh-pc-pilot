# setup-virtual-display.ps1 - Foolproof one-command setup for the dsh-pc-pilot virtual display canvas.
# Idempotent: safe to re-run at any time; each stage skips itself when already satisfied.
# Machine-readable result: the LAST stdout line is JSON prefixed with 'DSHSETUP '.
param(
  [string]$Action = 'auto',  # auto | status | install | activate
  [switch]$Banner            # print the human-facing banner + closing hints (bin/setup.mjs sets this)
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

# ---- pinned driver source (official VirtualDrivers release, SignPath-signed Inno installer)
$DRIVER_URL  = 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.5.2/Virtual.Display.Driver-v25.05.03-setup-x64.exe'
$DRIVER_SHA256 = 'ca10b85babecfb636c85b3f04d2306968d4f940dd3dd35767f866207bfba846e'
$DRIVER_FILE = Join-Path $env:TEMP 'dsh-vdd-setup.exe'

$script:result = [ordered]@{
  ok = $true
  action = $Action
  admin = $false
  canvas = $null            # "x,y,w,h" when a virtual display is active
  driver_installed = $false
  installed_now = $false
  activated_now = $false
  needs_manual = $false
  steps = @()
  message = ''
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DshSetupDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion; public ushort dmDriverVersion;
    public ushort dmSize; public ushort dmDriverExtra;
    public uint dmFields;
    public int dmPositionX; public int dmPositionY;
    public uint dmDisplayOrientation; public uint dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels; public uint dmBitsPerPel; public uint dmPelsWidth; public uint dmPelsHeight;
    public uint dmDisplayFlags; public uint dmDisplayFrequency;
    public uint dmICMMethod; public uint dmICMIntent; public uint dmMediaType; public uint dmDitherType;
    public uint dmReserved1; public uint dmReserved2; public uint dmPanningWidth; public uint dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplayDevices(string dev, uint num, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, uint mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);

  // Monitor attach state + rect of the Virtual Display Driver, all logic inside C#
  // (PowerShell struct-byref marshaling of DISPLAY_DEVICE fails silently).
  public static string GetVddState()
  {
    for (uint i = 0; i < 64; i++)
    {
      DISPLAY_DEVICE ad = new DISPLAY_DEVICE(); ad.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref ad, 0)) break;
      if (ad.DeviceString != "Virtual Display Driver") continue;
      DISPLAY_DEVICE mon = new DISPLAY_DEVICE(); mon.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(ad.DeviceName, 0, ref mon, 0)) continue;
      bool attached = (mon.StateFlags & 1) != 0;
      if (!attached) return "device_no_monitor";
      DEVMODE dm = new DEVMODE(); dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(ad.DeviceName, 0xFFFFFFFF, ref dm)) return "device_no_mode";
      return dm.dmPositionX + "," + dm.dmPositionY + "," + dm.dmPelsWidth + "," + dm.dmPelsHeight;
    }
    return "not_installed";
  }

  // Detached parking spot: primary monitor rect + a wide diagonal gap, so the
  // virtual canvas never shares an edge with the primary screen — a stray mouse
  // push can't drift onto the AI's desktop; reaching it takes deliberate travel.
  static int desiredX = -1, desiredY = -1;
  public static string ComputeDetachedPosition()
  {
    for (uint i = 0; i < 64; i++)
    {
      DISPLAY_DEVICE ad = new DISPLAY_DEVICE(); ad.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref ad, 0)) break;
      if ((ad.StateFlags & 1) == 0) continue;  // adapter not attached to desktop
      if (ad.DeviceString == "Virtual Display Driver") continue;
      DEVMODE pm = new DEVMODE(); pm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(ad.DeviceName, 0xFFFFFFFF, ref pm)) continue;
      desiredX = pm.dmPositionX + (int)pm.dmPelsWidth + 600;
      desiredY = pm.dmPositionY + (int)pm.dmPelsHeight + 600;
      return desiredX + "," + desiredY;
    }
    return "";
  }

  // Raise the VDD monitor to its preferred desktop mode AND park it at the
  // detached position. 1280x720 comes first: a lower canvas resolution renders
  // UI elements larger, so the PiP mirror on the primary screen stays readable.
  public static string SetBestMode()
  {
    ComputeDetachedPosition();
    for (uint i = 0; i < 64; i++)
    {
      DISPLAY_DEVICE ad = new DISPLAY_DEVICE(); ad.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref ad, 0)) break;
      if (ad.DeviceString != "Virtual Display Driver") continue;
      DEVMODE dm = new DEVMODE(); dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(ad.DeviceName, 0xFFFFFFFF, ref dm)) return "enumsettings_failed";
      uint[][] modes = new uint[][] { new uint[]{1280,720}, new uint[]{1366,768}, new uint[]{1600,900}, new uint[]{1920,1080} };
      foreach (uint[] m in modes)
      {
        // already at this mode AND parked at the detached spot: nothing to do —
        // re-applying via ChangeDisplaySettingsEx makes both monitors flicker
        if (dm.dmPelsWidth == m[0] && dm.dmPelsHeight == m[1] && dm.dmDisplayFrequency == 60
            && (desiredX < 0 || dm.dmPositionX == desiredX) && (desiredY < 0 || dm.dmPositionY == desiredY))
          return "mode_" + m[0] + "x" + m[1];
        DEVMODE tryDm = dm;
        tryDm.dmPelsWidth = m[0]; tryDm.dmPelsHeight = m[1]; tryDm.dmDisplayFrequency = 60;
        tryDm.dmFields = 0x400000u | 0x80000u | 0x100000u | 0x20u; // FREQUENCY|PELSW|PELSH|POSITION
        if (desiredX >= 0) { tryDm.dmPositionX = desiredX; tryDm.dmPositionY = desiredY; }
        else { tryDm.dmPositionX = dm.dmPositionX; tryDm.dmPositionY = dm.dmPositionY; }
        if (ChangeDisplaySettingsEx(ad.DeviceName, ref tryDm, IntPtr.Zero, 0x01u /*CDS_UPDATEREGISTRY*/, IntPtr.Zero) == 0)
          return "mode_" + m[0] + "x" + m[1];
      }
      return "mode_unsupported";
    }
    return "no_adapter";
  }
}
'@

function Get-VddState { return [DshSetupDisp]::GetVddState() }
function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

function Get-DriverDevice {
  $dev = Get-PnpDevice -Class Display -FriendlyName 'Virtual Display Driver' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dev) { return $dev.InstanceId }
  return $null
}

function Install-Driver {
  # Driver install requires admin (UAC prompt once) — the elevated child is only the
  # signed driver installer; the setup script itself keeps running unelevated.
  # Progress goes through Write-Output and the callers invoke this function bare:
  # calling it in an expression ([void]/if) would swallow ALL of its output.
  $script:installOk = $false
  $dev = Get-DriverDevice
  if ($dev) {
    $script:result.driver_installed = $true
    Write-Output "[install] 驱动已安装（$dev），跳过下载"
    $script:installOk = $true
    return
  }
  Write-Output "[install] 下载官方签名驱动（约 5.5MB，来自 VirtualDrivers/Virtual-Display-Driver）..."
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $DRIVER_URL -OutFile $DRIVER_FILE -UseBasicParsing -TimeoutSec 120 | Out-Null
  } catch {
    Write-Output "[install] 下载失败: $($_.Exception.Message)"
    Write-Output "[install] 请手动下载后双击安装: $DRIVER_URL"
    return
  }
  $hash = (Get-FileHash $DRIVER_FILE -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $DRIVER_SHA256) {
    Write-Output "[install] 校验失败：SHA256 不匹配（期望 $DRIVER_SHA256，实际 $hash），已删除文件"
    Remove-Item $DRIVER_FILE -Force -ErrorAction SilentlyContinue
    return
  }
  $sig = Get-AuthenticodeSignature $DRIVER_FILE
  if ($sig.Status -ne 'Valid') {
    Write-Output "[install] 数字签名校验失败（$($sig.Status)），中止安装"
    return
  }
  Write-Output "[install] 校验通过（SHA256 + Authenticode）。请在弹出的 UAC 对话框中点【是】授权安装..."
  try {
    $p = Start-Process -FilePath $DRIVER_FILE -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES' -Verb RunAs -Wait -PassThru
    if ($p.ExitCode -ne 0) { Write-Output "[install] 安装器退出码 $($p.ExitCode)"; }
  } catch {
    Write-Output "[install] 需要管理员授权，已取消（$($_.Exception.Message)）"
    return
  }
  # wait for device to appear
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-DriverDevice) { break }
  }
  $dev = Get-DriverDevice
  if ($dev) {
    $script:result.installed_now = $true
    Write-Output "[install] 驱动安装成功（$dev）"
    $script:installOk = $true
    return
  }
  Write-Output "[install] 安装后未检测到设备"
}

function Activate-Canvas {
  $script:activateOk = $false
  $dev = Get-DriverDevice
  if (-not $dev) { Write-Output "[activate] 驱动未安装，无法激活"; return }
  $state = Get-VddState
  if ($state -notin @('not_installed','device_no_monitor','device_no_mode')) {
    # already active — still (re)apply the preferred mode so a canvas left at a
    # non-preferred resolution (e.g. from an older install) self-heals
    $mode = [DshSetupDisp]::SetBestMode()
    Write-Output "[activate] 虚拟屏已激活（$state，模式 $mode）"
    $script:result.activated_now = $false
    $script:activateOk = $true
    return
  }
  if ($state -eq 'device_no_mode') {
    # monitor already attached to the desktop, only the mode is missing —
    # re-applying topology here would flicker the primary screen
    $mode = [DshSetupDisp]::SetBestMode()
    Write-Output "[activate] 虚拟屏已激活（$state，模式 $mode）"
    $script:activateOk = $true
    return
  }
  if ($state -eq 'device_no_monitor') {
    # nudge the driver to re-announce its monitor, then apply extend topology
    Write-Output "[activate] 设备存在但未挂屏，重启设备..."
    pnputil /restart-device $dev | Out-Null
    Start-Sleep -Seconds 5
  }
  Write-Output "[activate] 应用扩展拓扑（DisplaySwitch /extend）..."
  Start-Process -FilePath 'DisplaySwitch.exe' -ArgumentList '/extend' -Wait
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 700
    $state = Get-VddState
    if ($state -notin @('not_installed','device_no_monitor','device_no_mode')) { break }
  }
  $state = Get-VddState
  if ($state -in @('not_installed','device_no_monitor','device_no_mode')) {
    Write-Output "[activate] 程序化激活未生效（Windows 对间接显示器有确认回退机制）"
    return
  }
  $mode = [DshSetupDisp]::SetBestMode()
  Write-Output "[activate] 虚拟屏已激活（$state，分辨率 $($state.Split(',')[2])x$($state.Split(',')[3])，模式 $mode）"
  $script:activateOk = $true
}

function Show-Status {
  $state = Get-VddState
  $dev = Get-DriverDevice
  $script:result.driver_installed = [bool]$dev
  $script:result.admin = Test-Admin
  $script:result.canvas = if ($state -in @('not_installed','device_no_monitor','device_no_mode')) { $null } else { $state }
  Write-Output ("[status] 驱动=$([bool]$dev) 画布=$($script:result.canvas) 管理员=$($script:result.admin)")
}

# ------------------------------------------------------------------ main
if ($Banner) {
  Write-Output ''
  Write-Output '┌────────────────────────────────────────────────┐'
  Write-Output '│  dsh-pc-pilot 虚拟副屏 · 一键安装               │'
  Write-Output '│  为 AI 桌面操作提供一块真实虚拟显示器：         │'
  Write-Output '│  AI 窗口全部隐形运行，不再打扰你的主屏          │'
  Write-Output '└────────────────────────────────────────────────┘'
  Write-Output ''
}
switch ($Action) {
  'status' {
    Show-Status
  }
  'install' {
    Install-Driver
    if (-not $script:installOk) { $script:result.ok = $false }
    Show-Status
  }
  'activate' {
    Activate-Canvas
    if (-not $script:activateOk) {
      $script:result.needs_manual = $true
      Write-Output "[activate] 需要一次手动确认：按 Win+P 选择『扩展』，或在 设置>系统>屏幕 将多显示器设为『扩展这些显示器』"
    }
    Show-Status
  }
  'auto' {
    Show-Status
    $state = Get-VddState
    if ($state -notin @('not_installed','device_no_monitor','device_no_mode')) {
      # already up. NEVER touch display hardware on a healthy canvas — a redundant
      # mode-set or topology change makes the primary monitor flicker. Only heal
      # an old oversized install (width above the preferred 1366x768 tier).
      if ([int]($state.Split(',')[2]) -gt 1366) { Activate-Canvas }
      Write-Output "[auto] 虚拟副屏一切就绪，无需任何操作"
    } else {
      Install-Driver
      if (-not $script:installOk) { $script:result.ok = $false }
      else {
        Activate-Canvas
        if (-not $script:activateOk) { $script:result.needs_manual = $true; Write-Output "[auto] 需要一次手动确认：按 Win+P 选择『扩展』即可" }
      }
      Show-Status
    }
  }
  default { Write-Output "unknown action: $Action"; $script:result.ok = $false }
}

if ($Banner) {
  if ($script:result.ok -and -not $script:result.needs_manual) {
    Write-Output ''
    Write-Output '[OK] 完成。AI 的窗口今后将停泊在这块隐形副屏上，主屏恢复自由。'
    Write-Output '     如需卸载：pnputil /delete-driver oem138.inf /uninstall /force'
  } elseif ($script:result.needs_manual) {
    Write-Output ''
    Write-Output '[..] 未完全就绪：按上方提示完成一次手动确认（通常只需按一次 Win+P 选『扩展』），然后重新运行 npx dsh-pc-pilot 验证。'
  }
}

if (-not $script:result.canvas) { $script:result.ok = $false }
$json = ($script:result | ConvertTo-Json -Compress -Depth 4)
Write-Output ("DSHSETUP " + $json)
if (-not $script:result.ok) { exit 1 }
exit 0
