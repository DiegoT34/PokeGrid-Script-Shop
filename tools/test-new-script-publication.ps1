$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-new-script-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $catalog = [ordered]@{
    schemaVersion = 1
    updatedAt = '2026-01-01T00:00:00Z'
    scripts = @([ordered]@{
      id='existing-script';name='Existing Script';namespace='http://tampermonkey.net/';version='1.0.0';author='PokeGrid'
      summary='Existing';description='Existing';category='Utilidades';tags=@();permissions=@();minLauncherVersion='0.22.1'
      downloadUrl='https://example.invalid/existing.user.js';sha256='old';homepage='https://example.invalid';changelog='Base'
      icon='🧩';featured=$false;publishedAt='2026-01-01T00:00:00Z'
    })
  }
  [IO.File]::WriteAllText((Join-Path $testRoot 'catalog.json'),($catalog|ConvertTo-Json -Depth 12),$utf8)

  $newScript = Join-Path $testRoot 'brand-new.user.js'
  $newCode = "// ==UserScript==`n// @name Brand New Script`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// @description Nueva herramienta`n// @game Brand Arena`n// @match https://arena.example.test/*`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($newScript,$newCode,$utf8)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $newScript -Id 'brand-new-script' -PublicationMode New -Summary 'Nueva herramienta' -Description 'Nueva herramienta' -Changelog 'Primera publicación' -RepositoryRoot $testRoot
  if($LASTEXITCODE -ne 0){throw "La publicación nueva terminó con código $LASTEXITCODE."}

  $result = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if(@($result.scripts).Count -ne 2){throw 'El script nuevo no fue agregado al catálogo.'}
  $created=@($result.scripts)|Where-Object{$_.id -eq 'brand-new-script'}|Select-Object -First 1
  if(-not $created -or $created.name -ne 'Brand New Script'){throw 'La entrada nueva no conserva sus propios metadatos.'}
  if(@($created.games) -notcontains 'Brand Arena'){throw 'La publicación nueva no incluyó la etiqueta @game declarada.'}
  $original=@($result.scripts)|Where-Object{$_.id -eq 'existing-script'}|Select-Object -First 1
  if(-not $original -or $original.version -ne '1.0.0'){throw 'La publicación nueva alteró el script existente.'}

  $previousPreference=$ErrorActionPreference
  try{
    $ErrorActionPreference='Continue'
    $collisionOutput=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $newScript -Id 'existing-script' -PublicationMode New -RepositoryRoot $testRoot 2>&1|Out-String
    $collisionExitCode=$LASTEXITCODE
  }finally{$ErrorActionPreference=$previousPreference}
  if($collisionExitCode -eq 0){throw 'El publicador permitió sobrescribir un ID existente en modo New.'}
  if($collisionOutput -notmatch 'ya pertenece'){throw 'La colisión de ID no devolvió una explicación clara.'}

  $updateScript = Join-Path $testRoot 'existing-update.user.js'
  $updateCode = "// ==UserScript==`n// @name Existing Script`n// @namespace http://tampermonkey.net/`n// @version 1.1.0`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($updateScript,$updateCode,$utf8)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $updateScript -Id 'existing-script' -PublicationMode Update -Summary 'Existing' -Description 'Existing' -Changelog 'Update' -RepositoryRoot $testRoot
  if($LASTEXITCODE -ne 0){throw "La actualización terminó con código $LASTEXITCODE."}
  $updated = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $updatedEntry=@($updated.scripts)|Where-Object{$_.id -eq 'existing-script'}|Select-Object -First 1
  if($updatedEntry.version -ne '1.1.0' -or $updatedEntry.publishedAt -ne '2026-01-01T00:00:00Z'){throw 'La actualización no conservó correctamente la identidad existente.'}
  if(@($updated.scripts).Count -ne 2){throw 'La actualización duplicó entradas del catálogo.'}

  Write-Output 'New-script pipeline passed: add, collision protection, update identity and catalog preservation.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
