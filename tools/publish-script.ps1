param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9._-]{1,79}$')][string]$Id,
  [string]$Category = 'Utilidades',
  [string[]]$Tags = @(),
  [string[]]$Permissions = @(),
  [string]$MinLauncherVersion = '0.22.0',
  [string]$Icon = '🧩',
  [switch]$Featured
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = (Resolve-Path -LiteralPath $Path).Path
$sourceInfo = Get-Item -LiteralPath $source
if (-not $sourceInfo.PSIsContainer -and $sourceInfo.Length -gt 0 -and $sourceInfo.Length -le 1000000) {
  # válido
} else {
  throw 'El script debe ser un archivo no vacío y no superar 1 MB.'
}
if ($sourceInfo.Name -notmatch '(?i)\.user\.js$') { throw 'El archivo debe terminar en .user.js.' }

$code = Get-Content -LiteralPath $source -Raw -Encoding UTF8
if ($code -notmatch '(?is)//\s*==UserScript==.*?//\s*==/UserScript==') { throw 'Falta el bloque ==UserScript==.' }

function Read-Metadata([string]$Name) {
  $match = [regex]::Match($code, "(?im)^\s*//\s*@$([regex]::Escape($Name))\s+(.+?)\s*$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ''
}

$name = Read-Metadata 'name'
$namespace = Read-Metadata 'namespace'
$version = (Read-Metadata 'version').TrimStart('v')
$summary = Read-Metadata 'description'
$author = Read-Metadata 'author'
if (-not $name -or -not $namespace -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+].*)?$') {
  throw 'El script debe declarar @name, @namespace y @version X.Y.Z.'
}

$targetName = "$Id.user.js"
$targetDir = Join-Path $repoRoot 'scripts'
$target = Join-Path $targetDir $targetName
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
$sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
$catalogPath = Join-Path $repoRoot 'catalog.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = [ordered]@{
  id = $Id
  name = $name
  namespace = $namespace
  version = $version
  author = $(if ($author) { $author } else { 'DiegoT34' })
  summary = $(if ($summary) { $summary } else { $name })
  description = $(if ($summary) { $summary } else { $name })
  category = $Category
  tags = @($Tags)
  permissions = @($Permissions)
  minLauncherVersion = $MinLauncherVersion
  downloadUrl = "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/$targetName"
  sha256 = $sha256
  homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
  changelog = "Publicación $version"
  icon = $Icon
  featured = [bool]$Featured
  publishedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$remaining = @($catalog.scripts | Where-Object { $_.id -ne $Id })
$catalog.scripts = @([pscustomobject]$entry) + $remaining
$catalog.updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$catalog | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $catalogPath -Encoding UTF8

Write-Host "Preparado: $targetName" -ForegroundColor Green
Write-Host "Versión: $version"
Write-Host "SHA-256: $sha256"
Write-Host 'Revisa catalog.json y luego ejecuta:'
Write-Host '  git add catalog.json scripts/'
Write-Host "  git commit -m 'Publicar $name $version'"
Write-Host '  git push'
