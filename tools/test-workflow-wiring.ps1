$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$workflow = Join-Path $root '.github\workflows\validate-catalog.yml'
$content = Get-Content -LiteralPath $workflow -Raw -Encoding UTF8

if ($content -notmatch 'validate-catalog\.ps1') { throw 'El workflow no invoca tools/validate-catalog.ps1.' }
if ($content -match '1000000') { throw 'El workflow todavia impone el limite antiguo de 1000000 bytes; vive en validate-catalog.ps1.' }

$required = @(
  'test-git-workflow.ps1',
  'test-new-script-publication.ps1',
  'test-script-removal.ps1',
  'test-script-size-limit.ps1',
  'test-launcher-publication.ps1'
)
foreach ($test in $required) {
  if ($content -notmatch [regex]::Escape($test)) { throw "El workflow no ejecuta $test." }
}
if ($content -match 'test-publication-pipeline\.ps1') {
  throw 'test-publication-pipeline.ps1 no debe ejecutarse en CI: depende de un clon local que el runner no tiene.'
}
foreach ($job in @('validate:', 'test:')) {
  if ($content -notmatch [regex]::Escape($job)) { throw "El workflow no define el job $job" }
}
Write-Output 'Workflow wiring passed: delegates to validate-catalog.ps1, runs the five tests, excludes the local-only test, no stale 1 MB limit.'
