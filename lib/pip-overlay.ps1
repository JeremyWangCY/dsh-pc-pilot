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
