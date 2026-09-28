# Promover PokeGrid Publisher 1.3.1 a versión canónica — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sustituir la versión 1.1 rota de la raíz por la 1.3.1 que sí funciona, y hacer coherentes el publicador, el catálogo, el schema y el workflow de validación.

**Architecture:** Se promueve la carpeta `PokeGrid-Shop-Publisher-1.3.1/` a la raíz del repositorio. La validación del catálogo, hoy embebida como PowerShell dentro del YAML del workflow, se extrae a `tools/validate-catalog.ps1` para que sea ejecutable y testeable localmente; el workflow pasa a ser un wrapper delgado. Cada corrección de código lleva su propio test siguiendo la convención existente del proyecto: scripts PowerShell autónomos con `try/finally`, directorios temporales y `throw` en el fallo.

**Tech Stack:** Windows PowerShell 5.1, WinForms (`System.Windows.Forms`, `System.Drawing`), Git CLI, GitHub Actions (`windows-latest`, `pwsh`), JSON Schema draft 2020-12.

**Spec:** `docs/superpowers/specs/2026-09-28-pokegrid-publisher-1.3.1-promocion-design.md`

## Global Constraints

- **No hay `push`.** Todo queda en commits locales. El usuario revisa y decide.
- **`catalog.json` no se modifica.** Ningún campo, ningún orden, ningún hash.
- **Los 6 `.user.js` de `scripts/` no se modifican.** Sus SHA-256 son el contrato con el launcher.
- **Límite de userscripts: 10 MB.** Exactamente `10MB` en PowerShell = 10485760 bytes.
- **`minLauncherVersion`: `0.22.1`** en GUI, CLI y catálogo.
- **Encoding:** todo `.ps1` con caracteres no ASCII lleva BOM UTF-8, porque `Abrir-PokeGrid-Shop-Publisher.cmd` invoca `powershell.exe` (Windows PowerShell 5.1). Los `.cmd` van sin BOM y solo ASCII.
- **Finales de línea LF en todo el repositorio**, fijado por `.gitattributes` porque `core.autocrlf=true` en la máquina del usuario.
- **Convención de tests:** scripts autónomos en `tools/test-*.ps1`, `try/finally`, limpieza en `finally`, `throw` en el fallo, código de salida 0 en éxito. No se introduce Pester (la versión instalada es 3.4.0, de 2016, y el proyecto no lo usa).
- **Idioma:** mensajes al usuario y comentarios en español.

## Review Focus

Cinco clases de entrada o fallo que la especificación implica pero que ningún test del plan ejercita explícitamente. Cada una tiene su test en la tarea indicada.

1. **Una entrada del catálogo cuyo `.user.js` no existe en disco.** El CI debe fallar, no saltarse la comprobación. → Task 2, `test-validate-catalog.ps1`, fixture `missing-file`.
2. **Un `@version` con prefijo `v`**, por ejemplo `// @version v1.2.3`. El publicador lo normaliza al escribir, así que el archivo publicado nunca lo lleva, pero un archivo editado a mano sí. El validador debe comparar contra la forma normalizada, no contra la cruda. → Task 2, fixture `v-prefix`.
3. **Un `@version` de dos componentes**, por ejemplo `3.91`. El publicador lo normaliza a `3.91.0`; el validador debe rechazar el archivo sin normalizar en lugar de aceptarlo en silencio. → Task 2, fixture `two-component`.
4. **IDs duplicados que solo difieren en mayúsculas.** El patrón del schema ya prohíbe mayúsculas en `id`, pero la comprobación de unicidad debe ser insensible a mayúsculas para no depender de ese orden. → Task 2, fixture `duplicate-id-case`.
5. **La regla `scripts/*.user.js text eol=lf` de `.gitattributes`.** Si se elimina, Git convierte los `.user.js` a CRLF al commit, los SHA-256 dejan de coincidir y **los 6 scriptspublished quedan invalidados de golpe**, sin que ninguna tarea lo detecte. → Task 10, `test-gitattributes.ps1`.

---

## Estructura de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `PokeGrid-Shop-Publisher.ps1` | Reemplazar por 1.3.1 | GUI de tres pestañas |
| `Abrir-PokeGrid-Shop-Publisher.cmd` | Reemplazar por 1.3.1 | Lanzador |
| `PUBLISHER-README.md` | Reemplazar por 1.3.1 | Documentación del publicador |
| `tools/git-helper.ps1` | Añadir | Resolver y ejecutar `git` sin sombrear el ejecutable |
| `tools/publish-script.ps1` | Reemplazar por 1.3.1 + rollback | Publicar un userscript |
| `tools/remove-script.ps1` | Añadir | Retirar un script de la Shop |
| `tools/publish-launcher.ps1` | Añadir | Publicar una versión del launcher |
| `tools/validate-catalog.ps1` | **Crear** | Validar el catálogo. Toda la lógica del CI vive aquí |
| `tools/test-*.ps1` | Añadir 8, promover 6 | Pruebas |
| `.github/workflows/validate-catalog.yml` | Reescribir | Wrapper delgado sobre `validate-catalog.ps1` + job de tests |
| `catalog.schema.json` | Ampliar | Forma del catálogo, sin cambiar `required` |
| `.gitattributes` | Ampliar | LF universal + regla crítica de `scripts/` |
| `scripts/.gitkeep` | Eliminar | Resto de cuando la carpeta estaba vacía |
| `PokeGrid-Shop-Publisher-1.3.1/` | Eliminar | Contenido ya copiado a la raíz |

---

## Task 1: Promover la 1.3.1 a la raíz

**Files:**
- Create: `PokeGrid-Shop-Publisher.ps1`, `PUBLISHER-README.md`, `tools/git-helper.ps1`, `tools/remove-script.ps1`, `tools/publish-launcher.ps1`, `tools/test-*.ps1` (6)
- Modify: `Abrir-PokeGrid-Shop-Publisher.cmd`
- Delete: `PokeGrid-Shop-Publisher-1.3.1/`, `scripts/.gitkeep`

**Interfaces:**
- Consumes: nada. Es la primera tarea.
- Produces: en la raíz, `PokeGrid-Shop-Publisher.ps1` con parámetros `-SmokeTest`, `-ScreenshotPath`, `-InitialTab`; `tools/publish-script.ps1` con los parámetros documentados abajo; `git-helper.ps1` exportando `Resolve-PokeGridGitPath` y `Invoke-PokeGridGit`. Todas las tareas siguientes dependen de estos archivos en la raíz.

- [ ] **Step 1: Confirmar el estado de partida**

```powershell
cd C:\Users\Shockviny\Downloads\PokeGrid-Script-Shop
git status --short
Get-ChildItem 'PokeGrid-Shop-Publisher-1.3.1' -Recurse -File | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: `?? PokeGrid-Shop-Publisher-1.3.1/` y `12` (2 `.cmd`/`.ps1` de raíz más 10 de `tools`).

- [ ] **Step 2: Copiar preservando bytes exactos**

Se usa copia a nivel de byte: reescribir el contenido alters el BOM y rompe PowerShell 5.1.

```powershell
$src = 'PokeGrid-Shop-Publisher-1.3.1'
Copy-Item "$src\PokeGrid-Shop-Publisher.ps1"   'PokeGrid-Shop-Publisher.ps1'   -Force
Copy-Item "$src\PUBLISHER-README.md"           'PUBLISHER-README.md'           -Force
Copy-Item "$src\Abrir-PokeGrid-Shop-Publisher.cmd" 'Abrir-PokeGrid-Shop-Publisher.cmd' -Force
Copy-Item "$src\tools\*"                       'tools'                         -Force
```

Expected: sin salida ni error.

- [ ] **Step 3: Confirmar que los bytes se copiaron idénticos**

```powershell
$a = (Get-FileHash 'PokeGrid-Shop-Publisher-1.3.1\PokeGrid-Shop-Publisher.ps1' -Algorithm SHA256).Hash
$b = (Get-FileHash 'PokeGrid-Shop-Publisher.ps1' -Algorithm SHA256).Hash
if ($a -ne $b) { throw "El .ps1 no se copio identico: $a vs $b" }
Get-ChildItem 'PokeGrid-Shop-Publisher.ps1','Abrir-PokeGrid-Shop-Publisher.cmd','PUBLISHER-README.md' |
  ForEach-Object {
    $raw = [IO.File]::ReadAllBytes($_.FullName)
    $bom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
    "{0,-40} BOM={1}" -f $_.Name, $bom
  }
```

Expected: hash idéntico; `PokeGrid-Shop-Publisher.ps1` con `BOM=True`, `Abrir-PokeGrid-Shop-Publisher.cmd` con `BOM=False`.

- [ ] **Step 4: Ejecutar la suite heredada como puerta de regresión**

```powershell
$ErrorActionPreference = 'Continue'
foreach ($t in @('test-git-workflow.ps1','test-new-script-publication.ps1','test-script-removal.ps1','test-script-size-limit.ps1','test-launcher-publication.ps1')) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools\$t" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$t fallo tras la promocion" }
  "  OK  $t"
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File 'PokeGrid-Shop-Publisher.ps1' -SmokeTest
if ($LASTEXITCODE -ne 0) { throw 'El smoke test de la GUI fallo tras la promocion' }
```

Expected: 5 líneas `OK` y luego `PokeGrid Publisher 1.3.1 ... smoke passed.`

- [ ] **Step 5: Eliminar la carpeta 1.3.1 y el `.gitkeep`**

```powershell
Remove-Item -Recurse -Force 'PokeGrid-Shop-Publisher-1.3.1'
git rm --quiet 'scripts/.gitkeep'
```

Expected: sin salida.

- [ ] **Step 6: Confirmar que el catálogo y los scripts no se tocaron**

```powershell
git status --short
git diff --stat -- catalog.json scripts/
```

Expected: `catalog.json` y los `.user.js` no aparecen en el diff. Solo `scripts/.gitkeep` como borrado.

- [ ] **Step 7: Commit**

```powershell
git add -- PokeGrid-Shop-Publisher.ps1 PUBLISHER-README.md Abrir-PokeGrid-Shop-Publisher.cmd tools
git commit -m "Promover PokeGrid Publisher 1.3.1 a la raiz"
```

---

## Task 2: Extraer la validación del catálogo a `tools/validate-catalog.ps1`

**Files:**
- Create: `tools/validate-catalog.ps1`
- Test: `tools/test-validate-catalog.ps1`

**Interfaces:**
- Consumes: nada de tareas anteriores más el layout de la raíz de la Task 1.
- Produces:
  - `validate-catalog.ps1 -RepositoryRoot <string> [-MaxScriptBytes <int64>]` → escribe un resumen por `Write-Host` y lanza `throw` con **todos** los errores acumulados si hay alguno. Código de salida 0 si el catálogo es válido.
  - `test-validate-catalog.ps1` no exporta nada; solo valida fixtures.
  - La Task 3 invoca este script desde el workflow.

Esta es la tarea que hace verificable el resto del trabajo del CI, que hasta ahora era PowerShell embebido en YAML y no se podía ejecutar localmente.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-validate-catalog.ps1`:

```powershell
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

  # 6. Review Focus 2: prefijo v en @version, sin normalizar en el archivo.
  $vPrefix = New-Fixture 'v-prefix' 'con-v' '1.2.3' 'https://pokegrid.test/v' 0
  $file = Join-Path $vPrefix 'scripts\con-v.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 1.2.3', '@version v1.2.3'), $utf8)
  $r = Invoke-Validator $vPrefix
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version con prefijo v sin normalizar.' }

  # 7. Review Focus 3: @version de dos componentes, que el catalogo exige como tres.
  $twoPart = New-Fixture 'two-component' 'dos-partes' '3.91.0' 'https://pokegrid.test/two' 0
  $file = Join-Path $twoPart 'scripts\dos-partes.user.js'
  [IO.File]::WriteAllText($file, ((Get-Content $file -Raw) -replace '@version 3.91.0', '@version 3.91'), $utf8)
  $r = Invoke-Validator $twoPart
  if ($r.ExitCode -eq 0) { throw 'El validador acepto un @version de dos componentes.' }

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

  Write-Output 'Catalog validator passed: valid catalog, missing file, bad hash, bad URL, version mismatch, v prefix, two-component version, 10 MB limit, duplicate id case and RFC 3339 date.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-validate-catalog.ps1
```

Expected: FAIL. `powershell.exe` no encuentra el guion y el proceso termina con
código 1; el mensaje es `The argument '...\validate-catalog.ps1' is not recognized`
o equivalente. Any fixture que se declare valido hace fallar el test en
`Un catalogo valido fue rechazado`.

- [ ] **Step 3: Escribir la implementación mínima**

`tools/validate-catalog.ps1`:

```powershell
param(
  [string]$RepositoryRoot = '',
  [int64]$MaxScriptBytes = 10MB
)

$ErrorActionPreference = 'Stop'
$root = if ($RepositoryRoot) { [IO.Path]::GetFullPath($RepositoryRoot) } else { Split-Path -Parent $PSScriptRoot }
$catalogPath = Join-Path $root 'catalog.json'
$schemaPath = Join-Path $root 'catalog.schema.json'
$errors = [Collections.Generic.List[string]]::new()
$downloadBase = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts'
$rfc3339 = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'

if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw "No se encontro catalog.json en $root" }
$raw = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8
$catalog = $raw | ConvertFrom-Json

# Capa 1: schema. Test-Json solo existe en PowerShell 6+; en 5.1 se omite y
# dejan las comprobaciones explicitas de mas abajo, que son las que importan.
if ((Get-Command Test-Json -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $schemaPath -PathType Leaf)) {
  try {
    if (-not ($raw | Test-Json -SchemaFile $schemaPath -ErrorAction Stop)) {
      $errors.Add('catalog.json no cumple catalog.schema.json.')
    }
  } catch {
    $errors.Add("catalog.json no cumple catalog.schema.json: $($_.Exception.Message)")
  }
}

# Capa 2: formato y unicidad.
if ([int]$catalog.schemaVersion -ne 1) { $errors.Add('schemaVersion debe ser 1.') }
if ([string]$catalog.updatedAt -notmatch $rfc3339) {
  $errors.Add("updatedAt no es RFC 3339: '$($catalog.updatedAt)'")
}
$seen = @{}
foreach ($item in @($catalog.scripts)) {
  $id = [string]$item.id
  if ($id -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$') { $errors.Add("ID invalido: '$id'") }
  $key = $id.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { $errors.Add("ID duplicado: '$id'") } else { $seen[$key] = $true }
  if ([string]$item.version -notmatch '^\d+\.\d+\.\d+(?:[-+].*)?$') { $errors.Add("Version invalida: '$id'") }
  if ([string]$item.sha256 -notmatch '^[a-f0-9]{64}$') { $errors.Add("SHA-256 invalido: '$id'") }
  $expectedUrl = "$downloadBase/$id.user.js"
  if ([string]$item.downloadUrl -ne $expectedUrl) { $errors.Add("URL invalida: '$id'") }
}

# Capa 3: archivo en disco.
foreach ($item in @($catalog.scripts)) {
  $id = [string]$item.id
  $file = Join-Path $root "scripts\$id.user.js"
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $errors.Add("No existe scripts\$id.user.js"); continue }
  $length = (Get-Item -LiteralPath $file).Length
  if ($length -gt $MaxScriptBytes) {
    $errors.Add("scripts\$id.user.js ocupa $length bytes y supera el limite de 10 MB")
    continue
  }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne [string]$item.sha256) { $errors.Add("SHA-256 no coincide: '$id'") }
  $code = Get-Content -LiteralPath $file -Raw -Encoding UTF8
  $fileVersion = [regex]::Match($code, '(?im)^\s*//\s*@version\s+(.+?)\s*$').Groups[1].Value.Trim()
  $fileVersion = $fileVersion.TrimStart('v')
  if ($fileVersion -ne [string]$item.version) { $errors.Add("@version no coincide: '$id' (archivo '$fileVersion', catalogo '$($item.version)')") }
  $fileNamespace = [regex]::Match($code, '(?im)^\s*//\s*@namespace\s+(.+?)\s*$').Groups[1].Value.Trim()
  if ($fileNamespace -ne [string]$item.namespace) { $errors.Add("@namespace no coincide: '$id'") }
}

if ($errors.Count) {
  foreach ($message in $errors) { Write-Host "  ERROR  $message" -ForegroundColor Red }
  throw "Catalogo invalido: $($errors.Count) problema(s)."
}
Write-Host "Catalogo valido: $(@($catalog.scripts).Count) script(s), limite de $MaxScriptBytes bytes."
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-validate-catalog.ps1
```

Expected: `Catalog validator passed: valid catalog, missing file, bad hash, bad URL, version mismatch, v prefix, two-component version, 10 MB limit, duplicate id case and RFC 3339 date.`

- [ ] **Step 5: Validar el catálogo real del repositorio**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\validate-catalog.ps1 -RepositoryRoot .
```

Expected: `Catalogo valido: 6 script(s), limite de 10485760 bytes.`

- [ ] **Step 6: Añadir el BOM**

```powershell
$path = 'tools\validate-catalog.ps1'
$text = [IO.File]::ReadAllText($path)
[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($true))
```

- [ ] **Step 7: Commit**

```powershell
git add -- tools/validate-catalog.ps1 tools/test-validate-catalog.ps1
git commit -m "Extraer la validacion del catalogo a tools/validate-catalog.ps1"
```

---

## Task 3: Workflow delgado que delega en el validador

**Files:**
- Modify: `.github/workflows/validate-catalog.yml`
- Test: `tools/test-workflow-wiring.ps1`

**Interfaces:**
- Consumes: `tools/validate-catalog.ps1 -RepositoryRoot` de la Task 2.
- Produces: un workflow con dos jobs, `validate` y `test`. Ningún test posterior depende de él salvo Task 11.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-workflow-wiring.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$workflow = Join-Path $root '.github\workflows\validate-catalog.yml'
$content = Get-Content -LiteralPath $workflow -Raw -Encoding UTF8

if ($content -notmatch 'validate-catalog\.ps1') { throw 'El workflow no invoca tools/validate-catalog.ps1.' }
if ($content -match '1000000') { throw 'El workflow todavia impone el limite antiguo de 1000000 bytes; vive en validate-catalog.ps1.' }

$required = @(
  'test-git-workflow.ps1',
  'test-new-script-publication.ps1',
  'test-script-removal.ps1',
  'test-script-size-limit.ps1',
  'test-launcher-publication.ps1'
)
foreach ($test in $required) {
  if ($content -notmatch [regex]::Escape($test)) { throw "El workflow no ejecuta $test." }
}
if ($content -match 'test-publication-pipeline\.ps1') {
  throw 'test-publication-pipeline.ps1 no debe ejecutarse en CI: depende de un clon local que el runner no tiene.'
}
foreach ($job in @('validate:', 'test:')) {
  if ($content -notmatch [regex]::Escape($job)) { throw "El workflow no define el job $job" }
}
Write-Output 'Workflow wiring passed: delegates to validate-catalog.ps1, runs the five tests, excludes the local-only test, no stale 1 MB limit.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-workflow-wiring.ps1
```

Expected: FAIL con `El workflow no invoca tools/validate-catalog.ps1.`

- [ ] **Step 3: Reescribir el workflow**

`.github/workflows/validate-catalog.yml`:

```yaml
name: Validar catálogo

on:
  push:
    branches: [main]
  pull_request:

jobs:
  validate:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validar catálogo, metadatos y SHA-256
        shell: pwsh
        run: |
          & ./tools/validate-catalog.ps1 -RepositoryRoot $PWD
          if ($LASTEXITCODE -ne 0) { throw 'La validación del catálogo falló.' }

  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Ejecutar las pruebas del publicador
        shell: pwsh
        run: |
          $tests = @(
            'test-git-workflow.ps1'
            'test-new-script-publication.ps1'
            'test-script-removal.ps1'
            'test-script-size-limit.ps1'
            'test-launcher-publication.ps1'
          )
          foreach ($test in $tests) {
            Write-Host "--- $test ---"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools/$test"
            if ($LASTEXITCODE -ne 0) { throw "$test falló con código $LASTEXITCODE." }
          }
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-workflow-wiring.ps1
```

Expected: `Workflow wiring passed: delegates to validate-catalog.ps1, runs the five tests, excludes the local-only test, no stale 1 MB limit.`

- [ ] **Step 5: Ejecutar localmente lo que el workflow ejecutará**

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\validate-catalog.ps1 -RepositoryRoot .
foreach ($t in @('test-git-workflow.ps1','test-new-script-publication.ps1','test-script-removal.ps1','test-script-size-limit.ps1','test-launcher-publication.ps1')) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools\$t" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$t fallo" }
  "  OK  $t"
}
```

Expected: `Catalogo valido: 6 script(s)` y 5 líneas `OK`.

- [ ] **Step 6: Commit**

```powershell
git add -- .github/workflows/validate-catalog.yml tools/test-workflow-wiring.ps1
git commit -m "Delegar la validacion del workflow en tools/validate-catalog.ps1 y anadir job de pruebas"
```

---

## Task 4: Ampliar `catalog.schema.json`

**Files:**
- Modify: `catalog.schema.json`
- Test: `tools/test-catalog-schema.ps1`

**Interfaces:**
- Consumes: layout de raíz de la Task 1.
- Produces: un schema que documenta `games`, `author`, `summary`, `description`, `category`, `tags`, `permissions`, `changelog`, `icon`, `featured`, `publishedAt` y `homepage`, con los mismos 10 campos en `required` que ahora. `catalog.json` sigue validando sin modificarse.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-catalog-schema.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$schemaPath = Join-Path $root 'catalog.schema.json'
$catalogPath = Join-Path $root 'catalog.json'
$schema = Get-Content -LiteralPath $schemaPath -Raw -Encoding UTF8 | ConvertFrom-Json
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json

$documented = @('id','name','namespace','version','summary','description','category','minLauncherVersion','downloadUrl','sha256','author','tags','games','permissions','changelog','icon','featured','publishedAt','homepage')
foreach ($property in $documented) {
  if (-not $schema.properties.scripts.items.properties.$property) {
    throw "catalog.schema.json no documenta la propiedad '$property'."
  }
}
if (-not $schema.properties.scripts.items.additionalProperties) {
  throw 'Los items del schema deben mantener additionalProperties en true: el launcher debe seguir leyendo campos nuevos.'
}
if (@($schema.properties.scripts.items.required).Count -ne 10) {
  throw "El schema debe exigir exactamente 10 campos, no $(@($schema.properties.scripts.items.required).Count)."
}
if ($schema.properties.scripts.maxItems -ne 200) { throw 'El schema debe seguir limitando a 200 scripts.' }

# Comprobaciones explícitas: funcionan en Windows PowerShell 5.1, donde Test-Json no existe.
foreach ($item in @($catalog.scripts)) {
  foreach ($field in @($schema.properties.scripts.items.required)) {
    if (-not $item.PSObject.Properties[$field]) { throw "El catalogo real no tiene '$field' en '$($item.id)'." }
  }
  if ([string]$item.id -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$') { throw "id invalido en el catalogo real: $($item.id)" }
  if ([string]$item.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+].*)?$') { throw "version invalida: $($item.id)" }
  if ([string]$item.sha256 -notmatch '^[a-f0-9]{64}$') { throw "sha256 invalida: $($item.id)" }
}

if (Get-Command Test-Json -ErrorAction SilentlyContinue) {
  $raw = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8
  if (-not ($raw | Test-Json -SchemaFile $schemaPath)) { throw 'El catalogo real no valida contra el schema.' }
  Write-Output '  (validacion Test-Json ejecutada en PowerShell 7+)'
} else {
  Write-Output '  (Test-Json no disponible en Windows PowerShell 5.1; solo comprobaciones explicitas)'
}
Write-Output 'Catalog schema passed: documented properties, required set, additionalProperties and the real catalog.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-catalog-schema.ps1
```

Expected: FAIL con `catalog.schema.json no documenta la propiedad 'author'.`

- [ ] **Step 3: Ampliar el schema**

`catalog.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PokeGrid Script Shop catalog",
  "type": "object",
  "required": ["schemaVersion", "updatedAt", "scripts"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "updatedAt": { "type": "string", "format": "date-time" },
    "scripts": {
      "type": "array",
      "maxItems": 200,
      "items": {
        "type": "object",
        "required": ["id", "name", "namespace", "version", "summary", "description", "category", "minLauncherVersion", "downloadUrl", "sha256"],
        "properties": {
          "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{1,79}$" },
          "name": { "type": "string", "maxLength": 120 },
          "namespace": { "type": "string", "maxLength": 240 },
          "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+].*)?$" },
          "summary": { "type": "string", "maxLength": 300 },
          "description": { "type": "string", "maxLength": 4000 },
          "category": { "type": "string", "maxLength": 60 },
          "minLauncherVersion": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
          "downloadUrl": { "type": "string", "format": "uri" },
          "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
          "author": { "type": "string", "maxLength": 120 },
          "tags": { "type": "array", "items": { "type": "string", "maxLength": 40 } },
          "games": { "type": "array", "maxItems": 8, "items": { "type": "string", "maxLength": 80 } },
          "permissions": { "type": "array", "items": { "type": "string", "maxLength": 200 } },
          "changelog": { "type": "string", "maxLength": 2000 },
          "icon": { "type": "string", "maxLength": 8 },
          "featured": { "type": "boolean" },
          "publishedAt": { "type": "string", "format": "date-time" },
          "homepage": { "type": "string", "format": "uri" }
        },
        "additionalProperties": true
      }
    }
  },
  "additionalProperties": false
}
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-catalog-schema.ps1
```

Expected: `Catalog schema passed: documented properties, required set, additionalProperties and the real catalog.`

- [ ] **Step 5: Commit**

```powershell
git add -- catalog.schema.json tools/test-catalog-schema.ps1
git commit -m "Documentar en catalog.schema.json todos los campos que escribe el publicador"
```

---

## Task 5: BOM en los tres `.ps1` con acentos

**Files:**
- Modify: `tools/remove-script.ps1`, `tools/test-script-removal.ps1`, `tools/test-script-size-limit.ps1`
- Test: `tools/test-powershell-encoding.ps1`

**Interfaces:**
- Consumes: layout de raíz de la Task 1.
- Produces: invariante verificable de que todo `.ps1` con caracteres no ASCII lleva BOM, y todo `.cmd` no lo lleva.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-powershell-encoding.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$problems = [Collections.Generic.List[string]]::new()

foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -Include *.ps1) {
  if ($file.FullName -like '*\dist\*') { continue }
  $raw = [IO.File]::ReadAllBytes($file.FullName)
  $hasBom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
  $nonAscii = ([regex]::Matches([IO.File]::ReadAllText($file.FullName), '[^\x00-\x7F]')).Count
  if ($nonAscii -gt 0 -and -not $hasBom) {
    $problems.Add("$($file.Name) tiene $nonAscii caracteres no ASCII y no lleva BOM: Windows PowerShell 5.1 los mostrara rotos.")
  }
}
foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -Include *.cmd) {
  $raw = [IO.File]::ReadAllBytes($file.FullName)
  if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
    $problems.Add("$($file.Name) lleva BOM: un .cmd con BOM no se ejecuta correctamente en Windows.")
  }
  if (([regex]::Matches([IO.File]::ReadAllText($file.FullName), '[^\x00-\x7F]')).Count -gt 0) {
    $problems.Add("$($file.Name) tiene caracteres no ASCII: el .cmd debe ser ASCII puro.")
  }
}
if ($problems.Count) {
  foreach ($p in $problems) { Write-Host "  ERROR  $p" -ForegroundColor Red }
  throw "Encoding incorrecto en $($problems.Count) archivo(s)."
}
Write-Output 'PowerShell encoding passed: every .ps1 with accents has a BOM and every .cmd is ASCII without BOM.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-powershell-encoding.ps1
```

Expected: FAIL con `Encoding incorrecto en 3 archivo(s).`

- [ ] **Step 3: Añadir el BOM a los tres archivos**

```powershell
foreach ($path in @('tools\remove-script.ps1','tools\test-script-removal.ps1','tools\test-script-size-limit.ps1')) {
  $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($true))
  "  BOM anadido a $path"
}
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-powershell-encoding.ps1
```

Expected: `PowerShell encoding passed: every .ps1 with accents has a BOM and every .cmd is ASCII without BOM.`

- [ ] **Step 5: Confirmar que los tests afectados siguen pasando**

Los mensajes de esos tres archivos se leían rotos antes; ahora deben verse bien.

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-script-removal.ps1
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-script-size-limit.ps1
```

Expected: `Script removal pipeline passed: ...` y `Script size limit passed: ...`

- [ ] **Step 6: Commit**

```powershell
git add -- tools/remove-script.ps1 tools/test-script-removal.ps1 tools/test-script-size-limit.ps1 tools/test-powershell-encoding.ps1
git commit -m "Anadir el BOM que Windows PowerShell 5.1 necesita a tres scripts con acentos"
```

---

## Task 6: Unificar `minLauncherVersion` a `0.22.1`

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1:237`, `:255`, `:492`
- Test: `tools/test-min-launcher-default.ps1`

**Interfaces:**
- Consumes: GUI promovida en la Task 1.
- Produces: invariante de que GUI, CLI y catálogo coinciden en `0.22.1`.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-min-launcher-default.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$expected = '0.22.1'

$gui = Get-Content -LiteralPath (Join-Path $root 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
$cli = Get-Content -LiteralPath (Join-Path $root 'tools\publish-script.ps1') -Raw -Encoding UTF8

if ($gui -match "minLauncherBox\.Text\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'") {
  $guiValue = $Matches[1]
} else {
  throw 'No se encontro una asignacion literal a minLauncherBox en la GUI.'
}
if ($cli -notmatch "\[string\]\`$MinLauncherVersion\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'") {
  throw 'No se encontro el valor por defecto de MinLauncherVersion en publish-script.ps1.'
}
$cliValue = $Matches[1]

if ($guiValue -ne $expected) { throw "La GUI propone minLauncherVersion '$guiValue' y debe ser '$expected'." }
if ($cliValue -ne $expected) { throw "El CLI propone minLauncherVersion '$cliValue' y debe ser '$expected'." }

$occurrences = ([regex]::Matches($gui, [regex]::Escape("minLauncherBox.Text='0.22.1'"))).Count
$occurrences += ([regex]::Matches($gui, [regex]::Escape("minLauncherBox.Text = '0.22.1'"))).Count
if ($occurrences -ne 3) { throw "Se esperaban 3 asignaciones de minLauncherBox a 0.22.1 (Clear, Load y valor inicial) y hay $occurrences." }
if ($gui -match '0\.22\.3') { throw 'La GUI todavia contiene 0.22.3, que la sube al publicar sin avisar.' }

$catalog = Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($item in @($catalog.scripts)) {
  if ([string]$item.minLauncherVersion -ne $expected) {
    throw "El catalogo declara '$($item.minLauncherVersion)' en '$($item.id)' y debe ser '$expected'."
  }
}
Write-Output "Min launcher default passed: GUI, CLI and catalog all declare $expected."
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-min-launcher-default.ps1
```

Expected: FAIL con `La GUI propone minLauncherVersion '0.22.3' y debe ser '0.22.1'.`

- [ ] **Step 3: Cambiar las tres ocurrencias**

En `PokeGrid-Shop-Publisher.ps1`, reemplazar `0.22.3` por `0.22.1` en:

- Línea 237, dentro de `Clear-PublicationFields`:
  `$minLauncherBox.Text = '0.22.3'` → `$minLauncherBox.Text = '0.22.1'`
- Línea 255, dentro de `Load-SelectedScript`:
  `$minLauncherBox.Text='0.22.3'` → `$minLauncherBox.Text='0.22.1'`
- Línea 492, construcción del formulario:
  `$minLauncherBox=New-TextBox;$minLauncherBox.Text='0.22.3'` → `$minLauncherBox=New-TextBox;$minLauncherBox.Text='0.22.1'`

Y en la línea 487, que inicializa el texto de ayuda:
  `$sourceHint.Text = 'Arrastra un archivo aquí o utiliza Examinar.'` → `$sourceHint.Text = 'Arrastra un archivo aquí o utiliza Examinar. Tamaño máximo: 10 MB.'`

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-min-launcher-default.ps1
```

Expected: `Min launcher default passed: GUI, CLI and catalog all declare 0.22.1.`

- [ ] **Step 5: Commit**

```powershell
git add -- PokeGrid-Shop-Publisher.ps1 tools/test-min-launcher-default.ps1
git commit -m "Unificar minLauncherVersion en 0.22.1 entre GUI, CLI y catalogo"
```

---

## Task 7: Rollback de escrituras parciales en `publish-script.ps1`

**Files:**
- Modify: `tools/publish-script.ps1:97-131`
- Test: `tools/test-partial-publication-rollback.ps1`

**Interfaces:**
- Consumes: `publish-script.ps1 -Path -Id -PublicationMode -RepositoryRoot` de la Task 1.
- Produces: comportamiento de que si falla la escritura de `catalog.json` tras haber escrito `scripts/<id>.user.js`, ambos archivos vuelven a su estado anterior y el error original se propaga.

El alcance es deliberadamente la ventana **antes** del commit. Si falla el `push`, el commit ya existe y es correcto; revertirlo destruiría trabajo recuperable. Eso lo cubre la Task 8.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-partial-publication-rollback.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-script.ps1'
$utf8 = [Text.UTF8Encoding]::new($false)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pokegrid-rollback-' + [Guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
  $catalogPath = Join-Path $testRoot 'catalog.json'
  $catalog = [ordered]@{ schemaVersion = 1; updatedAt = '2026-01-01T00:00:00Z'; scripts = @() }
  $catalogJson = $catalog | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($catalogPath, $catalogJson, $utf8)
  $originalBytes = [IO.File]::ReadAllBytes($catalogPath)

  $script = Join-Path $testRoot 'nuevo.user.js'
  $code = "// ==UserScript==`n// @name Script de Prueba`n// @namespace https://pokegrid.test/rollback`n// @version 1.0.0`n// @description Prueba`n// @match https://poke.idleworld.online/*`n// ==/UserScript==`n"
  [IO.File]::WriteAllText($script, $code, $utf8)

  # catalog.json se marca como solo lectura: Get-Content sigue funcionando, pero
  # la escritura del publicador falla despues de haber copiado el userscript.
  # Un bloqueo FileShare.None no serviria: romperia la lectura de la linea 77,
  # el userscript nunca se escribiria y el test pasaria sin ejercitar el rollback.
  (Get-Item -LiteralPath $catalogPath).IsReadOnly = $true
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $publisher -Path $script -Id 'nuevo' -PublicationMode New -Summary 'Prueba' -Description 'Prueba' -Changelog 'Inicial' -RepositoryRoot $testRoot 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
    (Get-Item -LiteralPath $catalogPath).IsReadOnly = $false
  }

  if ($exitCode -eq 0) { throw 'El publicador deberia haber fallado al escribir un catalog.json de solo lectura.' }

  # La garantia que importa: el .user.js no puede quedar en disco, porque
  # describiria un estado que ningun SHA-256 del catalogo cubre.
  $published = Join-Path $testRoot 'scripts\nuevo.user.js'
  if (Test-Path -LiteralPath $published) {
    throw 'Tras el fallo quedo scripts\nuevo.user.js en disco: el rollback no restauro el estado previo.'
  }
  $parsed = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($parsed.scripts).Count -ne 0) { throw 'El catalogo registro una entrada pese a haber fallado la escritura.' }
  $afterBytes = [IO.File]::ReadAllBytes($catalogPath)
  if ($originalBytes.Length -ne $afterBytes.Length) {
    throw "catalog.json cambio de tamano tras el fallo: $($originalBytes.Length) -> $($afterBytes.Length)."
  }
  for ($i = 0; $i -lt $originalBytes.Length; $i++) {
    if ($originalBytes[$i] -ne $afterBytes[$i]) { throw "catalog.json cambio en el byte $i tras el fallo." }
  }
  $parsed = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($parsed.scripts).Count -ne 0) { throw 'El catalogo registro una entrada pese a haber fallado la escritura.' }

  Write-Output 'Partial publication rollback passed: the userscript and the catalog both returned to their previous state.'
} finally {
  if ((Test-Path -LiteralPath $testRoot) -and $testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-partial-publication-rollback.ps1
```

Expected: FAIL con `Tras el fallo quedo scripts\nuevo.user.js en disco: el rollback no restauro el estado previo.`

- [ ] **Step 3: Envolver las escrituras**

En `tools/publish-script.ps1`, reemplazar el bloque que va desde `$targetName = "$Id.user.js"` (línea 97) hasta el `WriteAllText` del catálogo (línea 131) por:

```powershell
$targetName = "$Id.user.js"
$targetDir = Join-Path $repoRoot 'scripts'
$target = Join-Path $targetDir $targetName

# Estado previo: si la escritura del catalogo falla tras copiar el userscript,
# el repositorio queda con un archivo que ningun SHA-256 del catalogo describe.
$catalogExisted = Test-Path -LiteralPath $catalogPath -PathType Leaf
$catalogBytes = if ($catalogExisted) { [IO.File]::ReadAllBytes($catalogPath) } else { $null }
$targetExisted = Test-Path -LiteralPath $target -PathType Leaf
$targetBytes = if ($targetExisted) { [IO.File]::ReadAllBytes($target) } else { $null }

try {
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  $publishedCode = [regex]::Replace($code, '(?im)^(\s*//\s*@version\s+).+?\s*$', "`${1}$version", 1)
  $publishedCode = $publishedCode -replace "\r\n?", "`n"
  [IO.File]::WriteAllText($target, $publishedCode, [Text.UTF8Encoding]::new($false))
  $sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  $publishedAt = if ($operationMode -eq 'Update' -and $existingById.publishedAt) { [string]$existingById.publishedAt } else { [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }
  $entry = [ordered]@{
    id = $Id
    name = $name
    namespace = $namespace
    version = $version
    author = $(if ($Author) { $Author } elseif ($metadataAuthor) { $metadataAuthor } else { 'DiegoT34' })
    summary = $(if ($Summary) { $Summary } elseif ($metadataDescription) { $metadataDescription } else { $name })
    description = $(if ($Description) { $Description } elseif ($metadataDescription) { $metadataDescription } else { $name })
    category = $Category
    tags = @($Tags)
    games = @($games)
    permissions = @($Permissions)
    minLauncherVersion = $MinLauncherVersion
    downloadUrl = "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts/$targetName"
    sha256 = $sha256
    homepage = 'https://github.com/DiegoT34/PokeGrid-Script-Shop'
    changelog = $(if ($Changelog) { $Changelog } else { "Publicación $version" })
    icon = $Icon
    featured = [bool]$Featured
    publishedAt = $publishedAt
  }
  $remaining = @($catalog.scripts | Where-Object { $_.id -ne $Id })
  $catalog.scripts = @([pscustomobject]$entry) + $remaining
  $catalog.updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $catalogJson = $catalog | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($catalogPath, $catalogJson, [Text.UTF8Encoding]::new($false))
} catch {
  # El userscript es la garantia critica: describiria un estado que ningun
  # SHA-256 del catalogo cubre. El catalogo suele estar intacto, porque su
  # escritura es la que fallo, pero se intenta restaurar sin dejar que un
  # segundo fallo tape el error original.
  try {
    if ($targetExisted) { [IO.File]::WriteAllText($target, $targetBytes) }
    elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  } catch {
    Write-Host "AVISO  No se pudo deshacer scripts\$Id.user.js: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  try {
    if ($catalogExisted) { [IO.File]::WriteAllText($catalogPath, $catalogBytes) }
  } catch {
    Write-Host "AVISO  No se pudo restaurar catalog.json: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  throw
}
```

La línea `$remaining` y las variables `$existingById`, `$operationMode` y `$games` ya existen en el archivo por encima; el bloque las reutiliza sin cambios de comportamiento.

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-partial-publication-rollback.ps1
```

Expected: `Partial publication rollback passed: the userscript and the catalog both returned to their previous state.`

- [ ] **Step 5: Ejecutar el test de alta nueva para confirmar que no se rompió nada**

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-new-script-publication.ps1
```

Expected: `New-script pipeline passed: add, collision protection, update identity and catalog preservation.`

- [ ] **Step 6: Commit**

```powershell
git add -- tools/publish-script.ps1 tools/test-partial-publication-rollback.ps1
git commit -m "Restaurar catalogo y userscript si la publicacion falla a medias"
```

---

## Task 8: Aviso cuando el commit existe pero el push falla

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1:708`
- Test: bloque `-SmokeTest` de `PokeGrid-Shop-Publisher.ps1`

**Interfaces:**
- Consumes: GUI promovida en la Task 1.
- Produces: función `Get-PushFailureMessage([string]$Name, [string]$Version, [string]$ErrorText)` que devuelve un texto mencionando que el commit local existe, que el catálogo online no cambió y el comando a ejecutar.

- [ ] **Step 1: Escribir el test que falla**

Añadir dentro del bloque `if($SmokeTest){`, justo antes de la línea `Write-Output` final:

```powershell
  $pushMessage = Get-PushFailureMessage 'Script de Ejemplo' '1.2.3' 'fatal: Authentication failed'
  foreach ($required in @('1.2.3','git push','autentic')) {
    if ($pushMessage -notmatch [regex]::Escape($required)) { throw "El aviso de push fallido no menciona '$required'." }
  }
```

- [ ] **Step 2: Ejecutar el smoke test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: FAIL con `El aviso de push fallido no menciona '1.2.3'.`

- [ ] **Step 3: Implementar la función**

Añadir junto a las demás funciones del guion, por ejemplo después de `Verify-OnlinePublication`:

```powershell
function Get-PushFailureMessage([string]$Name, [string]$Version, [string]$ErrorText) {
  return @(
    "El commit de $Name v$Version se creo correctamente en el repositorio local, pero no se pudo subir a GitHub.",
    '',
    'El catalogo online NO ha cambiado: los usuarios siguen viendo la version anterior.',
    'El trabajo no se ha perdido. Para completar la publicacion, ejecuta en esa carpeta:',
    '',
    '    git push',
    '',
    'Detalle del error:',
    $ErrorText
  ) -join "`r`n"
}
```

Y envolver el `push` de la línea 708. El `commit` y el `push` están en la misma línea; se separan así:

```powershell
    $message="Publicar $($script:loaded.Name) $($script:loaded.Version)";Log 'Creando commit local.'
    [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('commit','-m',$message,'--','catalog.json',$target))
    Log 'Subiendo la publicacion a GitHub.'
    try {
      [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('push'))
    } catch {
      $detail = $_.Exception.Message
      Log 'El commit es local; la publicacion online no se actualizo.' 'error'
      [Windows.Forms.MessageBox]::Show((Get-PushFailureMessage $script:loaded.Name $script:loaded.Version $detail),'Publicacion pendiente de subir','OK','Warning')|Out-Null
      return
    }
```

El `return` sale del manejador del botón; el `finally` sigue restaurando el estado de los controles.

- [ ] **Step 4: Ejecutar el smoke test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: `PokeGrid Publisher 1.3.1 catalog management, 10 MB userscripts, removal controls, publication tabs, responsive GUI and Git smoke passed.`

- [ ] **Step 5: Commit**

```powershell
git add -- PokeGrid-Shop-Publisher.ps1
git commit -m "Explicar que el commit es local cuando falla el push, en lugar de un error generico"
```

---

## Task 9: Aviso de peso antes de publicar

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1` (texto inicial de `$sourceHint`, líneas 264 y 269, y el bloque `-SmokeTest`)
- Test: bloque `-SmokeTest` de `PokeGrid-Shop-Publisher.ps1`

**Interfaces:**
- Consumes: GUI promovida en la Task 1, `$script:loaded.Size` y `$script:MaxScriptBytes` existentes.
- Produces: función `Get-SourceSizeText([int64]$SizeBytes)` que devuelve el texto de peso y resalta en ámbar por encima del 50 % del límite.

- [ ] **Step 1: Escribir el test que falla**

Añadir dentro del bloque `if($SmokeTest){`, antes del `Write-Output` final:

```powershell
  $smallText = Get-SourceSizeText 100KB
  if ($smallText -notmatch '10 MB') { throw "El texto de peso no indica el limite de 10 MB: $smallText" }
  if ($smallText -match '%') { throw "Un archivo pequeno no deberia mostrar un porcentaje: $smallText" }
  $largeText = Get-SourceSizeText (6MB)
  if ($largeText -notmatch '60') { throw "Un archivo de 6 MB deberia mostrar 60% del limite, no: $largeText" }
  if ($sourceHint.ForeColor -ne $palette.Warning) { throw 'El aviso de peso deberia resaltarse en ambar por encima del 50% del limite.' }
```

- [ ] **Step 2: Ejecutar el smoke test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: FAIL con `El texto de peso no indica el limite de 10 MB.`

- [ ] **Step 3: Implementar la función y usarla**

Añadir la función:

```powershell
function Get-SourceSizeText([int64]$SizeBytes) {
  $limitMB = $script:MaxScriptBytes / 1MB
  $mb = [Math]::Round($SizeBytes / 1MB, 2)
  $ratio = $SizeBytes / $script:MaxScriptBytes
  if ($ratio -gt 0.5) {
    $sourceHint.ForeColor = $palette.Warning
    return "$mb MB - $("{0:N0}" -f ($ratio * 100))% del limite de $limitMB MB"
  }
  $sourceHint.ForeColor = $palette.Dim
  return "$mb MB de un maximo de $limitMB MB"
}
```

Solo se sustituye la porción del peso dentro de los dos textos existentes; el resto
de la redaccion se conserva intacta. En `Load-SelectedScript`, linea 264, se cambia
unicamente `$(...)`:

```powershell
      $sourceHint.Text="Actualización detectada • versión publicada $($entry.version) • $(Get-SourceSizeText $script:loaded.Size)"
```

y linea 269:

```powershell
      $sourceHint.Text="Script nuevo • $(Get-SourceSizeText $script:loaded.Size) • metadatos correctos"
```

Y el texto inicial, línea 487, ya cambiado en la Task 6 a `'Arrastra un archivo aquí o utiliza Examinar. Tamaño máximo: 10 MB.'`

- [ ] **Step 4: Ejecutar el smoke test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: `PokeGrid Publisher 1.3.1 ... smoke passed.`

- [ ] **Step 5: Commit**

```powershell
git add -- PokeGrid-Shop-Publisher.ps1
git commit -m "Mostrar el peso del userscript y avisar al acercarse al limite de 10 MB"
```

---

## Task 10: `.gitattributes`

**Files:**
- Modify: `.gitattributes`
- Test: `tools/test-gitattributes.ps1`

**Interfaces:**
- Consumes: nada más que la raíz del repositorio.
- Produces: LF determinista en todo el repositorio y la regla `scripts/*.user.js text eol=lf` preservada.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-gitattributes.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$lines = @(Get-Content -LiteralPath (Join-Path $root '.gitattributes') -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })

if ($lines -notcontains '* text=auto eol=lf') {
  throw 'Falta "* text=auto eol=lf": con core.autocrlf=true los finales de linea dependen de cada maquina.'
}
# Review Focus 5: sin esta regla, Git escribe los .user.js con CRLF, sus SHA-256
# dejan de coincidir y los 6 scripts publicados quedan invalidados a la vez.
if ($lines -notcontains 'scripts/*.user.js text eol=lf') {
  throw 'Falta "scripts/*.user.js text eol=lf": sin ella los SHA-256 del catalogo se invalidan en bloque.'
}
Write-Output 'Git attributes passed: universal LF and the userscript rule that protects every SHA-256.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-gitattributes.ps1
```

Expected: FAIL con `Falta "* text=auto eol=lf"`.

- [ ] **Step 3: Ampliar `.gitattributes`**

```
* text=auto eol=lf
scripts/*.user.js text eol=lf
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-gitattributes.ps1
```

Expected: `Git attributes passed: universal LF and the userscript rule that protects every SHA-256.`

- [ ] **Step 5: Confirmar que los `.user.js` siguen con LF**

```powershell
Get-ChildItem scripts\*.user.js | ForEach-Object {
  $raw = [IO.File]::ReadAllBytes($_.FullName)
  $crlf = 0
  for ($i = 1; $i -lt $raw.Length; $i++) { if ($raw[$i] -eq 10 -and $raw[$i-1] -eq 13) { $crlf++ } }
  "{0,-40} CRLF={1}" -f $_.Name, $crlf
}
```

Expected: `CRLF=0` en los seis.

- [ ] **Step 6: Commit**

```powershell
git add -- .gitattributes tools/test-gitattributes.ps1
git commit -m "Fijar finales de linea LF en todo el repositorio"
```

---

## Task 11: Verificación final

**Files:**
- No se crean ni se modifican archivos.

**Interfaces:**
- Consumes: todo lo producido por las Tasks 1 a 10.
- Produces: un commit final que registra la verificación, o una corrección si algo falla.

- [ ] **Step 1: Ejecutar la suite completa**

```powershell
$ErrorActionPreference = 'Continue'
$tests = @(
  'test-validate-catalog.ps1','test-workflow-wiring.ps1','test-catalog-schema.ps1',
  'test-powershell-encoding.ps1','test-min-launcher-default.ps1',
  'test-partial-publication-rollback.ps1','test-gitattributes.ps1',
  'test-git-workflow.ps1','test-new-script-publication.ps1',
  'test-script-removal.ps1','test-script-size-limit.ps1','test-launcher-publication.ps1'
)
$failed = @()
foreach ($t in $tests) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "tools\$t" | Out-Null
  if ($LASTEXITCODE -ne 0) { $failed += $t; "  FALLA  $t" } else { "  OK     $t" }
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest | Out-Null
if ($LASTEXITCODE -ne 0) { $failed += 'smoke-test' ; "  FALLA  smoke-test" } else { "  OK     smoke-test" }
if ($failed.Count) { throw "Fallaron: $($failed -join ', ')" }
```

Expected: 12 líneas `OK` más `OK smoke-test`, sin `FALLA`.

- [ ] **Step 2: Confirmar que el catálogo y los scripts quedaron intactos**

```powershell
git diff main~1 --stat -- catalog.json scripts/
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\validate-catalog.ps1 -RepositoryRoot .
```

Expected: el primer comando no muestra `catalog.json` ni ningún `.user.js`; el segundo dice `Catalogo valido: 6 script(s)`.

- [ ] **Step 3: Confirmar que no hay cambios sin commitear**

```powershell
git status --short
```

Expected: salida vacía.

- [ ] **Step 4: Revisar el commit completo antes de entregar**

```powershell
git log --oneline main~10..HEAD
git diff main~10..HEAD --stat
```

Expected: un commit por tarea, ninguno toca `catalog.json` ni los `.user.js`.

- [ ] **Step 5: No hacer push**

```powershell
git status -sb
```

Expected: la rama está por delante del remoto. **No** ejecutar `git push`. El usuario revisa y decide.

- [ ] **Step 6 (opcional): aplastar en un único commit**

La especificación §13 propone un solo commit. Este plan hace uno por tarea, porque
cada entrega se verifica por separado y un commit es reversible. Si prefieres la
historia limpia de la spec, aplasta al revisar:

```powershell
git reset --soft main~11
git commit -m "Promover PokeGrid Publisher 1.3.1 a la version canonica" -m "Sustituye la 1.1 de la raiz, que no puede publicar por una recursion
infinita en su funcion Git(), por la 1.3.1 que si funciona. La 1.1 nunca
recibio las correcciones que su propio README atribuye a 1.1.1 y 1.1.2.

- Adopta el limite de 10 MB del publicador en el workflow, que seguia en 1 MB
- Extrae la validacion a tools/validate-catalog.ps1 y la hace testeable
- Convierte catalog.schema.json en la fuente de verdad de las reglas
- Anade un job que ejecuta las cinco pruebas del publicador
- Unifica minLauncherVersion en 0.22.1 entre GUI, CLI y catalogo
- Restaura catalogo y userscript si la publicacion falla a medias
- Anade el BOM que PowerShell 5.1 necesita a tres archivos con acentos
- Fija finales de linea LF en .gitattributes

El catalogo y los seis userscripts no se modifican."
```

Expected: un commit. `git log --oneline -1` muestra `Promover PokeGrid Publisher 1.3.1 a la version canonica`. **No** hacer push.
