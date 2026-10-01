$ErrorActionPreference = 'Stop'
$remover = Join-Path $PSScriptRoot 'remove-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-shots-remove-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)
$pngBytes = [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13,0x49,0x48,0x44,0x52)

try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot '.git') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
  $shotsDir = Join-Path $testRoot 'screenshots'
  New-Item -ItemType Directory -Path $shotsDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'fuera') -Force | Out-Null

  $script = Join-Path $testRoot 'scripts\se-van.user.js'
  [IO.File]::WriteAllText($script,"// ==UserScript==`n// @name Se Van`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n",$utf8)
  $otro = Join-Path $testRoot 'scripts\otro.user.js'
  [IO.File]::WriteAllText($otro,"// ==UserScript==`n// @name Otro`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n",$utf8)

  # Las suyas, y de dos scripts que NO se van.
  foreach($name in 'se-van-1.png','se-van-2.jpg'){ [IO.File]::WriteAllBytes((Join-Path $shotsDir $name),$pngBytes) }
  foreach($name in 'otro-1.png','queda-1.png'){ [IO.File]::WriteAllBytes((Join-Path $shotsDir $name),$pngBytes) }
  # Y un SENUELO fuera de la carpeta, con un nombre que el filtro tambien casaria. Un
  # Get-ChildItem sin acotar a la carpeta se lo lleva por delante.
  [IO.File]::WriteAllBytes((Join-Path $testRoot 'fuera\se-van-1.png'),$pngBytes)

  $base = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts'
  $shots = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots'
  $catalog = [ordered]@{
    schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'
    scripts = @(
      [ordered]@{ id='se-van';name='Se Van';namespace='http://tampermonkey.net/';version='1.0.0';summary='x';description='x';category='Utilidades';minLauncherVersion='0.22.1';downloadUrl="$base/se-van.user.js";sha256=('a'*64);publishedAt='2026-01-01T00:00:00Z';screenshots=@("$shots/se-van-1.png","$shots/se-van-2.jpg") },
      [ordered]@{ id='otro';name='Otro';namespace='http://tampermonkey.net/';version='1.0.0';summary='x';description='x';category='Utilidades';minLauncherVersion='0.22.1';downloadUrl="$base/otro.user.js";sha256=('b'*64);publishedAt='2026-01-01T00:00:00Z';screenshots=@("$shots/otro-1.png") }
    )
  }
  [IO.File]::WriteAllText((Join-Path $testRoot 'catalog.json'),($catalog|ConvertTo-Json -Depth 12),$utf8)

  # El removedor emite JSON. Con un PSCustomObject, al venir de un subproceso PowerShell lo
  # formatea como tabla y llega en lineas de texto, que hay que parsear a mano. Verificado:
  # sin JSON, cada elemento de la salida es un String tipo «ScreenshotsRemoved : 2».
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $crudo = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $remover -Id 'se-van' -RepositoryRoot $testRoot 2>&1 | Out-String
    $codigo = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if($codigo -ne 0){throw "La retirada fallo con codigo $codigo.`n$crudo"}
  $objeto = $crudo | ConvertFrom-Json
  if(-not $objeto -or -not ($objeto.PSObject.Properties.Name -contains 'ScreenshotsRemoved')){
    throw "La retirada no devolvio el objeto esperado.`n$crudo"
  }

  $restantes = @(Get-ChildItem -LiteralPath $shotsDir -File | Sort-Object Name | ForEach-Object { $_.Name })
  if($restantes -contains 'se-van-1.png'){throw "La captura se-van-1.png sobrevivio a la retirada.`n$($restantes -join ', ')"}
  if($restantes -contains 'se-van-2.jpg'){throw "La captura se-van-2.jpg sobrevivio a la retirada.`n$($restantes -join ', ')"}
  if($restantes -notcontains 'otro-1.png'){throw "La retirada borro la captura de otro script.`n$($restantes -join ', ')"}
  if($restantes -notcontains 'queda-1.png'){throw "La retirada borro una captura que no era del script retirado.`n$($restantes -join ', ')"}

  # El SENUELO: un -Filter sin acotar a la carpeta, o con -Recurse desde la raiz, lo habria
  # borrado. Y no vale con que el filtro sea "$Id-*": con este senuelo, ese filtro tambien
  # casaria, porque Get-ChildItem con -Recurse busca tambien en subcarpetas.
  if(-not (Test-Path -LiteralPath (Join-Path $testRoot 'fuera\se-van-1.png') -PathType Leaf)){
    throw 'La retirada borro un archivo FUERA de screenshots/. El borrado tiene que acotarse a la carpeta.'
  }

  # Y la revalidacion de cada ruta tiene que existir, no solo la acotacion del filtro. Son
  # dos defensas y la prueba anterior solo mide la primera: quitar la revalidacion dejando
  # el -Filter como estaba deja todo en verde, porque -Filter sobre una carpeta ya acotada
  # no sale de ella por su cuenta.
  $removido = Get-Content -LiteralPath $remover -Raw -Encoding UTF8
  if($removido -notmatch 'Get-ChildItem -LiteralPath \$shotsRoot -File -Filter'){
    throw 'El borrado de capturas no usa -LiteralPath $shotsRoot, asi que no se acota a la carpeta.'
  }
  if($removido -notmatch '\$shotPath\.StartsWith\(\$shotsRoot'){
    throw 'El borrado no revalida que cada ruta este dentro de screenshots/. Sin eso, un cambio futuro en el filtro borra fuera.'
  }

  # Y el catalogo sigue con el otro script.
  $tras = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if(@($tras.scripts).Count -ne 1 -or @($tras.scripts)[0].id -ne 'otro'){throw 'La retirada altero el resto del catalogo.'}

  # Y el objeto devuelto dice cuantas capturas borro, que es lo que la GUI registra. La
  # cuenta va como numero y los nombres como texto: un array de un elemento se
  # deserializa como escalar al venir de un subproceso.
  if(@($objeto.ScreenshotsRemoved).Count -ne 2){throw "El objeto devuelto declara $(@($objeto.ScreenshotsRemoved).Count) capturas borradas y son 2."}
  $borradas = @($objeto.ScreenshotsRemoved)
  if(($borradas | Sort-Object) -join ',' -ne 'se-van-1.png,se-van-2.jpg'){throw "Las capturas borradas no son las esperadas: $($borradas -join ', ')"}

  Write-Output 'Screenshots removal passed: borra las suyas, respeta las ajenas y no sale de la carpeta.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
