param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9._-]{1,79}$')][string]$Id,
  [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$catalogPath = Join-Path $repoRoot 'catalog.json'
$scriptsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'scripts'))
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

[pscustomobject]@{
  Id = $Id
  Name = [string]$entry.name
  Version = [string]$entry.version
  Target = "scripts/$Id.user.js"
  FileRemoved = $fileRemoved
  Remaining = @($catalog.scripts).Count
}
