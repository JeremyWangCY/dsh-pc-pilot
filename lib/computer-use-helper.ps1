# dsh computer-use helper (Windows PowerShell 5.1)
# Background synthetic-cursor semantics per cua-driver's Windows recipe:
#   dispatch=background (default): UIA patterns first, then pixel hit-test, then
#   WM_CHAR/WM_KEY/WM_MOUSEWHEEL messages. Never steals foreground. Actions that
#   cannot run in background return background_unavailable (caller may retry with
#   dispatch=foreground = real SendInput).
# Actions: list_apps, get_app_state, click, click_element, set_value, type, key,
#   scroll, drag, open_app, mouse_move, perform_action, select_text, screenshot,
#   zoom, switch_display, cursor_position, list_windows, wait. Usage: powershell -NoProfile -ExecutionPolicy Bypass
#   -File <this> -Action <action> -PayloadStdin (or -PayloadJson "<json>"); writes ONE JSON doc to stdout.
param(
  [string]$Action,
  [string]$PayloadJson = '',
  [switch]$PayloadStdin,
  # -Server: persistent daemon mode. One JSON request per stdin line
  # ({ id, action, ...payload fields }), one single-line JSON reply per line of
  # stdout. No idle exit here: PS blocking reads cannot enforce one, so idle
  # lifecycle is owned by the node side (300s kill timer in lib/index.js).
  # Without -Server the one-shot PayloadStdin/PayloadJson
  # contract is unchanged (fallback path).
  [switch]$Server
)

try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:MAX_ELEMENTS = 2000

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshWin32
{
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct WinInfo
  {
    public IntPtr Hwnd;
    public uint Pid;
    public string Title;
    public bool Visible;
    public bool Foreground;
    public bool Minimized;
    public RECT Rect;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION
  {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  public const uint SMTO_ABORTIFHUNG = 0x0002;

  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool LockSetForegroundWindow(uint uCode);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public static readonly IntPtr HWND_TOP = new IntPtr(0);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint LSFW_LOCK = 1;
  public const uint LSFW_UNLOCK = 2;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const uint WM_CLOSE = 0x0010;
  public const int SW_SHOWNOACTIVATE = 4;
  public const int STARTF_USESHOWWINDOW = 0x00000001;
  public const uint SEE_MASK_NOCLOSEPROCESS = 0x00000040;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHELLEXECUTEINFO
  {
    public int cbSize;
    public uint fMask;
    public IntPtr hwnd;
    public string lpVerb;
    public string lpFile;
    public string lpParameters;
    public string lpDirectory;
    public int nShow;
    public IntPtr hInstApp;
    public IntPtr lpIDList;
    public string lpClass;
    public IntPtr hkeyClass;
    public uint dwHotKey;
    public IntPtr hIconOrMonitor;
    public IntPtr hProcess;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO lpExecInfo);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO
  {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public ushort wShowWindow;
    public ushort cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION
  {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessW(
    string lpApplicationName,
    string lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint GetProcessId(IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  public static uint LaunchShellSilent(string file, string args)
  {
    SHELLEXECUTEINFO sei = new SHELLEXECUTEINFO();
    sei.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
    sei.fMask = SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = "open";
    sei.lpFile = file;
    sei.lpParameters = string.IsNullOrEmpty(args) ? null : args;
    sei.nShow = SW_SHOWNOACTIVATE;
    if (ShellExecuteExW(ref sei))
    {
      uint pid = 0;
      if (sei.hProcess != IntPtr.Zero)
      {
        pid = GetProcessId(sei.hProcess);
        CloseHandle(sei.hProcess);
      }
      return pid;
    }
    return 0;
  }

  public static uint LaunchProcessSilent(string appName, string cmdLine)
  {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = (ushort)SW_SHOWNOACTIVATE;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    if (CreateProcessW(appName, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi))
    {
      uint pid = pi.dwProcessId;
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      return pid;
    }
    return 0;
  }

  public static POINT ScreenToClientPoint(IntPtr hWnd, int sx, int sy)
  {
    POINT p = new POINT { X = sx, Y = sy };
    ScreenToClient(hWnd, ref p);
    return p;
  }

  static DshWin32()
  {
    InitDpiAwareness();
  }

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

  public static RECT GetDwmRect(IntPtr h)
  {
    RECT r;
    try
    {
      if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0)
      {
        if (r.Right > r.Left && r.Bottom > r.Top) return r;
      }
    }
    catch { }
    GetWindowRect(h, out r);
    return r;
  }

  public static bool CloseWindowGracefully(IntPtr h, uint timeoutMs = 3000)
  {
    IntPtr res;
    IntPtr ret = SendMessageTimeout(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, timeoutMs, out res);
    return ret != IntPtr.Zero;
  }

  public static bool PushWindowToBottom(IntPtr h)
  {
    return SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  public static WinInfo GetWinInfo(IntPtr h)
  {
    uint pid; GetWindowThreadProcessId(h, out pid);
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    RECT r = GetDwmRect(h);
    IntPtr fg = GetForegroundWindow();
    bool isMin = IsIconic(h);
    WinInfo wi = new WinInfo();
    wi.Hwnd = h; wi.Pid = pid; wi.Title = sb.ToString();
    wi.Visible = IsWindowVisible(h); wi.Foreground = (!isMin && h == fg);
    wi.Minimized = isMin;
    wi.Rect = r;
    return wi;
  }

  public static List<WinInfo> EnumWindowsList()
  {
    List<WinInfo> list = new List<WinInfo>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate(IntPtr h, IntPtr l)
    {
      if (!IsWindowVisible(h)) return true;
      bool isMin = IsIconic(h);
      RECT r = GetDwmRect(h);
      if (!isMin && (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      WinInfo wi = new WinInfo();
      wi.Hwnd = h; wi.Pid = pid; wi.Title = sb.ToString(); wi.Visible = true;
      wi.Foreground = (!isMin && h == fg); wi.Minimized = isMin; wi.Rect = r;
      list.Add(wi);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static RECT GetRect(IntPtr h) { return GetDwmRect(h); }

  public static void ForceForeground(IntPtr h)
  {
    // only restore MINIMIZED windows; never SW_RESTORE a visible/maximized window (would un-maximize it)
    if (IsIconic(h)) ShowWindow(h, 9);
    SetWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    INPUT[] alt = new INPUT[] { MkKey(0x12, 0), MkKey(0x12, 2) };
    SendInput(2, alt, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(40);
    INPUT[] esc = new INPUT[] { MkKey(0x1B, 0), MkKey(0x1B, 2) };
    SendInput(2, esc, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(40);
    IntPtr f = GetForegroundWindow();
    // GetWindowThreadProcessId RETURNS the thread id; the out param receives the process id.
    uint fgPid; uint fgTid = GetWindowThreadProcessId(f, out fgPid);
    uint curPid; uint curTid = GetWindowThreadProcessId(h, out curPid);
    uint myTid = GetCurrentThreadId();
    if (myTid != 0 && fgTid != 0 && myTid != fgTid) AttachThreadInput(myTid, fgTid, true);
    if (fgTid != 0 && curTid != 0 && fgTid != curTid) AttachThreadInput(curTid, fgTid, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SetFocus(h);
    if (fgTid != 0 && curTid != 0 && fgTid != curTid) AttachThreadInput(curTid, fgTid, false);
    if (myTid != 0 && fgTid != 0 && myTid != fgTid) AttachThreadInput(myTid, fgTid, false);
    System.Threading.Thread.Sleep(150);
  }

  public static long ForegroundHwnd()
  {
    return GetForegroundWindow().ToInt64();
  }

  private static INPUT MkMouse(uint flags, uint data)
  {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = 0; i.u.mi.dy = 0;
    i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; i.u.mi.time = 0; i.u.mi.dwExtraInfo = IntPtr.Zero;
    return i;
  }

  private static INPUT MkKey(ushort vk, uint flags)
  {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = 0;
    i.u.ki.dwFlags = flags; i.u.ki.time = 0; i.u.ki.dwExtraInfo = IntPtr.Zero;
    return i;
  }

  private static INPUT MkUni(char c, uint flags)
  {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = 0; i.u.ki.wScan = (ushort)c;
    i.u.ki.dwFlags = flags; i.u.ki.time = 0; i.u.ki.dwExtraInfo = IntPtr.Zero;
    return i;
  }

  public static void TypeText(string text)
  {
    if (string.IsNullOrEmpty(text)) return;
    List<INPUT> ev = new List<INPUT>();
    foreach (char c in text)
    {
      ev.Add(MkUni(c, 4));
      ev.Add(MkUni(c, 6));
    }
    SendInput((uint)ev.Count, ev.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static ushort MapKey(string key)
  {
    if (string.IsNullOrEmpty(key)) return 0;
    string k = key.Trim().ToLowerInvariant();
    switch (k)
    {
      case "return": case "enter": return 0x0D;
      case "escape": case "esc": return 0x1B;
      case "tab": return 0x09;
      case "backspace": case "bspace": return 0x08;
      case "space": case "spacebar": return 0x20;
      case "delete": case "del": return 0x2E;
      case "insert": case "ins": return 0x2D;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": case "pgup": return 0x21;
      case "pagedown": case "pgdn": return 0x22;
      case "up": case "arrowup": return 0x26;
      case "down": case "arrowdown": return 0x28;
      case "left": case "arrowleft": return 0x25;
      case "right": case "arrowright": return 0x27;
      case "capslock": case "caps": return 0x14;
      case "printscreen": case "prtsc": return 0x2C;
      case "scrolllock": return 0x91;
      case "pause": case "break": return 0x13;
      case "shift": case "shift_l": case "shift_r": return 0x10;
      case "ctrl": case "control": case "control_l": case "control_r": case "ctrl_l": case "ctrl_r": return 0x11;
      case "alt": case "alt_l": case "alt_r": case "option": case "option_l": case "option_r": return 0x12;
      case "win": case "meta": case "super": case "cmd": case "command": return 0x5B;
      case "period": case "dot": return 0xBE;
      case "comma": return 0xBC;
      case "semicolon": return 0xBA;
      case "slash": return 0xBF;
      case "backslash": return 0xDC;
      case "minus": case "dash": return 0xBD;
      case "plus": return 0xBB;
    }
    if (k.Length == 1)
    {
      char c = k[0];
      if (c >= 'a' && c <= 'z') return (ushort)(0x41 + (c - 'a'));
      if (c >= '0' && c <= '9') return (ushort)(0x30 + (c - '0'));
      if (c == '-') return 0xBD; if (c == '=' || c == '+') return 0xBB;
      if (c == '[') return 0xDB; if (c == ']') return 0xDD;
      if (c == '\\') return 0xDC; if (c == ';') return 0xBA;
      if (c == '\'') return 0xDE; if (c == ',') return 0xBC;
      if (c == '.') return 0xBE; if (c == '/') return 0xBF;
      if (c == '`') return 0xC0;
    }
    if (k.StartsWith("f") && k.Length > 1)
    {
      int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x6F + n);
    }
    return 0;
  }

  private static ushort MapModKey(string m)
  {
    if (string.IsNullOrEmpty(m)) return 0;
    m = m.Trim().ToLowerInvariant();
    if (m == "ctrl" || m == "control" || m == "control_l" || m == "control_r" || m == "ctrl_l" || m == "ctrl_r") return 0x11;
    if (m == "shift" || m == "shift_l" || m == "shift_r") return 0x10;
    if (m == "alt" || m == "alt_l" || m == "alt_r" || m == "option" || m == "option_l" || m == "option_r") return 0x12;
    if (m == "win" || m == "meta" || m == "super" || m == "cmd" || m == "command") return 0x5B;
    return 0;
  }

  public static void ParseChord(string rawKey, string rawMods, out string baseKey, out List<ushort> modVks)
  {
    List<ushort> resMods = new List<ushort>();
    if (!string.IsNullOrEmpty(rawMods))
    {
      foreach (string part in rawMods.Split(new char[] { ',', '+' }, StringSplitOptions.RemoveEmptyEntries))
      {
        ushort vk = MapModKey(part);
        if (vk != 0 && !resMods.Contains(vk)) resMods.Add(vk);
      }
    }
    baseKey = rawKey != null ? rawKey.Trim() : "";
    if (baseKey.Length > 1 && baseKey.Contains("+"))
    {
      if (baseKey.EndsWith("++"))
      {
        string pfx = baseKey.Substring(0, baseKey.Length - 2);
        string[] parts = pfx.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string p in parts)
        {
          ushort vk = MapModKey(p);
          if (vk != 0 && !resMods.Contains(vk)) resMods.Add(vk);
        }
        baseKey = "+";
      }
      else
      {
        string[] parts = baseKey.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length > 1)
        {
          for (int i = 0; i < parts.Length - 1; i++)
          {
            ushort vk = MapModKey(parts[i]);
            if (vk != 0 && !resMods.Contains(vk)) resMods.Add(vk);
          }
          baseKey = parts[parts.Length - 1];
        }
      }
    }
    modVks = resMods;
  }

  public static void KeyChord(string key, string modifiers)
  {
    string baseKey; List<ushort> mods;
    ParseChord(key, modifiers, out baseKey, out mods);
    ushort vk = MapKey(baseKey);
    if (vk == 0) throw new Exception("unknown key: " + baseKey);
    List<INPUT> ev = new List<INPUT>();
    foreach (ushort m in mods) ev.Add(MkKey(m, 0));
    ev.Add(MkKey(vk, 0));
    ev.Add(MkKey(vk, 2));
    for (int i = mods.Count - 1; i >= 0; i--) ev.Add(MkKey(mods[i], 2));
    SendInput((uint)ev.Count, ev.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MouseMove(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(40); }

  public static void MouseClick(int x, int y)
  {
    MouseClickEx(x, y, 1, "left");
  }

  // multi-click aware click (double/triple + any button): N quick down/up pairs
  // within the system double-click time so apps register them as 2/3-click sequences
  public static void MouseClickEx(int x, int y, int count, string button)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    uint downF = 0x0002, upF = 0x0004;
    string b = (button ?? "left").Trim().ToLowerInvariant();
    if (b == "right") { downF = 0x0008; upF = 0x0010; }
    else if (b == "middle") { downF = 0x0020; upF = 0x0040; }
    if (count < 1) count = 1;
    if (count > 3) count = 3;
    for (int i = 0; i < count; i++)
    {
      INPUT[] d = new INPUT[] { MkMouse(downF, 0) };
      INPUT[] u = new INPUT[] { MkMouse(upF, 0) };
      SendInput(1, d, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(25);
      SendInput(1, u, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(25);
    }
  }

  public static void Scroll(int x, int y, int amount, bool down)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    uint data = (uint)((down ? -1 : 1) * amount * 120);
    INPUT[] ev = new INPUT[] { MkMouse(0x0800, data) };
    SendInput(1, ev, Marshal.SizeOf(typeof(INPUT)));
  }

  // horizontal wheel (WM_MOUSEHWHEEL equivalent): positive delta = scroll right
  public static void ScrollH(int x, int y, int amount, bool right)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    uint data = (uint)((right ? 1 : -1) * amount * 120);
    INPUT[] ev = new INPUT[] { MkMouse(0x1000, data) };
    SendInput(1, ev, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Drag(int fx, int fy, int tx, int ty)
  {
    SetCursorPos(fx, fy); System.Threading.Thread.Sleep(60);
    INPUT[] d = new INPUT[] { MkMouse(0x0002, 0) };
    SendInput(1, d, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(60);
    int steps = Math.Max(6, (Math.Abs(tx - fx) + Math.Abs(ty - fy)) / 12);
    for (int i = 1; i <= steps; i++)
    {
      int cx = fx + (tx - fx) * i / steps;
      int cy = fy + (ty - fy) * i / steps;
      SetCursorPos(cx, cy);
      System.Threading.Thread.Sleep(8);
    }
    System.Threading.Thread.Sleep(60);
    INPUT[] u = new INPUT[] { MkMouse(0x0004, 0) };
    SendInput(1, u, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(30);
  }

  public static void MouseDown(int x, int y, string button)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(30);
    uint flag = 0x0002;
    string b = (button ?? "left").Trim().ToLowerInvariant();
    if (b == "right") flag = 0x0008;
    else if (b == "middle") flag = 0x0020;
    INPUT[] d = new INPUT[] { MkMouse(flag, 0) };
    SendInput(1, d, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MouseUp(int x, int y, string button)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(30);
    uint flag = 0x0004;
    string b = (button ?? "left").Trim().ToLowerInvariant();
    if (b == "right") flag = 0x0010;
    else if (b == "middle") flag = 0x0040;
    INPUT[] u = new INPUT[] { MkMouse(flag, 0) };
    SendInput(1, u, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void HoldKey(string key, string modifiers, int durationMs)
  {
    string baseKey; List<ushort> mods;
    ParseChord(key, modifiers, out baseKey, out mods);
    ushort vk = MapKey(baseKey);
    if (vk == 0) throw new Exception("unknown key: " + baseKey);
    List<INPUT> down = new List<INPUT>();
    foreach (ushort m in mods) down.Add(MkKey(m, 0));
    down.Add(MkKey(vk, 0));
    SendInput((uint)down.Count, down.ToArray(), Marshal.SizeOf(typeof(INPUT)));

    System.Threading.Thread.Sleep(durationMs);

    List<INPUT> up = new List<INPUT>();
    up.Add(MkKey(vk, 2));
    for (int i = mods.Count - 1; i >= 0; i--) up.Add(MkKey(mods[i], 2));
    SendInput((uint)up.Count, up.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

[DshWin32]::InitDpiAwareness()

# ---------------------------------------------------------------- payload / window helpers

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

function Get-ProcessNameFast {
  param([uint32]$ProcessId, [hashtable]$Cache)
  if ($null -ne $Cache -and $Cache.ContainsKey($ProcessId)) { return $Cache[$ProcessId] }
  $name = $null
  try {
    $p = [System.Diagnostics.Process]::GetProcessById([int]$ProcessId)
    $name = $p.ProcessName
  } catch { }
  if (-not $name) { $name = "pid:$ProcessId" }
  if ($null -ne $Cache) { $Cache[$ProcessId] = $name }
  return $name
}

function Get-CandidateWindows {
  # Shared candidate filtering for Resolve-TargetWindow and list_windows:
  # matches pid / window-title substring / process name, drops off-screen ghosts.
  param([string]$App)
  $wins = @([DshWin32]::EnumWindowsList())
  $filtered = $wins

  if ($App) {
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
      $idx = [Math]::Min($Index, $cand.Count) - 1
    } else {
      $best = 0
      $bestArea = -1
      for ($i = 0; $i -lt $cand.Count; $i++) {
        $area = ($cand[$i].Rect.Right - $cand[$i].Rect.Left) * ($cand[$i].Rect.Bottom - $cand[$i].Rect.Top)
        if ($area -gt $bestArea) { $bestArea = $area; $best = $i }
      }
      $idx = $best
    }
    $target = $cand[$idx]
  }

  # If target is iconic (minimized) and action is not read-only inspection (get_window),
  # silently unminimize with SW_SHOWNOACTIVATE so rect and UIA are valid without stealing focus
  if ($null -ne $target -and [DshWin32]::IsIconic($target.Hwnd)) {
    $currAct = Get-PayloadValue 'action'
    if ($currAct -notin @('get_window', 'list_windows')) {
      $prevFg = [DshWin32]::GetForegroundWindow()
      [DshWin32]::ShowWindow($target.Hwnd, 4) | Out-Null
      [DshWin32]::PushWindowToBottom($target.Hwnd) | Out-Null
      if ($prevFg -ne [IntPtr]::Zero -and [DshWin32]::GetForegroundWindow() -ne $prevFg) {
        try { [DshWin32]::ForceForeground($prevFg) } catch { }
      }
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
  param($Win)
  return @{
    hwnd = $Win.Hwnd.ToInt64()
    pid = $Win.Pid
    title = $Win.Title
    foreground = $Win.Foreground
    minimized = [bool]$Win.Minimized
    rect = @{ x = $Win.Rect.Left; y = $Win.Rect.Top; width = ($Win.Rect.Right - $Win.Rect.Left); height = ($Win.Rect.Bottom - $Win.Rect.Top) }
  }
}

function Safe-Int {
  param($v)
  if ($null -eq $v) { return 0 }
  $d = [double]$v
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 0 }
  return [int]$d
}

function Get-AccessibilityTree {
  param([IntPtr]$Hwnd, [int]$MaxElements = $script:MAX_ELEMENTS, $WinRect = $null)
  $script:cachedTreeHwnd = $Hwnd
  $script:cachedElements = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
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
    $relX = if ($null -ne $WinRect) { Safe-Int ($rect.X - $WinRect.Left) } else { Safe-Int $rect.X }
    $relY = if ($null -ne $WinRect) { Safe-Int ($rect.Y - $WinRect.Top) } else { Safe-Int $rect.Y }
    $item = [ordered]@{
      index = $count
      role = $cur.ControlType.ProgrammaticName
      name = if ($name) { $name } else { '' }
      value = if ($value) { $value } else { '' }
      automation_id = if ($autoId) { $autoId } else { '' }
      enabled = $cur.IsEnabled
      offscreen = $cur.IsOffscreen
      invokable = $invoke
      rect = @{ x = $relX; y = $relY; width = (Safe-Int $rect.Width); height = (Safe-Int $rect.Height) }
      screen_rect = @{ x = (Safe-Int $rect.X); y = (Safe-Int $rect.Y); width = (Safe-Int $rect.Width); height = (Safe-Int $rect.Height) }
    }
    $out.Add($item)
  }
  return $out
}

function Find-ElementByIndex {
  param([IntPtr]$Hwnd, [int]$Index)
  if ($script:cachedTreeHwnd -eq $Hwnd -and $null -ne $script:cachedElements -and $Index -ge 1 -and $Index -le $script:cachedElements.Count) {
    $cached = $script:cachedElements[$Index - 1]
    try {
      $null = $cached.Current.ProcessId
      return $cached
    } catch { }
  }
  $aeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
  $children = $aeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $n = 0
  foreach ($el in $children) {
    $n++
    if ($n -eq $Index) { return $el }
  }
  throw "element_not_found: index $Index"
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
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$ov`"") -WindowStyle Hidden | Out-Null
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

function Notify-Cursor {
  param([int]$X, [int]$Y, [string]$Label)
  $on = Get-OverlayEnabled
  if ($on) { Ensure-OverlayProcess }
  Write-CursorState -X $X -Y $Y -Label $Label -Show $on
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

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
      $h = $el.Current.NativeWindowHandle
      if ($h -ne 0) { return [IntPtr]$h }
    }
  }
  foreach ($el in $all) {
    $h = $el.Current.NativeWindowHandle
    if ($h -eq 0) { continue }
    $vp = $null; $tp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return [IntPtr]$h }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return [IntPtr]$h }
  }
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

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return $el }
  }
  return $null
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

function Send-BackgroundKey {
  param([IntPtr]$Hwnd, [string]$Key, [string]$Modifiers)
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
  $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0101, [IntPtr]$vk, [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
  for ($i = $modVks.Count - 1; $i -ge 0; $i--) { $null = [DshWin32]::SendMessageTimeout($Hwnd, 0x0101, [IntPtr]$modVks[$i], [IntPtr]::Zero, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res) }
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
  param([IntPtr]$Hwnd, [int]$Sx, [int]$Sy, [string]$Button, [int]$Count)
  $msgDown = 0x0201; $msgUp = 0x0202; $msgDbl = 0x0203; $wDown = 0x0001
  if ($Button -eq 'right') { $msgDown = 0x0204; $msgUp = 0x0205; $msgDbl = 0x0206; $wDown = 0x0002 }
  elseif ($Button -eq 'middle') { $msgDown = 0x0207; $msgUp = 0x0208; $msgDbl = 0x0209; $wDown = 0x0010 }
  $cpt = [DshWin32]::ScreenToClientPoint($Hwnd, $Sx, $Sy)
  $lParam = [IntPtr](($cpt.Y -band 0xFFFF) -shl 16 -bor ($cpt.X -band 0xFFFF))
  $res = [IntPtr]::Zero
  $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgDown, [IntPtr]$wDown, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
  $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgUp, [IntPtr]::Zero, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
  for ($i = 1; $i -lt $Count; $i++) {
    $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgDbl, [IntPtr]$wDown, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
    $null = [DshWin32]::SendMessageTimeout($Hwnd, $msgUp, [IntPtr]::Zero, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
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
  # ponytail: capped at $script:MAX_ELEMENTS — huge Chromium trees stop paying after that
  param([IntPtr]$Hwnd, [double]$X, [double]$Y)
  $hits = @{ best = $null; bestPattern = $null; method = $null }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $bestArea = -1.0
    $patArea = -1.0
    $count = 0
    foreach ($el in $children) {
      if ($count -ge $script:MAX_ELEMENTS) { break }
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
  } catch { }
  return $hits
}

function Invoke-FromPointInWindow {
  # Window-scoped semantic hit: fire the action pattern of the TARGET window's own
  # UIA tree element under the screen point. Occlusion semantics: with a specified
  # app, background clicks aim at the target window's tree — physical occlusion by
  # other windows does not affect delivery, and UIA pattern hits still take priority
  # over bare WM messages. Among matching elements the SMALLEST rectangle wins
  # (deepest control, mirroring Invoke-FromPoint's bottom-up walk). Same return
  # shape as Invoke-FromPoint.
  param([IntPtr]$Hwnd, [double]$X, [double]$Y)
  try {
    $best = (Find-TargetHitsAt -Hwnd $Hwnd -X $X -Y $Y).bestPattern
    if ($null -ne $best) {
      $method = $null
      $bp = $null
      if ($best.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$bp)) { $method = 'invoke' }
      elseif ($best.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$bp)) { $method = 'toggle' }
      elseif ($best.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$bp)) { $method = 'selection' }
      if ($method -eq 'invoke') { $bp.Invoke() }
      elseif ($method -eq 'toggle') { $bp.Toggle() }
      elseif ($method -eq 'selection') { $bp.Select() }
      return @{ ok = $true; method = $method; name = $best.Current.Name; rect = $best.Current.BoundingRectangle }
    }
  } catch { }
  return @{ ok = $false }
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

function Test-BitmapBlank {
  # True when the sampled quadrant points AND the border/title points are all pure
  # black — the PrintWindow / screen-DC signature of DirectComposition/UWP/
  # hardware-accelerated frames. Small bitmaps (<= 4px) are never flagged.
  param($bmp, [int]$w, [int]$h)
  if ($w -le 4 -or $h -le 4) { return $false }
  $samplePoints = @(
    @{ X = [int]($w * 0.5);  Y = [int]($h * 0.5) },
    @{ X = [int]($w * 0.25); Y = [int]($h * 0.25) },
    @{ X = [int]($w * 0.75); Y = [int]($h * 0.25) },
    @{ X = [int]($w * 0.25); Y = [int]($h * 0.75) },
    @{ X = [int]($w * 0.75); Y = [int]($h * 0.75) }
  )
  foreach ($pt in $samplePoints) {
    $px = $bmp.GetPixel($pt.X, $pt.Y)
    if ($px.R -ne 0 -or $px.G -ne 0 -or $px.B -ne 0) { return $false }
  }
  $borderTitlePoints = @(
    @{ X = [int]($w * 0.5);  Y = [Math]::Min($h - 1, 10) },
    @{ X = [int]($w * 0.25); Y = [Math]::Min($h - 1, 10) },
    @{ X = [int]($w * 0.75); Y = [Math]::Min($h - 1, 10) },
    @{ X = [Math]::Max(0, $w - 15); Y = [Math]::Min($h - 1, 10) },
    @{ X = [Math]::Min($w - 1, 5); Y = [int]($h * 0.5) },
    @{ X = [Math]::Max(0, $w - 5); Y = [int]($h * 0.5) },
    @{ X = [int]($w * 0.5);  Y = [Math]::Max(0, $h - 5) }
  )
  foreach ($pt in $borderTitlePoints) {
    $px = $bmp.GetPixel($pt.X, $pt.Y)
    if ($px.R -ne 0 -or $px.G -ne 0 -or $px.B -ne 0) { return $false }
  }
  return $true
}

function Do-AppState {
  param([string]$App, [int]$WindowIndex, [bool]$WithScreenshot, [string]$Dispatch)
  $win = Resolve-TargetWindow -App $App -Index $WindowIndex
  if ($Dispatch -eq 'foreground') {
    [DshWin32]::ForceForeground($win.Hwnd)
    Start-Sleep -Milliseconds 250
    $fresh = @([DshWin32]::EnumWindowsList() | Where-Object { $_.Hwnd -eq $win.Hwnd })
    if ($fresh.Count -gt 0) { $win = $fresh[0] }
  }
  $dwmRect = [DshWin32]::GetDwmRect($win.Hwnd)
  if ($dwmRect.Right -gt $dwmRect.Left -and $dwmRect.Bottom -gt $dwmRect.Top) {
    $win.Rect = $dwmRect
  }
  $shot = $null
  if ($WithScreenshot) {
    $dir = Join-Path $env:TEMP 'dsh-cua'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $path = Join-Path $dir ("shot-{0}.png" -f ([guid]::NewGuid().ToString('N')))
    $w = $win.Rect.Right - $win.Rect.Left
    $h = $win.Rect.Bottom - $win.Rect.Top
    # tier 1: PrintWindow multi-mode fallback (flags 2 -> 0 -> 3)
    $bmp = $null
    $ok = $false
    $black = $true
    foreach ($flag in @(2, 0, 3)) {
      if ($bmp) { $bmp.Dispose(); $bmp = $null }
      $bmp = New-Object System.Drawing.Bitmap([Math]::Max(1, $w), [Math]::Max(1, $h))
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      $tryOk = [DshWin32]::PrintWindow($win.Hwnd, $hdc, [uint32]$flag)
      $g.ReleaseHdc($hdc)
      $g.Dispose()
      if ($tryOk) {
        if (-not (Test-BitmapBlank $bmp $w $h)) {
          $ok = $true
          $black = $false
          break
        }
      }
    }
    if ($ok) { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) }
    # ponytail: GUID shot files are unbounded — keep newest 50, self-prunes the backlog too
    Get-ChildItem $dir -Filter 'shot-*.png' -ea SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 50 | Remove-Item -Force -ea SilentlyContinue
    if ($bmp) { $bmp.Dispose() }
    $minimized = [DshWin32]::IsIconic($win.Hwnd)
    if ($ok -and -not $black) {
      # tier 1 rendered real content (implicit method = print_window)
      $shot = @{
        path = $path
        width = $w
        height = $h
        scale = 1
        window_rect = @{ x = $win.Rect.Left; y = $win.Rect.Top }
      }
      if ($minimized) { $shot.error = 'window_minimized; screenshot is blank' }
    } elseif (-not $minimized) {
      # tier 2: screen-DC BitBlt of the window rect (same technique as the screenshot action).
      # ponytail: ceiling — BitBlt captures whatever is VISIBLE in that rect right now, so a
      # fully occluded window snapshots its occluder (never blank unless the desktop itself is);
      # a WGC (Windows.Graphics.Capture) bypass is the follow-up upgrade path (already on the
      # handoff list).
      $bmp2 = New-Object System.Drawing.Bitmap([Math]::Max(1, $w), [Math]::Max(1, $h))
      $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
      $g2.CopyFromScreen($win.Rect.Left, $win.Rect.Top, 0, 0, (New-Object System.Drawing.Size([Math]::Max(1, $w), [Math]::Max(1, $h))))
      $g2.Dispose()
      $bmp2.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $black2 = Test-BitmapBlank $bmp2 $w $h
      $bmp2.Dispose()
      $shot = @{
        path = $path
        width = $w
        height = $h
        scale = 1
        window_rect = @{ x = $win.Rect.Left; y = $win.Rect.Top }
        method = 'bitblt_screen'
      }
      if ($black2) {
        $shot.error = 'screenshot_black: print_window and bitblt_screen both produced blank frames (DirectComposition/UWP/hardware-accelerated or fully occluded target); use dispatch=foreground for a full render'
      }
    } else {
      # both tiers unavailable: minimized window (PrintWindow output is blank by definition)
      $shot = @{
        path = if ($ok) { $path } else { $null }
        width = if ($ok) { $w } else { 0 }
        height = if ($ok) { $h } else { 0 }
        scale = 1
        window_rect = @{ x = $win.Rect.Left; y = $win.Rect.Top }
        error = 'window_minimized; screenshot is blank'
      }
    }
  }
  $tree = Get-AccessibilityTree $win.Hwnd -WinRect $win.Rect
  $docText = Get-DocumentText $win.Hwnd
  return @{
    window = (Get-WindowInfo $win)
    screenshot = $shot
    elements = $tree
    element_count = $tree.Count
    document_text = if ($docText) { $docText } else { '' }
    note = 'Element indexes are only valid together with this state; refresh after any UI change.'
  }
}

# ---------------------------------------------------------------- actions

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
  if ($button -notin @('left', 'right', 'middle')) {
    throw "invalid mouse button: $button (expected 'left', 'right', or 'middle')"
  }
  $app = Get-PayloadValue 'app'
  $rawX = Get-PayloadValue 'x'
  $rawY = Get-PayloadValue 'y'
  $dispatch = Get-Dispatch
  $win = $null
  if ($app) {
    $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
    if ($dispatch -eq 'foreground') {
      [DshWin32]::ForceForeground($win.Hwnd)
      Start-Sleep -Milliseconds 150
      $Result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
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
          $byPid[$w.Pid] = @{ pid = $w.Pid; name = $name; windows = New-Object System.Collections.ArrayList }
        }
        $null = $byPid[$w.Pid].windows.Add((Get-WindowInfo $w))
      }
      $result.apps = @($byPid.Values)
      $result.message = "Found $($byPid.Count) apps / $($wins.Count) windows"
    }

    'get_app_state' {
      $app = Get-PayloadValue 'app'
      $idx = [int](Get-PayloadValue 'window_index')
      $shot = Get-PayloadValue 'screenshot'
      if ($null -eq $shot) { $shot = $true }
      $st = Do-AppState -App $app -WindowIndex $idx -WithScreenshot ([bool]$shot) -Dispatch (Get-Dispatch)
      $result.window = $st.window
      $result.screenshot = $st.screenshot
      $result.elements = $st.elements
      $result.element_count = $st.element_count
      $result.document_text = $st.document_text
      $result.note = $st.note
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
      if ($button -notin @('left', 'right', 'middle')) {
        throw "invalid mouse button: $button (expected 'left', 'right', or 'middle')"
      }
      $clickCount = 1
      $rawCount = Get-PayloadValue 'click_count'
      if ($null -ne $rawCount) {
        $clickCount = [int]$rawCount
        if ($clickCount -lt 1) { $clickCount = 1 }
        if ($clickCount -gt 3) { $clickCount = 3 }
      }
      $dispatch = Get-Dispatch
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') { [DshWin32]::ForceForeground($win.Hwnd) }
        $r = $win.Rect
        if ($dispatch -eq 'foreground') { $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64()) }
      }
      $sx = 0; $sy = 0; $res = $false
      if ($null -ne $rawElement -and ([string]$rawElement).Trim() -ne '' -and $win) {
        try {
          $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index ([int]$rawElement)
          $er = $el.Current.BoundingRectangle
          if ($er.Width -gt 0 -and $er.Height -gt 0) {
            $sx = Safe-Int ($er.X + $er.Width / 2); $sy = Safe-Int ($er.Y + $er.Height / 2)
            $res = $true; $result.element = [int]$rawElement
          }
        } catch { }
      }
      if (-not $res) {
        $hx = ($null -ne $rawX); $hy = ($null -ne $rawY)
        $x = if ($hx) { [int]$rawX } else { 0 }
        $y = if ($hy) { [int]$rawY } else { 0 }
        if ($win) {
          if ($hx -and $hy -and $x -ge $r.Left -and $x -le $r.Right -and $y -ge $r.Top -and $y -le $r.Bottom) {
            $sx = $x; $sy = $y
          } elseif ($hx -or $hy) {
            $sx = $r.Left + $x; $sy = $r.Top + $y
          }
          if ((-not $hx -and -not $hy) -or ($x -le 0 -and $y -le 0) -or ($sx -le 0 -and $sy -le 0)) {
            $c = Get-OverlayPoint-WindowCenter $win; $sx = $c[0]; $sy = $c[1]
          }
        } else {
          $sx = $x; $sy = $y
        }
      }

      $label = 'click'
      if ($clickCount -eq 2) { $label = 'double-click' }
      elseif ($clickCount -eq 3) { $label = 'triple-click' }
      if ($button -ne 'left') { $label = "$button $label" }
      if ($dispatch -eq 'background') {
        Notify-Cursor -X $sx -Y $sy -Label $label
        if ($button -eq 'left' -and $clickCount -eq 1) {
          if ($win) {
            # app-scoped: aim at the TARGET window's own tree — physical occlusion by
            # other windows does not affect delivery; UIA pattern hits still take
            # priority over bare WM messages
            $hit = Invoke-FromPointInWindow -Hwnd $win.Hwnd -X $sx -Y $sy
            if ($hit.ok) {
              $result.method = 'uia_window_hit_' + $hit.method
              $result.hit_name = $hit.name
              $result.message = "Background click at ($sx, $sy) -> $($hit.method) on '$($hit.name)' (target-window tree; occlusion-immune)"
            } else {
              # no actionable pattern at that point: deliver a plain WM click sequence
              # to the target window's own hwnd (stronger than the old
              # background_unavailable — clicks still land inside the app)
              $h = Find-TargetHwndAt -Hwnd $win.Hwnd -X $sx -Y $sy -Win $win
              Send-BackgroundMouseButton -Hwnd $h -Sx $sx -Sy $sy -Button 'left' -Count 1
              $result.method = 'wm_message'
              $result.target_hwnd = $h.ToInt64()
              $result.message = "Background click at ($sx, $sy): no invokable control in the target window tree; WM click delivered via the target-window path to hwnd $($h.ToInt64()) (occlusion-immune)"
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
              $result.message = "Background click at ($sx, $sy): no invokable/toggle/selectable control at that point (canvas or coordinate-text click). Use dispatch=foreground for a real click, or click_element with an element index."
            }
          }
        } else {
          # right/middle clicks and multi-clicks: standard WM click sequence;
          # app-scoped lookups must never hit the screen-level occluder
          if ($win) {
            $h = Find-TargetHwndAt -Hwnd $win.Hwnd -X $sx -Y $sy -Win $win
          } else {
            $h = Find-BackgroundHwndAt -Sx $sx -Sy $sy -Win $win
          }
          if ($h -ne [IntPtr]::Zero) {
            Send-BackgroundMouseButton -Hwnd $h -Sx $sx -Sy $sy -Button $button -Count $clickCount
            $result.method = 'wm_message'
            $result.target_hwnd = $h.ToInt64()
            $result.message = "Background $label sent via window message to hwnd $($h.ToInt64()) at ($sx, $sy)"
          } else {
            $result.background_unavailable = $true
            $result.message = "Background $label at ($sx, $sy): no target window found at that point. Use dispatch=foreground."
          }
        }
        $result.clicked = @{ x = $sx; y = $sy }
      } else {
        Notify-Cursor -X $sx -Y $sy -Label $label
        [DshWin32]::MouseClickEx($sx, $sy, $clickCount, $button)
        $result.button = $button
        $result.click_count = $clickCount
        $result.message = "$label at screen ($sx, $sy)"
        $result.clicked = @{ x = $sx; y = $sy }
      }
    }

    'click_element' {
      $app = Get-PayloadValue 'app'
      $element = [int](Get-PayloadValue 'element')
      $dispatch = Get-Dispatch
      $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
      if ($dispatch -eq 'foreground') {
        [DshWin32]::ForceForeground($win.Hwnd)
        Start-Sleep -Milliseconds 150
        $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
      }
      $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index $element
      # cursor indicator for ALL element interaction patterns: fire once up-front for
      # any element with a valid bounding rectangle (Invoke/Toggle/Selection/ExpandCollapse)
      if ($dispatch -eq 'background') {
        $elRect = $el.Current.BoundingRectangle
        if ($elRect.Width -gt 0 -and $elRect.Height -gt 0) {
          Notify-Cursor -X (Safe-Int ($elRect.X + $elRect.Width / 2)) -Y (Safe-Int ($elRect.Y + $elRect.Height / 2)) -Label ('click element ' + $element)
        }
      } else {
        $elRect = $el.Current.BoundingRectangle
        if ($elRect.Width -gt 0 -and $elRect.Height -gt 0) {
          Notify-Cursor -X (Safe-Int ($elRect.X + $elRect.Width / 2)) -Y (Safe-Int ($elRect.Y + $elRect.Height / 2)) -Label ('click element ' + $element)
        }
      }
      $ip = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
        $ip.Invoke()
        $result.method = 'invoke_pattern'
        $result.message = "Invoked element $element"
      } else {
        $tog = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tog)) {
          $tog.Toggle(); $result.method = 'toggle_pattern'; $result.message = "Toggled element $element"
        } else {
          $sel = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
            $sel.Select(); $result.method = 'selection_pattern'; $result.message = "Selected element $element"
          } else {
            $exp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$exp)) {
              $exp.Expand(); $result.method = 'expand_pattern'; $result.message = "Expanded element $element"
            } elseif ($dispatch -eq 'background') {
              $r = $el.Current.BoundingRectangle
              if ($r.Width -gt 0 -and $r.Height -gt 0) {
                $cx = (Safe-Int ($r.X + $r.Width / 2)); $cy = (Safe-Int ($r.Y + $r.Height / 2))
                $h = Find-TargetHwndAt -Hwnd $win.Hwnd -X $cx -Y $cy -Win $win
                Send-BackgroundMouseButton -Hwnd $h -Sx $cx -Sy $cy -Button 'left' -Count 1
                $result.method = 'wm_message'
                $result.target_hwnd = $h.ToInt64()
                $result.clicked = @{ x = $cx; y = $cy }
                $result.message = "Clicked element $element via target-window WM message to hwnd $($h.ToInt64()) at ($cx, $cy) (no UIA pattern; occlusion-immune)"
              } else {
                $result.background_unavailable = $true
                $result.element_rect = @{ x = (Safe-Int $r.X); y = (Safe-Int $r.Y); width = (Safe-Int $r.Width); height = (Safe-Int $r.Height) }
                $result.message = "Element $element has no UIA action pattern (Invoke/Toggle/Selection/ExpandCollapse) and invalid bounding rectangle; background click unavailable. Use dispatch=foreground."
              }
            } else {
              $pt = New-Object System.Windows.Point
              $clickable = $el.TryGetClickablePoint([ref]$pt)
              if ($clickable) {
                [DshWin32]::MouseClick([int]$pt.X, [int]$pt.Y)
                $result.method = 'clickable_point'
                $result.message = "Clicked element $element at ($([int]$pt.X), $([int]$pt.Y))"
                $result.clicked = @{ x = [int]$pt.X; y = [int]$pt.Y }
              } else {
                $r2 = $el.Current.BoundingRectangle
                if ($r2.Width -gt 0 -and $r2.Height -gt 0) {
                  $cx = (Safe-Int ($r2.X + $r2.Width / 2)); $cy = (Safe-Int ($r2.Y + $r2.Height / 2))
                  [DshWin32]::MouseClick($cx, $cy)
                  $result.method = 'rect_center'
                  $result.message = "Clicked element $element center at ($cx, $cy)"
                  $result.clicked = @{ x = $cx; y = $cy }
                } else {
                  throw 'element_not_clickable: element has no clickable point or frame'
                }
              }
            }
          }
        }
      }
    }

    'set_value' {
      $app = Get-PayloadValue 'app'
      $element = [int](Get-PayloadValue 'element')
      $value = Get-PayloadValue 'value'
      $dispatch = Get-Dispatch
      $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
      if ($dispatch -eq 'foreground') {
        [DshWin32]::ForceForeground($win.Hwnd)
        Start-Sleep -Milliseconds 150
        $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
      }
      $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index $element
      $vp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        if ($dispatch -eq 'background') { Notify-Cursor -X (Safe-Int ($el.Current.BoundingRectangle.X + $el.Current.BoundingRectangle.Width / 2)) -Y (Safe-Int ($el.Current.BoundingRectangle.Y + $el.Current.BoundingRectangle.Height / 2)) -Label 'set_value' }
        $vp.SetValue($value)
        $result.method = 'value_pattern'
        $result.message = "Set element $element value"
      } elseif ($dispatch -eq 'background') {
        $result.background_unavailable = $true
        $result.message = "Element $element has no ValuePattern; background set_value unavailable. Use dispatch=foreground (focus_type) or type instead."
      } else {
        $el.SetFocus()
        Start-Sleep -Milliseconds 100
        [DshWin32]::TypeText($value)
        $result.method = 'focus_type'
        $result.message = 'Focused element and typed value (unverified)'
      }
    }

    'type' {
      $app = Get-PayloadValue 'app'
      $text = Get-PayloadValue 'text'
      $dispatch = Get-Dispatch
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') {
          [DshWin32]::ForceForeground($win.Hwnd)
          Start-Sleep -Milliseconds 150
          $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
        }
        $pt = Get-OverlayPoint-WindowCenter $win
        $cx = $pt[0]; $cy = $pt[1]
        if ($dispatch -eq 'background') {
          $h = [IntPtr]::Zero
          $rawElement = Get-PayloadValue 'element'
          if ($null -ne $rawElement) {
            # explicit element target: when it maps to a native HWND, WM_CHAR goes
            # straight there (skips Find-TextInputHwnd); otherwise fall through
            $tel = Find-ElementByIndex -Hwnd $win.Hwnd -Index ([int]$rawElement)
            $tnh = $tel.Current.NativeWindowHandle
            if ($tnh -ne 0) { $h = [IntPtr]$tnh }
          }
          if ($h -eq [IntPtr]::Zero) { $h = Find-TextInputHwnd $win.Hwnd }
          if ($h -eq [IntPtr]::Zero) {
            # fallback: apps with no native edit HWND (WinUI/Chromium) -> ValuePattern.SetValue
            $vel = Find-ValuePatternEl $win.Hwnd
            if ($null -ne $vel) {
              Notify-Cursor -X $cx -Y $cy -Label ('set_value ' + $text.Length + ' chars')
              $vv = $null
              if ($vel.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vv)) {
                $vv.SetValue($text)
                $result.method = 'value_pattern'
                $result.message = "Set text via ValuePattern ($(($text.Length)) chars) — WinUI/Chromium target with no edit HWND; replaces field content. Verify with get_app_state."
                break
              }
            }
            $result.background_unavailable = $true
            $result.message = "type: no edit HWND or ValuePattern control for WM_CHAR in '$app'; use dispatch=foreground."
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

    'key' {
      $app = Get-PayloadValue 'app'
      $rawKey = Get-PayloadValue 'key'
      $rawMods = Get-PayloadValue 'modifiers'
      $chord = Parse-KeyChord -RawKey $rawKey -RawModifiers $rawMods
      $key = $chord.Key
      $mods = $chord.Modifiers
      $dispatch = Get-Dispatch
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') {
          [DshWin32]::ForceForeground($win.Hwnd)
          Start-Sleep -Milliseconds 150
          $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
        }
      }
      if ($dispatch -eq 'background' -and $null -ne $win) {
        $h = Find-TextInputHwnd $win.Hwnd
        if ($h -eq [IntPtr]::Zero) {
          $result.background_unavailable = $true
          $result.message = "key: no focusable control HWND in '$app' to receive WM_KEY; use dispatch=foreground."
          break
        }
        $pt = Get-OverlayPoint-WindowCenter $win
        Notify-Cursor -X $pt[0] -Y $pt[1] -Label ('key ' + $key)
        Send-BackgroundKey -Hwnd $h -Key $key -Modifiers $mods
        $result.method = 'wm_key'
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
      if ($amount -le 0) { $amount = 3 }
      $dir = Get-PayloadValue 'direction'
      if (-not $dir) { $dir = 'down' }
      $down = ($dir -ne 'up')
      $horizontal = ($dir -eq 'left' -or $dir -eq 'right')
      $right = ($dir -eq 'right')
      $dispatch = Get-Dispatch
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') { [DshWin32]::ForceForeground($win.Hwnd) }
        $r = $win.Rect
        $sx = $r.Left + $x; $sy = $r.Top + $y
      } else {
        $sx = $x; $sy = $y
      }
      if ($dispatch -eq 'background') {
        Notify-Cursor -X $sx -Y $sy -Label ('scroll ' + $dir)
        $pt = New-Object System.Windows.Point($sx, $sy)
        if ($horizontal) {
          # horizontal scroll: ScrollPattern (horizontal axis) first, then WM_MOUSEHWHEEL
          # (0x020E, wParam delta positive = scroll right); same hwnd fallback logic as vertical
          $done = $false
          $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
          for ($i = 0; $i -lt 16 -and $null -ne $el; $i++) {
            $scp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$scp)) {
              $none = [System.Windows.Automation.ScrollAmount]::NoAmount
              for ($n = 0; $n -lt $amount; $n++) { if ($right) { $scp.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, $none) } else { $scp.Scroll([System.Windows.Automation.ScrollAmount]::LargeDecrement, $none) } }
              $result.method = 'scroll_pattern'; $done = $true; break
            }
            $el = Get-UiaParent $el
          }
          if (-not $done) {
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
              if ($doc -and $doc.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$dscp)) {
                $none = [System.Windows.Automation.ScrollAmount]::NoAmount
                for ($n = 0; $n -lt $amount; $n++) { if ($down) { $dscp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeIncrement) } else { $dscp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeDecrement) } }
                $result.method = 'scroll_pattern'; $done = $true
                $result.message = "Scrolled $dir x$amount via ScrollPattern on target window document"
              }
            }
          }
          if (-not $done) {
            $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
            for ($i = 0; $i -lt 16 -and $null -ne $el; $i++) {
              $rvp = $null
              if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$rvp)) {
                for ($n = 0; $n -lt $amount; $n++) { if ($down) { $rvp.SmallIncrement() } else { $rvp.SmallDecrement() } }
                $result.method = 'range_value'; $done = $true; break
              }
              $scp = $null
              if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$scp)) {
                $none = [System.Windows.Automation.ScrollAmount]::NoAmount
                for ($n = 0; $n -lt $amount; $n++) { if ($down) { $scp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeIncrement) } else { $scp.Scroll($none, [System.Windows.Automation.ScrollAmount]::LargeDecrement) } }
                $result.method = 'scroll_pattern'; $done = $true; break
              }
              $el = Get-UiaParent $el
            }
          }
          if (-not $done) {
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
              if ($down) { $delta = -$delta }
              $wParam = [IntPtr]($delta -shl 16)
              $lParam = [IntPtr](($sy -band 0xFFFF) -shl 16 -bor ($sx -band 0xFFFF))
              $res = [IntPtr]::Zero
              $null = [DshWin32]::SendMessageTimeout($h, 0x020A, $wParam, $lParam, [DshWin32]::SMTO_ABORTIFHUNG, 3000, [ref]$res)
              $result.method = 'wm_mousewheel'
              $result.message = "Scrolled $dir x$amount via WM_MOUSEWHEEL to hwnd $($h.ToInt64())"
            } else {
              $result.background_unavailable = $true
              $result.message = 'scroll: no window under the point; nothing to scroll'
            }
          } else {
            $result.message = "Scrolled $dir x$amount via $($result.method)"
          }
        }
      } else {
        if ($horizontal) {
          [DshWin32]::ScrollH($sx, $sy, $amount, $right)
        } else {
          [DshWin32]::Scroll($sx, $sy, $amount, $down)
        }
        $result.message = "Scrolled $dir x$amount at ($sx, $sy)"
      }
    }

    'drag' {
      $app = Get-PayloadValue 'app'
      $dispatch = Get-Dispatch
      $win = $null
      if ($app) {
        $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
        if ($dispatch -eq 'foreground') { [DshWin32]::ForceForeground($win.Hwnd) }
        $r = $win.Rect
      }
      $fx = [int](Get-PayloadValue 'from_x'); $fy = [int](Get-PayloadValue 'from_y')
      $tx = [int](Get-PayloadValue 'to_x'); $ty = [int](Get-PayloadValue 'to_y')
      if ($win) {
        $fx += $r.Left; $fy += $r.Top; $tx += $r.Left; $ty += $r.Top
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
      } else {
        [DshWin32]::Drag($fx, $fy, $tx, $ty)
        $result.message = "Dragged ($fx,$fy) -> ($tx,$ty)"
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
          [DshWin32]::ForceForeground($win.Hwnd)
          Start-Sleep -Milliseconds 150
          $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
        }
      }
      if ($dispatch -eq 'background' -and $null -ne $win) {
        $h = Find-TextInputHwnd $win.Hwnd
        if ($h -eq [IntPtr]::Zero) {
          $result.background_unavailable = $true
          $result.message = "hold_key: no focusable control HWND in '$app' to receive WM_KEY; use dispatch=foreground."
          break
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

    'open_app' {
      $name = Get-PayloadValue 'name'
      if (-not $name) { throw 'open_app requires name' }
      # support arguments after the executable (quoted or unquoted):
      # 'notepad.exe C:\foo.txt', '"C:\Program Files\App\app.exe" --flag value'
      $cmd = Split-AppCommand -Name ([string]$name)
      $filePath = $cmd[0]
      $argList = @($cmd[1])
      # Launch silently in background using -WindowStyle Minimized (direct at bottom, zero flicker/focus steal)
      $style = if (Get-PayloadValue 'activate' -or (Get-Dispatch) -eq 'foreground') { 'Normal' } else { 'Minimized' }
      $proc = if ($argList.Count -gt 0) {
        Start-Process -FilePath $filePath -ArgumentList $argList -WindowStyle $style -PassThru
      } else {
        Start-Process -FilePath $filePath -WindowStyle $style -PassThru
      }
      $result.message = "Started $filePath ($($argList.Count) argument(s)) (launched $style in background)"
      $result.pid = $proc.Id
      # Asynchronous focus guard and lookup for background launch:
      # Edge/Chrome or multi-instance apps may contact an existing instance and try to jump forward.
      # Watch for 1s: if an app window steals foreground, immediately push to bottom & restore user foreground!
      for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 50
        if ($style -eq 'Minimized' -or (Get-Dispatch) -eq 'background') {
          $curFg = [DshWin32]::GetForegroundWindow()
          if ($curFg -ne [IntPtr]::Zero -and $prevUserFg -ne [IntPtr]::Zero -and $curFg -ne $prevUserFg) {
            [DshWin32]::PushWindowToBottom($curFg) | Out-Null
            try { [DshWin32]::ForceForeground($prevUserFg) } catch { }
          }
        }
        if (-not $result.hwnd) {
          $wins = @([DshWin32]::EnumWindowsList() | Where-Object { $_.Pid -eq $proc.Id })
          if ($wins.Count -gt 0) { $result.hwnd = $wins[0].Hwnd.ToInt64() }
        }
      }
    }

    'mouse_move' {
      $app = Get-PayloadValue 'app'
      $x = [int](Get-PayloadValue 'x')
      $y = [int](Get-PayloadValue 'y')
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
      if ($dispatch -eq 'background') {
        # synthetic cursor only: the user's real mouse is never moved in background
        Notify-Cursor -X $sx -Y $sy -Label 'move'
        $result.method = 'overlay_cursor'
        $result.position = @{ x = $sx; y = $sy }
        $result.message = "mouse_move: synthetic cursor shown at ($sx, $sy); the real mouse was NOT moved (use dispatch=foreground to move it)"
      } else {
        [DshWin32]::MouseMove($sx, $sy)
        $result.method = 'send_input'
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
      [DshWin32]::ForceForeground($win.Hwnd)
      $fgHwnd = [DshWin32]::GetForegroundWindow()
      $activated = ($fgHwnd -eq $win.Hwnd -or [DshWin32]::IsChild($win.Hwnd, $fgHwnd))
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
      $result.hwnd = $targetHwnd.ToInt64()
      $result.title = $title
      $result.closed = [bool]$sendOk
      $result.message = "Closed window '$title' (hwnd=$($targetHwnd.ToInt64()))"
    }

    'get_window' {
      $app = Get-PayloadValue 'app'
      $idx = [int](Get-PayloadValue 'window_index')
      $hwndVal = Get-PayloadValue 'hwnd'
      $hwnd = if ($hwndVal) { [int64]$hwndVal } else { 0 }
      $win = Resolve-TargetWindow -App $app -Index $idx -Hwnd $hwnd
      $rect = [DshWin32]::GetDwmRect($win.Hwnd)
      $pname = Get-ProcessNameFast -ProcessId $win.Pid -Cache $null
      $isMin = [DshWin32]::IsIconic($win.Hwnd)
      $sb = New-Object System.Text.StringBuilder(512)
      $null = [DshWin32]::GetWindowText($win.Hwnd, $sb, 512)
      $title = $sb.ToString()
      $rectObj = @{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
      $winInfo = @{
        hwnd = $win.Hwnd.ToInt64()
        title = $title
        pid = $win.Pid
        process_name = $pname
        rect = $rectObj
        minimized = [bool]$isMin
        foreground = (-not $isMin -and ([DshWin32]::GetForegroundWindow() -eq $win.Hwnd))
      }
      $result.window = $winInfo
      $result.hwnd = $win.Hwnd.ToInt64()
      $result.title = $title
      $result.pid = $win.Pid
      $result.process_name = $pname
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
      # Start-Sleep -Seconds is int-typed in PS 5.1 — use Milliseconds so fractional durations work
      Start-Sleep -Milliseconds ([int]($dur * 1000))
      $result.duration_s = $dur
      $result.message = "Waited $dur second(s)"
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
      $result.width = $iw
      $result.height = $ih
      $result.rect = @{ x = $ix; y = $iy; width = $iw; height = $ih }
      $result.display = $disp
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

    'perform_action' {
      $app = Get-PayloadValue 'app'
      $element = [int](Get-PayloadValue 'element')
      $perform = ([string](Get-PayloadValue 'perform')).Trim().ToLowerInvariant()
      $supportedPerforms = 'invoke, press, click, toggle, switch, select, add_to_selection, remove_from_selection, expand, collapse, focus, set_focus, scroll_up, scroll_down, scroll_left, scroll_right'
      $dispatch = Get-Dispatch
      $win = Resolve-TargetWindow -App $app -Index ([int](Get-PayloadValue 'window_index'))
      if ($dispatch -eq 'foreground') {
        [DshWin32]::ForceForeground($win.Hwnd)
        Start-Sleep -Milliseconds 150
        $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
      }
      $el = Find-ElementByIndex -Hwnd $win.Hwnd -Index $element
      if ($dispatch -eq 'background') {
        $elRect = $el.Current.BoundingRectangle
        if ($elRect.Width -gt 0 -and $elRect.Height -gt 0) {
          Notify-Cursor -X (Safe-Int ($elRect.X + $elRect.Width / 2)) -Y (Safe-Int ($elRect.Y + $elRect.Height / 2)) -Label ('perform ' + $perform)
        }
      }
      if (-not $perform) {
        throw "perform_action requires 'perform' (supported: $supportedPerforms)"
      }
      if ($perform -in @('invoke', 'press', 'click')) {
        $ip = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
          throw "element $element does not support InvokePattern; cannot perform '$perform'"
        }
        $ip.Invoke()
        $result.method = 'invoke_pattern'
        $result.message = "Performed '$perform' on element $element via InvokePattern"
      } elseif ($perform -in @('toggle', 'switch')) {
        $tog = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tog)) {
          throw "element $element does not support TogglePattern; cannot perform '$perform'"
        }
        $tog.Toggle()
        $result.method = 'toggle_pattern'
        $result.message = "Performed '$perform' on element $element via TogglePattern"
      } elseif ($perform -eq 'select') {
        $sel = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
          throw "element $element does not support SelectionItemPattern; cannot perform '$perform'"
        }
        $sel.Select()
        $result.method = 'selection_pattern'
        $result.message = "Performed '$perform' on element $element via SelectionItemPattern"
      } elseif ($perform -eq 'add_to_selection') {
        $sel = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
          throw "element $element does not support SelectionItemPattern; cannot perform '$perform'"
        }
        $sel.AddToSelection()
        $result.method = 'selection_pattern'
        $result.message = "Performed '$perform' on element $element via SelectionItemPattern"
      } elseif ($perform -eq 'remove_from_selection') {
        $sel = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
          throw "element $element does not support SelectionItemPattern; cannot perform '$perform'"
        }
        $sel.RemoveFromSelection()
        $result.method = 'selection_pattern'
        $result.message = "Performed '$perform' on element $element via SelectionItemPattern"
      } elseif ($perform -eq 'expand') {
        $exp = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$exp)) {
          throw "element $element does not support ExpandCollapsePattern; cannot perform '$perform'"
        }
        $exp.Expand()
        $result.method = 'expand_pattern'
        $result.message = "Performed '$perform' on element $element via ExpandCollapsePattern"
      } elseif ($perform -eq 'collapse') {
        $exp = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$exp)) {
          throw "element $element does not support ExpandCollapsePattern; cannot perform '$perform'"
        }
        $exp.Collapse()
        $result.method = 'expand_pattern'
        $result.message = "Performed '$perform' on element $element via ExpandCollapsePattern"
      } elseif ($perform -in @('focus', 'set_focus')) {
        $el.SetFocus()
        $result.method = 'set_focus'
        $result.message = "Focused element $element"
      } elseif ($perform -in @('scroll_up', 'scroll_down', 'scroll_left', 'scroll_right')) {
        $scp = $null
        if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$scp)) {
          throw "element $element does not support ScrollPattern; cannot perform '$perform'"
        }
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
        [DshWin32]::ForceForeground($win.Hwnd)
        Start-Sleep -Milliseconds 150
        $result.focus_ok = ([DshWin32]::ForegroundHwnd() -eq $win.Hwnd.ToInt64())
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
  # Universal non-intrusive background guard: In background dispatch mode, the user's active window must NEVER be stolen!
  # If the target app (e.g. Edge/Chromium UIA Invoke, WM messages) activates itself,
  # immediately demote the target window to bottom and restore the user's active window!
  if ($dispatchMode -eq 'background' -and $Action -notin @('activate_window') -and $prevUserFg -ne [IntPtr]::Zero) {
    $curFg = [DshWin32]::GetForegroundWindow()
    if ($curFg -ne [IntPtr]::Zero -and $curFg -ne $prevUserFg) {
      [DshWin32]::PushWindowToBottom($curFg) | Out-Null
      try { [DshWin32]::ForceForeground($prevUserFg) } catch { }
    }
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
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
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
    try { $line = [Console]::In.ReadLine() } catch { break }
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
$script:payload = $null
$rawJson = ''
try {
  if ($PayloadStdin -or ((-not $PayloadJson) -and [Console]::IsInputRedirected)) {
    $rawJson = [Console]::In.ReadToEnd()
  }
  if ((-not $rawJson) -and $PayloadJson) {
    $rawJson = $PayloadJson
  }
  if ($rawJson -and $rawJson.Trim().Length -gt 0) {
    $script:payload = $rawJson | ConvertFrom-Json
  }
} catch {
  @{ ok = $false; action = $Action; message = "Invalid JSON payload: $($_.Exception.Message)" } | ConvertTo-Json -Compress
  exit 0
}

$out = Invoke-ActionRequest -Action $Action -Payload $script:payload
if ($out -is [System.Array] -and $out.Count -gt 0) { $out = $out[$out.Count - 1] }
[Console]::Out.Write(($out | ConvertTo-Json -Depth 10 -Compress))
