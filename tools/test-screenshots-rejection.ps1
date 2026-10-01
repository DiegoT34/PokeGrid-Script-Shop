$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-shots-reject-' + [guid]::NewGuid().ToString('N'))
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
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @() }
  [IO.File]::WriteAllText((Join-Path $testRoot 'catalog.json'),($catalog|ConvertTo-Json -Depth 12),$utf8)

  $script = Join-Path $testRoot 'reject.user.js'
  $code = "// ==UserScript==`n// @name Reject`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($script,$code,$utf8)

  $buena = Join-Path $testRoot 'buena.png'
  [IO.File]::WriteAllBytes($buena,$pngBytes)
  $malaExt = Join-Path $testRoot 'mala.bmp'
  [IO.File]::WriteAllBytes($malaExt,$pngBytes)
  $inexistente = Join-Path $testRoot 'no-existe.png'

  $output = Invoke-Publisher -Script $publisher -Shots @($malaExt,$inexistente,$buena) -Params @{
    Path = $script; Id = 'reject-script'; PublicationMode = 'New'
    Summary = 'x'; Description = 'x'; Changelog = 'y'
    RepositoryRoot = $testRoot
  }
  if($output.ExitCode -ne 0){throw "La publicacion con capturas malas fallo; deberia publicarlas sin ellas.`n$($output.Output)"}

  # Cada rechazo dice POR QUE, en espanol, con el nombre del archivo.
  if($output.Output -notmatch 'extension'){throw "El rechazo por extension no se explico.`n$($output.Output)"}
  if($output.Output -notmatch 'No se encontro la captura'){throw "El rechazo por ruta inexistente no se explico.`n$($output.Output)"}
  if($output.Output -notmatch 'mala\.bmp'){throw 'El aviso no nombra el archivo descartado.'}
  if($output.Output -notmatch 'no-existe\.png'){throw 'El aviso no nombra el archivo inexistente.'}

  # Y lo bueno se publico igualmente.
  $entry = (Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'reject-script' } | Select-Object -First 1
  $urls = @($entry.screenshots)
  if($urls.Count -ne 1){throw "Se publico $($urls.Count) captura y se esperaba solo la buena."}
  if($urls[0] -notmatch 'reject-script-1\.png$'){throw "La captura buena no ocupo la posicion 1: $($urls[0])"}

  # Siete capturas: solo las 6 primeras, y se dice cuantas se ignoraron.
  $muchas = @()
  for($i=1;$i -le 7;$i++){
    $p = Join-Path $testRoot "mucha-$i.png"
    [IO.File]::WriteAllBytes($p,$pngBytes)
    $muchas += $p
  }
  # Siete capturas, todas con la MISMA extension. Es el caso real de alguien que quiere
  # mas de una foto, y el que hace falta para llegar al limite de seis.
  #
  # El plan pensaba que dos capturas con la misma extension colisionaban al generar el
  # nombre. No colisionan: el numerito las distingue, y el launcher acepta
  # mi-script-1.png y mi-script-2.png sin problema. Verificado contra
  # esCapturaDeShop antes de escribir este caso.
  $otras = @{}
  foreach ($nombre in 'varias-script') {
    $p = Join-Path $testRoot "$nombre.user.js"
    [IO.File]::WriteAllText($p, "// ==UserScript==`n// @name $nombre`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n", $utf8)
    $otras[$nombre] = $p
  }

  $varias = @()
  # NUEVE capturas, no siete. Con siete el aviso sale una vez pase lo que pase, asi que
  # no distingue un break de un continue. Con nueve, un continue repetiria el mismo aviso
  # en cada iteracion que exceda, y eso es exactamente lo que la comprobacion de abajo
  # caza. El numero sale de ahi, no de la cuenta de "cuantas sobran".
  for($i=1;$i -le 9;$i++){
    $p = Join-Path $testRoot "varias-$i.png"
    [IO.File]::WriteAllBytes($p,$pngBytes)
    $varias += $p
  }
  $salidaN = Invoke-Publisher -Script $publisher -Shots $varias -Params @{
    Path = $otras['varias-script']; Id = 'varias-script'; PublicationMode = 'New'
    Summary = 'x'; Description = 'x'; Changelog = 'y'
    RepositoryRoot = $testRoot
  }
  if($salidaN.ExitCode -ne 0){throw "La publicacion con 9 capturas fallo.`n$($salidaN.Output)"}
  $entryN = (Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'varias-script' } | Select-Object -First 1
  $urlsN = @($entryN.screenshots)
  if($urlsN.Count -ne 6){throw "Se publicaron $($urlsN.Count) capturas y el limite son 6."}
  for($i=0;$i -lt 6;$i++){
    if($urlsN[$i] -notmatch "varias-script-$($i+1)\.png$"){throw "La captura $i no se numero consecutivamente: $($urlsN[$i])"}
  }
  if($salidaN.Output -notmatch 'limite'){throw "El recorte por exceso no se explico.`n$($salidaN.Output)"}
  if($salidaN.Output -notmatch 'Se ignoraron 3'){throw "El aviso no dice cuantas se ignoraron; con nueve y limite de seis son tres.`n$($salidaN.Output)"}
  # Y las que sobran no se copian: el recorte ocurre en el bucle, antes de la copia. Sin
  # esto, archivos de mas se quedan en disco que ninguna entrada del catalogo describe.
  for($i=7;$i -le 9;$i++){
    if(Test-Path -LiteralPath (Join-Path $testRoot "screenshots\varias-$i.png")){
      throw "La captura varia-$i se copio a disco pese a estar fuera del limite."
    }
  }

  # El aviso del exceso se dice UNA vez, no en cada iteracion que excede. Con continue en
  # vez de break el resultado es el mismo, asi que esta comprobacion es la que distingue
  # una cosa de la otra: siete lineas de aviso del mismo texto son ruido, y quien publica
  # no puede leerlas por encima del motivo real.
  $avisosExceso = @($salidaN.Output -split "`n" | Where-Object { $_ -match 'Se ignoraron' })
  if($avisosExceso.Count -ne 1){throw "El aviso de exceso aparece $($avisosExceso.Count) veces y deberia aparecer una."}

  Write-Output 'Screenshots rejection passed: extension invalida, inexistente, exceso con numeracion consecutiva y cada aviso con su motivo.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
