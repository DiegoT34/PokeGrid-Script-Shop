$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-shots-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)

# Invoke-Publisher llama al publicador pasando las capturas como ARRAY DE VERDAD.
#
# No se puede con -File: en Windows PowerShell 5.1, `powershell.exe -File s.ps1 -X @($a,$b)`
# solo entrega el primer elemento del array y el resto se va a $args. Verificado: -File
# llega 1, -Command llega 2. Como las capturas son justamente una lista, invocar con -File
# hacia que la prueba viera una sola captura siempre.
#
# Con -Command el array llega entero al param(). Las comillas simples del camino son
# obligatorias en Windows.
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

# Un PNG valido de verdad. Los bytes magicos son los que hacen que la copia tenga
# sentido; el publicador no los mira, pero una prueba que usa un .png que no es un
# .png no esta probando el caso real.
$pngBytes = [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13,0x49,0x48,0x44,0x52)

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $catalog = [ordered]@{
    schemaVersion = 1
    updatedAt = '2026-01-01T00:00:00Z'
    scripts = @()
  }
  [IO.File]::WriteAllText((Join-Path $testRoot 'catalog.json'),($catalog|ConvertTo-Json -Depth 12),$utf8)

  $newScript = Join-Path $testRoot 'shot-script.user.js'
  $newCode = "// ==UserScript==`n// @name Shot Script`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($newScript,$newCode,$utf8)

  # Capturas con nombres HORRIBLES a proposito. El publicador no debe usar ninguno
  # de ellos: el nombre publicado se genera desde el id y la posicion.
  $shotA = Join-Path $testRoot 'Captura de pantalla (1).PNG'
  [IO.File]::WriteAllBytes($shotA,$pngBytes)
  $shotB = Join-Path $testRoot '   espacio y tilde a.jpg'
  [IO.File]::WriteAllBytes($shotB,$pngBytes)

  $primera = Invoke-Publisher -Script $publisher -Shots @($shotA,$shotB) -Params @{
    Path = $newScript; Id = 'shot-script'; PublicationMode = 'New'
    Summary = 'Con capturas'; Description = 'Con capturas'; Changelog = 'Primera'
    RepositoryRoot = $testRoot
  }
  if($primera.ExitCode -ne 0){throw "La publicacion con capturas termino con codigo $($primera.ExitCode).`n$($primera.Output)"}

  # 1. Los archivos se copiaron con el nombre GENERADO, no con el original.
  $shotsDir = Join-Path $testRoot 'screenshots'
  if(-not (Test-Path -LiteralPath $shotsDir -PathType Container)){throw 'No se creo la carpeta screenshots/.'}
  $copied = @(Get-ChildItem -LiteralPath $shotsDir -File | Sort-Object Name)
  $expectedNames = @('shot-script-1.png','shot-script-2.jpg')
  if($copied.Count -ne 2){throw "Se esperaban 2 capturas y hay $($copied.Count)."}
  if(($copied.Name -join ',') -ne ($expectedNames -join ',')){
    throw "Los nombres generados no son los esperados: $($copied.Name -join ',')"
  }

  # 2. El contenido es byte a byte el del original. Copiar no es renombrar.
  $origenA = (Get-FileHash -LiteralPath $shotA -Algorithm SHA256).Hash
  if((Get-FileHash -LiteralPath (Join-Path $shotsDir 'shot-script-1.png') -Algorithm SHA256).Hash -ne $origenA){
    throw 'La captura copiada no es identica al original.'
  }

  # 3. La entrada lleva las URLs completas, con la ruta y el repositorio correctos.
  $result = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $entry = @($result.scripts) | Where-Object { $_.id -eq 'shot-script' } | Select-Object -First 1
  if(-not $entry){throw 'La entrada no se escribio en el catalogo.'}
  $urls = @($entry.screenshots)
  if($urls.Count -ne 2){throw "La entrada declara $($urls.Count) capturas y se esperaban 2."}
  $base = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots'
  if($urls[0] -ne "$base/shot-script-1.png"){throw "URL de captura 0 inesperada: $($urls[0])"}
  if($urls[1] -ne "$base/shot-script-2.jpg"){throw "URL de captura 1 inesperada: $($urls[1])"}

  # 4. Sin -Screenshots, el campo NO aparece. Ni vacio: ausente.
  $solo = Join-Path $testRoot 'solo.user.js'
  $soloCode = "// ==UserScript==`n// @name Solo`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($solo,$soloCode,$utf8)
  $segunda = Invoke-Publisher -Script $publisher -Params @{
    Path = $solo; Id = 'solo-script'; PublicationMode = 'New'
    Summary = 'Solo'; Description = 'Solo'; Changelog = 'Primera'
    RepositoryRoot = $testRoot
  }
  if($segunda.ExitCode -ne 0){throw "La publicacion sin capturas fallo.`n$($segunda.Output)"}
  $raw = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8
  $soloEntry = ($raw | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'solo-script' } | Select-Object -First 1
  if($soloEntry.PSObject.Properties.Name -contains 'screenshots'){
    throw 'Un script sin capturas lleva el campo screenshots. Debe estar ausente, no vacio.'
  }

  # El limite de tamano. Un .png de 3 MB: se descarta con aviso y el resto se publica.
  # Este caso lo escribio el paso 7 del plan, y lo escribio porque el sabotaje del limite
  # de tamano NO MORDE con la prueba de arriba: la comprobacion no existia.
  $grande = Join-Path $testRoot 'grande.png'
  # La version del userscript sube a 1.1.0: el publicador tiene una guarda que no deja
  # republicar la misma version, y estos dos casos son actualizaciones.
  [IO.File]::WriteAllText($newScript, "// ==UserScript==`n// @name Shot Script`n// @namespace http://tampermonkey.net/`n// @version 1.1.0`n// ==/UserScript==`n", $utf8)
  $bytesGrandes = [byte[]]::new(3MB)
  [Array]::Copy($pngBytes, $bytesGrandes, $pngBytes.Length)
  [IO.File]::WriteAllBytes($grande, $bytesGrandes)
  $conGrande = Invoke-Publisher -Script $publisher -Shots @($grande) -Params @{
    Path = $newScript; Id = 'shot-script'; PublicationMode = 'Update'
    Summary = 'Con capturas'; Description = 'Con capturas'; Changelog = 'Segunda'
    RepositoryRoot = $testRoot
  }
  if($conGrande.ExitCode -ne 0){throw "La publicacion con una captura grande fallo; deberia descartarla y continuar.`n$($conGrande.Output)"}
  if($conGrande.Output -notmatch '3145728 bytes'){throw "El descarte por tamano no dijo cuantos bytes ocupa.`n$($conGrande.Output)"}
  if($conGrande.Output -notmatch 'Se descarto'){throw "El descarte por tamano no se marco como descarte.`n$($conGrande.Output)"}
  if(-not (Test-Path -LiteralPath $grande -PathType Leaf)){throw 'La prueba borro el original de la captura grande.'}
  $trasGrande = (Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'shot-script' } | Select-Object -First 1
  if(@($trasGrande.screenshots).Count -ne 2){throw 'La captura grande cambio el catalogo. Deberian conservarse las dos que ya habia.'}

  # Y el rollback: si la escritura del catalogo falla, las capturas nuevas no quedan
  # colgadas. Este caso tambien lo escribio el paso 7, porque el sabotaje del rollback
  # NO MORDE con la prueba de arriba: la comprobacion no existia.
  #
  # El fallo tiene que ocurrir DESPUES de copiar, que es cuando las capturas quedan
  # colgando. Ni un JSON roto ni un directorio sirven: ambos hacen que el publicador falle
  # al LEER el catalogo, antes de copiar, y el rollback no tendria nada que deshacer.
  # Verificado: con un directorio sale «No se encontro catalog.json en el repositorio».
  #
  # Lo que sirve es que la ESCRITURA falle con el catalogo ya leido y las capturas ya
  # copiadas. Abrir el archivo en exclusiva y no cerrarlo lo consigue: en Windows, un
  # archivo abierto sin compartir escritura no se puede escribir encima.
  $nueva = Join-Path $testRoot 'nueva.png'
  [IO.File]::WriteAllBytes($nueva, $pngBytes)
  [IO.File]::WriteAllText($newScript, "// ==UserScript==`n// @name Shot Script`n// @namespace http://tampermonkey.net/`n// @version 1.2.0`n// ==/UserScript==`n", $utf8)
  $bloqueo = [IO.File]::Open((Join-Path $testRoot 'catalog.json'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  # El publicador va a fallar, y su fallo llega como error de stderr del subproceso. Con
  # $ErrorActionPreference='Stop' eso corta la prueba aqui, antes de poder comprobar si
  # la captura quedo colgada. Se baja la preferencia solo durante la llamada.
  $preferencia = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $trasFallo = Invoke-Publisher -Script $publisher -Shots @($nueva) -Params @{
      Path = $newScript; Id = 'shot-script'; PublicationMode = 'Update'
      Summary = 'x'; Description = 'x'; Changelog = 'y'
      RepositoryRoot = $testRoot
    }
  } finally {
    $ErrorActionPreference = $preferencia
    $bloqueo.Dispose()
  }
  if($trasFallo.ExitCode -eq 0){throw 'La publicacion con el catalogo bloqueado devolvio exito.'}
  # Que la escritura fallara de verdad, no por otra cosa. El mensaje del publicador al
  # fallar la restauracion menciona el acceso al archivo, que es el bloqueo.
  if($trasFallo.Output -notmatch 'acceso al archivo|Access to the path'){
    throw "El fallo no fue de escritura bloqueada, asi que el caso no prueba el rollback.`n$($trasFallo.Output)"
  }
  # Lo que NO puede quedar es la captura NUEVA: la que se ha copiado en esta
  # publicacion y que ninguna entrada del catalogo describe, porque la escritura fallo.
  # Las dos anteriores SI deben quedar: el catch solo deshace lo que no existia antes,
  # y borrar las que ya estaban dejaria al usuario sin las fotos de la version buena.
  $colgadas = @(Get-ChildItem -LiteralPath (Join-Path $testRoot 'screenshots') -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  if($colgadas -contains 'shot-script-1.png' -or $colgadas -contains 'shot-script-2.jpg'){
    # shot-script-3.png es el nombre que habria tenido la nueva: el contador sigue en 2
    # porque las dos previas se recogieron del catalogo.
    $nuevas = @($colgadas | Where-Object { $_ -notin @('shot-script-1.png','shot-script-2.jpg') })
    if($nuevas.Count -gt 0){
      throw "Tras un fallo de escritura quedaron capturas nuevas colgando que el catalogo no describe: $($nuevas -join ', ')"
    }
  }
  if($colgadas -notcontains 'shot-script-1.png' -or $colgadas -notcontains 'shot-script-2.jpg'){
    throw "El rollback borro capturas que ya estaban antes de la publicacion.`n$($colgadas -join ', ')"
  }

  # Publicar una captura NUEVA sobre un script que ya tiene una no puede sobrescribirla.
  # Este caso lo anadio el implementador al ejecutar el paso 7, no el plan: la numeracion
  # arrancaba en 1 siempre, y el nombre generado volvia a ser shot-script-1.png con otro
  # contenido. La foto nueva se comia el sitio de la vieja sin avisar.
  #
  # La version sube a 1.3.0 porque el publicador no deja republicar la misma.
  [IO.File]::WriteAllText($newScript, "// ==UserScript==`n// @name Shot Script`n// @namespace http://tampermonkey.net/`n// @version 1.3.0`n// ==/UserScript==`n", $utf8)
  $cuatro = Join-Path $testRoot 'cuatro.webp'
  [IO.File]::WriteAllBytes($cuatro, $pngBytes)
  $hashPrevia1 = (Get-FileHash -LiteralPath (Join-Path $shotsDir 'shot-script-1.png') -Algorithm SHA256).Hash
  $hashPrevia2 = (Get-FileHash -LiteralPath (Join-Path $shotsDir 'shot-script-2.jpg') -Algorithm SHA256).Hash
  $conTercera = Invoke-Publisher -Script $publisher -Shots @($cuatro) -Params @{
    Path = $newScript; Id = 'shot-script'; PublicationMode = 'Update'
    Summary = 'Con capturas'; Description = 'Con capturas'; Changelog = 'Tercera'
    RepositoryRoot = $testRoot
  }
  if($conTercera.ExitCode -ne 0){throw "La publicacion con una tercera captura fallo.`n$($conTercera.Output)"}
  $trasTercera = (Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'shot-script' } | Select-Object -First 1
  $urlsTercera = @($trasTercera.screenshots)
  if($urlsTercera.Count -ne 1){throw "Al pasar una captura nueva el catalogo deberia declarar solo esa, y declara $($urlsTercera.Count)."}
  if($urlsTercera[0] -notmatch 'shot-script-3\.webp$'){throw "La captura nueva no se numero a continuacion de las anteriores: $($urlsTercera[0])"}
  if((Get-FileHash -LiteralPath (Join-Path $shotsDir 'shot-script-1.png') -Algorithm SHA256).Hash -ne $hashPrevia1){
    throw 'La captura nueva SOBRESCRIBIO a shot-script-1.png, que ya estaba publicada.'
  }
  if((Get-FileHash -LiteralPath (Join-Path $shotsDir 'shot-script-2.jpg') -Algorithm SHA256).Hash -ne $hashPrevia2){
    throw 'La captura nueva altero shot-script-2.jpg, que ya estaba publicada.'
  }
  if(-not (Test-Path -LiteralPath (Join-Path $shotsDir 'shot-script-3.webp') -PathType Leaf)){
    throw 'La captura nueva no se copio a disco con su nombre numerado.'
  }

  Write-Output 'Screenshots publication passed: nombre generado, copia identica, URLs completas, campo ausente sin capturas, limite de tamano, rollback sin capturas colgadas y numeracion que no sobrescribe.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
