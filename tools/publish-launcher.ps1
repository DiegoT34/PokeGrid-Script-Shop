param(
  [Parameter(Mandatory=$true)][string]$RepositoryRoot,
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$ReleaseNotes = '',
  [switch]$RunLocalChecks,
  [switch]$BuildLocal,
  [switch]$AllowAnyRemote
)

$ErrorActionPreference = 'Stop'
$helperPath = Join-Path $PSScriptRoot 'git-helper.ps1'
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'No se encontró tools\git-helper.ps1.' }
. $helperPath

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $encoding = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Resolve-PokeGridPnpm {
  $command = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue }
  if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) { return $command.Source }
  $fallbacks = @(
    (Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.cmd'),
    (Join-Path $env:APPDATA 'npm\pnpm.cmd')
  )
  return $fallbacks | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Invoke-PokeGridTool([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    Push-Location -LiteralPath $WorkingDirectory
    $ErrorActionPreference = 'Continue'
    $lines = & $Executable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $output = ($lines | Out-String).Trim()
  if ($output) { Write-Output $output }
  if ($exitCode -ne 0) { throw "El comando $([IO.Path]::GetFileName($Executable)) $($Arguments -join ' ') terminó con código $exitCode." }
}

$root = [IO.Path]::GetFullPath($RepositoryRoot)
if (-not (Test-Path -LiteralPath (Join-Path $root '.git') -PathType Container)) { throw 'La carpeta seleccionada no es un repositorio Git del launcher.' }
$packagePath = Join-Path $root 'package.json'
$workflowPath = Join-Path $root '.github\workflows\release.yml'
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or -not (Test-Path -LiteralPath $workflowPath -PathType Leaf)) {
  throw 'La carpeta no contiene package.json y el flujo .github\workflows\release.yml del launcher.'
}
$Version = $Version.Trim().TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'La nueva versión debe tener el formato X.Y.Z, por ejemplo 0.22.9.' }
$targetVersion = [Version]$Version
$packageRaw = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8
$package = $packageRaw | ConvertFrom-Json
if ([string]$package.name -ne 'pokegrid-launcher') { throw 'package.json no pertenece a PokeGrid Launcher.' }
if ([string]$package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'La versión actual de package.json no es válida.' }
$currentVersion = [Version][string]$package.version
if ($targetVersion -lt $currentVersion) { throw "La versión $Version es menor que la versión actual $currentVersion." }

$remote = (Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('remote','get-url','origin')).Output
if (-not $AllowAnyRemote -and $remote -notmatch '(?i)(?:github\.com[:/])DiegoT34/PokeGrid-Launcher(?:\.git)?$') {
  throw "El remoto origin no corresponde a DiegoT34/PokeGrid-Launcher: $remote"
}
$branch = (Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('branch','--show-current')).Output
if ($branch -ne 'main') { throw "Publica desde la rama main. Rama actual: $branch" }
$conflicts = (Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('ls-files','-u')).Output
if ($conflicts) { throw "Hay conflictos sin resolver:`r`n$conflicts" }

Write-Output 'Sincronizando referencias y etiquetas del launcher…'
[void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('fetch','origin','--tags','--prune'))
$remoteTag = Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('ls-remote','--exit-code','--tags','origin',"refs/tags/v$Version") -AllowFailure
if ($remoteTag.ExitCode -eq 0) { throw "La versión v$Version ya existe en GitHub." }
if ($remoteTag.ExitCode -ne 2) { throw $(if ($remoteTag.Output) { $remoteTag.Output } else { 'No se pudieron consultar las etiquetas remotas.' }) }

$behindText = (Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('rev-list','--count','HEAD..origin/main')).Output
$behind = 0
[void][int]::TryParse($behindText, [ref]$behind)
if ($behind -gt 0) {
  $dirty = (Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('status','--porcelain=v1','--','.',':(exclude,top,glob)*.user.js',':(exclude,top,glob)*.js',':(exclude,top,glob)*.rar',':(exclude,top,glob)*.zip',':(exclude,top,glob)*.7z')).Output
  if ($dirty) { throw "El repositorio está $behind commit(s) detrás de GitHub y tiene cambios locales. Sincronízalo antes de publicar." }
  Write-Output 'Actualizando main mediante avance rápido…'
  [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('pull','--ff-only','origin','main'))
}

if ($targetVersion -gt $currentVersion) {
  $replacement = '${1}' + $Version + '${2}'
  $updatedPackage = [regex]::Replace($packageRaw, '(?m)^(\s*"version"\s*:\s*")[^"]+("\s*,?)', $replacement, 1)
  if ($updatedPackage -eq $packageRaw) { throw 'No se pudo actualizar el campo version de package.json.' }
  Write-Utf8NoBom $packagePath $updatedPackage
  Write-Output "Versión preparada: $currentVersion → $Version"
} else {
  Write-Output "package.json ya está preparado como v$Version; se continuará con el reintento."
}

try {
  if ($RunLocalChecks -or $BuildLocal) {
    $pnpm = Resolve-PokeGridPnpm
    if (-not $pnpm) { throw 'No se encontró pnpm. Desmarca la validación local o instala Node.js y pnpm.' }
    Write-Output 'Ejecutando comprobaciones del launcher…'
    Invoke-PokeGridTool $pnpm @('check') $root
    Invoke-PokeGridTool $pnpm @('test:updater') $root
    Invoke-PokeGridTool $pnpm @('test:script-shop') $root
    if ($BuildLocal) {
      Write-Output 'Compilando el ZIP portátil local…'
      Invoke-PokeGridTool $pnpm @('dist') $root
      $zipPath = Join-Path $root "dist\IDLE-POKE-LAUNCHER-$Version-portatil.zip"
      if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw "No se generó $zipPath" }
      $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
      Write-Utf8NoBom "$zipPath.sha256" "$hash  $([IO.Path]::GetFileName($zipPath))"
      Write-Output "ZIP local verificado: $zipPath"
    }
  }

  # Los userscripts personales ubicados junto al proyecto nunca forman parte del launcher.
  [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('add','-A','--','.',':(exclude,top,glob)*.user.js',':(exclude,top,glob)*.js',':(exclude,top,glob)*.rar',':(exclude,top,glob)*.zip',':(exclude,top,glob)*.7z'))
  [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('diff','--cached','--check'))
  $cached = Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('diff','--cached','--quiet') -AllowFailure
  if ($cached.ExitCode -eq 1) {
    $firstNote = ($ReleaseNotes -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)
    $subject = "Publicar PokeGrid Launcher v$Version"
    if ($firstNote) { $subject = "$subject - $firstNote" }
    if ($subject.Length -gt 120) { $subject = $subject.Substring(0,120).TrimEnd() }
    Write-Output 'Creando el commit de la nueva versión…'
    [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('commit','-m',$subject))
  } elseif ($cached.ExitCode -ne 0) {
    throw 'No se pudieron comprobar los cambios preparados.'
  } else {
    Write-Output 'No hay archivos pendientes; se publicará el commit actual.'
  }

  Write-Output 'Subiendo la rama main…'
  [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('push','origin','main'))
  $localTag = Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('rev-parse','--verify','--quiet',"refs/tags/v$Version") -AllowFailure
  if ($localTag.ExitCode -eq 0) {
    Write-Output "Eliminando una etiqueta local incompleta de un intento anterior…"
    [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('tag','-d',"v$Version"))
  } elseif ($localTag.ExitCode -ne 1) {
    throw "No se pudo comprobar la etiqueta local v$Version."
  }
  Write-Output "Creando la etiqueta v$Version…"
  $tagMessage = "PokeGrid Launcher v$Version"
  if ($ReleaseNotes.Trim()) { $tagMessage += "`r`n`r`n" + $ReleaseNotes.Trim() }
  [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('tag','-a',"v$Version",'-m',$tagMessage))
  [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('push','origin',"v$Version"))
  Write-Output "PUBLICACIÓN_ENVIADA=https://github.com/DiegoT34/PokeGrid-Launcher/actions"
} catch {
  if ((Test-Path -LiteralPath $packagePath) -and $targetVersion -gt $currentVersion) {
    $headVersion = Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('show','HEAD:package.json') -AllowFailure
    $committedVersionPattern = '"version"\s*:\s*"' + [regex]::Escape($Version) + '"'
    if ($headVersion.ExitCode -eq 0 -and $headVersion.Output -match $committedVersionPattern) {
      # La versión ya quedó confirmada; se conserva para que el usuario pueda reintentar el push/tag.
    } else {
      Write-Utf8NoBom $packagePath $packageRaw
      [void](Invoke-PokeGridGit -RepositoryRoot $root -Arguments @('reset','--','package.json') -AllowFailure)
    }
  }
  throw
}
