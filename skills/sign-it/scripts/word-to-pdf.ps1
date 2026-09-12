param([Parameter(Mandatory=$true)][string]$In, [Parameter(Mandatory=$true)][string]$Out)
# sign-it convert, Word path: export a Word document to PDF through Word's COM
# automation (WSL calls this via powershell.exe when WINWORD.EXE is installed).
# Read-only open, no alerts, PDF export format 17, Word quits on every path.
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($In, $false, $true)
  $doc.ExportAsFixedFormat($Out, 17)
  $doc.Close(0)
  Write-Output "ok $Out"
} finally {
  $word.Quit()
}
