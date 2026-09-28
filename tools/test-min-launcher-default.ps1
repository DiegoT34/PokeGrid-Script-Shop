$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$expected = '0.22.1'

$gui = Get-Content -LiteralPath (Join-Path $root 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
$cli = Get-Content -LiteralPath (Join-Path $root 'tools\publish-script.ps1') -Raw -Encoding UTF8

if ($gui -match "minLauncherBox\.Text\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'") {
  $guiValue = $Matches[1]
} else {
  throw 'No se encontro una asignacion literal a minLauncherBox en la GUI.'
}
if ($cli -notmatch "\[string\]\`$MinLauncherVersion\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'") {
  throw 'No se encontro el valor por defecto de MinLauncherVersion en publish-script.ps1.'
}
$cliValue = $Matches[1]

if ($guiValue -ne $expected) { throw "La GUI propone minLauncherVersion '$guiValue' y debe ser '$expected'." }
if ($cliValue -ne $expected) { throw "El CLI propone minLauncherVersion '$cliValue' y debe ser '$expected'." }

$occurrences = ([regex]::Matches($gui, [regex]::Escape("minLauncherBox.Text='0.22.1'"))).Count
$occurrences += ([regex]::Matches($gui, [regex]::Escape("minLauncherBox.Text = '0.22.1'"))).Count
if ($occurrences -ne 3) { throw "Se esperaban 3 asignaciones de minLauncherBox a 0.22.1 (Clear, Load y valor inicial) y hay $occurrences." }
if ($gui -match '0\.22\.3') { throw 'La GUI todavia contiene 0.22.3, que la sube al publicar sin avisar.' }

$catalog = Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($item in @($catalog.scripts)) {
  if ([string]$item.minLauncherVersion -ne $expected) {
    throw "El catalogo declara '$($item.minLauncherVersion)' en '$($item.id)' y debe ser '$expected'."
  }
}
Write-Output "Min launcher default passed: GUI, CLI and catalog all declare $expected."
