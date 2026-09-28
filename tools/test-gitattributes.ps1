$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lines = @(Get-Content -LiteralPath (Join-Path $root '.gitattributes') -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })

if ($lines -notcontains '* text=auto eol=lf') {
  throw 'Falta "* text=auto eol=lf": con core.autocrlf=true los finales de linea dependen de cada maquina.'
}
# Sin esta regla, Git escribe los .user.js con CRLF, sus SHA-256 dejan de
# coincidir y los 6 scripts publicados quedan invalidados a la vez.
if ($lines -notcontains 'scripts/*.user.js text eol=lf') {
  throw 'Falta "scripts/*.user.js text eol=lf": sin ella los SHA-256 del catalogo se invalidan en bloque.'
}
Write-Output 'Git attributes passed: universal LF and the userscript rule that protects every SHA-256.'
