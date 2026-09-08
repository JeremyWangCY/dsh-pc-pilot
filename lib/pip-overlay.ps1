# pip-overlay.ps1 - Apple-style Picture-in-Picture (PiP) preview window for DSH Computer Use
# Provides a non-intrusive, floating live-monitor of the AI's virtual workspace.
param(
  [switch]$HideOnStart,
  [int]$InitialX = -1,
  [int]$InitialY = -1
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

# Win32 surface for the virtual display canvas mirror (EnumDisplay* + GDI cleanup)
$sig2 = @"
using System;
using System.Runtime.InteropServices;
public static class DshPipGdi {
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

  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int x, int y, int w, int h, IntPtr hdcSrc, int xSrc, int ySrc, uint rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  public const uint SRCCOPY = 0x00CC0020;

  // All enum logic runs inside C#: PowerShell struct-byref marshaling of DISPLAY_DEVICE
  // fails silently, so the PowerShell loop approach cannot be trusted here.
  public static string GetVddRect()
  {
    for (uint i = 0; i < 64; i++)
    {
      DISPLAY_DEVICE ad = new DISPLAY_DEVICE(); ad.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref ad, 0)) break;
      if (ad.DeviceString != "Virtual Display Driver") continue;
      DISPLAY_DEVICE mon = new DISPLAY_DEVICE(); mon.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(ad.DeviceName, 0, ref mon, 0)) continue;
      if ((mon.StateFlags & 1) == 0) continue;  // monitor not attached to desktop
      DEVMODE dm = new DEVMODE(); dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(ad.DeviceName, 0xFFFFFFFF, ref dm)) continue;
      return dm.dmPositionX + "," + dm.dmPositionY + "," + dm.dmPelsWidth + "," + dm.dmPelsHeight;
    }
    return "";
  }

  // Pure GDI capture of a screen rect; returns a caller-owned HBITMAP (delete after use).
  public static IntPtr CaptureRect(int x, int y, int w, int h)
  {
    IntPtr hdcScreen = GetDC(IntPtr.Zero);
    if (hdcScreen == IntPtr.Zero) return IntPtr.Zero;
    try
    {
      IntPtr hMem = CreateCompatibleDC(hdcScreen);
      IntPtr hBmp = CreateCompatibleBitmap(hdcScreen, w, h);
      if (hMem == IntPtr.Zero || hBmp == IntPtr.Zero) { if (hBmp != IntPtr.Zero) DeleteObject(hBmp); if (hMem != IntPtr.Zero) DeleteDC(hMem); return IntPtr.Zero; }
      IntPtr old = SelectObject(hMem, hBmp);
      BitBlt(hMem, 0, 0, w, h, hdcScreen, x, y, SRCCOPY);
      SelectObject(hMem, old);
      DeleteDC(hMem);
      return hBmp;
    }
    finally { ReleaseDC(IntPtr.Zero, hdcScreen); }
  }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'DshPipGdi').Type) {
  Add-Type -TypeDefinition $sig2
}

$sig = @"
using System;
using System.Runtime.InteropServices;
public static class DshPipWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public const int GWL_EXSTYLE = -20;
  public const long WS_EX_NOACTIVATE = 0x08000000L;
  public const long WS_EX_TOOLWINDOW = 0x00000080L;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
}
"@
if (-not ([System.Management.Automation.PSTypeName]'DshPipWin32').Type) {
  Add-Type -TypeDefinition $sig
}

$dir = Join-Path $env:TEMP "dsh-cua"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$stateFile = Join-Path $dir "pip.state"

# Apple macOS Sequoia / iOS PiP XAML design
$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="AI Workspace"
        Width="380" Height="240"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ShowActivated="False"
        Focusable="False"
        ResizeMode="NoResize">
    <Border Name="MainCard" CornerRadius="16" Background="#E61C1C1E" BorderBrush="#26FFFFFF" BorderThickness="1">
        <Border.Effect>
            <DropShadowEffect BlurRadius="24" Direction="270" ShadowDepth="4" Color="#000000" Opacity="0.5"/>
        </Border.Effect>
        <Grid>
            <!-- Header Bar -->
            <Grid Name="HeaderBar" Height="36" VerticalAlignment="Top" Margin="14,6,14,0" Background="Transparent">
                <!-- Left Title and Live Pill -->
                <StackPanel Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Left">
                    <TextBlock Text="AI Workspace" Foreground="#E5FFFFFF" FontSize="11" FontWeight="SemiBold" FontFamily="Segoe UI Variable Display, SF Pro Text, Segoe UI"/>
                    <Border Background="#2634C759" CornerRadius="8" Padding="6,2" Margin="8,0,0,0">
                        <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                            <Ellipse Width="5" Height="5" Fill="#34C759" Margin="0,0,4,0"/>
                            <TextBlock Text="Live" Foreground="#34C759" FontSize="9" FontWeight="Bold"/>
                        </StackPanel>
                    </Border>
                </StackPanel>

                <!-- Right Apple Traffic Light Control Buttons -->
                <StackPanel Orientation="Horizontal" VerticalAlignment="Center" HorizontalAlignment="Right">
                    <Border Name="BtnMini" Width="11" Height="11" CornerRadius="5.5" Background="#FFBD2E" Margin="0,0,7,0" Cursor="Hand">
                        <Border.ToolTip><ToolTip Content="Dynamic Island Mini Mode"/></Border.ToolTip>
                    </Border>
                    <Border Name="BtnExpand" Width="11" Height="11" CornerRadius="5.5" Background="#27C93F" Margin="0,0,7,0" Cursor="Hand">
                        <Border.ToolTip><ToolTip Content="Toggle Large Preview"/></Border.ToolTip>
                    </Border>
                    <Border Name="BtnClose" Width="11" Height="11" CornerRadius="5.5" Background="#FF5F56" Cursor="Hand">
                        <Border.ToolTip><ToolTip Content="Close PiP"/></Border.ToolTip>
                    </Border>
                </StackPanel>
            </Grid>

            <!-- Main Preview Area -->
            <Border Name="PreviewContainer" Margin="10,40,10,10" CornerRadius="10" Background="#0A0A0C" BorderBrush="#1AFFFFFF" BorderThickness="1" ClipToBounds="True">
                <Grid>
                    <Image Name="PreviewImg" Stretch="Uniform"/>
                    <!-- Placeholder message when no frame yet -->
                    <StackPanel Name="PlaceholderPanel" VerticalAlignment="Center" HorizontalAlignment="Center">
                        <TextBlock Text="Virtual Workspace Ready" Foreground="#66FFFFFF" FontSize="12" HorizontalAlignment="Center" FontFamily="Segoe UI Variable Text, SF Pro Text"/>
                        <TextBlock Text="Operations will mirror here silently" Foreground="#33FFFFFF" FontSize="10" Margin="0,4,0,0" HorizontalAlignment="Center"/>
                    </StackPanel>
                    <!-- Floating Action Status Pill -->
                    <Border VerticalAlignment="Bottom" HorizontalAlignment="Left" Background="#CC111113" BorderBrush="#26FFFFFF" BorderThickness="1" CornerRadius="6" Margin="8" Padding="7,3">
                        <TextBlock Name="ActionLabel" Text="Idle" Foreground="#B3FFFFFF" FontSize="9.5" FontFamily="Consolas, monospace"/>
                    </Border>
                </Grid>
            </Border>
        </Grid>
    </Border>
</Window>
"@

$reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($xaml))
$win = [System.Windows.Markup.XamlReader]::Load($reader)

# Element References
$btnClose = $win.FindName('BtnClose')
$btnMini = $win.FindName('BtnMini')
$btnExpand = $win.FindName('BtnExpand')
$previewImg = $win.FindName('PreviewImg')
$actionLabel = $win.FindName('ActionLabel')
$placeholder = $win.FindName('PlaceholderPanel')
$previewContainer = $win.FindName('PreviewContainer')
$headerBar = $win.FindName('HeaderBar')

# Default screen placement: bottom-right corner with 24px padding (pure WPF native)
$workArea = [System.Windows.SystemParameters]::WorkArea
$defaultW = 380
$defaultH = 240
if ($InitialX -ge 0 -and $InitialY -ge 0) {
  $win.Left = $InitialX
  $win.Top = $InitialY
} else {
  $win.Left = $workArea.Right - $defaultW - 24
  $win.Top = $workArea.Bottom - $defaultH - 24
}

# State variables
$script:isMini = $false
$script:isExpanded = $false
$script:lastFramePath = ''
$script:lastTs = 0.0
$script:lastActive = [DateTime]::Now
$script:tickCount = 0
$script:vddRect = $null
$script:vddRectAt = [DateTime]::MinValue

# Locate the active Virtual Display Driver monitor rect (physical pixels); cached 30s
function Get-DshVddRect {
  if (([DateTime]::Now - $script:vddRectAt).TotalSeconds -lt 30) { return $script:vddRect }
  $rect = $null
  $raw = [DshPipGdi]::GetVddRect()
  if ($raw) {
    $p = $raw.Split(',')
    $rect = @{ x = [int]$p[0]; y = [int]$p[1]; w = [int]$p[2]; h = [int]$p[3] }
  }
  $script:vddRect = $rect
  $script:vddRectAt = [DateTime]::Now
  return $rect
}

# Drag to move window
$headerBar.Add_MouseLeftButtonDown({
  $win.DragMove()
})

# Traffic Light Actions
$btnClose.Add_MouseLeftButtonDown({
  $win.Hide()
})

$btnMini.Add_MouseLeftButtonDown({
  if ($script:isMini) {
    # Restore from mini Dynamic Island
    $win.Width = if ($script:isExpanded) { 520 } else { 380 }
    $win.Height = if ($script:isExpanded) { 330 } else { 240 }
    $previewContainer.Visibility = [System.Windows.Visibility]::Visible
    $script:isMini = $false
  } else {
    # Collapse to mini Dynamic Island pill
    $win.Width = 200
    $win.Height = 44
    $previewContainer.Visibility = [System.Windows.Visibility]::Collapsed
    $script:isMini = $true
  }
})

$btnExpand.Add_MouseLeftButtonDown({
  if ($script:isMini) { return }
  if ($script:isExpanded) {
    $win.Width = 380
    $win.Height = 240
    $script:isExpanded = $false
  } else {
    $win.Width = 520
    $win.Height = 330
    $script:isExpanded = $true
  }
})

# Set WS_EX_NOACTIVATE so user typing focus is never stolen
$win.Add_SourceInitialized({
  $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  $exStyle = [DshPipWin32]::GetWindowLongPtr($hwnd, [DshPipWin32]::GWL_EXSTYLE)
  $newExStyle = [IntPtr]([long]$exStyle -bor [DshPipWin32]::WS_EX_NOACTIVATE -bor [DshPipWin32]::WS_EX_TOOLWINDOW)
  [DshPipWin32]::SetWindowLongPtr($hwnd, [DshPipWin32]::GWL_EXSTYLE, $newExStyle) | Out-Null
  [DshPipWin32]::SetWindowPos($hwnd, [DshPipWin32]::HWND_TOPMOST, 0, 0, 0, 0, [DshPipWin32]::SWP_NOMOVE -bor [DshPipWin32]::SWP_NOSIZE -bor [DshPipWin32]::SWP_NOACTIVATE -bor [DshPipWin32]::SWP_FRAMECHANGED) | Out-Null
})

# Polling timer for pip.state
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  if (Test-Path $stateFile) {
    try {
      $raw = Get-Content -Path $stateFile -Raw -ErrorAction Stop
      $st = $raw | ConvertFrom-Json
      if ($null -ne $st -and $st.ts -and ([double]$st.ts -ne $script:lastTs)) {
        $script:lastTs = [double]$st.ts
        $script:lastActive = [DateTime]::Now

        if ($st.label) {
          $actionLabel.Text = [string]$st.label
        }

        if ($st.frame -and (Test-Path $st.frame) -and ($st.frame -ne $script:lastFramePath)) {
          $script:lastFramePath = [string]$st.frame
          try {
            $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
            $bmp.BeginInit()
            $bmp.UriSource = [Uri]([System.IO.Path]::GetFullPath($st.frame))
            $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
            $bmp.EndInit()
            $bmp.Freeze()
            $previewImg.Source = $bmp
            $placeholder.Visibility = [System.Windows.Visibility]::Collapsed
          } catch { }
        }

        if ($st.show -eq $false) {
          $win.Hide()
        } elseif (-not $win.IsVisible) {
          $win.Show()
        }
      }
    } catch { }
  }

  # Virtual display canvas mirror: when the helper parks windows on a real IddCx
  # virtual monitor, that desktop region is private to the AI — mirroring it is
  # always safe (never leaks the user's physical screen). Rendered in-place, no disk.
  $script:tickCount++
  if (-not $script:isMini -and $win.IsVisible -and (($script:tickCount % 4) -eq 0)) {
    $vc = Get-DshVddRect
    if ($vc) {
      try {
        $hBmp = [DshPipGdi]::CaptureRect($vc.x, $vc.y, $vc.w, $vc.h)
        if ($hBmp -ne [IntPtr]::Zero) {
          $src = [System.Windows.Interop.Imaging]::CreateBitmapSourceFromHBitmap($hBmp, [IntPtr]::Zero, [System.Windows.Int32Rect]::Empty, [System.Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
          $src.Freeze()
          [DshPipGdi]::DeleteObject($hBmp) | Out-Null
          $previewImg.Source = $src
          $placeholder.Visibility = [System.Windows.Visibility]::Collapsed
          $script:lastFramePath = ''
        }
      } catch { }
    }
  }

  # Auto-exit if completely idle for 10 minutes
  if (([DateTime]::Now - $script:lastActive).TotalMinutes -ge 10) {
    $timer.Stop()
    $win.Close()
  }
})
$timer.Start()

if (-not $HideOnStart) {
  $win.Show()
}

$app = New-Object System.Windows.Application
$app.Run($win) | Out-Null
