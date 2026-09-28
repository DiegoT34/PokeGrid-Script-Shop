$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$problems = [Collections.Generic.List[string]]::new()

$all = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
  $_.FullName -notlike '*\dist\*' -and $_.FullName -notlike '*\.superpowers\*'
}

# -Include con -Recurse y -LiteralPath no filtra de forma fiable en Windows
# PowerShell 5.1: llega .md, .json y .user.js al bucle de .ps1. Se filtra por
# extension explicita para que el test mida lo que dice medir.
foreach ($file in $all | Where-Object { $_.Extension -eq '.ps1' }) {
  $raw = [IO.File]::ReadAllBytes($file.FullName)
  $hasBom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
  $nonAscii = ([regex]::Matches([IO.File]::ReadAllText($file.FullName), '[^\x00-\x7F]')).Count
  if ($nonAscii -gt 0 -and -not $hasBom) {
    $problems.Add("$($file.Name) tiene $nonAscii caracteres no ASCII y no lleva BOM: Windows PowerShell 5.1 los mostrara rotos.")
  }
}
foreach ($file in $all | Where-Object { $_.Extension -eq '.cmd' }) {
  $raw = [IO.File]::ReadAllBytes($file.FullName)
  if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
    $problems.Add("$($file.Name) lleva BOM: un .cmd con BOM no se ejecuta correctamente en Windows.")
  }
  if (([regex]::Matches([IO.File]::ReadAllText($file.FullName), '[^\x00-\x7F]')).Count -gt 0) {
    $problems.Add("$($file.Name) tiene caracteres no ASCII: el .cmd debe ser ASCII puro.")
  }
}
if ($problems.Count) {
  foreach ($p in $problems) { Write-Host "  ERROR  $p" -ForegroundColor Red }
  throw "Encoding incorrecto en $($problems.Count) archivo(s)."
}
Write-Output 'PowerShell encoding passed: every .ps1 with accents has a BOM and every .cmd is ASCII without BOM.'
