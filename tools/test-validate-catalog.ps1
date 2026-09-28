$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-catalog.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-validate-' + [Guid]::NewGuid().ToString('N'))

function New-Fixture([string]$Name, [string]$Id, [string]$Version, [string]$Namespace, [int]$PadBytes) {
  $root = Join-Path $testRoot $Name
  New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force | Out-Null
  $code = "// ==UserScript==`n// @name $Name`n// @namespace $Namespace`n// @version $Version`n// @match https://poke.idleworld.online/*`n// ==/UserScript==`n"
  if ($PadBytes -gt 0) { $code += "/*" + ('x' * $PadBytes) + "*/`n" }
  [IO.File]::WriteAllText((Join-Path $root "scripts\$Id.user.js"), $code, $utf8)
  $sha = (Get-FileHash -LiteralPath (Join-Path $root "scripts\$Id.user.js") -Algorithm SHA256).Hash.ToLowerInvariant()
  $entry = [ordered]@{
    id = $Id; name = $Name; namespace = $Namespace; version = $Version
    author = 'PokeGrid'; summary = 'Prueba'; description = 'Prueba'
    category = 'Utilidades'; tags = @(); permissions = @()
    minLauncherVersion = '0.22.1'
    downloadUrl = "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/$Id.user.js"
    sha256 = $sha; homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
    changelog = 'Base'; icon = 'X'; featured = $false; publishedAt = '2026-01-01T00:00:00Z'
  }
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @([pscustomobject]$entry) }
  [IO.File]::WriteAllText((Join-Path $root 'catalog.json'), ($catalog | ConvertTo-Json -Depth 12), $utf8)
  [IO.File]::WriteAllText((Join-Path $root 'catalog.schema.json'), (Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'catalog.schema.json') -Raw), $utf8)
  return $root
}

function Set-CatalogProperty([string]$Root, [string]$Property, $Value) {
  $path = Join-Path $Root 'catalog.json'
  $catalog = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Property -eq 'updatedAt') { $catalog.updatedAt = $Value }
  elseif ($Property -eq 'sha256') { $catalog.scripts[0].sha256 = $Value }
  elseif ($Property -eq 'downloadUrl') { $catalog.scripts[0].downloadUrl = $Value }
  elseif ($Property -eq 'appendId') { $catalog.scripts = @($catalog.scripts[0], [pscustomobject]($catalog.scripts[0] | ConvertTo-Json -Depth 12 | ConvertFrom-Json)) }
  else { throw "Set-CatalogProperty no conoce la propiedad '$Property'." }
  [IO.File]::WriteAllText($path, ($catalog | ConvertTo-Json -Depth 12), $utf8)
}

function Invoke-Validator([string]$Root) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validator -RepositoryRoot $Root 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
  } finally { $ErrorActionPreference = $previous }
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

  # 1. Catalogo valido: debe pasar.
  $ok = Invoke-Validator (New-Fixture 'valid' 'script-valido' '1.0.0' 'https://pokegrid.test/ok' 0)
  if ($ok.ExitCode -ne 0) { throw "Un catalogo valido fue rechazado:`n$($ok.Output)" }

  # 2. Review Focus 1: el .user.js no existe en disco.
  $missing = New-Fixture 'missing-file' 'sin-archivo' '1.0.0' 'https://pokegrid.test/missing' 0
  Remove-Item -LiteralPath (Join-Path $missing 'scripts\sin-archivo.user.js') -Force
  $r = Invoke-Validator $missing
  if ($r.ExitCode -eq 0) { throw 'El validador acepto una entrada cuyo .user.js no existe.' }
  if ($r.Output -notmatch 'No existe') { throw "El fallo por archivo ausente no es claro:`n$($r.Output)" }

  # 3. SHA-256 incorrecto.
  $badHash = New-Fixture 'bad-hash' 'hash-malo' '1.0.0' 'https://pokegrid.test/hash' 0
  Set-CatalogProperty $badHash 'sha256' ('a' * 64)
  $r = Invoke-Validator $badHash
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un SHA-256 incorrecto.' }
  if ($r.Output -notmatch 'SHA-256') { throw "El fallo por hash no es claro:`n$($r.Output)" }

  # 4. downloadUrl que no corresponde al id.
  $badUrl = New-Fixture 'bad-url' 'url-mala' '1.0.0' 'https://pokegrid.test/url' 0
  Set-CatalogProperty $badUrl 'downloadUrl' 'https://example.invalid/otro.user.js'
  $r = Invoke-Validator $badUrl
  if ($r.ExitCode -eq 0) { throw 'El validador acepto una downloadUrl inconsistente.' }

  # 5. @version del archivo que no coincide con el catalogo.
  $badVersion = New-Fixture 'bad-version' 'version-mala' '2.0.0' 'https://pokegrid.test/version' 0
  $file = Join-Path $badVersion 'scripts\version-mala.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 2.0.0', '@version 3.0.0'), $utf8)
  $r = Invoke-Validator $badVersion
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version distinto del catalogo.' }
  if ($r.Output -notmatch '@version') { throw "El fallo por @version no es claro:`n$($r.Output)" }

  # 6. Review Focus 2: prefijo v en @version, sin normalizar en el archivo.
  $vPrefix = New-Fixture 'v-prefix' 'con-v' '1.2.3' 'https://pokegrid.test/v' 0
  $file = Join-Path $vPrefix 'scripts\con-v.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 1.2.3', '@version v1.2.3'), $utf8)
  $r = Invoke-Validator $vPrefix
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version con prefijo v sin normalizar.' }

  # 7. Review Focus 3: @version de dos componentes, que el catalogo exige como tres.
  $twoPart = New-Fixture 'two-component' 'dos-partes' '3.91.0' 'https://pokegrid.test/two' 0
  $file = Join-Path $twoPart 'scripts\dos-partes.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 3.91.0', '@version 3.91'), $utf8)
  $r = Invoke-Validator $twoPart
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version de dos componentes.' }

  # 8. Archivo por encima del limite de 10 MB.
  $big = New-Fixture 'too-big' 'muy-grande' '1.0.0' 'https://pokegrid.test/big' (6MB)
  $r = Invoke-Validator $big
  if ($r.ExitCode -ne 0) { throw "Un archivo de 6 MB debe aceptarse con el limite de 10 MB:`n$($r.Output)" }
  $huge = New-Fixture 'too-huge' 'demasiado-grande' '1.0.0' 'https://pokegrid.test/huge' (11MB)
  $r = Invoke-Validator $huge
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un archivo por encima de 10 MB.' }
  if ($r.Output -notmatch '10 MB') { throw "El rechazo por tamano no menciona el limite de 10 MB:`n$($r.Output)" }

  # 9. Review Focus 4: dos ids que solo difieren en mayusculas.
  $dup = New-Fixture 'duplicate-id-case' 'mismo-id' '1.0.0' 'https://pokegrid.test/dup' 0
  Set-CatalogProperty $dup 'appendId'
  $path = Join-Path $dup 'catalog.json'
  $catalog = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $catalog.scripts[1].id = 'MISMO-ID'
  [IO.File]::WriteAllText($path, ($catalog | ConvertTo-Json -Depth 12), $utf8)
  $r = Invoke-Validator $dup
  if ($r.ExitCode -eq 0) { throw 'El validador acepto dos ids que solo difieren en mayusculas.' }
  if ($r.Output -notmatch 'duplicad') { throw "El fallo por id duplicado no es claro:`n$($r.Output)" }

  # 10. updatedAt que no es RFC 3339. El schema lo marca como anotacion y no lo aplica.
  $badDate = New-Fixture 'bad-date' 'fecha-mala' '1.0.0' 'https://pokegrid.test/date' 0
  Set-CatalogProperty $badDate 'updatedAt' '24/08/2026 10:08'
  $r = Invoke-Validator $badDate
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un updatedAt que no es RFC 3339.' }

  Write-Output 'Catalog validator passed: valid catalog, missing file, bad hash, bad URL, version mismatch, v prefix, two-component version, 10 MB limit, duplicate id case and RFC 3339 date.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
