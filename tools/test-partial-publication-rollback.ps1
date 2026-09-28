$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-rollback-' + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
  $catalogPath = Join-Path $testRoot 'catalog.json'
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @() }
  $catalogJson = $catalog | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($catalogPath, $catalogJson, $utf8)
  $originalBytes = [IO.File]::ReadAllBytes($catalogPath)

  $script = Join-Path $testRoot 'nuevo.user.js'
  $code = "// ==UserScript==`n// @name Script de Prueba`n// @namespace https://pokegrid.test/rollback`n// @version 1.0.0`n// @description Prueba`n// @match https://poke.idleworld.online/*`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($script, $code, $utf8)

  # catalog.json se marca como solo lectura: Get-Content sigue funcionando, pero
  # la escritura del publicador falla despues de haber copiado el userscript.
  # Un bloqueo FileShare.None no serviria: romperia la lectura de la linea 77,
  # el userscript nunca se escribiria y el test pasaria sin ejercitar el rollback.
  (Get-Item -LiteralPath $catalogPath).IsReadOnly = $true
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $script -Id 'nuevo' -PublicationMode New -Summary 'Prueba' -Description 'Prueba' -Changelog 'Inicial' -RepositoryRoot $testRoot 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
    (Get-Item -LiteralPath $catalogPath).IsReadOnly = $false
  }

  if ($exitCode -eq 0) { throw 'El publicador deberia haber fallado al escribir un catalog.json de solo lectura.' }

  # La garantia que importa: el .user.js no puede quedar en disco, porque
  # describiria un estado que ningun SHA-256 del catalogo cubre.
  $published = Join-Path $testRoot 'scripts\nuevo.user.js'
  if (Test-Path -LiteralPath $published) {
    throw 'Tras el fallo quedo scripts\nuevo.user.js en disco: el rollback no restauro el estado previo.'
  }
  $parsed = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($parsed.scripts).Count -ne 0) { throw 'El catalogo registro una entrada pese a haber fallado la escritura.' }
  $afterBytes = [IO.File]::ReadAllBytes($catalogPath)
  if ($originalBytes.Length -ne $afterBytes.Length) {
    throw "catalog.json cambio de tamano tras el fallo: $($originalBytes.Length) -> $($afterBytes.Length)."
  }
  for ($i = 0; $i -lt $originalBytes.Length; $i++) {
    if ($originalBytes[$i] -ne $afterBytes[$i]) { throw "catalog.json cambio en el byte $i tras el fallo." }
  }

  Write-Output 'Partial publication rollback passed: the userscript and the catalog both returned to their previous state.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
