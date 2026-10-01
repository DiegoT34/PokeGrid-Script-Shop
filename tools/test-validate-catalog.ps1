$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-catalog.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-validate-' + [Guid]::NewGuid().ToString('N'))

function New-Fixture([string]$Name, [string]$Id, [string]$Version, [string]$Namespace, [int]$PadBytes) {
  $root = Join-Path $testRoot $Name
  New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force | Out-Null
  $code = "// ==UserScript==`n// @name $Name`n// @namespace $Namespace`n// @version $Version`n// @match https://poke.idleworld.online/*`n// ==/UserScript==`n"
  if ($PadBytes -gt 0) { $code += "/*" + ('x' * $PadBytes) + "*/`n" }
  [IO.File]::WriteAllText((Join-Path $root "scripts\$Id.user.js"), $code, $utf8)
  $sha = (Get-FileHash -LiteralPath (Join-Path $root "scripts\$Id.user.js") -Algorithm SHA256).Hash.ToLowerInvariant()
  $entry = [ordered]@{
    id = $Id; name = $Name; namespace = $Namespace; version = $Version
    author = 'PokeGrid'; summary = 'Prueba'; description = 'Prueba'
    category = 'Utilidades'; tags = @(); permissions = @()
    minLauncherVersion = '0.22.1'
    downloadUrl = "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/$Id.user.js"
    sha256 = $sha; homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
    changelog = 'Base'; icon = 'X'; featured = $false; publishedAt = '2026-01-01T00:00:00Z'
  }
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @([pscustomobject]$entry) }
  [IO.File]::WriteAllText((Join-Path $root 'catalog.json'), ($catalog | ConvertTo-Json -Depth 12), $utf8)
  [IO.File]::WriteAllText((Join-Path $root 'catalog.schema.json'), (Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'catalog.schema.json') -Raw), $utf8)
  return $root
}

function Set-CatalogProperty([string]$Root, [string]$Property, $Value) {
  $path = Join-Path $Root 'catalog.json'
  $catalog = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Property -eq 'updatedAt') { $catalog.updatedAt = $Value }
  elseif ($Property -eq 'sha256') { $catalog.scripts[0].sha256 = $Value }
  elseif ($Property -eq 'downloadUrl') { $catalog.scripts[0].downloadUrl = $Value }
  elseif ($Property -eq 'appendId') { $catalog.scripts = @($catalog.scripts[0], [pscustomobject]($catalog.scripts[0] | ConvertTo-Json -Depth 12 | ConvertFrom-Json)) }
  else { throw "Set-CatalogProperty no conoce la propiedad '$Property'." }
  [IO.File]::WriteAllText($path, ($catalog | ConvertTo-Json -Depth 12), $utf8)
}

function Invoke-Validator([string]$Root) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validator -RepositoryRoot $Root 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
  } finally { $ErrorActionPreference = $previous }
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

  # 1. Catalogo valido: debe pasar.
  $ok = Invoke-Validator (New-Fixture 'valid' 'script-valido' '1.0.0' 'https://pokegrid.test/ok' 0)
  if ($ok.ExitCode -ne 0) { throw "Un catalogo valido fue rechazado:`n$($ok.Output)" }

  # 2. Review Focus 1: el .user.js no existe en disco.
  $missing = New-Fixture 'missing-file' 'sin-archivo' '1.0.0' 'https://pokegrid.test/missing' 0
  Remove-Item -LiteralPath (Join-Path $missing 'scripts\sin-archivo.user.js') -Force
  $r = Invoke-Validator $missing
  if ($r.ExitCode -eq 0) { throw 'El validador acepto una entrada cuyo .user.js no existe.' }
  if ($r.Output -notmatch 'No existe') { throw "El fallo por archivo ausente no es claro:`n$($r.Output)" }

  # 3. SHA-256 incorrecto.
  $badHash = New-Fixture 'bad-hash' 'hash-malo' '1.0.0' 'https://pokegrid.test/hash' 0
  Set-CatalogProperty $badHash 'sha256' ('a' * 64)
  $r = Invoke-Validator $badHash
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un SHA-256 incorrecto.' }
  if ($r.Output -notmatch 'SHA-256') { throw "El fallo por hash no es claro:`n$($r.Output)" }

  # 4. downloadUrl que no corresponde al id.
  $badUrl = New-Fixture 'bad-url' 'url-mala' '1.0.0' 'https://pokegrid.test/url' 0
  Set-CatalogProperty $badUrl 'downloadUrl' 'https://example.invalid/otro.user.js'
  $r = Invoke-Validator $badUrl
  if ($r.ExitCode -eq 0) { throw 'El validador acepto una downloadUrl inconsistente.' }

  # 5. @version del archivo que no coincide con el catalogo.
  $badVersion = New-Fixture 'bad-version' 'version-mala' '2.0.0' 'https://pokegrid.test/version' 0
  $file = Join-Path $badVersion 'scripts\version-mala.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 2.0.0', '@version 3.0.0'), $utf8)
  $r = Invoke-Validator $badVersion
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version distinto del catalogo.' }
  if ($r.Output -notmatch '@version') { throw "El fallo por @version no es claro:`n$($r.Output)" }

  # 6. Review Focus 2: prefijo v en @version. El SHA-256 se recalcula para que
  # lo unico que falle sea la comparacion de la version, no el hash.
  $vPrefix = New-Fixture 'v-prefix' 'con-v' '1.2.3' 'https://pokegrid.test/v' 0
  $file = Join-Path $vPrefix 'scripts\con-v.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 1.2.3', '@version v1.2.3'), $utf8)
  Set-CatalogProperty $vPrefix 'sha256' ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant())
  $r = Invoke-Validator $vPrefix
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version con prefijo v sin normalizar.' }
  if ($r.Output -notmatch '@version') { throw "El fallo por prefijo v no lo reporto la comprobacion de @version:`n$($r.Output)" }
  if ($r.Output -match 'SHA-256') { throw "La version se aceptaria si el hash cuadrara; el test no aislo la regla de @version:`n$($r.Output)" }

  # 7. Review Focus 3: @version de dos componentes, que el catalogo exige como tres.
  $twoPart = New-Fixture 'two-component' 'dos-partes' '3.91.0' 'https://pokegrid.test/two' 0
  $file = Join-Path $twoPart 'scripts\dos-partes.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 3.91.0', '@version 3.91'), $utf8)
  Set-CatalogProperty $twoPart 'sha256' ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant())
  $r = Invoke-Validator $twoPart
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version de dos componentes.' }
  if ($r.Output -notmatch '@version') { throw "La version de dos componentes no la reporto la comprobacion de @version:`n$($r.Output)" }
  if ($r.Output -match 'SHA-256') { throw "El test no aislo la regla de @version:`n$($r.Output)" }

  # 7b. Simetria: las dos formas de version sin normalizar se rechazan por la
  # misma regla, y una version ya normalizada con hash coherente se acepta.
  $clean = New-Fixture 'normalized' 'normalizada' '4.5.6' 'https://pokegrid.test/ok-version' 0
  $r = Invoke-Validator $clean
  if ($r.ExitCode -ne 0) { throw "Una @version normalizada con hash coherente deberia aceptarse:`n$($r.Output)" }

  # 8. Archivo por encima del limite de 10 MB.
  $big = New-Fixture 'too-big' 'muy-grande' '1.0.0' 'https://pokegrid.test/big' (6MB)
  $r = Invoke-Validator $big
  if ($r.ExitCode -ne 0) { throw "Un archivo de 6 MB debe aceptarse con el limite de 10 MB:`n$($r.Output)" }
  $huge = New-Fixture 'too-huge' 'demasiado-grande' '1.0.0' 'https://pokegrid.test/huge' (11MB)
  $r = Invoke-Validator $huge
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un archivo por encima de 10 MB.' }
  if ($r.Output -notmatch '10 MB') { throw "El rechazo por tamano no menciona el limite de 10 MB:`n$($r.Output)" }

  # 9. Review Focus 4: dos ids que solo difieren en mayusculas.
  $dup = New-Fixture 'duplicate-id-case' 'mismo-id' '1.0.0' 'https://pokegrid.test/dup' 0
  Set-CatalogProperty $dup 'appendId'
  $path = Join-Path $dup 'catalog.json'
  $catalog = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $catalog.scripts[1].id = 'MISMO-ID'
  [IO.File]::WriteAllText($path, ($catalog | ConvertTo-Json -Depth 12), $utf8)
  $r = Invoke-Validator $dup
  if ($r.ExitCode -eq 0) { throw 'El validador acepto dos ids que solo difieren en mayusculas.' }
  if ($r.Output -notmatch 'duplicad') { throw "El fallo por id duplicado no es claro:`n$($r.Output)" }

  # 10. updatedAt que no es RFC 3339. El schema lo marca como anotacion y no lo aplica.
  $badDate = New-Fixture 'bad-date' 'fecha-mala' '1.0.0' 'https://pokegrid.test/date' 0
  Set-CatalogProperty $badDate 'updatedAt' '24/08/2026 10:08'
  $r = Invoke-Validator $badDate
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un updatedAt que no es RFC 3339.' }

  # 11. Capturas. AVISAN, y no tumban.
  #
  # Esta capa avisa y no lanza por una razon que conviene no olvidar al leerla: el launcher
  # hace lo mismo. downloadUrl invalida SI lanza, porque sin ella no se puede instalar el
  # script; una captura es decoracion, y dejar sin Shop a media gente por un archivo mal
  # puesto seria peor que la captura que falta.
  $shotsBase = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots'
  # El id de los fixtures de esta seccion es 'con-captura'. El caso del prefijo tiene que
  # usar un nombre que de verdad NO empieza por ese id, o cae en el aviso de URL invalida y
  # no prueba la regla del prefijo. Con 'otro-script-1.png' no hay duda.
  $casosCapturas = @(
    @('host ajeno con la ruta exacta', @("https://otro-sitio.example/DiegoT34/PokeGrid-Script-Shop/main/screenshots/con-captura-1.png"), 'URL invalida'),
    @('prefijo de otro script',       @("$shotsBase/otro-script-1.png"),                                                   'deberia empezar por'),
    @('extension no valida',           @("$shotsBase/con-captura-1.bmp"),                                                   'URL invalida'),
    @('captura sin archivo en disco',  @("$shotsBase/con-captura-1.png"),                                                   'no existe en disco')
  )
  foreach ($caso in $casosCapturas) {
    $nombre = $caso[0]
    $urls = $caso[1]
    $esperado = $caso[2]
    $raiz = New-Fixture ("captura-" + ($nombre -replace '[^a-zA-Z0-9]', '-')) 'con-captura' '1.0.0' 'https://pokegrid.test/captura' 0
    $script = @"
`$catalog = Get-Content -LiteralPath (Join-Path '$raiz' 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
`$catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @($(($urls | ForEach-Object { "'$_'" }) -join ',')) -Force
[IO.File]::WriteAllText((Join-Path '$raiz' 'catalog.json'), (`$catalog | ConvertTo-Json -Depth 12), `$utf8)
"@
    Invoke-Expression $script
    $r = Invoke-Validator $raiz
    if ($r.ExitCode -ne 0) { throw "Una captura invalida ($nombre) TUMBO el catalogo. Debe avisar sin tumbar.`n$($r.Output)" }
    if ($r.Output -notmatch $esperado) { throw "La captura invalida ($nombre) no se explico como se esperaba ($esperado):`n$($r.Output)" }
    if ($r.Output -notmatch 'captura') { throw "El aviso de $nombre no menciona que es una captura:`n$($r.Output)" }
  }

  # Y una captura buena pasa limpio y se cuenta.
  $bien = New-Fixture 'captura-buena' 'foto-bien' '1.0.0' 'https://pokegrid.test/captura-ok' 0
  New-Item -ItemType Directory -Path (Join-Path $bien 'screenshots') -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $bien 'screenshots\foto-bien-1.png'), [byte[]](0x89, 0x50, 0x4E, 0x47))
  $buena = @"
`$catalog = Get-Content -LiteralPath (Join-Path '$bien' 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
`$catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('$shotsBase/foto-bien-1.png') -Force
[IO.File]::WriteAllText((Join-Path '$bien' 'catalog.json'), (`$catalog | ConvertTo-Json -Depth 12), `$utf8)
"@
  Invoke-Expression $buena
  $r = Invoke-Validator $bien
  if ($r.ExitCode -ne 0) { throw "Una captura valida fue rechazada:`n$($r.Output)" }
  if ($r.Output -notmatch 'captura') { throw "El validador no informa de cuantas capturas hay:`n$($r.Output)" }

  # El limite de seis: avisa, pero no tumba. Y el aviso dice la cuenta EXACTA, porque con un
  # limite de 60 en vez de 6 el aviso desaparece entero y no se ve que falta.
  $muchas = New-Fixture 'captura-muchas' 'foto-muchas' '1.0.0' 'https://pokegrid.test/captura-muchas' 0
  $lista = (1..7 | ForEach-Object { "'$shotsBase/foto-muchas-$_.png'" }) -join ','
  $script = @"
`$catalog = Get-Content -LiteralPath (Join-Path '$muchas' 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
`$catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @($lista) -Force
[IO.File]::WriteAllText((Join-Path '$muchas' 'catalog.json'), (`$catalog | ConvertTo-Json -Depth 12), `$utf8)
"@
  Invoke-Expression $script
  $r = Invoke-Validator $muchas
  if ($r.ExitCode -ne 0) { throw 'Siete capturas TUMBARON el catalogo. Deben avisar sin tumbar.' }
  if ($r.Output -notmatch 'limite son 6') { throw "El aviso del exceso no dice el limite exacto:`n$($r.Output)" }
  if ($r.Output -notmatch 'declara 7 capturas') { throw "El aviso del exceso no dice cuantas hay:`n$($r.Output)" }
  if ($r.Output -notmatch '7 captura\(s\)') { throw "El resumen no cuenta las capturas declaradas:`n$($r.Output)" }

  # La captura cuya URL es valida y el archivo NO esta en disco. Es el caso que distingue
  # la comprobacion de disco: el regex pasa porque la URL es correcta, y lo que falta es el
  # fichero. El caso de «host ajeno» que hay arriba no lo distingue, porque ahi el regex ya
  # falla antes de llegar a la comprobacion de disco.
  $sinDisco = New-Fixture 'captura-sin-disco' 'foto-sin-disco' '1.0.0' 'https://pokegrid.test/captura-sin-disco' 0
  $script = @"
`$catalog = Get-Content -LiteralPath (Join-Path '$sinDisco' 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
`$catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('$shotsBase/foto-sin-disco-1.png') -Force
[IO.File]::WriteAllText((Join-Path '$sinDisco' 'catalog.json'), (`$catalog | ConvertTo-Json -Depth 12), `$utf8)
"@
  Invoke-Expression $script
  $r = Invoke-Validator $sinDisco
  if ($r.ExitCode -ne 0) { throw "Una captura sin archivo en disco TUMBO el catalogo. Debe avisar sin tumbar.`n$($r.Output)" }
  if ($r.Output -notmatch 'no existe en disco') { throw "Una captura con URL valida y sin archivo en disco no se aviso como tal:`n$($r.Output)" }
  if ($r.Output -notmatch 'captura 1') { throw "El aviso no dice que posicion ocupa la captura:`n$($r.Output)" }

  # Y el mismo caso, pero con el archivo en disco y OTRO nombre: la URL y el disco
  # discrepan, que es lo que pasa cuando alguien renombra el archivo a mano.
  $desacuerdo = New-Fixture 'captura-desacuerdo' 'foto-desacuerdo' '1.0.0' 'https://pokegrid.test/captura-desacuerdo' 0
  New-Item -ItemType Directory -Path (Join-Path $desacuerdo 'screenshots') -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $desacuerdo 'screenshots\otro-nombre.png'), [byte[]](0x89, 0x50, 0x4E, 0x47))
  $script = @"
`$catalog = Get-Content -LiteralPath (Join-Path '$desacuerdo' 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
`$catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('$shotsBase/foto-desacuerdo-1.png') -Force
[IO.File]::WriteAllText((Join-Path '$desacuerdo' 'catalog.json'), (`$catalog | ConvertTo-Json -Depth 12), `$utf8)
"@
  Invoke-Expression $script
  $r = Invoke-Validator $desacuerdo
  if ($r.Output -notmatch 'foto-desacuerdo-1\.png') { throw "El aviso no nombra el archivo que falta:`n$($r.Output)" }
  if ($r.Output -notmatch 'no existe en disco') { throw "Un archivo renombrado a mano no se aviso:`n$($r.Output)" }

  # Una captura con mayusculas en el nombre es VALIDA, y es la que con una comparacion
  # sensible a mayusculas se rechazaria sin motivo. El launcher las acepta porque el prefijo
  # lo compara en minusculas. Este caso lo blinda: sin el, `StartsWith` en vez de
  # `ToLowerInvariant().StartsWith` no lo nota nadie.
  $mayus = New-Fixture 'captura-mayus' 'foto-mayus' '1.0.0' 'https://pokegrid.test/captura-mayus' 0
  New-Item -ItemType Directory -Path (Join-Path $mayus 'screenshots') -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $mayus 'screenshots\Foto-Mayus-1.PNG'), [byte[]](0x89, 0x50, 0x4E, 0x47))
  $script = @"
`$catalog = Get-Content -LiteralPath (Join-Path '$mayus' 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
`$catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('$shotsBase/Foto-Mayus-1.PNG') -Force
[IO.File]::WriteAllText((Join-Path '$mayus' 'catalog.json'), (`$catalog | ConvertTo-Json -Depth 12), `$utf8)
"@
  Invoke-Expression $script
  $r = Invoke-Validator $mayus
  if ($r.Output -match 'AVISO') { throw "Una captura con mayusculas en el nombre se aviso, y el launcher la acepta: el prefijo lo compara en minusculas.`n$($r.Output)" }
  if ($r.ExitCode -ne 0) { throw "Una captura valida con mayusculas fue rechazada:`n$($r.Output)" }

  # Y el esquema declara el campo. additionalProperties lo permitiria igual, pero un
  # esquema que no declara un campo del contrato no es un esquema del contrato.
  $schemaText = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'catalog.schema.json') -Raw -Encoding UTF8
  if ($schemaText -notmatch '"screenshots"') { throw 'catalog.schema.json no declara el campo screenshots.' }
  if ($schemaText -notmatch '"maxItems"\s*:\s*6') { throw 'El esquema no declara el limite de 6 capturas.' }

  Write-Output 'Catalog validator passed: valid catalog, missing file, bad hash, bad URL, version mismatch, v prefix, two-component version, normalized version accepted, 10 MB limit, duplicate id case, RFC 3339 date, y capturas que avisan sin tumbar.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
