param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9._-]{1,79}$')][string]$Id,
  [ValidateSet('Auto','New','Update')][string]$PublicationMode = 'Auto',
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
$maxScriptBytes = 10MB
$source = (Resolve-Path -LiteralPath $Path).Path
$sourceInfo = Get-Item -LiteralPath $source
if (-not $sourceInfo.PSIsContainer -and $sourceInfo.Length -gt 0 -and $sourceInfo.Length -le $maxScriptBytes) {
  # válido
} else {
  throw 'El script debe ser un archivo no vacío y no superar 10 MB.'
}
if ($sourceInfo.Name -notmatch '(?i)(?:\.user)?\.js$') { throw 'El archivo debe ser .js o .user.js.' }

$code = Get-Content -LiteralPath $source -Raw -Encoding UTF8
if ($code -notmatch '(?is)//\s*==UserScript==.*?//\s*==/UserScript==') { throw 'Falta el bloque ==UserScript==.' }

function Read-Metadata([string]$Name) {
  $match = [regex]::Match($code, "(?im)^\s*//\s*@$([regex]::Escape($Name))\s+(.+?)\s*$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ''
}

function Read-MetadataList([string]$Name) {
  return @([regex]::Matches($code, "(?im)^\s*//\s*@$([regex]::Escape($Name))\s+(.+?)\s*$") |
    ForEach-Object { $_.Groups[1].Value.Trim() } | Where-Object { $_ } | Select-Object -Unique)
}

function Game-Labels([string[]]$Patterns, [string[]]$DeclaredGames) {
  $labels = [Collections.Generic.List[string]]::new()
  $add = {
    param([string]$Label)
    $clean = $Label.Trim()
    if ($clean -and -not ($labels | Where-Object { $_ -ieq $clean })) { $labels.Add($clean.Substring(0,[Math]::Min(80,$clean.Length))) }
  }
  foreach($declared in @($DeclaredGames)){& $add $declared}
  if($labels.Count){return @($labels|Select-Object -First 8)}
  foreach($pattern in @($Patterns)){
    if($pattern -eq '<all_urls>'){& $add 'Todos los juegos';continue}
    $gameHost=[regex]::Match($pattern,'^(?:\*|https?)://([^/]+)',[Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value.ToLowerInvariant()
    if(-not $gameHost -or $gameHost -eq '*'){continue}
    $gameHost=$gameHost -replace '^\*\.','' -replace '^www\.',''
    if($gameHost -eq 'poke.idleworld.online'){& $add 'Poke Idle World'}else{& $add $gameHost}
  }
  if(-not $labels.Count){& $add 'Poke Idle World'}
  return @($labels|Select-Object -First 8)
}

$name = Read-Metadata 'name'
$namespace = Read-Metadata 'namespace'
$version = (Read-Metadata 'version').TrimStart('v')
$metadataDescription = Read-Metadata 'description'
$metadataAuthor = Read-Metadata 'author'
$games = Game-Labels -Patterns @((Read-MetadataList 'match') + (Read-MetadataList 'include')) -DeclaredGames (Read-MetadataList 'game')
if ($version -match '^\d+\.\d+$') { $version = "$version.0" }
if (-not $name -or -not $namespace -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+].*)?$') {
  throw 'El script debe declarar @name, @namespace y @version X.Y.Z.'
}

$catalogPath = Join-Path $repoRoot 'catalog.json'
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw 'No se encontró catalog.json en el repositorio de la Shop.' }
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$existingById = @($catalog.scripts) | Where-Object { [string]$_.id -ieq $Id } | Select-Object -First 1
$identityMatches = @(@($catalog.scripts) | Where-Object {
  ([string]$_.name).Trim() -ieq $name.Trim() -and ([string]$_.namespace).Trim() -ieq $namespace.Trim()
})
if ($identityMatches.Count -gt 1) { throw "El catálogo contiene varias entradas para $name y su namespace." }
$existingByIdentity = $identityMatches | Select-Object -First 1

$operationMode = $PublicationMode
if ($operationMode -eq 'Auto') { $operationMode = $(if ($existingById) { 'Update' } else { 'New' }) }
if ($operationMode -eq 'New') {
  if ($existingById) { throw "El ID '$Id' ya pertenece a $($existingById.name). Selecciona Actualización o usa otro ID para el script nuevo." }
  if ($existingByIdentity) { throw "Este script ya existe como '$($existingByIdentity.id)'. Cárgalo como actualización para conservar su identidad." }
} else {
  if (-not $existingById) { throw "No existe una publicación con el ID '$Id'. Vuelve a cargar el archivo para publicarlo como script nuevo." }
  if (([string]$existingById.name).Trim() -ine $name.Trim() -or ([string]$existingById.namespace).Trim() -ine $namespace.Trim()) {
    throw "El archivo seleccionado no corresponde a '$Id'. El nombre o namespace no coincide con la publicación existente."
  }
  # Publicar sobre una version anterior o igual no cambia nada en la Shop y
  # genera un commit inutil, asi que se detiene antes de escribir archivos.
  if ([Version]$existingById.version -ge [Version]$version) {
    throw "La publicación '$Id' ya está en la versión $($existingById.version) o superior. Sube @version en el archivo antes de publicar."
  }
}

$targetName = "$Id.user.js"
$targetDir = Join-Path $repoRoot 'scripts'
$target = Join-Path $targetDir $targetName

# Estado previo: si la escritura del catalogo falla tras copiar el userscript,
# el repositorio queda con un archivo que ningun SHA-256 del catalogo describe.
$catalogExisted = Test-Path -LiteralPath $catalogPath -PathType Leaf
$catalogBytes = if ($catalogExisted) { [IO.File]::ReadAllBytes($catalogPath) } else { $null }
$targetExisted = Test-Path -LiteralPath $target -PathType Leaf
$targetBytes = if ($targetExisted) { [IO.File]::ReadAllBytes($target) } else { $null }

try {
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  $publishedCode = [regex]::Replace($code, '(?im)^(\s*//\s*@version\s+).+?\s*$', "`${1}$version", 1)
  $publishedCode = $publishedCode -replace "\r\n?", "`n"
  [IO.File]::WriteAllText($target, $publishedCode, [Text.UTF8Encoding]::new($false))
  $sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  $publishedAt = if ($operationMode -eq 'Update' -and $existingById.publishedAt) { [string]$existingById.publishedAt } else { [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }
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
    games = @($games)
    permissions = @($Permissions)
    minLauncherVersion = $MinLauncherVersion
    downloadUrl = "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/$targetName"
    sha256 = $sha256
    homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
    changelog = $(if ($Changelog) { $Changelog } else { "Publicación $version" })
    icon = $Icon
    featured = [bool]$Featured
    publishedAt = $publishedAt
  }
  $remaining = @($catalog.scripts | Where-Object { $_.id -ne $Id })
  $catalog.scripts = @([pscustomobject]$entry) + $remaining
  $catalog.updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $catalogJson = $catalog | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($catalogPath, $catalogJson, [Text.UTF8Encoding]::new($false))
} catch {
  # El userscript es la garantia critica: describiria un estado que ningun
  # SHA-256 del catalogo cubre. El catalogo suele estar intacto, porque su
  # escritura es la que fallo, pero se intenta restaurar sin dejar que un
  # segundo fallo tape el error original.
  try {
    if ($targetExisted) { [IO.File]::WriteAllBytes($target, $targetBytes) }
    elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  } catch {
    Write-Host "AVISO  No se pudo deshacer scripts\$Id.user.js: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  try {
    if ($catalogExisted) { [IO.File]::WriteAllBytes($catalogPath, $catalogBytes) }
  } catch {
    Write-Host "AVISO  No se pudo restaurar catalog.json: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  throw
}

$operationLabel = $(if ($operationMode -eq 'New') { 'script nuevo' } else { 'actualización' })
Write-Host "Preparado como ${operationLabel}: $targetName" -ForegroundColor Green
Write-Host "Versión: $version"
Write-Host "SHA-256: $sha256"
Write-Host 'Revisa catalog.json y luego ejecuta:'
Write-Host '  git add catalog.json scripts/'
Write-Host "  git commit -m 'Publicar $name $version'"
Write-Host '  git push'
