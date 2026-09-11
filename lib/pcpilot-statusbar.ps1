# PC-Pilot status pill: top-center frosted dark bar with a breathing green dot.
# Visible while the helper is acting (status.state fresh), hides shortly after
# the last action. Click-through, never activates, per-pixel-alpha layered
# window — same technique as the virtual cursor overlay (PS 5.1 + PS7 compatible).
param(
  [string]$RenderSample = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dpiSig = @"
using System;
using System.Runtime.InteropServices;

public static class DshStatusDpi
{
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static void InitDpiAwareness()
  {
    try
    {
      if (!SetProcessDpiAwarenessContext((IntPtr)(-4)))
      {
        SetProcessDPIAware();
      }
    }
    catch
    {
      try { SetProcessDPIAware(); } catch { }
    }
  }
}
"@
Add-Type -TypeDefinition $dpiSig
[DshStatusDpi]::InitDpiAwareness()
$dir = Join-Path $env:TEMP "dsh-cua"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$cs = @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class DshStatusPill
{
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential)] public struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct WNDCLASSW
  {
    public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
    public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName; [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASSW wc);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT p, ref SIZE s, IntPtr src, ref POINT p2, uint key, ref BLENDFUNCTION bf, uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(string n);

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO
  {
    public BITMAPINFOHEADER bmiHeader;
    public uint bmiColors;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER
  {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
    public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }

  public const int W = 320, H = 56;
  static IntPtr hwnd = IntPtr.Zero;
  static IntPtr hdcMem = IntPtr.Zero;
  static IntPtr hbm = IntPtr.Zero;
  static IntPtr hbmOld = IntPtr.Zero;
  static IntPtr bitsAt = IntPtr.Zero;
  static WndProc _wndProc;
  delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);

  public static void InitDpiAwareness()
  {
    try { if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetProcessDPIAware(); }
    catch { try { SetProcessDPIAware(); } catch { } }
  }
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  static GraphicsPath RoundedRect(RectangleF r, float radius)
  {
    GraphicsPath p = new GraphicsPath();
    p.AddArc(r.X, r.Y, radius, radius, 180, 90);
    p.AddArc(r.X + r.Width - radius, r.Y, radius, radius, 270, 90);
    p.AddArc(r.X + r.Width - radius, r.Y + r.Height - radius, radius, radius, 0, 90);
    p.AddArc(r.X, r.Y + r.Height - radius, radius, radius, 90, 90);
    p.CloseFigure();
    return p;
  }

  static Bitmap RenderBitmap(double breath)
  {
    Bitmap bmp = new Bitmap(W, H, PixelFormat.Format32bppPArgb);
    using (Graphics g = Graphics.FromImage(bmp))
    {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.Clear(Color.Transparent);

      var rect = new RectangleF(0.5f, 0.5f, W - 1.0f, H - 1.0f);
      var radius = (float)(H - 1.0);
      using (GraphicsPath pill = RoundedRect(rect, radius))
      {
        using (var fill = new LinearGradientBrush(rect, Color.FromArgb(224, 22, 22, 26), Color.FromArgb(198, 28, 28, 32), 90f))
        {
          g.FillPath(fill, pill);
        }
        using (var edge = new Pen(Color.FromArgb(44, 255, 255, 255), 1.2f))
        {
          edge.Alignment = PenAlignment.Inset;
          g.DrawPath(edge, pill);
        }
        var sheenRect = new RectangleF(1.2f, 1.2f, W - 2.4f, H / 2f);
        using (var sheenPath = RoundedRect(sheenRect, radius - 1f))
        using (var sheen = new LinearGradientBrush(sheenRect, Color.FromArgb(24, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f))
        {
          g.FillPath(sheen, sheenPath);
        }
      }

      using (var font = new Font("Segoe UI Semibold", 13.5f, FontStyle.Bold, GraphicsUnit.Point))
      {
        var fmt = new StringFormat { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Center };
        var textRect = new RectangleF(20, 0, W - 70, H);
        using (var brush = new SolidBrush(Color.FromArgb(236, 245, 245, 247)))
        {
          g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
          g.DrawString("PC-Pilot \u8fd0\u884c\u4e2d", font, brush, textRect, fmt);
        }
      }

      float cx = W - 30f, cy = H / 2f;
      float alpha = (float)(0.30 + 0.70 * (0.5 + 0.5 * Math.Sin(breath)));
      using (GraphicsPath glow = new GraphicsPath())
      {
        glow.AddEllipse(cx - 11, cy - 11, 22, 22);
        using (PathGradientBrush pgb = new PathGradientBrush(glow))
        {
          pgb.CenterPoint = new PointF(cx, cy);
          pgb.CenterColor = Color.FromArgb((int)(110 * alpha), 50, 215, 75);
          pgb.SurroundColors = new Color[] { Color.FromArgb(0, 50, 215, 75) };
          g.FillPath(pgb, glow);
        }
      }
      using (SolidBrush dot = new SolidBrush(Color.FromArgb((int)(255 * alpha), 48, 209, 88)))
      {
        g.FillEllipse(dot, cx - 5, cy - 5, 10, 10);
      }
    }
    return bmp;
  }

  static void RenderSurface(double breath)
  {
    using (Bitmap bmp = RenderBitmap(breath))
    {
      var bmi = new BITMAPINFO();
      bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
      bmi.bmiHeader.biWidth = W;
      bmi.bmiHeader.biHeight = -H;
      bmi.bmiHeader.biPlanes = 1;
      bmi.bmiHeader.biBitCount = 32;
      bmi.bmiHeader.biCompression = 0;

      IntPtr dc = GetDC(IntPtr.Zero);
      if (hdcMem == IntPtr.Zero)
      {
        hdcMem = CreateCompatibleDC(dc);
        hbm = CreateDIBSection(hdcMem, ref bmi, 0, out bitsAt, IntPtr.Zero, 0);
        hbmOld = SelectObject(hdcMem, hbm);
      }
      BitmapData data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
      try
      {
        int bytes = Math.Abs(data.Stride) * H;
        byte[] buf = new byte[bytes];
        Marshal.Copy(data.Scan0, buf, 0, bytes);
        Marshal.Copy(buf, 0, bitsAt, bytes);
      }
      finally { bmp.UnlockBits(data); }
      ReleaseDC(IntPtr.Zero, dc);
    }
  }

  static void EnsureWindow()
  {
    InitDpiAwareness();
    if (hwnd != IntPtr.Zero) return;
    var wc = new WNDCLASSW();
    _wndProc = new WndProc(DefWindowProcW);
    wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc);
    wc.hInstance = GetModuleHandleW(null);
    wc.lpszClassName = "DshStatusPillCls";
    RegisterClassW(ref wc);
    uint ex = 0x80000 | 0x20 | 0x80 | 0x8000000 | 0x8; // LAYERED|TRANSPARENT|TOOLWINDOW|TOPMOST|NOACTIVATE
    uint st = 0x80000000; // WS_POPUP
    hwnd = CreateWindowExW(ex, "DshStatusPillCls", "", st, -4000, -4000, W, H, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
    RenderSurface(0);
  }

  public static void Show(int x, int y, double breath)
  {
    EnsureWindow();
    if (hwnd == IntPtr.Zero) return;
    RenderSurface(breath);
    POINT p; p.X = x; p.Y = y;
    SIZE s; s.cx = W; s.cy = H;
    POINT p2; p2.X = 0; p2.Y = 0;
    var bf = new BLENDFUNCTION();
    bf.BlendOp = 0; bf.BlendFlags = 0; bf.SourceConstantAlpha = 255; bf.AlphaFormat = 1;
    IntPtr dc = GetDC(IntPtr.Zero);
    UpdateLayeredWindow(hwnd, dc, ref p, ref s, hdcMem, ref p2, 0, ref bf, 2);
    ReleaseDC(IntPtr.Zero, dc);
    SetWindowPos(hwnd, (IntPtr)(-1), x, y, W, H, 0x0010 | 0x0040); // NOACTIVATE|SHOWWINDOW
    ShowWindow(hwnd, 4);
  }

  public static void Hide()
  {
    if (hwnd != IntPtr.Zero) ShowWindow(hwnd, 0);
  }

  public static void Cleanup()
  {
    if (hdcMem != IntPtr.Zero && hbmOld != IntPtr.Zero) { SelectObject(hdcMem, hbmOld); hbmOld = IntPtr.Zero; }
    if (hbm != IntPtr.Zero) { DeleteObject(hbm); hbm = IntPtr.Zero; }
    if (hdcMem != IntPtr.Zero) { DeleteDC(hdcMem); hdcMem = IntPtr.Zero; }
    if (hwnd != IntPtr.Zero) { ShowWindow(hwnd, 0); hwnd = IntPtr.Zero; }
  }

  public static void SaveSampleImage(string path, double breath)
  {
    using (Bitmap bmp = RenderBitmap(breath))
    {
      string dir = System.IO.Path.GetDirectoryName(path);
      if (!string.IsNullOrEmpty(dir) && !System.IO.Directory.Exists(dir)) System.IO.Directory.CreateDirectory(dir);
      bmp.Save(path, ImageFormat.Png);
    }
  }
}
"@
$csFile = Join-Path $dir "dsh-status-pill.cs"
[System.IO.File]::WriteAllText($csFile, $cs, [System.Text.Encoding]::UTF8)
if ($PSVersionTable.PSEdition -eq 'Core') {
  Add-Type -Path $csFile -ReferencedAssemblies "System.Drawing.Common", "System.Drawing.Primitives", "System.Private.Windows.GdiPlus", "System.Private.Windows.Core"
} else {
  Add-Type -Path $csFile -ReferencedAssemblies "System.Drawing"
}

if ($RenderSample) {
  [DshStatusPill]::SaveSampleImage($RenderSample, 1.2)
  exit 0
}

Set-Content -Path (Join-Path $dir "statusbar.pid") -Value $PID -Encoding ascii

$stateFile = Join-Path $dir "status.state"
$lastTs = 0.0
$lastActive = [DateTime]::Now
$visible = $false
while ($true) {
  [System.Windows.Forms.Application]::DoEvents()
  $show = $false
  if (Test-Path $stateFile) {
    try {
      $st = Get-Content -Path $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($null -ne $st -and $st.ts) {
        $age = ([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) - ([double]$st.ts)
        if ($st.show -and $age -ge 0 -and $age -lt 4000) { $show = $true }
      }
    } catch { }
  }
  if ($show) {
    $lastActive = [DateTime]::Now
    $breath = ([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) / 1000.0 * (2 * [Math]::PI / 1.8)
    $x = [int](([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width) / 2 - [DshStatusPill]::W / 2)
    $y = 14
    [DshStatusPill]::Show($x, $y, $breath)
    $visible = $true
  } elseif ($visible) {
    [DshStatusPill]::Hide()
    $visible = $false
  }
  if (([DateTime]::Now - $lastActive).TotalSeconds -ge 120) {
    [DshStatusPill]::Hide()
    [DshStatusPill]::Cleanup()
    $pidFile = Join-Path $dir "statusbar.pid"
    if (Test-Path $pidFile) {
      try {
        $savedPid = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
        if ([int]$savedPid -eq $PID) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
      } catch { }
    }
    exit 0
  }
  Start-Sleep -Milliseconds 80
}
