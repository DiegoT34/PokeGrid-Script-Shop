$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'git-helper.ps1')

$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("pokegrid-shots-git-" + [Guid]::NewGuid().ToString('N'))
$remote = Join-Path $testRoot 'remote.git'
$seed = Join-Path $testRoot 'seed'
$work = Join-Path $testRoot 'work'
$git = Resolve-PokeGridGitPath
$utf8 = [Text.UTF8Encoding]::new($false)
$pngBytes = [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13,0x49,0x48,0x44,0x52)

# Ver tools\test-screenshots-publication.ps1: -File no pasa arrays, hay que usar -Command.
function Invoke-Publisher {
  param([string]$Script,[hashtable]$Params,[string[]]$Shots)
  $piezas = @("'$Script'")
  foreach($k in ($Params.Keys | Sort-Object)){ $piezas += "-$k '$($Params[$k])'" }
  if($Shots -and $Shots.Count -gt 0){
    $lista = ($Shots | ForEach-Object { "'$_'" }) -join ','
    $piezas += "-Screenshots @($lista)"
  }
  $command = '& ' + ($piezas -join ' ')
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $command 2>&1 | Out-String
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  & $git init --bare $remote | Out-Null
  & $git init $seed | Out-Null
  & $git -C $seed config user.name 'PokeGrid Test'
  & $git -C $seed config user.email 'pokegrid-test@local.invalid'
  $emptyCatalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @() }
  [IO.File]::WriteAllText((Join-Path $seed 'catalog.json'),($emptyCatalog|ConvertTo-Json -Depth 12),$utf8)
  Copy-Item -LiteralPath $publisher -Destination (Join-Path $seed 'publish-script.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'git-helper.ps1') -Destination (Join-Path $seed 'git-helper.ps1')
  & $git -C $seed add -- catalog.json publish-script.ps1 git-helper.ps1
  & $git -C $seed commit -m 'Catalogo inicial' | Out-Null
  & $git -C $seed branch -M main
  & $git -C $seed remote add origin $remote
  & $git -C $seed push -u origin main | Out-Null
  & $git --git-dir=$remote symbolic-ref HEAD refs/heads/main
  & $git clone $remote $work | Out-Null
  & $git -C $work config user.name 'PokeGrid Test'
  & $git -C $work config user.email 'pokegrid-test@local.invalid'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gitattributes-de-prueba') -Destination (Join-Path $work '.gitattributes')

  $shot = Join-Path $testRoot 'captura.png'
  [IO.File]::WriteAllBytes($shot,$pngBytes)
  $script = Join-Path $testRoot 'con-shots.user.js'
  $code = "// ==UserScript==`n// @name Con Shots`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($script,$code,$utf8)

  $pub = Invoke-Publisher -Script (Join-Path $work 'publish-script.ps1') -Shots @($shot) -Params @{
    Path = $script; Id = 'con-shots'; PublicationMode = 'New'
    Summary = 'x'; Description = 'x'; Changelog = 'y'
    RepositoryRoot = $work
  }
  if($pub.ExitCode -ne 0){throw "La publicacion con capturas fallo.`n$($pub.Output)"}

  # Esto es lo que importa: el add incluye la carpeta, y el commit la lleva.
  $idBoxValue = 'con-shots'
  $target = "scripts/$idBoxValue.user.js"
  [void](Invoke-PokeGridGit -RepositoryRoot $work -Arguments @('add','--','catalog.json',$target,'screenshots'))

  $staged = & $git -C $work diff --cached --name-only
  $stagedNames = @($staged)
  if($stagedNames -notcontains 'catalog.json'){throw "El catalogo no quedo en el area de preparacion.`n$($stagedNames -join ', ')"}
  if(-not ($stagedNames | Where-Object { $_ -like 'screenshots/*' })){
    throw "La carpeta screenshots/ no quedo en el area de preparacion. El commit saldra bien y la URL apuntara a imagenes que no estan en GitHub.`n$($stagedNames -join ', ')"
  }

  [void](Invoke-PokeGridGit -RepositoryRoot $work -Arguments @('commit','-m','Con capturas','--','catalog.json',$target,'screenshots'))
  # Y al remoto, que es donde acaba de verdad: un commit local que nunca se sube deja la
  # URL del catalogo apuntando a imagenes que no existen para el que lee la Shop.
  [void](Invoke-PokeGridGit -RepositoryRoot $work -Arguments @('push'))
  $enRemoto = & $git --git-dir=$remote ls-tree -r --name-only main
  if(@($enRemoto) -notcontains 'screenshots/con-shots-1.png'){
    $enLocal = @(& $git -C $work ls-tree -r --name-only HEAD)
    throw "La captura no llego al remoto.`nremoto: $($enRemoto -join ', ')`nlocal:  $($enLocal -join ', ')`nestado: $(& $git -C $work status --short | Out-String)"
  }

  # La regla de binario tiene que existir, y no basta con que el comentario la mencione.
  $attrs = & $git -C $work check-attr binary -- screenshots/con-shots-1.png
  if($attrs -notmatch ': binary: set'){throw "La regla de binario no se aplica a las capturas.`n$attrs"}

  # Y el caso que de verdad rompe la GUI: publicar SIN capturas cuando la carpeta no existe.
  # Si la GUI hace `git add -- screenshots` sin crearla antes, el add sale con error y la
  # publicacion entera de un script sin fotos se queda a medias. Esto no lo prueba ningun
  # otro test del repo.
  $solo = Join-Path $testRoot 'solo.user.js'
  [IO.File]::WriteAllText($solo, "// ==UserScript==`n// @name Solo`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n", $utf8)
  $pubSolo = Invoke-Publisher -Script (Join-Path $work 'publish-script.ps1') -Params @{
    Path = $solo; Id = 'solo-script'; PublicationMode = 'New'
    Summary = 'x'; Description = 'x'; Changelog = 'y'
    RepositoryRoot = $work
  }
  if($pubSolo.ExitCode -ne 0){throw "La publicacion sin capturas fallo.`n$($pubSolo.Output)"}
  [void](Invoke-PokeGridGit -RepositoryRoot $work -Arguments @('add','--','catalog.json','scripts/solo-script.user.js','screenshots'))
  $stagedSolo = @(& $git -C $work diff --cached --name-only)
  if($stagedSolo -notcontains 'catalog.json'){
    throw "El add con una carpeta screenshots/ vacia fallo y dejo la publicacion sin preparar. Un add sobre ruta inexistente sale con codigo de error.`n$($stagedSolo -join ', ')"
  }

  # Y el codigo de la GUI, que esta prueba no ejecuta. Todo lo de arriba usa git
  # directamente y por eso no mira lo que la GUI hace: con la GUI rota, estas
  # comprobaciones siguen en verde. Hace falta mirarla.
  #
  # Se comprueba el TEXTO de los cuatro comandos, no su resultado, porque la GUI necesita
  # una ventana y un repositorio real. Es la unica forma de cubrirla desde aqui, y por eso
  # las cuatro cadenas van con su ancla exacta: una comprobacion de este tipo que busca un
  # texto que aparece en mas de un sitio no vigila nada.
  $gui = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
  # OJO con las dos cosas que aqui se equivocan solas:
  #
  # 1. El patron va en comillas DOBLES porque el resto lleva comillas simples de PowerShell.
  #    Pero en comillas dobles, `$target` se expande a la variable —que aqui no existe— y el
  #    patron se queda en "add...,,screenshots" y no casa con nada. Con el codigo equivocado
  #    la cuenta daba 0, no el 2 esperado.
  #
  # 2. La GUI escribe `$target` SIN backtick, porque va como argumento de un array y no
  #    dentro de una cadena. Un patron con backtick delante casaba igual, porque en regex
  #    `+$ es lo mismo que `$$`. Con backtick la cuenta daba 2 con el codigo equivocado: una
  #    comprobacion que pasa con lo que deberia fallar no vigila nada.
  #
  # Se construye el patron con [char]96 para el backtick, fuera de cualquier comilla
  # expandible, y sin backtick delante de `$`.
  $patronAdd = @'
@\('add','--','catalog\.json',\$target,'screenshots'\)
'@
  $patronCommit = @'
@\('commit','-m',\$[\w]+,'--','catalog\.json',\$target,'screenshots'\)
'@
  $patronAddSolo = @'
@\('add','--','catalog\.json',\$target\)
'@
  $patronCommitSolo = @'
@\('commit','-m',\$[\w]+,'--','catalog\.json',\$target\)
'@
  $adds = @([regex]::Matches($gui, $patronAdd))
  if($adds.Count -ne 2){throw "Los dos git add de la GUI tienen que incluir 'screenshots' y hay $($adds.Count) que lo hacen de 2."}
  $commits = @([regex]::Matches($gui, $patronCommit))
  if($commits.Count -ne 2){throw "Los dos git commit de la GUI tienen que incluir 'screenshots' y hay $($commits.Count) que lo hacen de 2."}
  if($gui -notmatch 'function Ensure-ScreenshotsFolder'){
    throw 'La GUI no crea la carpeta screenshots/ antes del add. Un add sobre ruta inexistente sale con error y corta la publicacion de un script sin fotos.'
  }
  if($gui -notmatch 'Ensure-ScreenshotsFolder \$repoRoot'){
    throw 'Ensure-ScreenshotsFolder existe pero no se llama antes de los add.'
  }
  # Y que la carpeta se cree de verdad, no solo que la funcion exista: el cuerpo tiene que
  # contener el NewItem. Una funcion vacia con el nombre correcto no arregla nada.
  if($gui -notmatch "function Ensure-ScreenshotsFolder \{[^}]*New-Item"){
    throw 'Ensure-ScreenshotsFolder no crea nada: le falta el New-Item dentro.'
  }
  # Y ningun add ni commit puede quedarse sin la carpeta. Este es el fallo que la
  # documentacion llama «el mas caro del trabajo», asi que se cuenta, no se busca.
  $addsSinCarpeta = @([regex]::Matches($gui, $patronAddSolo))
  if($addsSinCarpeta.Count -gt 0){throw "Hay $($addsSinCarpeta.Count) git add sin la carpeta screenshots/."}
  $commitsSinCarpeta = @([regex]::Matches($gui, $patronCommitSolo))
  if($commitsSinCarpeta.Count -gt 0){throw "Hay $($commitsSinCarpeta.Count) git commit sin la carpeta screenshots/."}

  # Y la regla de binario, que sin ella la conversion global de fin de linea pasa las
  # imagenes. Se lee el fichero real, no un comentario que la mencione.
  $attributesPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.gitattributes'
  $attributes = Get-Content -LiteralPath $attributesPath -Raw -Encoding UTF8
  if($attributes -notmatch '(?m)^screenshots/\* binary\s*$'){
    throw '.gitattributes no declara «screenshots/* binary».'
  }

  Write-Output 'Screenshots git-add passed: la carpeta entra en el area de preparacion, llega al remoto, el add no falla cuando esta vacia, y los cuatro comandos de la GUI la incluyen.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
