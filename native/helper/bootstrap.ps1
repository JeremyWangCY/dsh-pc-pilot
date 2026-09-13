# dsh computer-use helper (Windows PowerShell 5.1)
# Background synthetic-cursor semantics per cua-driver's Windows recipe:
#   dispatch=background (default): UIA patterns first, then pixel hit-test, then
#   WM_CHAR/WM_KEY/WM_MOUSEWHEEL messages. Never steals foreground. Actions that
#   cannot run in background return background_unavailable (caller may retry with
#   dispatch=foreground = real SendInput).
# Actions: list_apps, list_windows, get_window, launch_app, get_window_state,
#   click, press_key, type_text, scroll, drag, set_value,
#   perform_secondary_action, activate_window, select_text, screenshot,
#   zoom, switch_display, cursor_position, list_windows, wait. Usage: powershell -NoProfile -ExecutionPolicy Bypass
#   -File <this> -Action <action> -PayloadStdin (or -PayloadJson "<json>"); writes ONE JSON doc to stdout.
param(
  [string]$Action,
  [string]$PayloadJson = '',
  [switch]$PayloadStdin,
  [ValidateRange(100, 180000)]
  [int]$TimeoutMs = 20000,
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
$script:lastScreenshot = $null

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
  public delegate bool EnumChildWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildWindowsProc lpEnumFunc, IntPtr lParam);
  public static IntPtr FindDescendantByClass(IntPtr parent, string wantedClass)
  {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (h, p) => {
      var name = new StringBuilder(128);
      GetClassName(h, name, name.Capacity);
      if (string.Equals(name.ToString(), wantedClass, StringComparison.Ordinal)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);
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
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
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

  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetApplicationUserModelId(IntPtr hProcess, ref uint applicationUserModelIdLength, StringBuilder applicationUserModelId);

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION
  {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(
    IntPtr processHandle,
    int processInformationClass,
    ref PROCESS_BASIC_INFORMATION processInformation,
    int processInformationLength,
    out int returnLength);

  public static string QueryProcessImagePath(uint pid)
  {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return null;
    try
    {
      uint size = 32768;
      var sb = new StringBuilder((int)size);
      return QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString() : null;
    }
    finally { CloseHandle(h); }
  }

  public static string QueryProcessAumid(uint pid)
  {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return null;
    try
    {
      uint size = 0;
      int rc = GetApplicationUserModelId(h, ref size, null);
      if (size == 0 || (rc != 0 && rc != 122)) return null;
      var sb = new StringBuilder((int)size);
      rc = GetApplicationUserModelId(h, ref size, sb);
      return rc == 0 ? sb.ToString() : null;
    }
    finally { CloseHandle(h); }
  }

  public static uint QueryParentProcessId(uint pid)
  {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return 0;
    try
    {
      PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
      int returned;
      int rc = NtQueryInformationProcess(h, 0, ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned);
      return rc == 0 ? unchecked((uint)info.InheritedFromUniqueProcessId.ToInt64()) : 0;
    }
    finally { CloseHandle(h); }
  }

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

  public static void MouseMoveWithModifiers(int x, int y, string modifiers)
  {
    string ignored; List<ushort> mods;
    ParseChord("", modifiers, out ignored, out mods);
    foreach (ushort m in mods) SendInput(1, new INPUT[] { MkKey(m, 0) }, Marshal.SizeOf(typeof(INPUT)));
    try { MouseMove(x, y); }
    finally { for (int i = mods.Count - 1; i >= 0; i--) SendInput(1, new INPUT[] { MkKey(mods[i], 2) }, Marshal.SizeOf(typeof(INPUT))); }
  }

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
    uint mouseData = 0;
    string b = (button ?? "left").Trim().ToLowerInvariant();
    if (b == "right") { downF = 0x0008; upF = 0x0010; }
    else if (b == "middle") { downF = 0x0020; upF = 0x0040; }
    else if (b == "back") { downF = 0x0080; upF = 0x0100; mouseData = 0x0001; }
    else if (b == "forward") { downF = 0x0080; upF = 0x0100; mouseData = 0x0002; }
    if (count < 1) count = 1;
    if (count > 3) count = 3;
    for (int i = 0; i < count; i++)
    {
      INPUT[] d = new INPUT[] { MkMouse(downF, mouseData) };
      INPUT[] u = new INPUT[] { MkMouse(upF, mouseData) };
      SendInput(1, d, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(25);
      SendInput(1, u, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(25);
    }
  }

  public static void MouseClickExWithModifiers(int x, int y, int count, string button, string modifiers)
  {
    string ignored; List<ushort> mods;
    ParseChord("", modifiers, out ignored, out mods);
    foreach (ushort m in mods) SendInput(1, new INPUT[] { MkKey(m, 0) }, Marshal.SizeOf(typeof(INPUT)));
    try { MouseClickEx(x, y, count, button); }
    finally { for (int i = mods.Count - 1; i >= 0; i--) SendInput(1, new INPUT[] { MkKey(mods[i], 2) }, Marshal.SizeOf(typeof(INPUT))); }
  }

  public static void Scroll(int x, int y, int amount, bool down)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    uint data = (uint)((down ? -1 : 1) * amount * 120);
    INPUT[] ev = new INPUT[] { MkMouse(0x0800, data) };
    SendInput(1, ev, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void ScrollWithModifiers(int x, int y, int amount, bool down, string modifiers)
  {
    string ignored; List<ushort> mods;
    ParseChord("", modifiers, out ignored, out mods);
    foreach (ushort m in mods) SendInput(1, new INPUT[] { MkKey(m, 0) }, Marshal.SizeOf(typeof(INPUT)));
    try { Scroll(x, y, amount, down); }
    finally { for (int i = mods.Count - 1; i >= 0; i--) SendInput(1, new INPUT[] { MkKey(mods[i], 2) }, Marshal.SizeOf(typeof(INPUT))); }
  }

  // horizontal wheel (WM_MOUSEHWHEEL equivalent): positive delta = scroll right
  public static void ScrollH(int x, int y, int amount, bool right)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    uint data = (uint)((right ? 1 : -1) * amount * 120);
    INPUT[] ev = new INPUT[] { MkMouse(0x1000, data) };
    SendInput(1, ev, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void ScrollHWithModifiers(int x, int y, int amount, bool right, string modifiers)
  {
    string ignored; List<ushort> mods;
    ParseChord("", modifiers, out ignored, out mods);
    foreach (ushort m in mods) SendInput(1, new INPUT[] { MkKey(m, 0) }, Marshal.SizeOf(typeof(INPUT)));
    try { ScrollH(x, y, amount, right); }
    finally { for (int i = mods.Count - 1; i >= 0; i--) SendInput(1, new INPUT[] { MkKey(mods[i], 2) }, Marshal.SizeOf(typeof(INPUT))); }
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

  public static void DragPath(int[] xs, int[] ys)
  {
    if (xs == null || ys == null || xs.Length < 2 || xs.Length != ys.Length) throw new Exception("drag path requires at least two points");
    SetCursorPos(xs[0], ys[0]); System.Threading.Thread.Sleep(60);
    SendInput(1, new INPUT[] { MkMouse(0x0002, 0) }, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(60);
    for (int i = 1; i < xs.Length; i++)
    {
      int distance = Math.Abs(xs[i] - xs[i - 1]) + Math.Abs(ys[i] - ys[i - 1]);
      int steps = Math.Max(1, distance / 12);
      for (int j = 1; j <= steps; j++)
      {
        int cx = xs[i - 1] + (xs[i] - xs[i - 1]) * j / steps;
        int cy = ys[i - 1] + (ys[i] - ys[i - 1]) * j / steps;
        SetCursorPos(cx, cy); System.Threading.Thread.Sleep(8);
      }
    }
    System.Threading.Thread.Sleep(60);
    SendInput(1, new INPUT[] { MkMouse(0x0004, 0) }, Marshal.SizeOf(typeof(INPUT))); System.Threading.Thread.Sleep(30);
  }

  public static void DragPathWithModifiers(int[] xs, int[] ys, string modifiers)
  {
    string ignored; List<ushort> mods;
    ParseChord("", modifiers, out ignored, out mods);
    foreach (ushort m in mods) SendInput(1, new INPUT[] { MkKey(m, 0) }, Marshal.SizeOf(typeof(INPUT)));
    try { DragPath(xs, ys); }
    finally { for (int i = mods.Count - 1; i >= 0; i--) SendInput(1, new INPUT[] { MkKey(mods[i], 2) }, Marshal.SizeOf(typeof(INPUT))); }
  }

  public static void MouseDown(int x, int y, string button)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(30);
    uint flag = 0x0002;
    uint mouseData = 0;
    string b = (button ?? "left").Trim().ToLowerInvariant();
    if (b == "right") flag = 0x0008;
    else if (b == "middle") flag = 0x0020;
    else if (b == "back") { flag = 0x0080; mouseData = 0x0001; }
    else if (b == "forward") { flag = 0x0080; mouseData = 0x0002; }
    INPUT[] d = new INPUT[] { MkMouse(flag, mouseData) };
    SendInput(1, d, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MouseUp(int x, int y, string button)
  {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(30);
    uint flag = 0x0004;
    uint mouseData = 0;
    string b = (button ?? "left").Trim().ToLowerInvariant();
    if (b == "right") flag = 0x0010;
    else if (b == "middle") flag = 0x0040;
    else if (b == "back") { flag = 0x0100; mouseData = 0x0001; }
    else if (b == "forward") { flag = 0x0100; mouseData = 0x0002; }
    INPUT[] u = new INPUT[] { MkMouse(flag, mouseData) };
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

// UIA providers can block inside unmanaged calls. A PowerShell stopwatch cannot
// interrupt those calls; the one-shot process owns a managed watchdog instead.
public static class PcPilotDeadline
{
  private static System.Threading.Timer timer;
  private static readonly object gate = new object();
  public static void Start(int milliseconds, string reply)
  {
    timer = new System.Threading.Timer(delegate(object state) {
      lock (gate) {
        Console.Out.Write(reply);
        Console.Out.Flush();
        Environment.Exit(124);
      }
    }, null, milliseconds, System.Threading.Timeout.Infinite);
  }
  public static void WriteReply(string reply)
  {
    lock (gate) {
      if (timer != null) { timer.Dispose(); timer = null; }
      Console.Out.Write(reply);
      Console.Out.Flush();
    }
  }
}
'@

[DshWin32]::InitDpiAwareness()

# ---------------------------------------------------------------- payload / window helpers
