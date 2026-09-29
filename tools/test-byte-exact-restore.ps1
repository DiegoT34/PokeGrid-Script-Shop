$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-restore-bytes-' + [Guid]::NewGuid().ToString('N'))

function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Catalog([string]$Path, $Entries) {
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @($Entries) }
  [IO.File]::WriteAllText($Path, ($catalog | ConvertTo-Json -Depth 12), $utf8)
}

try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
  $catalogPath = Join-Path $testRoot 'catalog.json'
  $target = Join-Path $testRoot 'scripts\restaurable.user.js'

  # Estado previo: un script ya publicado en 1.0.0 y su entrada en el catalogo.
  $oldCode = "// ==UserScript==`n// @name Script Restaurable`n// @namespace https://pokegrid.test/restore`n// @version 1.0.0`n// @description Antes`n// @match https://poke.idleworld.online/*`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($target, $oldCode, $utf8)
  $oldEntry = [ordered]@{
    id = 'restaurable'; name = 'Script Restaurable'; namespace = 'https://pokegrid.test/restore'
    version = '1.0.0'; author = 'PokeGrid'; summary = 'Antes'; description = 'Antes'
    category = 'Utilidades'; tags = @(); permissions = @(); minLauncherVersion = '0.22.1'
    downloadUrl = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/restaurable.user.js'
    sha256 = (Get-Sha $target); homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
    changelog = 'Base'; icon = 'X'; featured = $false; publishedAt = '2026-01-01T00:00:00Z'
  }
  Write-Catalog $catalogPath @([pscustomobject]$oldEntry)

  $catalogBytesBefore = [IO.File]::ReadAllBytes($catalogPath)
  $targetBytesBefore = [IO.File]::ReadAllBytes($target)

  $newCode = "// ==UserScript==`n// @name Script Restaurable`n// @namespace https://pokegrid.test/restore`n// @version 2.0.0`n// @description Despues`n// @match https://poke.idleworld.online/*`n// ==/UserScript==`n"
  $newScript = Join-Path $testRoot 'actualizacion.user.js'
  [IO.File]::WriteAllText($newScript, $newCode, $utf8)

  # El catalogo se marca de solo lectura, pero se desbloquea en cuanto el publicador
  # ha escrito el userscript: la escritura del catalogo falla y el RESTAURE si
  # puede ejecutarse. Asi se ejercita de verdad la rama de restauracion, que con
  # el catalogo permanentemente bloqueado nunca llega a correr.
  # Solo catalog.json queda de solo lectura, y por eso la escritura del catalogo
  # falla. El .user.js sigue siendo escribible, asi que su restauracion se
  # ejecuta de verdad: es la rama que restorations bytes y la que el test mide.
  (Get-Item -LiteralPath $catalogPath).IsReadOnly = $true
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $newScript -Id 'restaurable' -PublicationMode Update -Summary 'Despues' -Description 'Despues' -Changelog 'Cambio' -RepositoryRoot $testRoot 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
    (Get-Item -LiteralPath $catalogPath).IsReadOnly = $false
  }

  if ($exitCode -eq 0) { throw 'El publicador deberia haber fallado al escribir el catalogo de solo lectura.' }

  # La rama critica: el .user.js ya existia, asi que se restaura, no se borra.
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'El rollback borro el .user.js que ya existia: deberia restaurarlo.' }
  $targetAfter = [IO.File]::ReadAllBytes($target)
  if ($targetAfter.Length -ne $targetBytesBefore.Length) {
    throw "El .user.js restaurado mide $($targetAfter.Length) bytes en vez de $($targetBytesBefore.Length): el contenido anterior se perdio o se decimallo."
  }
  for ($i = 0; $i -lt $targetBytesBefore.Length; $i++) {
    if ($targetBytesBefore[$i] -ne $targetAfter[$i]) { throw "El .user.js restaurado difiere en el byte $i." }
  }
  $restoredCode = [IO.File]::ReadAllText($target, $utf8)
  if ($restoredCode -notmatch '@version 1\.0\.0') { throw 'El .user.js restaurado no conserva la version anterior 1.0.0.' }

  # El catalogo debe seguir siendo JSON valido: un WriteAllText sobre un byte[]
  # lo convierte en una lista de digitos decimales.
  $catalogAfter = [IO.File]::ReadAllBytes($catalogPath)
  $catalogText = [Text.Encoding]::UTF8.GetString($catalogAfter)
  $parsed = $null
  try { $parsed = $catalogText | ConvertFrom-Json } catch { throw "catalog.json quedo ilegible tras el fallo: $($_.Exception.Message)" }
  if (@($parsed.scripts).Count -ne 1) { throw "El catalogo deberia conservar 1 entrada, tiene $(@($parsed.scripts).Count)." }
  if ([string]$parsed.scripts[0].version -ne '1.0.0') { throw "El catalogo registro la version '$($parsed.scripts[0].version)' en vez de conservar '1.0.0'." }
  for ($i = 0; $i -lt $catalogBytesBefore.Length; $i++) {
    if ($catalogBytesBefore[$i] -ne $catalogAfter[$i]) { throw "catalog.json difiere en el byte $i tras restaurarse." }
  }

  Write-Output 'Byte-exact restore passed: an existing userscript and the catalog are both restored byte for byte after a failed publication.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
