$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\..\lib\pc-pilot-helper.ps1", [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { Write-Output $errors[0].Message; exit 1 }
Write-Output 'PS_PARSE_OK'
