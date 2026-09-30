$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# El valor por defecto que la GUI y el CLI ofrecen. Es un invariante: los tres
# sitios tienen que proponer lo mismo.
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

$occurrences = ([regex]::Matches($gui, [regex]::Escape("minLauncherBox.Text='$expected'"))).Count
$occurrences += ([regex]::Matches($gui, [regex]::Escape("minLauncherBox.Text = '$expected'"))).Count
if ($occurrences -ne 3) { throw "Se esperaban 3 asignaciones de minLauncherBox a $expected (Clear, Load y valor inicial) y hay $occurrences." }
# La GUI no debe subirse la version por su cuenta al publicar: eso lo decide quien
# publica, no el valor precargado en el campo.
if ($gui -match "minLauncherBox\.Text\s*=\s*'0\.22\.(?!1')") {
  throw "La GUI propose una version de launcher distinta de ${expected}: la sube al publicar sin avisar."
}

# EL CATALOGO NO TIENE QUE SEGUIR AL DEFAULT. Un script ya publicado puede exigir un
# launcher mas nuevo que el que la GUI propone por defecto: es legitimo, es lo que
# quiere quien lo publico. Lo que no vale es una version que no exista, o vacia.
# Antes este test exigia $expected en cada entrada y fallaba en cuanto alguien
# publicaba algo que necesitaba un launcher mas reciente, que es justo su trabajo.
$catalog = Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$entries = @($catalog.scripts)
if ($entries.Count -eq 0) { throw 'El catalogo no tiene entradas.' }
foreach ($item in $entries) {
  $declared = [string]$item.minLauncherVersion
  if ($declared -notmatch '^\d+\.\d+\.\d+$') {
    throw "El catalogo declara '$declared' en '$($item.id)' y no es una version valida."
  }
  # [version] y no [double]: una version tiene tres partes y no es un decimal.
  if ([version]$declared -lt [version]'0.22.1') {
    throw "El catalogo declara '$declared' en '$($item.id)', por debajo del minimo que soporta el publicador ($expected)."
  }
}
Write-Output "Min launcher default passed: GUI and CLI both offer $expected, and all $($entries.Count) catalog entries declare a valid version at or above it."
