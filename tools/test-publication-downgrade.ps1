$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-downgrade-' + [Guid]::NewGuid().ToString('N'))

function Write-Catalog([string]$Path, [string]$Id, [string]$Name, [string]$Namespace, [string]$Version) {
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @([pscustomobject]([ordered]@{
    id = $Id; name = $Name; namespace = $Namespace; version = $Version
    author = 'PokeGrid'; summary = 'Base'; description = 'Base'; category = 'Utilidades'
    tags = @(); permissions = @(); minLauncherVersion = '0.22.1'
    downloadUrl = "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/$Id.user.js"
    sha256 = 'a' * 64; homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
    changelog = 'Base'; icon = 'X'; featured = $false; publishedAt = '2026-01-01T00:00:00Z'
  })) }
  [IO.File]::WriteAllText($Path, ($catalog | ConvertTo-Json -Depth 12), $utf8)
}
function Write-Script([string]$Path, [string]$Name, [string]$Namespace, [string]$Version) {
  $code = "// ==UserScript==`n// @name $Name`n// @namespace $Namespace`n// @version $Version`n// @description Prueba`n// @match https://poke.idleworld.online/*`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($Path, $code, $utf8)
}
function Publish([string]$ScriptPath, [string]$Id, [string]$Root) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $ScriptPath -Id $Id -PublicationMode Update -Summary 'S' -Description 'D' -Changelog 'C' -RepositoryRoot $Root 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
  } finally { $ErrorActionPreference = $previous }
}

try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
  $catalogPath = Join-Path $testRoot 'catalog.json'

  # 1. Re-publicar la misma version no debe cambiar el catalogo.
  Write-Catalog $catalogPath 'estable' 'Script Estable' 'https://pokegrid.test/est' '2.0.0'
  $before = [IO.File]::ReadAllBytes($catalogPath)
  $same = Join-Path $testRoot 'misma.user.js'
  Write-Script $same 'Script Estable' 'https://pokegrid.test/est' '2.0.0'
  $r = Publish $same 'estable' $testRoot
  if ($r.ExitCode -eq 0) { throw 'Republicar la misma version deberia rechazarse: no cambia nada en la Shop.' }
  if ($r.Output -notmatch 'superior') { throw "El rechazo no explica que hay que subir la version:`n$($r.Output)" }
  $after = [IO.File]::ReadAllBytes($catalogPath)
  if ($before.Length -ne $after.Length) { throw 'El catalogo cambio pese al rechazo.' }

  # 2. Bajar de version es peor que repetirla: deja el Shop en un estado viejo.
  $down = Join-Path $testRoot 'bajada.user.js'
  Write-Script $down 'Script Estable' 'https://pokegrid.test/est' '1.0.0'
  $r = Publish $down 'estable' $testRoot
  if ($r.ExitCode -eq 0) { throw 'Publicar una version INFERIOR deberia rechazarse: dejaria la Shop en un estado anterior.' }
  if ($r.Output -notmatch 'superior') { throw "El rechazo de bajada no es claro:`n$($r.Output)" }
  $afterDown = [IO.File]::ReadAllBytes($catalogPath)
  if ($before.Length -ne $afterDown.Length) { throw 'El catalogo cambio pese al rechazo de la bajada.' }
  $parsed = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$parsed.scripts[0].version -ne '2.0.0') { throw "El catalogo quedo en '$($parsed.scripts[0].version)'." }

  # 3. Subir de version si se permite.
  $up = Join-Path $testRoot 'subida.user.js'
  Write-Script $up 'Script Estable' 'https://pokegrid.test/est' '2.1.0'
  $r = Publish $up 'estable' $testRoot
  if ($r.ExitCode -ne 0) { throw "Subir de version deberia permitirse:`n$($r.Output)" }
  $parsed = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$parsed.scripts[0].version -ne '2.1.0') { throw "La subida no se registro: quedo '$($parsed.scripts[0].version)'." }

  Write-Output 'Publication version guard passed: same version, downgrade and upgrade are handled as specified.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
