$ErrorActionPreference = 'Stop'
$remover = Join-Path $PSScriptRoot 'remove-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-remove-script-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)

try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $testRoot '.git') -Force | Out-Null
  $catalog = [ordered]@{
    schemaVersion = 1
    updatedAt = '2026-01-01T00:00:00Z'
    scripts = @(
      [ordered]@{ id='remove-me';name='Remove Me';version='2.0.0' },
      [ordered]@{ id='keep-me';name='Keep Me';version='1.0.0' }
    )
  }
  [IO.File]::WriteAllText((Join-Path $testRoot 'catalog.json'), ($catalog | ConvertTo-Json -Depth 12), $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot 'scripts\remove-me.user.js'), '// remove', $utf8)
  [IO.File]::WriteAllText((Join-Path $testRoot 'scripts\keep-me.user.js'), '// keep', $utf8)

  $result = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $remover -Id 'remove-me' -RepositoryRoot $testRoot | Select-Object -Last 1
  if ($LASTEXITCODE -ne 0) { throw "La eliminación terminó con código $LASTEXITCODE." }
  $updated = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($updated.scripts).Count -ne 1 -or [string]$updated.scripts[0].id -ne 'keep-me') { throw 'No se retiró exclusivamente la entrada seleccionada.' }
  if (Test-Path -LiteralPath (Join-Path $testRoot 'scripts\remove-me.user.js')) { throw 'El archivo publicado no fue eliminado.' }
  if (-not (Test-Path -LiteralPath (Join-Path $testRoot 'scripts\keep-me.user.js'))){ throw 'Se eliminó un userscript ajeno.' }
  $raw = [IO.File]::ReadAllBytes((Join-Path $testRoot 'catalog.json'))
  if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) { throw 'catalog.json fue guardado con BOM.' }
  Write-Output 'Script removal pipeline passed: exact catalog entry and userscript removed; unrelated publication preserved.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
