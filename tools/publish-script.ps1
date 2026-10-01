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
  [switch]$Featured,
  [string[]]$Screenshots = @()
)

$ErrorActionPreference = 'Stop'
$repoRoot = if ($RepositoryRoot) { [IO.Path]::GetFullPath($RepositoryRoot) } else { Split-Path -Parent $PSScriptRoot }
$maxScriptBytes = 10MB
# El mismo contrato que aplica el launcher en src/script-shop-screenshots.js. Si un
# dia divergen, el launcher tiene razon: es el que decide si la captura se ve.
$maxShotBytes = 2MB
$maxShots = 6
$shotsBase = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots'
$shotExtensionPattern = '^(?i)\.(?:png|jpg|jpeg|webp|gif)$'
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

# Capturas: se copian con un nombre GENERADO a partir del id y la posicion. El
# nombre del archivo que elige la persona no se usa, y esa es toda la proteccion:
# el prefijo con el id es lo que impide que un script se apropie de las capturas
# de otro, asi que respetarlo inutilitaria la regla. Solo se lee la extension.
$shotsDir = Join-Path $repoRoot 'screenshots'
$shotWarnings = [Collections.Generic.List[string]]::new()
$shotNames = [Collections.Generic.List[string]]::new()
$shotState = @()

# El numero de la siguiente captura NO empieza en cero si el script ya tenia fotos.
#
# Sin esto, publicar una captura nueva sobre un script que ya tenia una la SOBRESCRIBE:
# el nombre generado seria otra vez <id>-1.png, y la foto nueva se comia el sitio de la
# vieja sin avisar ni dejar rastro. Verificado antes de escribir estas lineas.
$shotNext = 1
$previas = @()
if ($existingById) { $previas = @($existingById.screenshots | Where-Object { [string]$_ }) }
foreach ($previa in $previas) {
  $nombrePrevio = ([string]$previa).Split('/')[-1]
  $corte = $nombrePrevio.LastIndexOf('.')
  if ($corte -le 0) { continue }
  $cola = $nombrePrevio.Substring(0, $corte)
  $guionFinal = $cola.LastIndexOf('-')
  if ($guionFinal -le 0) { continue }
  $numeroPrevio = 0
  if ([int]::TryParse($cola.Substring($guionFinal + 1), [ref]$numeroPrevio)) {
    if ($numeroPrevio -ge $shotNext) { $shotNext = $numeroPrevio + 1 }
  }
}
if ($previas.Count -gt 0 -and $shotNext -le $maxShots) {
  $shotWarnings.Add("El script ya tenia $($previas.Count) captura(s) y las nuevas se numeran desde la $shotNext, para no sobrescribirlas.")
}

if ($Screenshots.Count -gt 0) {
  if (-not $shotsDir.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'La ruta calculada de screenshots/ no es segura.'
  }
  foreach ($candidate in @($Screenshots)) {
    # El total es el de las previas MAS las nuevas, no solo las nuevas. Con el recuento
    # solo de las nuevas, un script con tres previas y cinco nuevas no daba el aviso del
    # limite, y se acababa con ocho capturas declaradas de las que el launcher solo
    # enseñaria seis.
    if (($previas.Count + $shotNames.Count) -ge $maxShots) {
      $restantes = @($Screenshots).Count - [array]::IndexOf(@($Screenshots), $candidate)
      $shotWarnings.Add("Se ignoraron $restantes captura(s) mas por el limite de $maxShots, contando las $($previas.Count) que ya tenia.")
      break
    }
    $full = [IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $shotWarnings.Add("No se encontro la captura: $full")
      continue
    }
    $length = (Get-Item -LiteralPath $full).Length
    if ($length -gt $maxShotBytes) {
      $shotWarnings.Add("Se descarto $([IO.Path]::GetFileName($full)): ocupa $length bytes y el limite son $maxShotBytes.")
      continue
    }
    $extension = [IO.Path]::GetExtension($full)
    if ($extension -notmatch $shotExtensionPattern) {
      $shotWarnings.Add("Se descarto $([IO.Path]::GetFileName($full)): la extension '$extension' no es valida.")
      continue
    }
    # La extension se normaliza a minusculas, pero NO se rechaza por repetida. Es lo que
    # creia el plan y era un error mio: el launcher acepta mi-script-1.png y
    # mi-script-2.png sin problema, porque lo que las distingue es el numero, no la
    # extension. Filtrar por extension repetida hacia imposible tener las seis capturas,
    # que es justo lo que el launcher y el limite de $maxShots si soportan.
    $normalized = $extension.ToLowerInvariant()
    # El numero sale de $shotNext, que ya continua al de las previas. Con
    # $shotNames.Count + 1 volvia a uno, y la captura nueva se comia el sitio de la
    # anterior: el aviso decia «se numeran desde la 2» y el archivo salia como -1.webp.
    $shotState += [pscustomobject]@{
      Source = $full
      Name = "$Id-$shotNext$normalized"
      Existed = Test-Path -LiteralPath (Join-Path $shotsDir "$Id-$shotNext$normalized") -PathType Leaf
    }
    $shotNames.Add("$Id-$shotNext$normalized")
    $shotNext += 1
  }
}

# Publicar sin -Screenshots CONSERVA las capturas que el script ya tenia, y avisa. Y
# tambien las conserva cuando se pasaron capturas y ninguna sirvio: un archivo mal puesto
# no puede hacer que el script pierda las fotos que lleva meses mostrando.
#
# Es la decision D3 de la especificacion, y sin esto se perdian: verificado que una
# actualizacion sin el parametro se llevaba el campo screenshots del catalogo.
#
# Se recogen del catalogo y no de disco, porque el catalogo es la autoridad: es lo que el
# launcher baja. Un archivo suelto en screenshots/ sin entrada no es una captura del
# script, es basura de una publicacion anterior.
# Las previas SIEMPRE se conservan, tambien cuando se pasan capturas nuevas. Publicar una
# actualizacion con un par de fotos no puede borrar del catalogo las otras que el script
# llevaba meses enseñando: verificado que lo hacia, porque el bloque solo corria cuando no
# quedaba ninguna captura nueva.
#
# Van PRIMERO en la lista, que es el orden que las tenia antes. Asi el recorte por el limite
# de seis se come las nuevas —que son las que se acaban de subir— y no las viejas.
if ($previas.Count -gt 0) {
  $nuevas = @($shotNames)
  $shotNames.Clear()
  foreach ($previa in $previas) { $shotNames.Add(([string]$previa).Split('/')[-1]) }
  foreach ($nombre in $nuevas) { $shotNames.Add($nombre) }
  if ($nuevas.Count -eq 0) {
    $motivo = $(if ($Screenshots.Count -eq 0) { "no se paso -Screenshots" } else { "ninguna de las capturas indicadas sirvio" })
    $shotWarnings.Add("Se conservaron $($previas.Count) captura(s) que ya tenia el script porque $motivo. Para cambiarlas, pasa -Screenshots con archivos validos; para quitarlas, borra los archivos de screenshots\ y quita su entrada del catalogo.")
  }
}

# El recorte final, por si el total se pasa aunque el bucle no haya avisado. Se hace
# sobre la lista ya combinada —previas primero— para que lo que se salga sean las nuevas.
if ($shotNames.Count -gt $maxShots) {
  $sobran = $shotNames.Count - $maxShots
  while ($shotNames.Count -gt $maxShots) { $shotNames.RemoveAt($shotNames.Count - 1) }
  $shotWarnings.Add("Se descartaron $sobran captura(s) por el limite de $maxShots. Son las nuevas: las que ya tenia el script se conservan.")
}

try {
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  if ($shotState.Count -gt 0) {
    New-Item -ItemType Directory -Path $shotsDir -Force | Out-Null
    foreach ($shot in $shotState) {
      Copy-Item -LiteralPath $shot.Source -Destination (Join-Path $shotsDir $shot.Name) -Force
    }
  }
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
  # El campo screenshots solo se anade si hay capturas. Un array vacio ocuparia espacio
  # y diria que el script tiene fotos que no tiene, y un null escrito tal cual diria
  # lo mismo de otra forma: ConvertTo-Json en PowerShell 5.1 no tiene SkipIfNull, asi
  # que la unica manera de que la clave no aparezca es no ponerla.
  if ($shotNames.Count -gt 0) {
    $entry.screenshots = @($shotNames | ForEach-Object { "$shotsBase/$_" })
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
  # Las capturas tambien son estado. Un archivo de mas que ninguna entrada del
  # catalogo describe es basura que se acumula, y una foto de la version anterior
  # sustituida por la nueva deja la ficha mostrando lo que ya no hace.
  try {
    if ($shotState.Count -gt 0) {
      foreach ($shot in $shotState) {
        if ($shot.Existed) { continue }
        $written = Join-Path $shotsDir $shot.Name
        if (Test-Path -LiteralPath $written) { Remove-Item -LiteralPath $written -Force }
      }
    }
  } catch {
    Write-Host "AVISO  No se pudieron deshacer las capturas: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  throw
}

$operationLabel = $(if ($operationMode -eq 'New') { 'script nuevo' } else { 'actualización' })
foreach ($warning in $shotWarnings) { Write-Host "AVISO  $warning" -ForegroundColor Yellow }
Write-Host "Preparado como ${operationLabel}: $targetName" -ForegroundColor Green
Write-Host "Versión: $version"
Write-Host "SHA-256: $sha256"
Write-Host 'Revisa catalog.json y luego ejecuta:'
Write-Host '  git add catalog.json scripts/'
if ($shotNames.Count -gt 0) { Write-Host '  git add screenshots/' }
Write-Host "  git commit -m 'Publicar $name $version'"
Write-Host '  git push'
