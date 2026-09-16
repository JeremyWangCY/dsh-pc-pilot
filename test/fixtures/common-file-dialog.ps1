Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = 'PC-Pilot Common Dialog Fixture'
$dialog.FileName = 'fixture.txt'
$dialog.Filter = 'Text files (*.txt)|*.txt|All files (*.*)|*.*'
$null = $dialog.ShowDialog()
$dialog.Dispose()
