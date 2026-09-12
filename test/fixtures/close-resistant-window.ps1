Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Windows.Forms;
public class CloseResistantWindow : Form {
  public CloseResistantWindow() {
    Text = "PC-Pilot close-resistant fixture";
    Width = 420; Height = 180;
    StartPosition = FormStartPosition.Manual; Left = 80; Top = 120;
    FormClosing += (sender, args) => { args.Cancel = true; };
  }
}
'@ -ReferencedAssemblies System.Windows.Forms
[System.Windows.Forms.Application]::Run((New-Object CloseResistantWindow))
