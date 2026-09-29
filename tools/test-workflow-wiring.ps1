$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$workflow = Join-Path $root '.github\workflows\validate-catalog.yml'
$content = Get-Content -LiteralPath $workflow -Raw -Encoding UTF8

if ($content -notmatch 'validate-catalog\.ps1') { throw 'El workflow no invoca tools/validate-catalog.ps1.' }
if ($content -match '1000000') { throw 'El workflow todavia impone el limite antiguo de 1000000 bytes; vive en validate-catalog.ps1.' }

# Cada test autonomous que existe en tools/ debe correr en CI. Un test que solo
# se ejecuta en local protege nada: la siguiente Pull Request puede romper lo
# que protege sin que ningun job se ponga rojo.
$required = @(Get-ChildItem -LiteralPath (Join-Path $root 'tools') -File |
  Where-Object { $_.Name -like 'test-*.ps1' -and $_.Name -ne 'test-publication-pipeline.ps1' } |
  ForEach-Object { $_.Name } | Sort-Object)
if ($required.Count -lt 14) { throw "Se esperaban al menos 14 tests en CI y el workflow declara $($required.Count)." }
foreach ($test in $required) {
  if ($content -notmatch [regex]::Escape($test)) { throw "El workflow no ejecuta $test." }
}
if ($content -match 'test-publication-pipeline\.ps1') {
  throw 'test-publication-pipeline.ps1 no debe ejecutarse en CI: depende de un clon local que el runner no tiene.'
}
foreach ($job in @('validate:', 'test:')) {
  if ($content -notmatch [regex]::Escape($job)) { throw "El workflow no define el job $job" }
}
Write-Output "Workflow wiring passed: delegates to validate-catalog.ps1, runs all $($required.Count) self-contained tests, excludes the local-only test, no stale 1 MB limit."
