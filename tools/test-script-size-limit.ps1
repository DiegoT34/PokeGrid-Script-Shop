$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-size-limit-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-TestScript([string]$Path, [int]$PayloadBytes, [string]$Name, [string]$Version) {
  $header = "// ==UserScript==`n// @name $Name`n// @namespace https://pokegrid.test/size-limit`n// @version $Version`n// @description Prueba del límite de tamaño`n// @match https://example.test/*`n// ==/UserScript==`n"
  $payload = 'x' * $PayloadBytes
  [IO.File]::WriteAllText($Path, $header + "/*$payload*/", $utf8)
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @() }
  [IO.File]::WriteAllText((Join-Path $testRoot 'catalog.json'), ($catalog | ConvertTo-Json -Depth 8), $utf8)

  $accepted = Join-Path $testRoot 'accepted.user.js'
  Write-TestScript $accepted (6MB) 'Accepted Large Script' '1.0.0'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $accepted -Id 'accepted-large-script' -PublicationMode New -Summary 'Prueba grande' -Description 'Prueba grande' -Changelog 'Inicial' -RepositoryRoot $testRoot
  if ($LASTEXITCODE -ne 0) { throw "El archivo de más de 5 MB fue rechazado con código $LASTEXITCODE." }
  $published = Join-Path $testRoot 'scripts\accepted-large-script.user.js'
  if (-not (Test-Path -LiteralPath $published -PathType Leaf) -or (Get-Item -LiteralPath $published).Length -le 5MB) {
    throw 'El archivo de más de 5 MB no fue publicado correctamente.'
  }

  $rejected = Join-Path $testRoot 'rejected.user.js'
  Write-TestScript $rejected (11MB) 'Rejected Large Script' '1.0.0'
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $rejected -Id 'rejected-large-script' -PublicationMode New -RepositoryRoot $testRoot 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($exitCode -eq 0) { throw 'El publicador aceptó incorrectamente un archivo superior a 10 MB.' }
  if ($output -notmatch '10 MB') { throw 'El rechazo por tamaño no informó claramente el límite de 10 MB.' }

  Write-Output 'Script size limit passed: files over 5 MB are accepted and files over 10 MB are rejected.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
