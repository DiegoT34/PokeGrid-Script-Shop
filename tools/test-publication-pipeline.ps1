param(
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$Id,
  [string]$RepositoryRoot = (Join-Path $env:LOCALAPPDATA 'PokeGrid-Shop-Publisher\repository')
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $ScriptPath).Path
$catalogPath = Join-Path $RepositoryRoot 'catalog.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$existing = @($catalog.scripts) | Where-Object { $_.id -eq $Id } | Select-Object -First 1
if (-not $existing) { throw "No existe $Id en el catálogo usado para la prueba." }
$code = Get-Content -LiteralPath $source -Raw -Encoding UTF8
$version = [regex]::Match($code, '(?im)^\s*//\s*@version\s+(.+?)\s*$').Groups[1].Value.Trim().TrimStart('v')
if ($version -match '^\d+\.\d+$') { $version = "$version.0" }

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("pokegrid-publisher-pipeline-" + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
  Copy-Item -LiteralPath $catalogPath -Destination (Join-Path $testRoot 'catalog.json')
  $parameters = @{
    Path=$source; Id=$Id; Category=[string]$existing.category; Tags=@($existing.tags)
    Permissions=@($existing.permissions); Summary=[string]$existing.summary
    Description=[string]$existing.description; Changelog="Prueba local $version"
    Author=[string]$existing.author; MinLauncherVersion=[string]$existing.minLauncherVersion
    Icon=[string]$existing.icon; Featured=($existing.featured -eq $true); RepositoryRoot=$testRoot
  }
  & (Join-Path $PSScriptRoot 'publish-script.ps1') @parameters | Out-Null
  $generatedCatalog = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $generated = @($generatedCatalog.scripts) | Where-Object { $_.id -eq $Id } | Select-Object -First 1
  $publishedPath = Join-Path $testRoot "scripts\$Id.user.js"
  $actualHash = (Get-FileHash -LiteralPath $publishedPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($generated.version -ne $version) { throw "La versión generada ($($generated.version)) no coincide con $version." }
  if ($generated.sha256 -ne $actualHash) { throw 'El SHA-256 generado no coincide con el archivo publicado.' }
  Write-Output "PokeGrid publication pipeline passed: $Id v$version and SHA-256 verified without publishing."
} finally {
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
