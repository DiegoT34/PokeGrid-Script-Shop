$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'git-helper.ps1')

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("pokegrid-publisher-git-" + [Guid]::NewGuid().ToString('N'))
$remote = Join-Path $testRoot 'remote.git'
$seed = Join-Path $testRoot 'seed'
$publisher = Join-Path $testRoot 'publisher'
$verification = Join-Path $testRoot 'verification'
$git = Resolve-PokeGridGitPath

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  & $git init --bare $remote | Out-Null
  & $git init $seed | Out-Null
  & $git -C $seed config user.name 'PokeGrid Test'
  & $git -C $seed config user.email 'pokegrid-test@local.invalid'
  Set-Content -LiteralPath (Join-Path $seed 'catalog.json') -Value '{"scripts":[]}' -Encoding UTF8
  & $git -C $seed add -- catalog.json
  & $git -C $seed commit -m 'Catálogo inicial' | Out-Null
  & $git -C $seed branch -M main
  & $git -C $seed remote add origin $remote
  & $git -C $seed push -u origin main | Out-Null
  & $git --git-dir=$remote symbolic-ref HEAD refs/heads/main
  & $git clone $remote $publisher | Out-Null
  & $git -C $publisher config user.name 'PokeGrid Test'
  & $git -C $publisher config user.email 'pokegrid-test@local.invalid'

  [void](Invoke-PokeGridGit -RepositoryRoot $publisher -Arguments @('pull','--ff-only'))
  Set-Content -LiteralPath (Join-Path $publisher 'script.user.js') -Value '// userscript de prueba' -Encoding UTF8
  [void](Invoke-PokeGridGit -RepositoryRoot $publisher -Arguments @('add','--','script.user.js'))
  [void](Invoke-PokeGridGit -RepositoryRoot $publisher -Arguments @('commit','-m','Publicación de prueba','--','script.user.js'))
  [void](Invoke-PokeGridGit -RepositoryRoot $publisher -Arguments @('push'))

  & $git clone $remote $verification | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $verification 'script.user.js') -PathType Leaf)) {
    throw 'El push de prueba no llegó al repositorio remoto temporal.'
  }
  Write-Output 'PokeGrid Publisher Git workflow passed: pull, add, commit and push completed.'
} finally {
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
