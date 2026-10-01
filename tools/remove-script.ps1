param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9._-]{1,79}$')][string]$Id,
  [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$catalogPath = Join-Path $repoRoot 'catalog.json'
$scriptsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'scripts'))
$shotsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'screenshots'))
$targetPath = [IO.Path]::GetFullPath((Join-Path $scriptsRoot "$Id.user.js"))

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git') -PathType Container)) {
  throw 'La carpeta seleccionada no es el repositorio Git de la Script Shop.'
}
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
  throw 'No se encontró catalog.json en el repositorio de la Shop.'
}
if (-not $targetPath.StartsWith($scriptsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'La ruta calculada del userscript no es segura.'
}
if (-not $shotsRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'La ruta calculada de screenshots/ no es segura.'
}

$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$catalog.schemaVersion -ne 1 -or -not ($catalog.scripts -is [Array])) {
  throw 'catalog.json no utiliza un formato compatible.'
}
$entry = @($catalog.scripts) | Where-Object { [string]$_.id -ceq $Id } | Select-Object -First 1
if (-not $entry) { throw "El script '$Id' ya no existe en el catálogo." }

$catalog.scripts = @($catalog.scripts | Where-Object { [string]$_.id -cne $Id })
$catalog.updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$catalogJson = $catalog | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($catalogPath, $catalogJson, [Text.UTF8Encoding]::new($false))

$fileRemoved = $false
if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
  Remove-Item -LiteralPath $targetPath -Force
  $fileRemoved = $true
}

# Las capturas del script retirado. Sin esto se acumulan archivos huerfanos en
# screenshots/ que ninguna entrada del catalogo describe, y el repositorio crece sin que
# nadie sepa por que. Es el mismo motivo por el que la retirada ya borra el userscript.
#
# El patron es el prefijo con el guion, que es lo que genera el publicador. El nombre
# original del archivo no existe, y con el hay dos capturas que se llamarian igual y una
# seria de otro script.
#
# El borrado se acota a la carpeta Y se revalida cada ruta una a una. Un -Recurse desde la
# raiz del repositorio se lleva por delante lo que este alrededor, y con un id como
# "se-van" el nombre casaria con archivos de otras carpetas. La prueba pone un senuelo
# justo para eso.
$shotsRemoved = @()
if (Test-Path -LiteralPath $shotsRoot -PathType Container) {
  foreach ($shot in @(Get-ChildItem -LiteralPath $shotsRoot -File -Filter "$Id-*" -ErrorAction SilentlyContinue)) {
    $shotPath = [IO.Path]::GetFullPath($shot.FullName)
    if (-not $shotPath.StartsWith($shotsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { continue }
    try {
      Remove-Item -LiteralPath $shotPath -Force
      $shotsRemoved += $shot.Name
    } catch {
      Write-Host "AVISO  No se pudo borrar la captura $($shot.Name): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

# Se emite como JSON y no como PSCustomObject porque este script se invoca en un subproceso,
# y ahi un PSCustomObject llega al padre formateado como tabla, en lineas de texto. Quien
# lo lee tiene que adivinar el formato. Con JSON no hay que adivinar nada: el padre lo
# parsea con ConvertFrom-Json y listo.
[ordered]@{
  Id = $Id
  Name = [string]$entry.name
  Version = [string]$entry.version
  Target = "scripts/$Id.user.js"
  FileRemoved = [bool]$fileRemoved
  ScreenshotsRemoved = @($shotsRemoved)
  Remaining = @($catalog.scripts).Count
} | ConvertTo-Json -Depth 4
