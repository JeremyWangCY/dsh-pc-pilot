Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class PilotTestWindow : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  public PilotTestWindow() {
    Text = "PC-Pilot native test fixture"; Width = 480; Height = 260;
    StartPosition = FormStartPosition.Manual; Left = 80; Top = 120;
    var editor = new TextBox { Left=20, Top=20, Width=400, Text="fixture text" };
    var button = new Button { Left=20, Top=80, Text="Minimize", Width=120 };
    button.Click += (s,e) => { WindowState = FormWindowState.Minimized; };
    Controls.Add(editor); Controls.Add(button);
    Shown += (s,e) => { SetWindowPos(Handle, new IntPtr(1),0,0,0,0,0x13); };
  }
}
'@ -ReferencedAssemblies System.Windows.Forms
[System.Windows.Forms.Application]::Run((New-Object PilotTestWindow))
