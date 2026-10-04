# El `commit` con la carpeta screenshots/ en el pathspec.
#
# MEDIDO, y este test nace de un fallo real: el publicador no podia publicar ni
# retirar NADA, y el boton de retirar se quedaba muerto.
#
#   git add    -- catalog.json scripts/x.user.js screenshots   ->  sale 0
#   git commit -- catalog.json scripts/x.user.js screenshots   ->  sale 1
#       error: pathspec 'screenshots' did not match any file(s) known to git
#
# Los dos con el mismo pathspec y el mismo repositorio. `add` ignora en silencio un
# directorio sin contenido; `commit -- <rutas>` NO, porque exige que cada ruta sea una
# ruta que git conoce, y git no guarda directorios: solo los guardaria si tuviera un
# archivo dentro.
#
# Por eso la carpeta vacia que crea `Ensure-ScreenshotsFolder` tapaba el error del
# `add` y dejaba vivo el del `commit`, que va un paso despues. Y como el `add` ya
# habia preparado todo, la publicacion moria en el ultimo momento con el indice
# sucio. En la retirada eso es peor: `remove-script.ps1` ya habia borrado el archivo
# y la entrada del catalogo, de modo que reintentar find el error "el script ya no
# existe en el catalogo" y el boton no podia hacer nada.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'git-helper.ps1')

$raiz = Split-Path -Parent $PSScriptRoot
$publisher = Join-Path $raiz 'PokeGrid-Shop-Publisher.ps1'
$git = Resolve-PokeGridGitPath
$utf8 = [Text.UTF8Encoding]::new($false)
$pngBytes = [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13,0x49,0x48,0x44,0x52)

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("pokegrid-commit-pathspec-" + [Guid]::NewGuid().ToString('N'))
$remote = Join-Path $testRoot 'remote.git'
$seed = Join-Path $testRoot 'seed'

function Invoke-Local {
  # Mismo contrato que la GUI: add, y commit con el pathspec que dice Get-CommitPathspec.
  param([string]$Work,[string]$Target,[string]$Message)
  [void](Invoke-PokeGridGit -RepositoryRoot $Work -Arguments @('add','--','catalog.json',$Target,'screenshots'))
  $spec = Get-PokeGridCommitPathspec -RepositoryRoot $Work -Paths @('catalog.json',$Target)
  return Invoke-PokeGridGit -RepositoryRoot $Work -Arguments (@('commit','-m',$Message,'--') + $spec) -AllowFailure
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  & $git init --bare $remote | Out-Null
  & $git init $seed | Out-Null
  & $git -C $seed config user.name 'PokeGrid Test'
  & $git -C $seed config user.email 'pokegrid-test@local.invalid'
  [IO.File]::WriteAllText((Join-Path $seed 'catalog.json'),
    '{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00Z","scripts":[]}', $utf8)
  New-Item -ItemType Directory -Path (Join-Path $seed 'scripts') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $seed 'scripts\solo.user.js'), "// ==UserScript==`n// v1`n", $utf8)
  & $git -C $seed add -- catalog.json scripts/solo.user.js
  & $git -C $seed commit -q -m 'Catalogo inicial' | Out-Null
  & $git -C $seed branch -M main
  & $git -C $seed remote add origin $remote
  & $git -C $seed push -q -u origin main | Out-Null
  & $git --git-dir=$remote symbolic-ref HEAD refs/heads/main

  # --- CASO 1: publicar SIN capturas. La carpeta no existe todavia, que es el estado
  # de cualquier clon, y el de la maquina del usuario. ---
  $work = Join-Path $testRoot 'sin-capturas'
  & $git clone -q $remote $work
  & $git -C $work config user.name 'PokeGrid Test'
  & $git -C $work config user.email 'pokegrid-test@local.invalid'
  if (Test-Path (Join-Path $work 'screenshots')) { throw 'El clon deberia empezar sin carpeta screenshots/.' }

  [IO.File]::WriteAllText((Join-Path $work 'catalog.json'),
    '{"schemaVersion":1,"updatedAt":"2026-01-02T00:00:00Z","scripts":[]}', $utf8)
  [IO.File]::WriteAllText((Join-Path $work 'scripts\solo.user.js'), "// ==UserScript==`n// v2`n", $utf8)

  # Lo que hace la GUI antes del add: crear la carpeta aunque este vacia.
  [void](New-Item -ItemType Directory -Path (Join-Path $work 'screenshots') -Force)

  # Y el pathspec que devuelve la funcion, que es lo que hay que mirar: si incluye
  # 'screenshots' con la carpeta vacia, el commit de abajo va a fallar.
  $specVacia = Get-PokeGridCommitPathspec -RepositoryRoot $work -Paths @('catalog.json','scripts/solo.user.js')
  if (@($specVacia) -contains 'screenshots') {
    throw "Con la carpeta screenshots/ vacia, el pathspec NO puede llevar 'screenshots'.`nPathspec: $($specVacia -join ', ')"
  }

  $r = Invoke-Local -Work $work -Target 'scripts/solo.user.js' -Message 'Publicar sin capturas'
  if ($r.ExitCode -ne 0) {
    throw "El commit de una publicacion SIN capturas fallo.`n$($r.Output)`nCon el pathspec viejo ('screenshots' incluido) este es exactamente el error que dejo al usuario sin publicar."
  }
  [void](Invoke-PokeGridGit -RepositoryRoot $work -Arguments @('push'))

  # --- CASO 2: publicar CON capturas. Aqui 'screenshots' TIENE que ir, o las
  # capturas se quedan fuera del commit y la URL del catalogo apunta a imagenes que
  # no estan en GitHub. El fallo en la direccion contraria. ---
  $work2 = Join-Path $testRoot 'con-capturas'
  & $git clone -q $remote $work2
  & $git -C $work2 config user.name 'PokeGrid Test'
  & $git -C $work2 config user.email 'pokegrid-test@local.invalid'
  [IO.File]::WriteAllText((Join-Path $work2 'catalog.json'),
    '{"schemaVersion":1,"updatedAt":"2026-01-03T00:00:00Z","scripts":[]}', $utf8)
  [IO.File]::WriteAllText((Join-Path $work2 'scripts\solo.user.js'), "// ==UserScript==`n// v3`n", $utf8)
  [void](New-Item -ItemType Directory -Path (Join-Path $work2 'screenshots') -Force)
  [IO.File]::WriteAllBytes((Join-Path $work2 'screenshots\solo-1.png'), $pngBytes)

  # El `add` es lo que mete la captura en el indice, y el pathspec se consulta DESPUES.
  # Si se consultara antes, la carpeta vacia en disco haria que se quitara y la
  # captura se quedaria fuera: por eso la funcion mira el indice y no el disco.
  [void](Invoke-PokeGridGit -RepositoryRoot $work2 -Arguments @('add','--','catalog.json','scripts/solo.user.js','screenshots'))
  $specLlena = Get-PokeGridCommitPathspec -RepositoryRoot $work2 -Paths @('catalog.json','scripts/solo.user.js')
  if (@($specLlena) -notcontains 'screenshots') {
    throw "Con una captura preparada, el pathspec TIENE que llevar 'screenshots'.`nPathspec: $($specLlena -join ', ')"
  }
  $r2 = Invoke-PokeGridGit -RepositoryRoot $work2 -Arguments (@('commit','-m','Con capturas','--') + $specLlena) -AllowFailure
  if ($r2.ExitCode -ne 0) { throw "El commit con capturas fallo.`n$($r2.Output)" }
  [void](Invoke-PokeGridGit -RepositoryRoot $work2 -Arguments @('push'))

  $enRemoto = @(& $git --git-dir=$remote ls-tree -r --name-only main)
  if ($enRemoto -notcontains 'screenshots/solo-1.png') {
    $enLocal = @(& $git -C $work2 ls-tree -r --name-only HEAD)
    throw "La captura no llego al remoto.`nremoto: $($enRemoto -join ', ')`nlocal:  $($enLocal -join ', ')"
  }

  # --- Y la GUI, no una reimplementacion. El caso de arriba usa Get-CommitPathspec
  # tal cual, pero el defecto original era que los dos `commit` de la GUI llevaban
  # 'screenshots' escrito a mano. Eso hay que verlo en el fichero. ---
  $gui = Get-Content -LiteralPath $publisher -Raw -Encoding UTF8
  $commitsConCarpeta = @([regex]::Matches($gui,
    @'
@\('commit','-m',\$[\w]+,'--','catalog\.json',\$target,'screenshots'\)
'@))
  if ($commitsConCarpeta.Count -gt 0) {
    throw "Hay $($commitsConCarpeta.Count) git commit de la GUI con 'screenshots' escrito a mano. Con la carpeta vacia el commit sale con codigo 1 y la publicacion se queda a medias."
  }
  $commitsConHelper = @([regex]::Matches($gui,
    @'
@\('commit','-m',\$[\w]+,'--'\) \+ \(Get-PokeGridCommitPathspec -RepositoryRoot \$repoRoot -Paths @\('catalog\.json',\$target\)\)
'@))
  if ($commitsConHelper.Count -ne 2) {
    throw "Los dos git commit de la GUI tienen que usar Get-CommitPathspec y hay $($commitsConHelper.Count) que lo hacen de 2."
  }

  Write-Output 'Commit pathspec passed: sin capturas el commit sale, con capturas la captura llega al remoto, y los dos commits de la GUI usan el pathspec que decide el indice.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}