$ErrorActionPreference='Stop'
$helper=Join-Path $PSScriptRoot 'git-helper.ps1'
$publisher=Join-Path $PSScriptRoot 'publish-launcher.ps1'
. $helper
$git=Resolve-PokeGridGitPath
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-launcher-publisher-'+[guid]::NewGuid().ToString('N'))
$source=Join-Path $testRoot 'source';$remote=Join-Path $testRoot 'remote.git';$clone=Join-Path $testRoot 'verify'
try{
  New-Item -ItemType Directory -Path $source -Force|Out-Null
  & $git init --bare $remote|Out-Null
  & $git -C $source init -b main|Out-Null
  & $git -C $source config user.name 'PokeGrid Test';& $git -C $source config user.email 'test@pokegrid.local'
  New-Item -ItemType Directory -Path (Join-Path $source '.github\workflows') -Force|Out-Null
  [IO.File]::WriteAllText((Join-Path $source 'package.json'),"{`n  `"name`": `"pokegrid-launcher`",`n  `"version`": `"0.22.8`"`n}`n",[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $source '.github\workflows\release.yml'),"name: test`n",[Text.UTF8Encoding]::new($false))
  & $git -C $source add -A;& $git -C $source commit -m 'Base launcher'|Out-Null;& $git -C $source remote add origin $remote;& $git -C $source push -u origin main|Out-Null
  & $git -C $source tag -a 'v0.22.9' -m 'Etiqueta incompleta de una prueba anterior'
  New-Item -ItemType Directory -Path (Join-Path $source 'src') -Force|Out-Null
  [IO.File]::WriteAllText((Join-Path $source 'src\feature.js'),"module.exports = 'test';`n",[Text.UTF8Encoding]::new($false))
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -RepositoryRoot $source -Version '0.22.9' -ReleaseNotes 'Prueba del publicador' -AllowAnyRemote
  if($LASTEXITCODE -ne 0){throw "publish-launcher.ps1 terminó con código $LASTEXITCODE"}
  & $git clone --branch main $remote $clone|Out-Null
  $published=Get-Content -LiteralPath (Join-Path $clone 'package.json') -Raw|ConvertFrom-Json
  if([string]$published.version -ne '0.22.9'){throw 'La versión publicada no coincide.'}
  if(-not(Test-Path -LiteralPath (Join-Path $clone 'src\feature.js'))){throw 'Los cambios pendientes del launcher no fueron publicados.'}
  $tag=(& $git -C $clone tag --list 'v0.22.9'|Out-String).Trim()
  if($tag -ne 'v0.22.9'){throw 'La etiqueta de Release no fue publicada.'}
  $tagObject=(& $git -C $clone cat-file tag 'v0.22.9'|Out-String)
  if($tagObject -notmatch 'Prueba del publicador'){throw 'Las notas no fueron guardadas en la etiqueta de Release.'}
  Write-Output 'Launcher publication pipeline passed: version, pending changes, retry cleanup, notes, commit, main push and release tag.'
}finally{
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue}
}
