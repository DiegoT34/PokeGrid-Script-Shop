param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9._-]{1,79}$')][string]$Id,
  [string]$Category = 'Utilidades',
  [string[]]$Tags = @(),
  [string[]]$Permissions = @(),
  [string]$Summary = '',
  [string]$Description = '',
  [string]$Changelog = '',
  [string]$Author = '',
  [string]$MinLauncherVersion = '0.22.1',
  [string]$Icon = '🧩',
  [string]$RepositoryRoot = '',
  [switch]$Featured
)

$ErrorActionPreference = 'Stop'
$repoRoot = if ($RepositoryRoot) { [IO.Path]::GetFullPath($RepositoryRoot) } else { Split-Path -Parent $PSScriptRoot }
$source = (Resolve-Path -LiteralPath $Path).Path
$sourceInfo = Get-Item -LiteralPath $source
if (-not $sourceInfo.PSIsContainer -and $sourceInfo.Length -gt 0 -and $sourceInfo.Length -le 1000000) {
  # válido
} else {
  throw 'El script debe ser un archivo no vacío y no superar 1 MB.'
}
if ($sourceInfo.Name -notmatch '(?i)(?:\.user)?\.js$') { throw 'El archivo debe ser .js o .user.js.' }

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
$metadataDescription = Read-Metadata 'description'
$metadataAuthor = Read-Metadata 'author'
if ($version -match '^\d+\.\d+$') { $version = "$version.0" }
if (-not $name -or -not $namespace -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+].*)?$') {
  throw 'El script debe declarar @name, @namespace y @version X.Y.Z.'
}

$targetName = "$Id.user.js"
$targetDir = Join-Path $repoRoot 'scripts'
$target = Join-Path $targetDir $targetName
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
$publishedCode = [regex]::Replace($code, '(?im)^(\s*//\s*@version\s+).+?\s*$', "`${1}$version", 1)
$publishedCode = $publishedCode -replace "\r\n?", "`n"
[IO.File]::WriteAllText($target, $publishedCode, [Text.UTF8Encoding]::new($false))
$sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
$catalogPath = Join-Path $repoRoot 'catalog.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = [ordered]@{
  id = $Id
  name = $name
  namespace = $namespace
  version = $version
  author = $(if ($Author) { $Author } elseif ($metadataAuthor) { $metadataAuthor } else { 'DiegoT34' })
  summary = $(if ($Summary) { $Summary } elseif ($metadataDescription) { $metadataDescription } else { $name })
  description = $(if ($Description) { $Description } elseif ($metadataDescription) { $metadataDescription } else { $name })
  category = $Category
  tags = @($Tags)
  permissions = @($Permissions)
  minLauncherVersion = $MinLauncherVersion
  downloadUrl = "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/$targetName"
  sha256 = $sha256
  homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
  changelog = $(if ($Changelog) { $Changelog } else { "Publicación $version" })
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
