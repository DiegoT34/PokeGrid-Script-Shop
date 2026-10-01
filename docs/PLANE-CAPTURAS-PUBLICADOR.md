# Publicar capturas desde la herramienta  ->  Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la herramienta publicadora copie capturas de pantalla al repositorio de la Shop, genere su nombre y su URL, y avise de lo que no cumple en vez de publicarlo en silencio.

**Architecture:** Un parámetro nuevo `-Screenshots` en `tools/publish-script.ps1`, que es donde hoy se arma la entrada del catálogo y se escribe la URL del userscript. El publicador **genera** el nombre (`<id>-<n>.<ext>`), nunca lo pide, y añade el campo `screenshots` a la entrada. `tools/validate-catalog.ps1` crece con una cuarta capa que avisa sin lanzar. `PokeGrid-Shop-Publisher.ps1` incluye `screenshots/` en su `git add`/`git commit`, y `tools/remove-script.ps1` borra las capturas del script que retira.

**Tech Stack:** PowerShell 5.1+ (Windows Forms para la GUI), `ConvertTo-Json`, `git` vía `tools/git-helper.ps1`. Sin dependencias nuevas.

**Spec:** `docs/SPEC-CAPTURAS-PUBLICADOR.md`

## Global Constraints

- **Cero dependencias nuevas.** Ni un módulo, ni un paquete.
- **PowerShell 5.1.** Nada de sintaxis que solo exista en 7+: nada de `??=`, nada de `Get-FileHash -AsByteStream`, nada de `Join-Path` con varios segmentos.
- **`schemaVersion` se queda en `1`.** Si sube, los launchers antiguos pierden la Shop.
- **El launcher no se toca.** Cero cambios en `PokeGrid-Launcher`.
- **La GUI no se toca**, salvo las cuatro líneas de `git add`/`git commit` y el `remove-script`.
- **Español con tildes** en mensajes, avisos y comentarios. UTF-8 sin BOM.
- **Nada de `git add -A`** ni `git commit -a`: siempre rutas explícitas, que es lo que ya hace el repo.
- **`net.fetch`-style safety en el borrado:** toda ruta calculada se valida contra su raíz antes de borrar o copiar. `remove-script.ps1:18-20` ya lo hace para `scripts/` y el patrón se repite.
- **Una captura que no cumple se descarta con aviso y no tumba nada.** `downloadUrl` inválida **sí** lanza, como hoy.
- **El contrato es `esCapturaDeShop` de `PokeGrid-Launcher/src/script-shop-screenshots.js`.** Si una regla de este plan y el launcher discrepan, el launcher tiene razón y hay que corregir el plan.

### Las reglas del contrato, exactas

Verificadas corriendo el launcher, no leyéndolo:

| Regla | Valor exacto |
|---|---|
| Host | `raw.githubusercontent.com`, exacto |
| Ruta | `/DiegoT34/PokeGrid-Script-Shop/(main\|[a-f0-9]{40})/screenshots/<nombre>`, plana |
| Prefijo | `<id>-` con guion, comparado **en minúsculas** |
| Extensión | `png`, `jpg`, `jpeg`, `webp`, `gif`, en cualquier mayúscula |
| Nombre | `^[a-z0-9][a-z0-9._-]{0,99}\.` antes de la extensión. **Las mayúsculas en el nombre valen.** |
| URL | Sin query string ni fragmento |
| Cantidad | Hasta 6 |
| Tamaño | Hasta 2 MB, comprobado **al copiar** |

## Review Focus

Las cinco clases de fallo que la spec permite pero que ninguna prueba de contenido caza, con su prueba asignada en la tarea que las posee:

1. **Un archivo de más sin su entrada en el catálogo**, o al revés: una URL en el catálogo sin el archivo en `screenshots/`. Sale bien por arriba y se descubre en la máquina de quien lee la Shop.  ->   Tarea 1 prueba el rollback; Tarea 3 prueba que el commit lleva los archivos.
2. **Un `git add` que no incluye la carpeta.** El commit sale, el publicador dice "listo", y la URL apunta a imágenes que no están en GitHub. Ninguna prueba de contenido lo ve.  ->   Tarea 3, prueba del comando.
3. **Una captura huérfana al retirar un script.** El repositorio crece con archivos que ninguna entrada describe.  ->   Tarea 4.
4. **Un borrado fuera de `screenshots/`.** Un `-Filter "$Id-*"` sin validar la raíz puede tocar lo que haya alrededor.  ->   Tarea 4, con un archivo señuelo fuera de la carpeta.
5. **Un aviso que no se ve.** Un aviso escrito a una salida que nadie lee es indistinguible de ningún aviso.  ->   Tarea 2, comprobando el texto que sale por stdout y por stderr.

---

### Task 1: El publicador copia y genera el nombre

**Files:**
- Modify: `tools/publish-script.ps1:1-15` (el `param()`), `tools/publish-script.ps1:102-145` (copia y entrada)
- Test: `tools/test-screenshots-publication.ps1` (nuevo)

**Interfaces:**
- Consumes: nada de otras tareas. Es la primera.
- Produces: el parámetro `-Screenshots` (array de rutas), y la carpeta `screenshots/` en el repositorio con archivos `<id>-<n>.<ext>`. La Tarea 2 lo consume para los rechazos; la Tarea 4 para el borrado.

- [ ] **Paso 1: La prueba que falla**

`tools/test-screenshots-publication.ps1`, con el estilo del repo: subproceso `powershell.exe`, `throw` con mensaje en español, `try/finally` que limpia el temporal.

```powershell
$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-shots-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)

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
  $shotB = Join-Path $testRoot '   espacio y tilde á.jpg'
  [IO.File]::WriteAllBytes($shotB,$pngBytes)

  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $newScript -Id 'shot-script' -PublicationMode New -Summary 'Con capturas' -Description 'Con capturas' -Changelog 'Primera' -Screenshots @($shotA,$shotB) -RepositoryRoot $testRoot 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){throw "La publicacion con capturas termino con codigo $LASTEXITCODE.`n$output"}

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
  foreach($name in $expectedNames){
    $destino = Join-Path $shotsDir $name
    if((Get-FileHash -LiteralPath $destino -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $testRoot $name) -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash){
      # El original no se llama asi, se compara con el origen real.
    }
  }
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
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $solo -Id 'solo-script' -PublicationMode New -Summary 'Solo' -Description 'Solo' -Changelog 'Primera' -RepositoryRoot $testRoot | Out-Null
  if($LASTEXITCODE -ne 0){throw 'La publicacion sin capturas fallo.'}
  $raw = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8
  $soloEntry = ($raw | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'solo-script' } | Select-Object -First 1
  if($soloEntry.PSObject.Properties.Name -contains 'screenshots'){
    throw 'Un script sin capturas lleva el campo screenshots. Debe estar ausente, no vacio.'
  }

  Write-Output 'Screenshots publication passed: nombre generado, copia identica, URLs completas y campo ausente sin capturas.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

- [ ] **Paso 2: Ejecutar y verificar que falla**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-publication.ps1`
Expected: FAIL  ->  el parámetro `-Screenshots` no existe, así que PowerShell se queja antes de que el publicador haga nada. El mensaje tiene que mencionar `Screenshots`.

Si en vez de eso falla con otra cosa, **para y escríbelo**: significa que el `param()` no es lo que creemos.

- [ ] **Paso 3: El parámetro y la copia**

En `tools/publish-script.ps1`, al final del `param()` (después de `[switch]$Featured`, línea 15):

```powershell
  [string[]]$Screenshots = @(),
```

Y una constante junto a `$maxScriptBytes` (línea 20), con el motivo de cada valor:

```powershell
# El mismo contrato que aplica el launcher en src/script-shop-screenshots.js. Si un
# dia divergen, el launcher tiene razon: es el que decide si la captura se ve.
$maxShotBytes = 2MB
$maxShots = 6
$shotsBase = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots'
$shotExtensionPattern = '^(?i)\.(?:png|jpg|jpeg|webp|gif)$'
```

Y el bloque que copia y genera nombres, entre la línea 111 y el `try` de la 113, junto al
estado previo que ya se guarda (líneas 106-111: `$catalogExisted` a `$targetBytes`):

```powershell
# Capturas: se copian con un nombre GENERADO a partir del id y la posicion. El
# nombre del archivo que elige la persona no se usa, y esa es toda la proteccion:
# el prefijo con el id es lo que impide que un script se apropie de las capturas
# de otro, asi que respetarlo inutilitaria la regla. Solo se lee la extension.
$shotsDir = Join-Path $repoRoot 'screenshots'
$shotWarnings = [Collections.Generic.List[string]]::new()
$shotNames = [Collections.Generic.List[string]]::new()
$shotState = @()
if ($Screenshots.Count -gt 0) {
  if (-not $shotsDir.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'La ruta calculada de screenshots/ no es segura.'
  }
  $seenExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($candidate in @($Screenshots)) {
    if ($shotNames.Count -ge $maxShots) {
      $shotWarnings.Add("Se ignoraron $($Screenshots.Count - $maxShots) captura(s) mas: el limite son $maxShots.")
      break
    }
    $full = [IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $shotWarnings.Add("No se encontro la captura: $full")
      continue
    }
    $length = (Get-Item -LiteralPath $full).Length
    if ($length -gt $maxShotBytes) {
      $shotWarnings.Add("Se descarto $([IO.Path]::GetFileName($full)): ocupa $length bytes y el limite son $maxShotBytes.")
      continue
    }
    $extension = [IO.Path]::GetExtension($full)
    if ($extension -notmatch $shotExtensionPattern) {
      $shotWarnings.Add("Se descarto $([IO.Path]::GetFileName($full)): la extension '$extension' no es valida.")
      continue
    }
    $normalized = $extension.ToLowerInvariant()
    if (-not $seenExtensions.Add($normalized)) {
      $shotWarnings.Add("Se descarto $([IO.Path]::GetFileName($full)): la extension $normalized ya esta usada por otra captura.")
      continue
    }
    $shotState += [pscustomobject]@{
      Source = $full
      Name = "$Id-$($shotNames.Count + 1)$normalized"
      Existed = Test-Path -LiteralPath (Join-Path $shotsDir "$Id-$($shotNames.Count + 1)$normalized") -PathType Leaf
    }
    $shotNames.Add("$Id-$($shotNames.Count + 1)$normalized")
  }
}
```

Y dentro del `try` (línea 114), justo después de `New-Item -ItemType Directory -Path $targetDir`, la copia:

```powershell
  if ($shotState.Count -gt 0) {
    New-Item -ItemType Directory -Path $shotsDir -Force | Out-Null
    foreach ($shot in $shotState) {
      Copy-Item -LiteralPath $shot.Source -Destination (Join-Path $shotsDir $shot.Name) -Force
    }
  }
```

Y el campo en la entrada, después de `icon = $Icon` (línea 138) y **antes** de `featured`:

```powershell
    # El campo solo existe si hay capturas. Un array vacio ocuparia espacio y
    # diria que el script tiene fotos que no tiene.
    screenshots = $(if ($shotNames.Count -gt 0) { @($shotNames | ForEach-Object { "$shotsBase/$_" }) } else { $null })
```

Y en el `catch` (después de restaurar `$target`, línea 155), la restauración de las capturas:

```powershell
  # Las capturas tambien son estado. Un archivo de mas que ninguna entrada del
  # catalogo describe es basura que se acumula, y una foto de la version anterior
  # sustituida por la nueva deja la ficha mostrando lo que ya no hace.
  try {
    if ($shotState.Count -gt 0) {
      foreach ($shot in $shotState) {
        $written = Join-Path $shotsDir $shot.Name
        if ($shot.Existed) { continue }
        if (Test-Path -LiteralPath $written) { Remove-Item -LiteralPath $written -Force }
      }
    }
  } catch {
    Write-Host "AVISO  No se pudieron deshacer las capturas: $($_.Exception.Message)" -ForegroundColor Yellow
  }
```

Y los avisos, al final, antes del `Write-Host "Preparado como..."` (línea 165):

```powershell
foreach ($warning in $shotWarnings) { Write-Host "AVISO  $warning" -ForegroundColor Yellow }
```

- [ ] **Paso 4: Ejecutar y verificar que pasa**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-publication.ps1`
Expected: PASS con `Screenshots publication passed: ...`

- [ ] **Paso 5: El resto de pruebas sigue en verde**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-new-script-publication.ps1`  ->   PASS
Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-publication-downgrade.ps1`  ->   PASS
Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-partial-publication-rollback.ps1`  ->   PASS

Las tres comprueban la publicación por el camino viejo. Si `test-new-script-publication` falla con algo del campo `screenshots`, es que la entrada sin capturas está llevando el campo, y eso es el punto 4 de la prueba.

- [ ] **Paso 6: Sabotear para comprobar que muerde**

Escribe un script que haga la copia **antes** de tiempo. Reglas de este proyecto: la copia se toma en el instante y antes de mutar, y **nunca** `git checkout`, que revierte al último commit y se lleva trabajo sin commitear.

| # | Mutación | Aserción que debe caer |
|---|---|---|
| 1 | Usa `$original.Name` en vez de `"$Id-$n$normalized"` | `Los nombres generados no son los esperados` |
| 2 | Quita la línea que añade `screenshots` a la entrada | `La entrada declara 0 capturas y se esperaban 2` |
| 3 | Deja el campo siempre, incluso vacío | `Un script sin capturas lleva el campo screenshots` |
| 4 | Quita la comprobación de `$maxShotBytes` | La prueba **no lo caza**: hay que añadir una captura de 3 MB a esta prueba antes de dar la tarea por buena (Paso 7) |
| 5 | Quita la restauración del `catch` | `test-partial-publication-rollback.ps1` no lo caza tampoco. Añade el caso al paso 7 |

Los 4 y 5 son huecos reales. El paso 7 los cierra; hasta entonces, están declarados, no escondidos.

- [ ] **Paso 7: Cerrar los dos huecos que el sabotaje destapa**

En `tools/test-screenshots-publication.ps1`, añade antes del `Write-Output` final:

```powershell
  # El limite de tamano. Un .png de 3 MB: se descarta con aviso y el resto se publica.
  $grande = Join-Path $testRoot 'grande.png'
  $bytesGrandes = [byte[]]::new(3MB)
  [Array]::Copy($pngBytes, $bytesGrandes, $pngBytes.Length)
  [IO.File]::WriteAllBytes($grande, $bytesGrandes)
  $conGrande = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $newScript -Id 'shot-script' -PublicationMode Update -Summary 'Con capturas' -Description 'Con capturas' -Changelog 'Segunda' -Screenshots @($grande) -RepositoryRoot $testRoot 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){throw "La publicacion con una captura grande fallo; deberia descartarla y continuar.`n$conGrande"}
  if($conGrande -notmatch '3 MB'){throw "El descarte por tamano no se explico en la salida.`n$conGrande"}
  if(-not (Test-Path -LiteralPath (Join-Path $testRoot 'grande.png'))){throw 'La prueba borro el original.'}
  $trasGrande = (Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'shot-script' } | Select-Object -First 1
  if(@($trasGrande.screenshots).Count -ne 2){throw 'La captura grande cambio el catalogo. Deberia conservarse lo que ya habia.'}

  # Y el rollback: si la escritura del catalogo falla, las capturas no quedan colgadas.
  $roto = Join-Path $testRoot 'catalog.json'
  [IO.File]::WriteAllBytes($roto, [byte[]](0x7B, 0x22, 0x62, 0x61)) # "{ba" con bytes que rompen UTF-8
  $trasFallo = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $newScript -Id 'shot-script' -PublicationMode Update -Summary 'x' -Description 'x' -Changelog 'y' -Screenshots @($shotA) -RepositoryRoot $testRoot 2>&1 | Out-String
  if($LASTEXITCODE -eq 0){throw 'La publicacion con el catalogo roto devolvio exito.'}
  # El original se ha movido, asi que esta captura es nueva: no debe quedar en disco.
  $colgadas = @(Get-ChildItem -LiteralPath (Join-Path $testRoot 'screenshots') -File -ErrorAction SilentlyContinue)
  if(@($colgadas | Where-Object { $_.Name -eq 'shot-script-3.png' }).Count -gt 0){
    throw 'Tras un fallo quedo una captura colgada que ninguna entrada del catalogo describe.'
  }
```

Y repite el sabotaje 4 y el 5, que ahora sí tienen que morder.

- [ ] **Paso 8: Commit**

```bash
git add tools/publish-script.ps1 tools/test-screenshots-publication.ps1
git commit -m "Copiar capturas al repositorio con el nombre generado desde el id

El launcher ya las muestra y las baja del repositorio oficial, y este repo no sabia nada de
ellas: quien publica tenia que copiarlas a mano y escribirlas en catalog.json a mano.

El nombre lo genera el publicador, como <id>-<n>.<ext>, y no se pide. No es purismo: el
prefijo con el id es lo que impide que un script se apropie de las capturas de otro, y si se
respetara el nombre que elige la persona, bastaria pasar otra-captura.png para colgar la foto
de otro script. Solo se lee la extension.

Una captura que no cumple se descarta con aviso y no tumba la publicacion. Bloquear el
script entero por un archivo mal puesto seria un fallo de la herramienta, no una proteccion.

El catch restaura tambien las capturas, igual que ya restauraba el userscript: un archivo de
mas que ninguna entrada del catalogo describe es basura que se acumula."
```

---

### Task 2: Los rechazos y sus avisos

**Files:**
- Modify: `tools/publish-script.ps1` (los `$shotWarnings` del paso 3 de la Tarea 1, que ya existen)
- Test: `tools/test-screenshots-rejection.ps1` (nuevo)

**Interfaces:**
- Consumes: el `-Screenshots` y la lista `$shotWarnings` de la Tarea 1.
- Produces: nada para tareas siguientes. La Tarea 3 y la 4 usan las mismas reglas, pero no dependen de este fichero.

- [ ] **Paso 1: La prueba que falla**

`tools/test-screenshots-rejection.ps1`. La diferencia con la Tarea 1: aquí importa **que se avise**, y un aviso que no se ve es indistinguible de ninguno.

```powershell
$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-shots-reject-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)
$pngBytes = [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13,0x49,0x48,0x44,0x52)

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

  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $script -Id 'reject-script' -PublicationMode New -Summary 'x' -Description 'x' -Changelog 'y' -Screenshots @($malaExt,$inexistente,$buena) -RepositoryRoot $testRoot 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){throw "La publicacion con capturas malas fallo; deberia publicarlas sin ellas.`n$output"}

  # Cada rechazo dice POR QUE, en espanol, con el nombre del archivo.
  if($output -notmatch 'extension'){throw "El rechazo por extension no se explico.`n$output"}
  if($output -notmatch 'No se encontro la captura'){throw "El rechazo por ruta inexistente no se explico.`n$output"}
  if($output -notmatch 'mala\.bmp'){throw 'El aviso no nombra el archivo descartado.'}
  if($output -notmatch 'no-existe\.png'){throw 'El aviso no nombra el archivo inexistente.'}

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
  $salida7 = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $script -Id 'seven-script' -PublicationMode New -Summary 'x' -Description 'x' -Changelog 'y' -Screenshots $muchas -RepositoryRoot $testRoot 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){throw "La publicacion con 7 capturas fallo.`n$salida7"}
  $entry7 = (Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json).scripts | Where-Object { $_.id -eq 'seven-script' } | Select-Object -First 1
  if(@($entry7.screenshots).Count -ne 6){throw "Se publicaron $(@($entry7.screenshots).Count) capturas y el limite son 6."}
  if($salida7 -notmatch 'limite'){throw "El recorte por exceso no se explico.`n$salida7"}

  Write-Output 'Screenshots rejection passed: extension, inexistente, exceso, y cada aviso con su motivo.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

- [ ] **Paso 2: Ejecutar y verificar que falla**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-rejection.ps1`
Expected: FAIL. La parte de "cada rechazo dice por qué" tiene que fallar, porque en la Tarea 1 solo se acumulo el aviso de tamaño y el de exceso; el de extensión y el de inexistente sí están, pero el patrón de texto puede no coincidir. **Si pasa entero, para y escribe por qué**  ->  una prueba que pasa sin que el código la necesitara significa que la prueba no comprueba lo que dice.

- [ ] **Paso 3: Los rechazos que falten**

Los rechazos de extensión, de inexistente y de duplicada de extensión ya están en el paso 3 de la Tarea 1. El que falta es el de exceso con el aviso claro, y el texto de cada aviso. Ajusta los `Add` para que el mensaje sea el que la prueba busca, y añade el aviso de exceso dentro del bucle en vez de solo contar:

```powershell
    if ($shotNames.Count -ge $maxShots) {
      $shotWarnings.Add("Se ignoraron $($Screenshots.Count - $maxShots) captura(s) mas por el limite de $maxShots.")
      break
    }
```

Y la duplicada de extensión, que la Tarea 1 ya tiene pero cuya prueba falta. Si dos capturas tienen la misma extensión, los nombres generados colisionarían (`shot-script-1.png` dos veces). Ojo con esto: **es un caso real**, porque el publicador genera el nombre y no puede distinguir dos archivos que solo se diferencian en el nombre original.

- [ ] **Paso 4: Ejecutar y verificar que pasa**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-rejection.ps1`
Expected: PASS

- [ ] **Paso 5: Sabotear para comprobar que muerde**

| # | Mutación | Aserción que debe caer |
|---|---|---|
| 1 | Cambia `Write-Host "AVISO  $warning"` por `Write-Host $warning -ForegroundColor DarkGray` sobre un fondo oscuro | La prueba no lo caza, porque busca texto y no color. **Añade antes la comprobación de que el aviso va a una salida real** (paso 6) |
| 2 | Quita la comprobación de la extensión | `El rechazo por extension no se explico` |
| 3 | Cambia el `break` del límite por un `continue` | Se publicarán 7 capturas y `Se publicaron 7 capturas y el limite son 6` |
| 4 | Cambia el texto del aviso a "descartada" en vez de "Se descarto ...: la extension" | `El aviso no nombra el archivo descartado` |

- [ ] **Paso 6: Cerrar el hueco del color y del destino**

Un aviso a una salida que nadie lee no es un aviso. En `tools/test-screenshots-rejection.ps1`, antes del `Write-Output` final, comprueba que el aviso sale por **stdout**, no por stderr y no por un canal de PowerShell interno:

```powershell
  # El aviso tiene que ser visible, no solo estar escrito. Un Write-Host con color
  # sobre un fondo ilegible es indistinguible de no avisar.
  $soloAvisos = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $script -Id 'reject-script' -PublicationMode Update -Summary 'x' -Description 'x' -Changelog 'y' -Screenshots @($malaExt) -RepositoryRoot $testRoot 2>&1 | Out-String
  if($soloAvisos -notmatch 'AVISO'){throw "El descarte no se marco como AVISO, y asi se pierde entre el ruido.`n$soloAvisos"}
  if($soloAvisos -notmatch 'Yellow'){throw "El aviso no se distingue visualmente del resto de la salida."}
```

Y repite el sabotaje 1.

- [ ] **Paso 7: Commit**

```bash
git add tools/publish-script.ps1 tools/test-screenshots-rejection.ps1
git commit -m "Explicar cada captura descartada y por que, en vez de callar

Un descarte sin motivo es indistinguible de un fallo: quien publica no sabe si la imagen
estaba mal puesta, si era demasiado grande o si el publicador la ignores. Y un aviso que no
se distingue del resto de la salida es lo mismo que no avisar.

Se comprueba que el aviso sale marcado y en color, no solo escrito.

Dos capturas con la misma extension ahora se rechazan con aviso. Sin eso los nombres
generados colisionarian  -> los dos serian <id>-1.png ->  y la segunda sobrescribiria a la primera
sin que nada lo dijera."
```

---

### Task 3: El commit tiene que llevar las capturas

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1:866`, `:871`, `:933`, `:936` (los cuatro `Invoke-PokeGridGit` de `add` y `commit`)
- Test: `tools/test-screenshots-git-add.ps1` (nuevo)

**Interfaces:**
- Consumes: nada del publicador. Es una corrección independiente de la GUI, y se puede revisar por separado.
- Produces: la carpeta `screenshots/` entra en el commit de publicación.

- [ ] **Paso 1: La prueba que falla**

Esta tarea es la que protege del fallo más caro del proyecto, y su prueba tiene que mirar **el comando**, no el resultado: cuando `git add` no incluye la carpeta, todo lo demás está bien y el fallo no se ve en ningún archivo.

```powershell
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

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  & $git init --bare $remote | Out-Null
  & $git init $seed | Out-Null
  & $git -C $seed config user.name 'PokeGrid Test'
  & $git -C $seed config user.email 'pokegrid-test@local.invalid'
  $emptyCatalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @() }
  [IO.File]::WriteAllText((Join-Path $seed 'catalog.json'),($emptyCatalog|ConvertTo-Json -Depth 12),$utf8)
  New-Item -ItemType Directory -Path (Join-Path $seed 'tools') -Force | Out-Null
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

  $shot = Join-Path $testRoot 'captura.png'
  [IO.File]::WriteAllBytes($shot,$pngBytes)
  $script = Join-Path $testRoot 'con-shots.user.js'
  $code = "// ==UserScript==`n// @name Con Shots`n// @namespace http://tampermonkey.net/`n// @version 1.0.0`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($script,$code,$utf8)

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $work 'publish-script.ps1') -Path $script -Id 'con-shots' -PublicationMode New -Summary 'x' -Description 'x' -Changelog 'y' -Screenshots @($shot) -RepositoryRoot $work | Out-Null
  if($LASTEXITCODE -ne 0){throw 'La publicacion con capturas fallo.'}

  # Esto es lo que importa: el add incluye la carpeta, el commit la lleva.
  $idBoxValue = 'con-shots'
  $target = "scripts/$idBoxValue.user.js"
  $before = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command @"
`$args = @('add','--','catalog.json',`$target,'screenshots')
& '$git' -C '$work' @args
"@ 2>&1 | Out-String

  $staged = & $git -C $work diff --cached --name-only
  $stagedNames = @($staged)
  if($stagedNames -notcontains 'catalog.json'){throw "El catalogo no quedo en el area de preparacion.`n$($stagedNames -join ', ')"}
  if(-not ($stagedNames | Where-Object { $_ -like 'screenshots/*' })){throw "La carpeta screenshots/ no quedo en el area de preparacion. El commit saldra bien y la URL apuntara a imagenes que no estan en GitHub.`n$($stagedNames -join ', ')"}

  # Y que la imagen llegue al commit como binario, sin que la regla de fin de linea
  # global le toque los bytes.
  [void](Invoke-PokeGridGit -RepositoryRoot $work -Arguments @('commit','-m','Con capturas','--','catalog.json',$target,'screenshots'))
  $enRemoto = & $git --git-dir=$remote ls-tree -r --name-only main
  if(@($enRemoto) -notcontains 'screenshots/con-shots-1.png'){throw "La captura no llego al remoto.`n$(@($enRemoto) -join ', ')"}
  $bytesEnRemoto = & $git --git-dir=$remote show 'main:screenshots/con-shots-1.png' 2>$null
  if($null -eq $bytesEnRemoto){throw 'No se pudo leer la captura del remoto.'}

  Write-Output 'Screenshots git-add passed: la carpeta entra en el area de preparacion y llega al commit.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

- [ ] **Paso 2: Ejecutar y verificar que falla**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-git-add.ps1`
Expected: FAIL en `La carpeta screenshots/ no quedo en el area de preparacion`.

Esa aserción es el corazón de la tarea: si pasa, el `git add` de la GUI ya incluye la carpeta y no hay nada que arreglar.

- [ ] **Paso 3: Los cuatro comandos de la GUI**

En `PokeGrid-Shop-Publisher.ps1`, añade `screenshots` a los cuatro `add` y `commit` de las líneas 866, 871, 933 y 936. El camino se arma una vez y se reutiliza:

```powershell
$screenshotsPath = 'screenshots'
```

Y cada uno de los cuatro pasa de:

```powershell
@('add','--','catalog.json',$target)
```

a:

```powershell
@('add','--','catalog.json',$target,$screenshotsPath)
```

Y de:

```powershell
@('commit','-m',$commitMessage,'--','catalog.json',$target)
```

a:

```powershell
@('commit','-m',$commitMessage,'--','catalog.json',$target,$screenshotsPath)
```

**Sobre la retirada (líneas 866 y 871):** añadir `screenshots` al `add` de una retirada no borra los archivos, y la Tarea 4 se encarga de eso. Aquí solo se hace que el comando no falle por una ruta que no existe, y `git add` con una ruta ausente sale con error. **La Tarea 4 debe llegar antes de que esto se pruebe en serio**: si `screenshots/` no existe, `git add -- screenshots` falla y bloquea la publicación entera, incluso de un script sin capturas. Por eso el paso 4 de esta tarea crea la carpeta siempre.

- [ ] **Paso 4: Que la carpeta exista siempre**

Que `git add -- screenshots` no falle es responsabilidad de esta tarea, no de la Tarea 4. En `PokeGrid-Shop-Publisher.ps1`, justo antes del primer `add`, y también antes del segundo bloque:

```powershell
# git add con una ruta que no existe sale con codigo de error. Y una publicacion sin
# capturas no tiene por que crear la carpeta, asi que se crea vacia. Es lo mas barato:
# un directorio vacio no lo lleva git a ninguna parte.
if(-not (Test-Path -LiteralPath (Join-Path $repoRoot $screenshotsPath) -PathType Container)){
  [void](New-Item -ItemType Directory -Path (Join-Path $repoRoot $screenshotsPath) -Force)
}
```

- [ ] **Paso 5: Ejecutar y verificar que pasa**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-git-add.ps1`
Expected: PASS

Y las de la GUI, que no se pueden lanzar a mano pero sí comprobar que no se rompieron:

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { [void][scriptblock]::Create((Get-Content -LiteralPath 'PokeGrid-Shop-Publisher.ps1' -Raw -Encoding UTF8)); 'sintaxis OK' }"`
Expected: `sintaxis OK`

- [ ] **Paso 6: `.gitattributes`**

En `.gitattributes`, añade una línea:

```gitattributes
screenshots/* binary
```

Con un comentario arriba que diga por qué:

```gitattributes
# La regla global * text=auto eol=lf pasaria las imagenes por una conversion de fin de
# linea. Git las detecta como binarias por el contenido, pero eso depende de que las
# detecte bien, y una imagen con un byte que parezca texto se lleva dos conversiones que
# no le corresponden.
```

- [ ] **Paso 7: Sabotear para comprobar que muerde**

| # | Mutación | Aserción que debe caer |
|---|---|---|
| 1 | Quita `'screenshots'` de uno de los cuatro `@('add',...)` | `La carpeta screenshots/ no quedo en el area de preparacion` |
| 2 | Quita el `New-Item` del paso 4 | `git add -- screenshots` falla y la prueba lo ve como publicacion fallida |
| 3 | Deja el comentario de `.gitattributes` pero quita la línea `screenshots/* binary` | Ninguna prueba lo caza. **Añádela**: compara `git check-attr` antes y después |

- [ ] **Paso 8: Cerrar el hueco de `.gitattributes`**

En `tools/test-screenshots-git-add.ps1`, antes del `Write-Output` final:

```powershell
  # La regla de binario tiene que existir, y no basta con que el comentario la mencione.
  $attrs = & $git -C $work check-attr binary -- screenshots/con-shots-1.png
  if($attrs -notmatch ': binary: set'){throw "La regla de binario no se aplica a las capturas.`n$attrs"}
```

Y repite el sabotaje 3.

- [ ] **Paso 9: Commit**

```bash
git add PokeGrid-Shop-Publisher.ps1 tools/test-screenshots-git-add.ps1 .gitattributes
git commit -m "Que el commit de publicacion lleve la carpeta de capturas

Los cuatro git add y git commit de la GUI aceptan solo catalog.json y el userscript. Con
capturas, el commit salia bien, el publicador decia que estaba listo, y la URL del catalogo
apuntaba a imagenes que no estaban en GitHub. El fallo no aparece en la maquina de quien
publica, que es la que puede arreglarlo, sino en la de quien lee la Shop.

Ninguna prueba de contenido lo caza, porque todo lo demas es cierto: por eso la prueba
mira el area de preparacion y el arbol del remoto, no el contenido del catalogo.

git add con una ruta que no existe sale con error, y una publicacion sin capturas no tiene
por que crear la carpeta, asi que se crea vacia antes del add. Un directorio vacio no lo
lleva git a ninguna parte.

.gitattributes recibe screenshots/* binary, porque la regla global * text=auto eol=lf
pasaria las imagenes por una conversion de fin de linea."
```

---

### Task 4: Retirar un script borra sus capturas

**Files:**
- Modify: `tools/remove-script.ps1:34-38` (donde borra el userscript)
- Test: `tools/test-screenshots-removal.ps1` (nuevo)

**Interfaces:**
- Consumes: el patrón de borrado validado de `remove-script.ps1:18-20` y el nombre generado `<id>-<n>.<ext>` de la Tarea 1.
- Produce: el objeto devuelto gana `ScreenshotsRemoved`, que la GUI puede registrar.

- [ ] **Paso 1: La prueba que falla**

```powershell
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

  # Las suyas, y de otros dos scripts que NO se van.
  foreach($name in 'se-van-1.png','se-van-2.jpg'){ [IO.File]::WriteAllBytes((Join-Path $shotsDir $name),$pngBytes) }
  foreach($name in 'otro-1.png','queda-1.png'){ [IO.File]::WriteAllBytes((Join-Path $shotsDir $name),$pngBytes) }
  # Y un SENUELO fuera de la carpeta, con un nombre que el filtro tambien casaria.
  [IO.File]::WriteAllBytes((Join-Path $testRoot 'fuera\se-van-1.png'),$pngBytes)

  $base = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts'
  $catalog = [ordered]@{
    schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'
    scripts = @(
      [ordered]@{ id='se-van';name='Se Van';namespace='http://tampermonkey.net/';version='1.0.0';summary='x';description='x';category='Utilidades';minLauncherVersion='0.22.1';downloadUrl="$base/se-van.user.js";sha256=('a'*64);publishedAt='2026-01-01T00:00:00Z' },
      [ordered]@{ id='otro';name='Otro';namespace='http://tampermonkey.net/';version='1.0.0';summary='x';description='x';category='Utilidades';minLauncherVersion='0.22.1';downloadUrl="$base/otro.user.js";sha256=('b'*64);publishedAt='2026-01-01T00:00:00Z' }
    )
  }
  [IO.File]::WriteAllText((Join-Path $testRoot 'catalog.json'),($catalog|ConvertTo-Json -Depth 12),$utf8)

  $resultado = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $remover -Id 'se-van' -RepositoryRoot $testRoot 2>&1 | Out-String
  if($LASTEXITCODE -ne 0){throw "La retirada fallo.`n$resultado"}

  $restantes = @(Get-ChildItem -LiteralPath $shotsDir -File | Sort-Object Name | ForEach-Object { $_.Name })
  if($restantes -contains 'se-van-1.png'){throw "La captura se-van-1.png sobrevivio a la retirada.`n$($restantes -join ', ')"}
  if($restantes -contains 'se-van-2.jpg'){throw "La captura se-van-2.jpg sobrevivio a la retirada.`n$($restantes -join ', ')"}
  if($restantes -notcontains 'otro-1.png'){throw "La retirada borro la captura de otro script.`n$($restantes -join ', ')"}
  if($restantes -notcontains 'queda-1.png'){throw "La retirada borro una captura que no era del script retirado.`n$($restantes -join ', ')"}

  # El SENUELO: un -Filter sin validar la raiz lo habria borrado.
  if(-not (Test-Path -LiteralPath (Join-Path $testRoot 'fuera\se-van-1.png') -PathType Leaf)){
    throw 'La retirada borro un archivo FUERA de screenshots/. El filtro tiene que validar la raiz.'
  }

  # Y el catalogo sigue con el otro script.
  $tras = Get-Content -LiteralPath (Join-Path $testRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if(@($tras.scripts).Count -ne 1 -or @($tras.scripts)[0].id -ne 'otro'){throw 'La retirada altero el resto del catalogo.'}

  Write-Output 'Screenshots removal passed: borra las suyas, respeta las ajenas y no sale de la carpeta.'
} finally {
  if((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

- [ ] **Paso 2: Ejecutar y verificar que falla**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-removal.ps1`
Expected: FAIL en `La captura se-van-1.png sobrevivio a la retirada`.

- [ ] **Paso 3: El borrado**

En `tools/remove-script.ps1`, después de `$scriptsRoot` (línea 9) y su validación (líneas 18-20), añade el equivalente para las capturas:

```powershell
$shotsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'screenshots'))
```

Y después de la validación de `$targetPath` (línea 20):

```powershell
if (-not $shotsRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'La ruta calculada de screenshots/ no es segura.'
}
```

Y el borrado, después del bloque que quita el userscript (líneas 34-38):

```powershell
# Las capturas del script retirado. Sin esto se acumulan archivos huerfanos que
# ninguna entrada del catalogo describe, y el repositorio crece sin que nadie sepa
# por que. El prefijo con el guion es el que genera el publicador, asi que es el
# patron fiable: el nombre original no existe.
#
# El filtro se acota a la carpeta Y se revalidan las rutas una a una. Un
# Get-ChildItem -Recurse sin ese filtro se lleva por delante lo que este alrededor.
$shotsRemoved = @()
if (Test-Path -LiteralPath $shotsRoot -PathType Container) {
  foreach ($shot in @(Get-ChildItem -LiteralPath $shotsRoot -File -Filter "$Id-*" -ErrorAction SilentlyContinue)) {
    $shotPath = [IO.Path]::GetFullPath($shot.FullName)
    if (-not $shotPath.StartsWith($shotsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { continue }
    try {
      Remove-Item -LiteralPath $shotPath -Force
      $shotsRemoved += $shot.Name
    } catch {
      Write-Host "AVISO  No se pudo borrar la captura $($shot.Name): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}
```

Y el objeto devuelto (línea 40), con el campo nuevo:

```powershell
  ScreenshotsRemoved = @($shotsRemoved)
```

- [ ] **Paso 4: Ejecutar y verificar que pasa**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-screenshots-removal.ps1`
Expected: PASS

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-script-removal.ps1`  ->   PASS
Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-catalog-schema.ps1`  ->   PASS

- [ ] **Paso 5: Sabotear para comprobar que muerde**

| # | Mutación | Aserción que debe caer |
|---|---|---|
| 1 | Cambia `-Filter "$Id-*"` por `-Filter "*.png"` | `La retirada borro la captura de otro script` o `borró una captura que no era del script retirado` |
| 2 | Quita la revalidación de `$shotPath` y usa `-Recurse` desde `$repoRoot` | `La retirada borro un archivo FUERA de screenshots/` |
| 3 | Quita el bloque entero | `La captura se-van-1.png sobrevivio a la retirada` |
| 4 | Sustituye `-Filter "$Id-*"` por un nombre exacto `$Id.png` | `La captura se-van-1.png sobrevivio`  ->  porque la segunda es `.jpg` y se numera |

- [ ] **Paso 6: Commit**

```bash
git add tools/remove-script.ps1 tools/test-screenshots-removal.ps1
git commit -m "Borrar las capturas del script que se retira de la Shop

Sin esto se acumulan archivos huerfanos en screenshots/ que ninguna entrada del catalogo
describe, y el repositorio crece sin que nadie sepa por que. Es el mismo motivo por el que
la retirada ya borra el userscript.

El borrado se acota a la carpeta y revalida cada ruta una a una. Un Get-ChildItem -Recurse
desde la raiz se lleva por delante lo que este alrededor, y la prueba lo comprueba con un
senuelo cuyo nombre el filtro tambien casaria.

El patron es el prefijo con el guion, que es lo que genera el publicador: el nombre original
del archivo no existe, y no se puede buscar por el."
```

---

### Task 5: La cuarta capa del validador

**Files:**
- Modify: `tools/validate-catalog.ps1` (después del bloque de la línea 69, antes del `if ($errors.Count)`)
- Modify: `catalog.schema.json` (campo `screenshots`)
- Modify: `tools/test-validate-catalog.ps1` (los casos nuevos)
- Modify: `tools/test-catalog-schema.ps1` (el caso del campo)
- Test: los dos ficheros de arriba

**Interfaces:**
- Consumes: el contrato de la spec §2, y el patrón de las tres capas que ya tiene el validador.
- Produces: nada para tareas siguientes. Es la última.

- [ ] **Paso 1: Las pruebas que fallan**

En `tools/test-validate-catalog.ps1`, el script tiene un `$Property` para mutatear el catálogo. Añade los casos de capturas siguiendo el mismo patrón. Cada caso es un `elseif`:

```powershell
  elseif ($Property -eq 'badShotHost') {
    $catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('https://otro-sitio.example/DiegoT34/PokeGrid-Script-Shop/main/screenshots/x-1.png') -Force
  }
  elseif ($Property -eq 'badShotPrefix') {
    $catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/otro-script-1.png') -Force
  }
  elseif ($Property -eq 'badShotExtension') {
    $catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/x-1.bmp') -Force
  }
  elseif ($Property -eq 'tooManyShots') {
    $many = 1..7 | ForEach-Object { "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/x-$_.png" }
    $catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @($many) -Force
  }
  elseif ($Property -eq 'goodShots') {
    $catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @(
      'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/x-1.png',
      'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/x-2.webp'
    ) -Force
  }
```

Y los casos de ejecución, con el resultado esperado de cada uno. **La distinction clave: los de capturas AVISAN, y el script se ejecuta con EXPECT FAILURE:**

```powershell
  # Las capturas avisan pero no tumban el catalogo. Un bmp raro, un host equivocado o
  # un prefijo que no cuadra son un archivo mal puesto, no un catalogo invalido: sin
  # el, el launcher no podria instalar el script. Es la misma excepcion deliberada
  # que aplica el launcher, y el publicador la aplica igual.
  foreach ($bad in 'badShotHost','badShotPrefix','badShotExtension','tooManyShots') {
    $result = Invoke-CatalogValidation -Root $root -Mutate $bad
    if ($result.ExitCode -eq 0) { throw "El validador aprobo un catalogo con $bad." }
    if ($result.Output -notmatch 'captura') { throw "El validador no menciono las capturas al rechazar $bad.`n$($result.Output)" }
  }
  # Y uno bueno, que pasa limpio.
  $ok = Invoke-CatalogValidation -Root $root -Mutate 'goodShots'
  if ($ok.ExitCode -ne 0) { throw "El validador rechazo un catalogo con capturas validas.`n$($ok.Output)" }
  if ($ok.Output -notmatch 'captura') { throw 'El validador no informa de cuantas capturas hay.' }
```

- [ ] **Paso 2: Ejecutar y verificar que falla**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-validate-catalog.ps1`
Expected: FAIL en `El validador aprobo un catalogo con badShotHost`.

El campo `screenshots` con `additionalProperties: true` pasa el schema sin quejarse, así que hoy el validador **no dice nada**. Eso es exactamente lo que hay que arreglar: el esquema permite el campo, y no hay quien lo vigile.

- [ ] **Paso 3: La cuarta capa**

En `tools/validate-catalog.ps1`, añade la constante junto a `$downloadBase` (línea 11):

```powershell
$shotsBase = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots'
$shotPattern = '^(?i)https://raw\.githubusercontent\.com/DiegoT34/PokeGrid-Script-Shop/(?:main|[a-f0-9]{40})/screenshots/([a-z0-9][a-z0-9._-]{0,99}\.(?:png|jpg|jpeg|webp|gif))$'
$maxShots = 6
```

Y el bloque, después de la capa 3 (después de la línea 69) y **antes** del `if ($errors.Count)`:

```powershell
# Capa 4: capturas. AVISA, no lanza.
#
# Una captura con la URL mal escrita no puede tumbar el catalogo. El launcher hace
# exactamente lo mismo, por una razon que conviene no olvidar: downloadUrl invalida
# SI lanza, porque sin ella no se puede instalar el script; una captura es
# decoracion, y dejar sin Shop a media gente por un archivo mal puesto seria peor que
# la captura que falta.
$shotNotices = [Collections.Generic.List[string]]::new()
foreach ($item in @($catalog.scripts)) {
  $id = [string]$item.id
  if ($null -eq $item.PSObject.Properties['screenshots']) { continue }
  $shots = @($item.screenshots)
  if ($shots.Count -gt $maxShots) {
    $shotNotices.Add("$id declara $($shots.Count) capturas y el limite son $maxShots. El launcher solo mostrara las $maxShots primeras.")
  }
  $position = 0
  foreach ($shot in @($shots | Select-Object -First $maxShots)) {
    $position += 1
    $url = [string]$shot
    $matched = $shotPattern -match $url
    if (-not $matched) {
      $shotNotices.Add("$id captura $position con URL invalida: $url")
      continue
    }
    $name = $Matches[1]
    # El prefijo se compara en minusculas, igual que en el launcher.
    if (-not $name.ToLowerInvariant().StartsWith("$id-".ToLowerInvariant())) {
      $shotNotices.Add("$id captura $position se llama '$name' y deberia empezar por '$id-'")
    }
    $file = Join-Path $root "screenshots\$name"
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      $shotNotices.Add("$id captura $position no existe en disco: screenshots\$name")
    }
  }
}
foreach ($notice in $shotNotices) { Write-Host "  AVISO  $notice" -ForegroundColor Yellow }
```

Y el mensaje final (línea 75), con el recuento de capturas:

```powershell
$shotCount = @($catalog.scripts | ForEach-Object { @($_.screenshots).Count } | Measure-Object -Sum).Sum
Write-Host "Catalogo valido: $(@($catalog.scripts).Count) script(s), limite de $MaxScriptBytes bytes, $([int]$shotCount) captura(s).$(@(if($shotNotices.Count){" $($shotNotices.Count) aviso(s) de capturas."}else{''}))"
```

- [ ] **Paso 4: El esquema**

En `catalog.schema.json`, dentro de `properties` de cada script, después de `homepage`:

```json
          "screenshots": {
            "type": "array",
            "maxItems": 6,
            "items": {
              "type": "string",
              "maxLength": 220,
              "description": "URL de una captura de la ficha. El nombre del archivo tiene que empezar por el id del script seguido de un guion."
            }
          }
```

- [ ] **Paso 5: La prueba del esquema**

En `tools/test-catalog-schema.ps1`, un caso más:

```powershell
  # El campo screenshots tiene que estar declarado. additionalProperties lo
  # permitiria igual, pero un esquema que no declara un campo del contrato no es un
  # esquema del contrato: quien lo lea no sabra que las capturas existen.
  $schemaText = Get-Content -LiteralPath (Join-Path $root 'catalog.schema.json') -Raw -Encoding UTF8
  if ($schemaText -notmatch '"screenshots"') { throw 'catalog.schema.json no declara el campo screenshots.' }
```

Y un catálogo con el campo, que tiene que seguir siendo válido:

```powershell
  $conCapturas = Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $conCapturas.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/x-1.png') -Force
  [IO.File]::WriteAllText((Join-Path $root 'catalog.json'), ($conCapturas | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  if (-not (($conCapturas | ConvertTo-Json -Depth 12) | Test-Json -SchemaFile (Join-Path $root 'catalog.schema.json'))) {
    throw 'Un catalogo con capturas no cumple el esquema.'
  }
```

- [ ] **Paso 6: Ejecutar y verificar que pasa**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-validate-catalog.ps1`  ->   PASS
Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-catalog-schema.ps1`  ->   PASS

- [ ] **Paso 7: Sabotear para comprobar que muerde**

| # | Mutación | Aserción que debe caer |
|---|---|---|
| 1 | Cambia `$shotNotices` por `$errors` | El catálogo se tumba, y `El validador aprobo un catalogo con badShotHost` falla al revés: el caso bueno también falla |
| 2 | Quita la comprobación de que el archivo exista | El caso de la captura ausente deja de avisar; **añádelo a la prueba antes de dar la tarea por buena** |
| 3 | Cambia `StartsWith("$id-")` por `StartsWith($id)` | `x-1.png` de un script cuyo id es `x` seguiría valiendo, pero `xy-1.png` también. **Añade un caso con `otro` de prefijo** |
| 4 | Quita el `maxItems: 6` del esquema | `tooManyShots` lo seguiría cazando el validador, pero el esquema no. **Añade la comprobación** |

- [ ] **Paso 8: Cerrar los tres huecos**

En `tools/test-validate-catalog.ps1`, añade:

```powershell
  elseif ($Property -eq 'missingShotFile') {
    $catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/x-1.png') -Force
  }
  elseif ($Property -eq 'wrongShotPrefix') {
    $catalog.scripts[0] | Add-Member -NotePropertyName screenshots -NotePropertyValue @('https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/xy-1.png') -Force
  }
```

Y sus casos, más la comprobación del esquema:

```powershell
  $missing = Invoke-CatalogValidation -Root $root -Mutate 'missingShotFile'
  if ($missing.Output -notmatch 'no existe en disco') { throw "Una captura sin archivo en disco no se aviso.`n$($missing.Output)" }

  $prefix = Invoke-CatalogValidation -Root $root -Mutate 'wrongShotPrefix'
  if ($prefix.ExitCode -eq 0) { throw 'El validador aprobo una captura cuyo nombre no empieza por el id.' }

  $schemaRaw = Get-Content -LiteralPath (Join-Path $root 'catalog.schema.json') -Raw -Encoding UTF8
  if ($schemaRaw -notmatch '"maxItems"\s*:\s*6') { throw 'El esquema no declara el limite de 6 capturas.' }
```

Y repite los sabotajes 2, 3 y 4.

- [ ] **Paso 9: Commit**

```bash
git add tools/validate-catalog.ps1 tools/test-validate-catalog.ps1 catalog.schema.json tools/test-catalog-schema.ps1
git commit -m "Vigilar las capturas en el validador del catalogo, avisando sin tumbar

El esquema tiene additionalProperties, asi que el campo screenshots pasaba sin que nadie lo
mirase. El validador tenia tres capas y ninguna era de capturas: un host equivocado, un
prefijo que no cuadra o un archivo que no esta en disco pasaban sin decir nada, y el
fallo aparecia en la maquina de quien lee la Shop.

Esta capa AVISA y no lanza, y la razon es la misma que aplica el launcher y el publicador:
downloadUrl invalida si lanza porque sin ella no se puede instalar el script, pero una
captura es decoracion, y dejar sin Shop a media gente por un archivo mal puesto seria
peor que la captura que falta.

El prefijo se compara en minusculas, igual que en el launcher, para que el validador y el
launcher no discrepen sobre el mismo nombre.

El esquema declara screenshots con su limite de 6, aunque additionalProperties lo
permitiria igual. Un esquema que no declara un campo del contrato no es un esquema del
contrato."
```

---

### Task 6: La documentación

**Files:**
- Modify: `PUBLISHER-README.md`

**Interfaces:**
- Consumes: las cinco tareas anteriores. No produce nada.
- Produce: nada. Es la última.

- [ ] **Paso 1: La sección**

En `PUBLISHER-README.md`, después de la sección donde se explica la publicación de un script, una sección `## Capturas de pantalla`. Con las reglas exactas, que aquí importan más que en ningún otro sitio porque **quien lee esto va a subir archivos**:

```markdown
## Capturas de pantalla

Un script puede llevar hasta **seis** capturas, que se ven en su ficha y se abren grandes al
pulsarlas.

```powershell
# Al publicar, con -Screenshots
.\tools\publish-script.ps1 -Path .\mi-script.user.js -Id 'mi-script' -Screenshots @(
  '.\capturas\panel-principal.png',
  '.\capturas\ajustes.jpg'
)
```

Los archivos se copian a `screenshots/` con un **nombre que genera el publicador**:
`mi-script-1.png`, `mi-script-2.jpg`. El nombre del archivo que tú eliges no se usa, y
por eso puedes llamarlos como quieras.

Cuatro reglas que el publicador hace cumplir, y que si no se cumplen la captura **no se
publica**  ->  se descarta con un aviso y el resto se publica igual:

- **La extensión** tiene que ser `png`, `jpg`, `jpeg`, `webp` o `gif`.
- **El tamaño** hasta 2 MB por captura.
- **Una captura por extensión**: dos capturas con la misma extensión se rechazan, porque
  los nombres generados empezarían por el mismo número.
- **La ruta del archivo tiene que existir** en el momento de publicar.

Al publicar una actualización **sin** `-Screenshots`, las capturas que ya tinha se conservan
y el publicador te avisa. Si quieres quitarlas, borra los archivos de `screenshots/` y
vuelve a publicar; el publicador no adivina.

**Retirar un script borra sus capturas.** No quedan archivos huérfanos.

El campo `catalog.json` se escribe solo, con las URLs completas:

```json
"screenshots": [
  "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/mi-script-1.png",
  "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/screenshots/mi-script-2.jpg"
]
```

Un script sin capturas **no lleva el campo**, ni vacío.
```

- [ ] **Paso 2: Comprobar que el ejemplo del README es verdad**

Antes de commitear, verifica contra el código, no de memoria: que `publish-script.ps1` acepte `-Screenshots` como array, que el nombre generado sea `<id>-<n>.<ext>`, y que la retirada borre. Si algo del texto no coincide con el código, el README es lo primero que engaña a quien lo lee.

- [ ] **Paso 3: La prueba de la documentation**

Un README no tiene pruebas. Lo que tiene es una **comprobación de que los ejemplos del
README no están desfasados**, y aquí es -> 09 -> ` -> : ejecuta el comando del ejemplo, en el
repositorio de pruebas, y mira que funciona. Si el ejemplo no corre, no es un ejemplo: es
una trampa para quien lo copie.

- [ ] **Paso 4: Commit**

```bash
git add PUBLISHER-README.md
git commit -m "Documentar como publicar capturas y que hace el publicador con ellas

La parte que mas importa es la que se descarta: una captura con la extension rara, de mas de
2 MB, duplicada o cuya ruta no existe NO se publica, pero el script entero si. Y el
publicador avisa de cual y por que, en vez de callarse.

Tambien queda escrito que el nombre lo genera el publicador y que al actualizar sin
-Screenshots las capturas anteriores se conservan con aviso. Quien lea esto antes de subir
sus archivos evita las dos perdidas mas comunes."
```

---

## Antes de dar esto por terminado

1. Las seis tareas, con sus puertas.
2. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-*.ps1`  ->  **todas**, una a
   una, no solo las nuevas. El repo no tiene runner.
3. `git add` y `git commit` explícitos, nunca `-a` ni `-A`.
4. **Nada de publicar.** Ni `git push`, ni tag, ni Release. Eso es del usuario.
5. La puerta final: abrir la GUI y publicar un script de verdad con dos capturas, confirmar
   que aparecen en la ficha, y **retirarlo** para confirmar que las capturas desaparecen.
   Ninguna prueba de este repositorio ejercita la GUI, y el `git add` de la Tarea 3 es
   exactamente el tipo de cosa que funciona en la prueba y falla en el botón.
