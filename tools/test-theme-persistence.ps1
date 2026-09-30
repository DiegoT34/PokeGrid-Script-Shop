$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$path = Get-PokeGridThemePath
Assert ($path -like '*PokeGrid-Shop-Publisher*') "La ruta del tema no apunta a la carpeta del Publisher: $path"
$existed = Test-Path -LiteralPath $path
$backup = if ($existed) { [IO.File]::ReadAllBytes($path) } else { $null }
try {
  if ($existed) { Remove-Item -LiteralPath $path -Force }

  # Sin archivo, clave por defecto.
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Sin archivo deberia usarse crystal-dark.'

  Save-PokeGridTheme 'midnight'
  Assert ((Read-PokeGridThemeKey) -eq 'midnight') 'La clave guardada no se leyo de vuelta.'

  # Un archivo corrupto no debe romper el arranque.
  [IO.File]::WriteAllText($path, "clave-que-no-existe`r`n")
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Una clave desconocida debio caer al tema por defecto.'

  [IO.File]::WriteAllText($path, '')
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Un archivo vacio debio caer al tema por defecto.'

  # Basura binaria tampoco.
  [IO.File]::WriteAllText($path, [char]0xFF + [char]0xFE + 'basura')
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Un archivo binario debio caer al tema por defecto.'

  Write-Output 'Theme persistence passed: default, round-trip and three corrupt-file recoveries.'
} finally {
  if ($existed) { [IO.File]::WriteAllBytes($path, $backup) }
  elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
