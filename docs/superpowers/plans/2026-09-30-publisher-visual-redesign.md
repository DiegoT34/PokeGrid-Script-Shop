# Rediseño visual del PokeGrid Publisher — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar por completo el aspecto del publicador —cristal, 4 temas, jerarquía tipográfica, botones, paneles, iconos vectoriales y animaciones— sin alterar la lógica de publicación.

**Architecture:** El aspecto se mueve a datos. `tools/theme.ps1` contiene los 4 temas como tablas puras más las funciones matemáticas puras (blend, contraste WCAG, interpolación, easing). `tools/ui.ps1` contiene los helpers visuales de WinForms y GDI+ (regiones redondeadas, sombras, iconos vectoriales, registro de tema). El guion existente sigue siendo el dueño de la lógica y pide tokens en vez de colores.

**Tech Stack:** Windows PowerShell 5.1, WinForms, GDI+ (`System.Drawing`), P/Invoke a `dwmapi.dll`, sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-09-30-publisher-visual-redesign-design.md`

## Global Constraints

- **La lógica no cambia.** Nombres de función, parámetros, mensajes, flujos y códigos de salida intactos. El smoke test existente debe seguir verde sin haberlo modificado.
- **Windows 10 build 19045.** No hay Mica ni Acrylic; solo `DwmEnableBlurBehindWindow`. No se puede usar `DWMWA_SYSTEMBACKDROP_TYPE`.
- **WinForms no tiene alfa por píxel.** Los paneles de cristal son colores opacos pre-mezclados, no translúcidos reales.
- **Sin dependencias nuevas.** Solo `Add-Type` con C# embebido. Nada de NuGet, fuentes descargadas ni paquetes externos.
- **Fuentes disponibles:** Bahnschrift (10 variantes), Segoe UI (Light/Semilight/Semibold/Black), Cascadia Mono. Inter, Poppins, Aptos y Segoe UI Variable **no están instaladas** y no se pueden usar.
- **El cuarto tema se llama `PLANE`**, en mayúsculas, sin traducir. Su clave interna sigue siendo `flat`.
- **Contraste mínimo 4.5:1** en los pares texto/fondo de los 4 temas, medido con la fórmula WCAG real, no estimado.
- **Animaciones por `System.Windows.Forms.Timer`**, nunca `Thread.Sleep`. Un único `Timer` de 16 ms adelanta todas las activas.
- **Encoding:** todo `.ps1` con caracteres no ASCII lleva BOM UTF-8. `tools/test-powershell-encoding.ps1` lo verifica y corre en CI.
- **Convención de tests:** `tools/test-*.ps1`, `try/finally`, limpieza en `finally`, `throw` en el fallo, código 0 en éxito.

## Estado medido del guion actual

Recuento real, no estimado. Define el tamaño de cada tarea:

| Métrica | Valor | Tarea que lo elimina |
|---|---|---|
| Colores hardcodeados `Color '#...'` | 30 (15 en `$palette`, 15 sueltos) | T3 |
| Usos de `$palette.X` | 78 | T3 |
| Tamaños de fuente arbitrarios | 16 distintos (7, 7.2, 7.3, 7.5, 7.6, 7.7, 7.8, 8, 8.5, 9, 9.5, 11, 12.5, 15, 19, 23, 28) | T6 |
| Emojis como iconos | 11 instancias de 3 glifos | T7 |
| Constructores a rediseñar | 9 | T4, T5 |
| Funciones totales | 27, de las cuales 9 son de construcción visual | T3-T8 |

## Review Focus

Cinco clases de entrada o fallo que la especificación implica pero que ningún test cubre. Cada una tiene su test en la tarea indicada.

1. **Un equipo sin soporte de blur** — VM, sesión RDP, GPU deshabilitada. La app debe seguir siendo usable y decirlo, no verse rota. → T9, `test-blur-degradation.ps1`.
2. **El usuario tiene el tema claro activo y el escritorio es blanco.** Un panel claro translúcido sobre fondo blanco se vuelve ilegible. → T10, `test-theme-contrast.ps1`, midiendo los 4 temas con la fórmula WCAG.
3. **El usuario cambia de tema 20 veces seguidas.** Un cambio en caliente mal implementado deja controles a medias, con el color de un tema que ya no está activo. → T11, `test-theme-hot-swap.ps1`.
4. **El tema guardado en disco está corrupto** — se editó a mano, o quedó de una versión anterior con otra estructura. La app no debe arrancar en negro. → T2, `test-theme-persistence.ps1`.
5. **La máquina es lenta y las animaciones se encadenan** — un hover seguido de un clic seguido de un cambio de pestaña crea 3 animaciones sobre el mismo control. Sin un único reloj, se pelean y el control queda en un estado intermedio. → T8, `test-animation-clock.ps1`.

---

## Estructura de archivos

| Archivo | Acción | Responsabilidad única |
|---|---|---|
| `tools/theme.ps1` | Crear | 4 temas como datos + matemáticas puras de color |
| `tools/ui.ps1` | Crear | Helpers WinForms/GDI+: esquinas, sombras, iconos, reloj de animación, registro de tema |
| `PokeGrid-Shop-Publisher.ps1` | Modificar | La lógica, intacta; pide tokens en vez de colores |
| `tools/test-theme-*.ps1` | Crear (4) | Contrato de los datos de tema |
| `tools/test-icon-*.ps1` | Crear (1) | Los 7 iconos vectoriales |
| `tools/test-blur-degradation.ps1` | Crear (1) | El blur cae sin romper |
| `tools/test-animation-clock.ps1` | Crear (1) | Un solo reloj, sin Timers compitiendo |
| `tools/test-theme-hot-swap.ps1` | Crear (1) | Cambio en caliente sin controles a medias |

`catalog.json`, `scripts/`, `tools/publish-*.ps1`, `tools/remove-script.ps1`,
`tools/git-helper.ps1`, `tools/validate-catalog.ps1` y el workflow **no se tocan**.

---

## Task 1: `tools/theme.ps1` — matemáticas puras de color

**Files:**
- Create: `tools/theme.ps1`
- Test: `tools/test-theme-math.ps1`

**Interfaces:**
- Consumes: nada. Primera tarea.
- Produce, en el ámbito global al hacer dot-source:
  - `Get-ThemeColor([string]$Path, [string]$Fallback = '', $Theme = $null)` → `[Drawing.Color]`.
    Resuelve `'Text.Primary'` o `'Rest.Primary.Hover'` sobre `$script:theme`, o sobre `$Theme`
    si se pasa uno. Devuelve `$Fallback` si la ruta existe, y lanza si no existe y no hay reserva.
  - `Blend-Color([Drawing.Color]$Base, [Drawing.Color]$Over, [double]$Amount)` → `[Drawing.Color]`. `$Amount` 0.0-1.0. Es el que produce el cristal: `Blend-Color $base $surface 0.14`.
  - `Get-RelativeLuminance([Drawing.Color]$Color)` → `[double]` en 0..1. Fórmula WCAG 2.1.
  - `Get-ContrastRatio([Drawing.Color]$A, [Drawing.Color]$B)` → `[double]`. Luminancia relativa mayor sobre menor, resultado 1.0-21.0.
  - `Lerp-Color([Drawing.Color]$From, [Drawing.Color]$To, [double]$T)` → `[Drawing.Color]`. Interpolación lineal canal a canal, `$T` 0.0-1.0.

T2 añade encima `Get-PokeGridTheme`, `Get-PokeGridThemes` y `Test-PokeGridTheme`.
T8 añade `Get-PokeGridEasing`. T3-T7 consumen solo lo de esta tarea.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-theme-math.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$themeFile = Join-Path $PSScriptRoot 'theme.ps1'
if (-not (Test-Path -LiteralPath $themeFile -PathType Leaf)) {
  throw "No existe $themeFile: las funciones de color se prueban sin interfaz, primero deben existir."
}
. $themeFile

function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function ToHex([Drawing.Color]$c) { '#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B }

# Blend: 0 % mantiene la base, 100 % devuelve la capa.
$base = [Drawing.Color]::FromArgb(11, 18, 32)
$over = [Drawing.Color]::FromArgb(200, 220, 255)
Assert ((ToHex (Blend-Color $base $over 0.0)) -eq '#0B1220') 'Blend-Color con 0 no devolvio la base.'
Assert ((ToHex (Blend-Color $base $over 1.0)) -eq '#C8DCFF') 'Blend-Color con 1 no devolvio la capa.'
$mid = Blend-Color $base $over 0.5
Assert ($mid.R -ge 100 -and $mid.R -le 111) "Blend-Color al 50% no quedo en el punto medio: R=$($mid.R)"

# Blend recorta Amount en vez de fallar: un callers con 1.4 no debe romper la app.
$over1 = Blend-Color $base $over 1.4
Assert ((ToHex $over1) -eq '#C8DCFF') 'Blend-Color no recorto un Amount mayor que 1.'
$under = Blend-Color $base $over -0.3
Assert ((ToHex $under) -eq '#0B1220') 'Blend-Color no recorto un Amount negativo.'

# Luminancia: blanco 1.0, negro 0.0, y monotona.
Assert ([Math]::Abs((Get-RelativeLuminance ([Drawing.Color]::White)) - 1.0) -lt 0.001) 'El blanco deberia dar luminancia 1.0.'
Assert ([Math]::Abs((Get-RelativeLuminance ([Drawing.Color]::Black)) - 0.0) -lt 0.001) 'El negro deberia dar luminancia 0.0.'
$gray80 = [Drawing.Color]::FromArgb(204, 204, 204)
Assert ([Math]::Abs((Get-RelativeLuminance $gray80) - 0.6038) -lt 0.002) 'La luminancia de un gris 80% no coincide con el valor de referencia de WCAG.'

# Contraste: pares conocidos de la especificacion WCAG.
Assert ([Math]::Abs((Get-ContrastRatio ([Drawing.Color]::White ([Drawing.Color]::Black)) - 21.0) -lt 0.01) 'Blanco sobre negro deberia dar 21:1.'
Assert ([Math]::Abs((Get-ContrastRatio ([Drawing.Color]::White $gray80) - 3.95) -lt 0.02) 'Blanco sobre gris 80% deberia dar ~3.95:1, el valor de referencia.'
Assert ((Get-ContrastRatio ([Drawing.Color]::FromArgb(30, 40, 60) ([Drawing.Color]::FromArgb(200, 220, 255))) -gt 1) 'El contraste debe ser simetrico en orden.'
Assert ([Math]::Abs((Get-ContrastRatio $gray80 ([Drawing.Color]::FromArgb(255, 255, 255))) - (Get-ContrastRatio ([Drawing.Color]::FromArgb(255, 255, 255) $gray80)) -lt 0.001) 'El contraste no es simetrico.'

# Lerp: extremos exactos y punto medio.
Assert ((ToHex (Lerp-Color $base $over 0.0)) -eq '#0B1220') 'Lerp-Color con T=0 no devolvio el origen.'
Assert ((ToHex (Lerp-Color $base $over 1.0)) -eq '#C8DCFF') 'Lerp-Color con T=1 no devolvio el destino.'
$lerpMid = Lerp-Color ([Drawing.Color]::Black) ([Drawing.Color]::White) 0.5
Assert ($lerpMid.R -ge 126 -and $lerpMid.R -le 129) "Lerp al 50% entre blanco y negro deberia dar ~128, dio $($lerpMid.R)"

Write-Output 'Theme math passed: blend, relative luminance, WCAG contrast ratio and colour interpolation.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-math.ps1
```

Expected: FAIL con `No existe ...\tools\theme.ps1`.

- [ ] **Step 3: Escribir la implementación mínima**

`tools/theme.ps1`:

```powershell
# Tokens visuales del PokeGrid Publisher.
#
# Este archivo contiene DATOS y MATEMATICA PURA: no dibuja nada y no depende de
# WinForms mas alla del tipo Drawing.Color. Eso lo hace verificable sin abrir la
# interfaz, que es donde se va a comprobar el contraste de los 4 temas.
#
# El guion principal pide tokens por rol ('Text.Primary') y nunca un color fijo,
# de modo que cambiar de tema es sustituir $script:theme y nada mas.

function Get-ThemeColor([string]$Path, [string]$Fallback = '', $Theme = $null) {
  # $Theme explicito permite validar un tema que aun no es el activo: asi
  # Test-PokeGridTheme puede comprobar los 4 sin cambiar el global.
  $cursor = $(if ($Theme) { $Theme } else { $script:theme })
  foreach ($segment in ($Path -split '\.')) {
    if ($null -eq $cursor) { break }
    if ($cursor -is [hashtable]) {
      if (-not $cursor.ContainsKey($segment)) { $cursor = $null; break }
      $cursor = $cursor[$segment]
    } elseif ($cursor.PSObject.Properties[$segment]) {
      $cursor = $cursor.PSObject.Properties[$segment].Value
    } else { $cursor = $null; break }
  }
  if ($null -eq $cursor -or $cursor -is [string]) {
    if ($Fallback) { return [Drawing.ColorTranslator]::FromHtml($Fallback) }
    $owner = $(if ($Theme) { $Theme.Key } else { $script:theme.Key })
    throw "El tema '$owner' no define el token '$Path'."
  }
  return $cursor
}

function Blend-Color([Drawing.Color]$Base, [Drawing.Color]$Over, [double]$Amount) {
  # Amount se recorta en lugar de fallar: un llamador con 1.4 no debe tumbar la app.
  if ($Amount -lt 0) { $Amount = 0.0 }
  if ($Amount -gt 1) { $Amount = 1.0 }
  return [Drawing.Color]::FromArgb(
    [int][Math]::Round($Base.R + (($Over.R - $Base.R) * $Amount)),
    [int][Math]::Round($Base.G + (($Over.G - $Base.G) * $Amount)),
    [int][Math]::Round($Base.B + (($Over.B - $Base.B) * $Amount)))
}

function Get-RelativeLuminance([Drawing.Color]$Color) {
  # WCAG 2.1: los canales se linealizan antes de ponderarlos.
  $channels = @($Color.R, $Color.G, $Color.B)
  $linear = foreach ($value in $channels) {
    $srgb = $value / 255.0
    if ($srgb -le 0.03928) { $srgb / 12.92 } else { [Math]::Pow((($srgb + 0.055) / 1.055), 2.4) }
  }
  return (0.2126 * $linear[0]) + (0.7152 * $linear[1]) + (0.0722 * $linear[2])
}

function Get-ContrastRatio([Drawing.Color]$A, [Drawing.Color]$B) {
  $la = Get-RelativeLuminance $A
  $lb = Get-RelativeLuminance $B
  if ($lb -gt $la) { $tmp = $la; $la = $lb; $lb = $tmp }
  return ($la + 0.05) / ($lb + 0.05)
}

function Lerp-Color([Drawing.Color]$From, [Drawing.Color]$To, [double]$T) {
  if ($T -lt 0) { $T = 0.0 }
  if ($T -gt 1) { $T = 1.0 }
  return [Drawing.Color]::FromArgb(
    [int][Math]::Round($From.R + (($To.R - $From.R) * $T)),
    [int][Math]::Round($From.G + (($To.G - $From.G) * $T)),
    [int][Math]::Round($From.B + (($To.B - $From.B) * $T)))
}
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-math.ps1
```

Expected: `Theme math passed: blend, relative luminance, WCAG contrast ratio and colour interpolation.`

- [ ] **Step 5: Añadir el BOM**

```powershell
$path = 'tools\theme.ps1'
[IO.File]::WriteAllText($path, [IO.File]::ReadAllText($path), [Text.UTF8Encoding]::new($true))
```

- [ ] **Step 6: Commit**

```powershell
git add -- tools/theme.ps1 tools/test-theme-math.ps1
git commit -m "Anadir tools/theme.ps1 con blend, luminancia WCAG y contraste"
```

---

## Task 2: Los 4 temas como datos, con persistencia

**Files:**
- Modify: `tools/theme.ps1`
- Test: `tools/test-theme-data.ps1`, `tools/test-theme-persistence.ps1`

**Interfaces:**
- Consumes: T1 (`Get-ThemeColor`, `Get-ContrastRatio`).
- Produce:
  - `Get-PokeGridThemes()` → `[hashtable]` con las 4 claves. `flat` se muestra como **PLANE**.
  - `Get-PokeGridTheme([string]$Key = '')` → `[hashtable]`. Sin `Key` devuelve el de `$script:theme`. Clave desconocida → `crystal-dark`.
  - `Test-PokeGridTheme($Theme)` → `[string[]]` de tokens ausentes; vacío significa válido.
  - `Get-PokeGridThemePath()` → ruta de `%LOCALAPPDATA%\PokeGrid-Shop-Publisher\theme.txt`.
  - `Save-PokeGridTheme([string]$Key)` y `Read-PokeGridThemeKey()` → `[string]`.

T3 hace dot-source de este archivo desde el guion principal.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-theme-data.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes
Assert ($themes.Count -eq 4) "Se esperaban 4 temas y hay $($themes.Count)."
foreach ($key in @('crystal-dark', 'crystal-light', 'midnight', 'flat')) {
  Assert ($themes.ContainsKey($key)) "Falta el tema '$key'."
}

# PLANE es el nombre visible del cuarto tema; su clave interna sigue siendo flat.
Assert ($themes['flat'].Name -eq 'PLANE') "El tema flat debe mostrarse como PLANE, no como '$($themes['flat'].Name)'."

# Los 4 comparten estructura: un token que falta en uno, esta en todos.
$required = @(
  'Key', 'Name', 'Kind', 'Blur', 'Base', 'Radius', 'Spacing',
  'Text.Primary', 'Text.Secondary', 'Text.Disabled',
  'Surface.Base', 'Surface.Raised', 'Surface.Soft', 'Surface.Hover',
  'Border.Base', 'Border.Strong',
  'Rest.Primary.Base', 'Rest.Primary.Hover', 'Rest.Primary.Fore',
  'Rest.Danger.Base', 'Rest.Danger.Hover', 'Rest.Danger.Fore',
  'Rest.Success.Base', 'Rest.Warning.Base',
  'Shadow.Depth', 'Shadow.Alpha',
  'Motion.Fast', 'Motion.Normal', 'Motion.Slow',
  'Font.Display', 'Font.Body', 'Font.Mono'
)
foreach ($name in $themes.Keys) {
  $missing = Test-PokeGridTheme $themes[$name]
  if ($missing.Count) { throw "El tema '$name' no define: $($missing -join ', ')" }
}

# PLANE no usa cristal y sus animaciones son instantaneas.
Assert ($themes['flat'].Kind -eq 'flat') 'PLANE debe ser un tema plano.'
Assert (-not $themes['flat'].Blur) 'PLANE no debe pedir blur.'
Assert ($themes['flat'].Motion.Fast -eq 0 -and $themes['flat'].Motion.Slow -eq 0) 'PLANE no debe animar.'
foreach ($name in @('crystal-dark', 'crystal-light', 'midnight')) {
  Assert ($themes[$name].Kind -eq 'glass') "$name deberia ser de cristal."
  Assert ($themes[$name].Blur) "$name deberia pedir blur."
  Assert ($themes[$name].Motion.Fast -gt 0) "$name deberia animar."
}

# Ningun color mal formado, y el radio y la rejilla son razonables.
foreach ($name in $themes.Keys) {
  $theme = $themes[$name]
  foreach ($token in @($theme.Base, $theme.Text.Primary, $theme.Text.Secondary, $theme.Surface.Base, $theme.Border.Base)) {
    Assert ([string]$token -match '^#[0-9A-Fa-f]{6}$') "El tema '$name' tiene un color mal formado: '$token'."
  }
  Assert ($theme.Radius -ge 0 -and $theme.Radius -le 16) "El radio de '$name' fuera de rango: $($theme.Radius)."
  Assert ($theme.Spacing -ge 2 -and $theme.Spacing -le 8) "La rejilla de '$name' fuera de rango: $($theme.Spacing)."
}

# El texto principal de cada tema se lee sobre su propia superficie.
foreach ($name in $themes.Keys) {
  $script:theme = $themes[$name]
  $ratio = Get-ContrastRatio (Get-ThemeColor 'Text.Primary') (Get-ThemeColor 'Surface.Base')
  if ($ratio -lt 4.5) {
    throw "El tema '$name' tiene texto principal sobre superficie en $('{0:N2}' -f $ratio):1, por debajo de 4.5:1."
  }
}

# Un token inexistente da error claro, no un color negro silencioso.
$script:theme = $themes['crystal-dark']
$missingFailed = $false
try { [void](Get-ThemeColor 'No.Existe') } catch { $missingFailed = $true }
Assert $missingFailed 'Get-ThemeColor debio fallar con un token inexistente en vez de devolver negro.'
$fallback = Get-ThemeColor 'No.Existe' '#123456'
Assert ($fallback.R -eq 0x12 -and $fallback.G -eq 0x34) 'Get-ThemeColor no respeto el color de reserva.'

Write-Output 'Theme data passed: four themes, PLANE naming, full token coverage, valid colours and readable text.'
```

`tools/test-theme-persistence.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$path = Get-PokeGridThemePath
Assert ($path -like '*PokeGrid-Shop-Publisher*') "La ruta del tema no apunta a la carpeta del Publisher: $path"
$existed = Test-Path -LiteralPath $path
$backup = if ($existed) { [IO.File]::ReadAllBytes($path) } else { $null }
try {
  if ($existed) { Remove-Item -LiteralPath $path -Force }

  # Review Focus 4: sin archivo, clave por defecto.
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Sin archivo deberia usarse crystal-dark.'

  Save-PokeGridTheme 'midnight'
  Assert ((Read-PokeGridThemeKey) -eq 'midnight') 'La clave guardada no se leyo de vuelta.'

  # Un archivo corrupto no debe romper el arranque.
  [IO.File]::WriteAllText($path, "clave-que-no-existe`r`n")
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Una clave desconocida debio caer al tema por defecto.'

  [IO.File]::WriteAllText($path, '')
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Un archivo vacio debio caer al tema por defecto.'

  # Basura binaria tampoco.
  [IO.File]::WriteAllText($path, [char]0xFF + [char]0xFE + 'basura')
  Assert ((Read-PokeGridThemeKey) -eq 'crystal-dark') 'Un archivo binario debio caer al tema por defecto.'

  Write-Output 'Theme persistence passed: default, round-trip and three corrupt-file recoveries.'
} finally {
  if ($existed) { [IO.File]::WriteAllBytes($path, $backup) }
  elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-data.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-persistence.ps1
```

Expected: ambos FAIL. El primero con `Se esperaban 4 temas y hay 0` o con un error de
`Get-PokeGridThemes` inexistente; el segundo con `La ruta del tema no apunta...`.

- [ ] **Step 3: Añadir los 4 temas y la persistencia**

Añadir al final de `tools/theme.ps1`:

```powershell
$script:PokeGridThemeSettings = [ordered]@{
  'crystal-dark' = [ordered]@{
    Key = 'crystal-dark'; Name = 'Cristal oscuro'; Kind = 'glass'; Blur = $true
    Base = '#0B1220'; Radius = 10; Spacing = 4
    Text = [ordered]@{ Primary = '#F1F5FB'; Secondary = '#9FB0C7'; Disabled = '#5B6B80' }
    Surface = [ordered]@{ Base = '#131C2B'; Raised = '#1A2536'; Soft = '#0F1826'; Hover = '#22314A' }
    Border = [ordered]@{ Base = '#24344A'; Strong = '#38506E' }
    Rest = [ordered]@{
      Primary = [ordered]@{ Base = '#1E88B8'; Hover = '#25A0D6'; Fore = '#04121C' }
      Danger  = [ordered]@{ Base = '#B04A3F'; Hover = '#C85A4C'; Fore = '#FFF4F2' }
      Success = [ordered]@{ Base = '#2E9E77'; Hover = '#37B98C'; Fore = '#03150E' }
      Warning = [ordered]@{ Base = '#B58A2E'; Hover = '#CBA03C'; Fore = '#1A1204' }
    }
    Shadow = [ordered]@{ Depth = 18; Alpha = 52; Y = 4 }
    Motion = [ordered]@{ Fast = 120; Normal = 180; Slow = 240; Easing = 'easeOutCubic' }
    Font = [ordered]@{ Display = 'Bahnschrift'; Body = 'Segoe UI'; Mono = 'Cascadia Mono' }
  }
  'crystal-light' = [ordered]@{
    Key = 'crystal-light'; Name = 'Cristal claro'; Kind = 'glass'; Blur = $true
    Base = '#DFE7F0'; Radius = 10; Spacing = 4
    Text = [ordered]@{ Primary = '#101A26'; Secondary = '#46586E'; Disabled = '#8797AB' }
    Surface = [ordered]@{ Base = '#F4F8FC'; Raised = '#FFFFFF'; Soft = '#E9F0F7'; Hover = '#DCE6F0' }
    Border = [ordered]@{ Base = '#C2CFDE'; Strong = '#9DB0C4' }
    Rest = [ordered]@{
      Primary = [ordered]@{ Base = '#166FA5'; Hover = '#1B84C1'; Fore = '#FFFFFF' }
      Danger  = [ordered]@{ Base = '#B03A2E'; Hover = '#C9483A'; Fore = '#FFFFFF' }
      Success = [ordered]@{ Base = '#1F7A5A'; Hover = '#27916B'; Fore = '#FFFFFF' }
      Warning = [ordered]@{ Base = '#8F6A18'; Hover = '#A87E1E'; Fore = '#FFFFFF' }
    }
    Shadow = [ordered]@{ Depth = 16; Alpha = 40; Y = 3 }
    Motion = [ordered]@{ Fast = 120; Normal = 180; Slow = 240; Easing = 'easeOutCubic' }
    Font = [ordered]@{ Display = 'Bahnschrift'; Body = 'Segoe UI'; Mono = 'Cascadia Mono' }
  }
  'midnight' = [ordered]@{
    Key = 'midnight'; Name = 'Nocturno'; Kind = 'glass'; Blur = $true
    Base = '#050B18'; Radius = 12; Spacing = 4
    Text = [ordered]@{ Primary = '#E6F1FF'; Secondary = '#8CA6CC'; Disabled = '#5E7392' }
    Surface = [ordered]@{ Base = '#0C1729'; Raised = '#122238'; Soft = '#081222'; Hover = '#1A2F4A' }
    Border = [ordered]@{ Base = '#1D3A5C'; Strong = '#2F5178' }
    Rest = [ordered]@{
      Primary = [ordered]@{ Base = '#00A8C8'; Hover = '#22C4E4'; Fore = '#001318' }
      Danger  = [ordered]@{ Base = '#C0453A'; Hover = '#DA5A4C'; Fore = '#FFF2F0' }
      Success = [ordered]@{ Base = '#22A97C'; Hover = '#2FC48F'; Fore = '#01140E' }
      Warning = [ordered]@{ Base = '#C79A32'; Hover = '#DEB143'; Fore = '#1A1204' }
    }
    Shadow = [ordered]@{ Depth = 22; Alpha = 60; Y = 5 }
    Motion = [ordered]@{ Fast = 120; Normal = 180; Slow = 260; Easing = 'easeOutCubic' }
    Font = [ordered]@{ Display = 'Bahnschrift'; Body = 'Segoe UI'; Mono = 'Cascadia Mono' }
  }
  'flat' = [ordered]@{
    Key = 'flat'; Name = 'PLANE'; Kind = 'flat'; Blur = $false
    Base = '#1B1F24'; Radius = 0; Spacing = 4
    Text = [ordered]@{ Primary = '#FFFFFF'; Secondary = '#C2CAD3'; Disabled = '#8A939E' }
    Surface = [ordered]@{ Base = '#242A31'; Raised = '#2E353D'; Soft = '#1F242A'; Hover = '#39414A' }
    Border = [ordered]@{ Base = '#4A545F'; Strong = '#6B7883' }
    Rest = [ordered]@{
      Primary = [ordered]@{ Base = '#2B6CB0'; Hover = '#3B82C4'; Fore = '#FFFFFF' }
      Danger  = [ordered]@{ Base = '#9B2C2C'; Hover = '#C0392B'; Fore = '#FFFFFF' }
      Success = [ordered]@{ Base = '#1E8449'; Hover = '#27AE60'; Fore = '#FFFFFF' }
      Warning = [ordered]@{ Base = '#9A7B0F'; Hover = '#B8961A'; Fore = '#FFFFFF' }
    }
    Shadow = [ordered]@{ Depth = 0; Alpha = 0; Y = 0 }
    Motion = [ordered]@{ Fast = 0; Normal = 0; Slow = 0; Easing = 'linear' }
    Font = [ordered]@{ Display = 'Bahnschrift'; Body = 'Segoe UI'; Mono = 'Cascadia Mono' }
  }
}

function Get-PokeGridThemes() {
  return $script:PokeGridThemeSettings
}

function Get-PokeGridTheme([string]$Key = '') {
  $themes = $script:PokeGridThemeSettings
  if (-not $Key) {
    if ($script:theme -and $themes.Contains($script:theme.Key)) { return $script:theme }
    return $themes['crystal-dark']
  }
  if ($themes.Contains($Key)) { return $themes[$Key] }
  return $themes['crystal-dark']
}

function Test-PokeGridTheme($Theme) {
  $missing = [Collections.Generic.List[string]]::new()
  $required = @(
    'Key', 'Name', 'Kind', 'Blur', 'Base', 'Radius', 'Spacing',
    'Text.Primary', 'Text.Secondary', 'Text.Disabled',
    'Surface.Base', 'Surface.Raised', 'Surface.Soft', 'Surface.Hover',
    'Border.Base', 'Border.Strong',
    'Rest.Primary.Base', 'Rest.Primary.Hover', 'Rest.Primary.Fore',
    'Rest.Danger.Base', 'Rest.Danger.Hover', 'Rest.Danger.Fore',
    'Rest.Success.Base', 'Rest.Warning.Base',
    'Shadow.Depth', 'Shadow.Alpha',
    'Motion.Fast', 'Motion.Normal', 'Motion.Slow',
    'Font.Display', 'Font.Body', 'Font.Mono'
  )
  foreach ($token in $required) {
    try { [void](Get-ThemeColor $token -Theme $Theme) } catch { $missing.Add($token) }
  }
  return @($missing)
}

function Get-PokeGridThemePath() {
  return (Join-Path $env:LOCALAPPDATA 'PokeGrid-Shop-Publisher\theme.txt')
}

function Save-PokeGridTheme([string]$Key) {
  $path = Get-PokeGridThemePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
  [IO.File]::WriteAllText($path, $Key, [Text.UTF8Encoding]::new($false))
}

function Read-PokeGridThemeKey() {
  # Review Focus 4: cualquier archivo ilegible cae al tema por defecto. Un tema
  # corrupto no puede impedir que la aplicacion abra.
  $path = Get-PokeGridThemePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return 'crystal-dark' }
  try {
    $key = ([IO.File]::ReadAllText($path) -split "`r?`n")[0].Trim()
    if (-not $key) { return 'crystal-dark' }
    if (-not $script:PokeGridThemeSettings.Contains($key)) { return 'crystal-dark' }
    return $key
  } catch { return 'crystal-dark' }
}
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-math.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-data.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-persistence.ps1
```

Expected: los tres en verde. Si el contraste de algún tema queda por debajo de 4.5:1,
`test-theme-data.ps1` lo dice con el ratio exacto y hay que oscurecer el texto o aclarar la
superficie en ese tema.

- [ ] **Step 5: Añadir el BOM a los tests nuevos y commitear**

```powershell
foreach ($p in @('tools\test-theme-data.ps1','tools\test-theme-persistence.ps1')) {
  [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p), [Text.UTF8Encoding]::new($true))
}
git add -- tools/theme.ps1 tools/test-theme-data.ps1 tools/test-theme-persistence.ps1
git commit -m "Definir los 4 temas del Publisher como datos, con persistencia segura"
```

---

## Task 3: Migrar los 78 usos de `$palette` a tokens

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1` (líneas 52-60 y sus 78 usos)
- Test: `tools/test-no-hardcoded-colors.ps1`

**Interfaces:**
- Consumes: T1 (`Get-ThemeColor`), T2 (`Get-PokeGridTheme`, `Get-PokeGridThemes`).
- Produce: `$palette` deja de existir como tabla de colores y pasa a ser un *proxy* a
  `$script:theme`, de modo que los 78 usos existentes siguen funcionando sin tocarlos:

```powershell
$script:theme = Get-PokeGridTheme (Read-PokeGridThemeKey)
$palette = [pscustomobject]@{
  Background = Get-ThemeColor 'Base'
  Surface    = Get-ThemeColor 'Surface.Base'
  SurfaceRaised = Get-ThemeColor 'Surface.Raised'
  SurfaceSoft= Get-ThemeColor 'Surface.Soft'
  Border     = Get-ThemeColor 'Border.Base'
  BorderFocus = Get-ThemeColor 'Rest.Primary.Hover'
  Text       = Get-ThemeColor 'Text.Primary'
  Muted      = Get-ThemeColor 'Text.Secondary'
  Dim        = Get-ThemeColor 'Text.Disabled'
  Primary    = Get-ThemeColor 'Rest.Primary.Hover'
  PrimaryDark= Get-ThemeColor 'Rest.Primary.Base'
  Accent     = Get-ThemeColor 'Rest.Danger.Hover'
  AccentDark = Get-ThemeColor 'Rest.Danger.Base'
  Success    = Get-ThemeColor 'Rest.Success.Base'
  Warning    = Get-ThemeColor 'Rest.Warning.Base'
  Danger     = Get-ThemeColor 'Rest.Danger.Fore'
}
```

Los 15 colores sueltos que no están en `$palette` se sustituyen por
`Get-ThemeColor` con la ruta correcta:

| Hex actual | Veces | Token |
|---|---|---|
| `#102D40` | 5 | `Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Primary.Base') 0.22` |
| `#06101B` | 3 | `Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.25` |
| `#123329` | 3 | `Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Success.Base') 0.22` |
| `#3B1821` | 3 | `Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Danger.Base') 0.22` |
| `#19314B` | 1 | `Surface.Hover` |
| `#1B91B4` | 1 | `Rest.Primary.Hover` |
| `#C95143` | 1 | `Rest.Danger.Hover` |
| `#12344A` | 1 | `Rest.Primary.Base` mezclado |
| `#F1C75B` | 1 | `Rest.Warning.Base` |
| `#42C8EF` | 1 | `Rest.Primary.Hover` |
| `#081523`, `#091523`, `#07131F`, `#08131F`, `#A8B8CA`, `#07111D`, `#0C1928`, `#112238`, `#0A1624`, `#263D56`, `#F2F6FC`, `#FF715B`, `#A43F34`, `#48D49B`, `#FF7D8F`, `#35C4EB`, `#167B9B`, `#8396AE`, `#5E728B` | 1 c/u | Ya cubiertos por `$palette` o por `Surface.*` |

`Color '#...'` deja de usarse para colores de tema; se conserva la función `Color` para
cálculos puntuales, pero ninguna constante visual la llama.

**Prueba de humo:** el smoke test existente debe seguir verde.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-no-hardcoded-colors.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$gui = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8

# 1. No queda ningun color de tema escrito a mano.
$literals = [regex]::Matches($gui, "Color '#([0-9A-Fa-f]{6})'")
if ($literals.Count) {
  $values = ($literals | ForEach-Object { "#" + $_.Groups[1].Value.ToUpper() } | Sort-Object -Unique) -join ', '
  throw "Quedan $($literals.Count) colores hardcodeados en el guion: $values"
}

# 2. $palette existe pero solo como proxy al tema, no como tabla de hex.
$paletteBlock = [regex]::Match($gui, '(?s)\$palette\s*=\s*\[pscustomobject\]@\{.*?\}').Value
if (-not $paletteBlock) { throw 'No se encontro la tabla $palette: deberia ser un proxy al tema activo.' }
if ($paletteBlock -match "#[0-9A-Fa-f]{6}") { throw '$palette vuelve a contener hex: el aspecto tiene que venir del tema.' }
foreach ($key in @('Background','Surface','SurfaceRaised','SurfaceSoft','Border','Text','Muted','Dim')) {
  if ($paletteBlock -notmatch "\b$key\s*=") { throw "El proxy de \$palette no expone la clave '$key' que ya usaba el guion." }
}

# 3. El guion hace dot-source del tema y elige el tema guardado.
if ($gui -notmatch '^\s*\.\s+\$themePath' -and $gui -notmatch 'theme\.ps1') { throw 'El guion no carga tools/theme.ps1.' }
if ($gui -notmatch 'Read-PokeGridThemeKey') { throw 'El guion no restaura el tema guardado: se perderia en cada arranque.' }

Write-Output 'No hardcoded colours passed: every theme colour comes from a token and the saved theme is restored.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-no-hardcoded-colors.ps1
```

Expected: FAIL con `Quedan 30 colores hardcodeados en el guion: #07111D, #0A1624, ...`

- [ ] **Step 3: Cargar el tema y convertir `$palette` en proxy**

En `PokeGrid-Shop-Publisher.ps1`, reemplazar el bloque de las líneas 52-60:

```powershell
function Color([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }

$themePath = Join-Path $PSScriptRoot 'tools\theme.ps1'
if (-not (Test-Path -LiteralPath $themePath -PathType Leaf)) { throw 'No se encontró tools\theme.ps1.' }
. $themePath
$script:theme = Get-PokeGridTheme (Read-PokeGridThemeKey)

# $palette se mantiene como proxy para no tocar los 78 usos ya escritos.
# Cada clave apunta a un token del tema activo, no a un color fijo.
$palette = [pscustomobject]@{
  Background   = Get-ThemeColor 'Base'
  Surface      = Get-ThemeColor 'Surface.Base'
  SurfaceRaised= Get-ThemeColor 'Surface.Raised'
  SurfaceSoft  = Get-ThemeColor 'Surface.Soft'
  Border       = Get-ThemeColor 'Border.Base'
  BorderFocus  = Get-ThemeColor 'Rest.Primary.Hover'
  Text         = Get-ThemeColor 'Text.Primary'
  Muted        = Get-ThemeColor 'Text.Secondary'
  Dim          = Get-ThemeColor 'Text.Disabled'
  Primary      = Get-ThemeColor 'Rest.Primary.Hover'
  PrimaryDark  = Get-ThemeColor 'Rest.Primary.Base'
  Accent       = Get-ThemeColor 'Rest.Danger.Hover'
  AccentDark   = Get-ThemeColor 'Rest.Danger.Base'
  Success      = Get-ThemeColor 'Rest.Success.Base'
  Warning      = Get-ThemeColor 'Rest.Warning.Base'
  Danger       = Get-ThemeColor 'Rest.Danger.Fore'
}
```

Luego sustituir cada hex suelto por su token, según la tabla del bloque de Interfaces.
Los tres fondos del panel de log y de los chips de estado:

```powershell
$logBox.BackColor = Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.25
$statusChip.BackColor = Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Primary.Base') 0.22
$statusChip.BackColor = Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Success.Base') 0.22
$statusChip.BackColor = Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Danger.Base') 0.22
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-no-hardcoded-colors.ps1
```

Expected: `No hardcoded colours passed: every theme colour comes from a token and the saved theme is restored.`

- [ ] **Step 5: Ejecutar el smoke test para confirmar que la lógica no se rompió**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: `PokeGrid Publisher 1.3.1 ... smoke passed.` sin haber modificado el bloque
`if($SmokeTest){`.

- [ ] **Step 6: Commit**

```powershell
git add -- PokeGrid-Shop-Publisher.ps1 tools/test-no-hardcoded-colors.ps1
git commit -m "Sacar los 30 colores hardcodeados del guion y dejarlos como tokens"
```

---

## Task 4: Botones con esquinas redondeadas y estados definidos

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1:95-114` (`New-Button`)
- Test: `tools/test-button-visual.ps1`

**Interfaces:**
- Consumes: T1 (`Lerp-Color`), T2 (`$script:theme.Motion`, `Radius`), T3 (`$palette`).
- Produce:
  - `New-RoundedRegion([int]$Width, [int]$Height, [int]$Radius)` → `[Drawing.Region]`.
    Devuelve `$null` si el radio es 0, para que PLANE no gaste nada.
  - `Set-ButtonRole($button, [string]$role)` → fija los 5 estados desde el tema:
    `normal`, `hover`, `pressed`, `disabled`, `focus`.
  - `Get-ButtonRoleStyle([string]$role)` → hashtable con
    `Base`, `Hover`, `Pressed`, `Fore`, `Border`. Roles: `primary`, `danger`,
    `ghost`, `secondary`, `success`.

`New-Button` mantiene su firma `New-Button([string]$text, [string]$kind = 'secondary')`
y traduce `kind` a `role`: `accent` → `danger`, el resto se pasa tal cual. Así no se
tocan las 15 llamadas existentes.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-button-visual.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes
foreach ($name in $themes.Keys) {
  $script:theme = $themes[$name]

  # Una region redondeada de verdad, no un rectangulo.
  $region = New-RoundedRegion 200 40 $script:theme.Radius
  if ($script:theme.Radius -gt 0) {
    Assert ($null -ne $region) "El tema '$name' pide radio $($script:theme.Radius) y New-RoundedRegion devolvio null."
    Assert ($region.GetRegionPixel(2, 20) -eq $false) 'La esquina superior izquierda deberia quedar fuera de la region redondeada.'
    Assert ($region.GetRegionPixel(100, 20) -eq $true) 'El centro horizontal deberia estar dentro de la region.'
    Assert ($region.GetRegionPixel(100, 1) -eq $true) 'El borde superior central deberia estar dentro de la region.'
  } else {
    Assert ($null -eq $region) "PLANE tiene radio 0 y no deberia crear region: $name"
  }

  # Los cinco estados existen y son colores validos, distintos del fondo.
  foreach ($role in @('primary', 'danger', 'ghost', 'secondary', 'success')) {
    $style = Get-ButtonRoleStyle $role
    foreach ($key in @('Base', 'Hover', 'Pressed', 'Fore', 'Border')) {
      Assert ($style.ContainsKey($key)) "El rol '$role' del tema '$name' no define '$key'."
      Assert ($style[$key] -is [Drawing.Color]) "El rol '$role' del tema '$name' tiene '$key' que no es un Color."
    }
    $contrast = Get-ContrastRatio $style.Fore $style.Base
    if ($contrast -lt 4.5) {
      throw "En '$name' el rol '$role' tiene su texto sobre su fondo en $('{0:N2}' -f $contrast):1, por debajo de 4.5:1."
    }
    # Hover y pressed tienen que verse distintos del reposo, o el cambio no se percibe.
    Assert ($style.Hover -ne $style.Base) "El rol '$role' de '$name' no diferencia hover de reposo."
    Assert ($style.Pressed -ne $style.Hover) "El rol '$role' de '$name' no diferencia presion de hover."
  }
}

Write-Output 'Button visual passed: rounded regions per theme radius and five distinct accessible states per role.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-button-visual.ps1
```

Expected: FAIL. `New-RoundedRegion` no existe.

- [ ] **Step 3: Implementar y conectar**

Añadir a `PokeGrid-Shop-Publisher.ps1`, antes de `New-Button`:

```powershell
function New-RoundedRegion([int]$Width, [int]$Height, [int]$Radius) {
  if ($Radius -le 0) { return $null }
  $path = [Drawing.Drawing2D.GraphicsPath]::new()
  $d = $Radius * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($Width - $d, 0, $d, $d, 270, 90)
  $path.AddArc($Width - $d, $Height - $d, $d, $d, 0, 90)
  $path.AddArc(0, $Height - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return [Drawing.Region]::new($path)
}

function Get-ButtonRoleStyle([string]$role) {
  $rest = switch ($role) {
    'danger'  { 'Danger' }
    'success' { 'Success' }
    'primary' { 'Primary' }
    default   { $null }
  }
  if ($rest) {
    $base = Get-ThemeColor "Rest.$rest.Base"
    $hover = Get-ThemeColor "Rest.$rest.Hover"
    $fore = Get-ThemeColor "Rest.$rest.Fore"
    $pressed = Blend-Color $base ([Drawing.Color]::Black) 0.18
    $border = $hover
  } else {
    $base = Get-ThemeColor 'Surface.Raised'
    $hover = Get-ThemeColor 'Surface.Hover'
    $fore = Get-ThemeColor 'Text.Primary'
    $pressed = Blend-Color $base ([Drawing.Color]::Black) 0.12
    $border = Get-ThemeColor 'Border.Base'
  }
  return @{
    Base = $base; Hover = $hover; Pressed = $pressed
    Fore = $fore; Border = $border
  }
}

function Set-ButtonRole($button, [string]$role) {
  $style = Get-ButtonRoleStyle $role
  $button.BackColor = $style.Base
  $button.ForeColor = $style.Fore
  $button.FlatAppearance.BorderColor = $style.Border
  $button.FlatAppearance.MouseDownBackColor = $style.Pressed
  $script:buttonStyles[[int]$button.GetHashCode()] = @{ Role = $role; Style = $style }
  $button.Tag = @{ Role = $role }
  return $style
}
```

Y reemplazar `New-Button` por:

```powershell
function New-Button([string]$text, [string]$kind = 'secondary') {
  $button = [Windows.Forms.Button]::new()
  $button.Text = $text
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 1
  $button.Font = [Drawing.Font]::new('Segoe UI Semibold', 9.5, [Drawing.FontStyle]::Bold)
  $button.Cursor = 'Hand'
  $button.Margin = [Windows.Forms.Padding]::new(4)
  $button.UseVisualStyleBackColor = $false
  $role = if ($kind -eq 'accent') { 'danger' } else { $kind }
  Set-ButtonRole $button $role | Out-Null
  $button.Add_MouseEnter(({ if ($this.Enabled) { $s = $script:buttonStyles[[int]$this.GetHashCode()].Style; $this.BackColor = $s.Hover; $this.FlatAppearance.BorderColor = $s.Hover } }.GetNewClosure()))
  $button.Add_MouseLeave(({ $s = $script:buttonStyles[[int]$this.GetHashCode()].Style; $this.BackColor = $s.Base; $this.FlatAppearance.BorderColor = $s.Border; $this.Region = New-RoundedRegion $this.Width $this.Height ([int]$script:theme.Radius) }.GetNewClosure()))
  return $button
}
```

Declarar `$script:buttonStyles = @{}` junto a `$script:theme`.

En `Apply-ResponsiveLayout`, añadir dentro del bucle existente de tarjetas:

```powershell
  foreach ($b in $script:buttonStyles.Keys) { }
```

No hace falta: los estilos se resuelven en el momento de pintar. Lo que sí hace falta es
aplicar la región redondeada una vez que cada botón tiene tamaño, dentro de
`Apply-ResponsiveLayout`:

```powershell
  foreach ($control in $form.Controls) { Apply-RoundedRegions $control }
```

con

```powershell
function Apply-RoundedRegions($control) {
  if ($control -is [Windows.Forms.Button]) {
    $control.Region = New-RoundedRegion $control.Width $control.Height ([int]$script:theme.Radius)
  }
  foreach ($child in $control.Controls) { Apply-RoundedRegions $child }
}
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-button-visual.ps1
```

Expected: `Button visual passed: rounded regions per theme radius and five distinct accessible states per role.`

Si algún rol queda por debajo de 4.5:1, el test dice el ratio exacto: hay que ajustar el
`Fore` de ese rol en ese tema, no relajar el umbral.

- [ ] **Step 5: Smoke test y commit**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
git add -- PokeGrid-Shop-Publisher.ps1 tools/test-button-visual.ps1
git commit -m "Rediseñar los botones con esquinas redondeadas y cinco estados desde el tema"
```

---

## Task 5: Tarjetas y paneles con profundidad

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1:127-132` (`New-Card`), y los paneles de fondo
- Test: `tools/test-surface-visual.ps1`

**Interfaces:**
- Consumes: T1 (`Blend-Color`), T2 (`Radius`, `Shadow.*`, `Surface.*`), T4 (`New-RoundedRegion`).
- Produce:
  - `Get-GlassColor([string]$token, [double]$opacity = 0.14)` → `[Drawing.Color]`.
    El cristal: el color del token mezclado contra el fondo con el alfa pedido.
  - `New-CardShadow([int]$width, [int]$height)` → `Panel` en `Surface.Soft` desplazado
    `Shadow.Y`, que se dibuja detrás de la tarjeta. Devuelve `$null` cuando
    `Shadow.Depth` es 0, para que PLANE no gaste nada.
  - `New-Card([int]$height)` mantiene su firma y devuelve la tarjeta con borde claro,
    fondo de cristal y región redondeada.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-surface-visual.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes
foreach ($name in $themes.Keys) {
  $script:theme = $themes[$name]

  # El cristal es una mezcla: se parece mas al fondo que a la superficie pura.
  $glass = Get-GlassColor 'Surface.Raised' 0.14
  $base = Get-ThemeColor 'Base'
  $surface = Get-ThemeColor 'Surface.Raised'
  $distanceToBase = [Math]::Abs($glass.R - $base.R) + [Math]::Abs($glass.G - $base.G) + [Math]::Abs($glass.B - $base.B)
  $distanceToSurface = [Math]::Abs($glass.R - $surface.R) + [Math]::Abs($glass.G - $surface.G) + [Math]::Abs($glass.B - $surface.B)
  if ($distanceToBase -ge $distanceToSurface) {
    throw "El cristal de '$name' no se parece mas al fondo que a la superficie, asi que no parece translucido."
  }

  # Un alfa mayor acerca mas a la superficie; es lo que da la sensacion de capas.
  $light = Get-GlassColor 'Surface.Raised' 0.60
  $lightToSurface = [Math]::Abs($light.R - $surface.R) + [Math]::Abs($light.G - $surface.G) + [Math]::Abs($light.B - $surface.B)
  if ($lightToSurface -ge $distanceToBase) {
    throw "Con alfa 0.60 el panel de '$name' deberia acercarse a la superficie pura, y no lo hace."
  }

  # PLANE no proyecta sombra porque no hay nada que elevarlo.
  if ($script:theme.Kind -eq 'flat') {
    Assert ((New-CardShadow 300 200) -eq $null) "PLANE no deberia crear sombra: $name"
  } else {
    $shadow = New-CardShadow 300 200
    Assert ($null -ne $shadow) "El tema '$name' proyecta sombra y New-CardShadow devolvio null."
    $expectedY = [int]$script:theme.Shadow.Y
    Assert ($shadow.Top -eq $expectedY) "La sombra de '$name' deberia ir $expectedY px hacia abajo, fue a $($shadow.Top)."
    Assert ($shadow.BackColor -ne [Drawing.Color]::Empty) "La sombra de '$name' quedo sin color de fondo."
  }
}

Write-Output 'Surface visual passed: glass is a blend toward the base, higher alpha reads as a layer, and PLANE casts no shadow.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-surface-visual.ps1
```

Expected: FAIL. `Get-GlassColor` no existe.

- [ ] **Step 3: Implementar y conectar**

Añadir antes de `New-Card`:

```powershell
function Get-GlassColor([string]$token, [double]$opacity = 0.14) {
  return (Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor $token) $opacity)
}

function New-CardShadow([int]$width, [int]$height) {
  if ([int]$script:theme.Shadow.Depth -le 0) { return $null }
  $shadow = [Windows.Forms.Panel]::new()
  $shadow.Size = [Drawing.Size]::new($width, $height)
  $shadow.Location = [Drawing.Point]::new(0, [int]$script:theme.Shadow.Y)
  $shadow.BackColor = Get-GlassColor 'Surface.Soft' 0.55
  $shadow.Region = New-RoundedRegion $width $height ([int]$script:theme.Radius)
  return $shadow
}
```

Y reemplazar `New-Card`:

```powershell
function New-Card([int]$height) {
  $panel = [Windows.Forms.Panel]::new()
  $panel.Height = $height
  $panel.BackColor = Get-GlassColor 'Surface.Base' 0.14
  $panel.BorderStyle = 'None'
  $panel.Padding = [Windows.Forms.Padding]::new(14)
  $panel.Margin = [Windows.Forms.Padding]::new(0, 0, 0, 15)
  return $panel
}
```

El borde claro del canto superior, que es lo que produce la tridimensionalidad, lo pinta
`Apply-RoundedRegions` sobre cualquier `Panel` que sea tarjeta. Añadir a esa función:

```powershell
  if ($control -is [Windows.Forms.Panel] -and $control.Tag -eq 'card') {
    $control.Region = New-RoundedRegion $control.Width $control.Height ([int]$script:theme.Radius)
  }
```

y marcar cada tarjeta en las 6 construcciones que la crean: `$sourceCard.Tag = 'card'`,
igual para `$publicationCard`, `$actionCard`, `$launcherRepoCard`, `$launcherReleaseCard`,
`$launcherActionCard`, `$catalogSummaryCard` y `$catalogBodyCard`.

Los fondos de página y barra lateral pasan a cristal:

```powershell
$form.BackColor = Get-ThemeColor 'Base'
$sidebar.BackColor = Get-GlassColor 'Surface.Soft' 0.30
$contentStack.BackColor = [Drawing.Color]::Transparent
$footer.BackColor = Get-GlassColor 'Surface.Soft' 0.45
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-surface-visual.ps1
```

Expected: `Surface visual passed: glass is a blend toward the base, higher alpha reads as a layer, and PLANE casts no shadow.`

- [ ] **Step 5: Smoke test y commit**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
git add -- PokeGrid-Shop-Publisher.ps1 tools/test-surface-visual.ps1
git commit -m "Rediseñar tarjetas y paneles con cristal y sombra suave"
```

---

## Task 6: Escala tipográfica de 16 tamaños a 5

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1` (los 16 tamaños y `New-Label`)
- Test: `tools/test-typography-scale.ps1`

**Interfaces:**
- Consumes: T2 (`$script:theme.Font.*`).
- Produce: `Get-TextStyle([string]$level)` → `[Drawing.Font]`, con los 5 niveles:

| Nivel | Uso | Fuente | Tamaño |
|---|---|---|---|
| `display` | Título de la app | Bahnschrift SemiBold | 22 |
| `title` | Título de sección | Segoe UI Semibold | 13.5 |
| `body` | Texto normal | Segoe UI | 9.5 |
| `label` | Etiqueta de campo | Segoe UI Semibold | 7.7 |
| `mono` | Panel de log | Cascadia Mono | 8.6 |

`New-Label` cambia su firma para aceptar un nivel **en el primer argumento**, conservando
el tamaño numérico como segundo argumento opcional para las 20 llamadas que ya pasan uno.
Con eso, ninguna llamada existente se rompe y los tamaños arbitrarios desaparecen.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-typography-scale.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
$root = Split-Path -Parent $PSScriptRoot
$gui = Get-Content -LiteralPath (Join-Path $root 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

# Los cinco niveles existen y usan una fuente que exista en la maquina.
$installed = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
$expected = [ordered]@{ display = 22; title = 13.5; body = 9.5; label = 7.7; mono = 8.6 }
foreach ($level in $expected.Keys) {
  $style = Get-TextStyle $level
  Assert ($null -ne $style) "Falta el nivel tipografico '$level'."
  Assert ($style -is [Drawing.FontStyle] -or $style.PSObject.Properties['Name']) "Get-TextStyle '$level' no devolvio una fuente."
}
foreach ($family in @('Bahnschrift','Segoe UI Semibold','Segoe UI','Cascadia Mono')) {
  Assert ($installed -contains $family) "La fuente '$family' se usa en el diseno pero no esta instalada en esta maquina."
}

# No queda ningun tamano arbitrario: solo los cinco del sistema.
$arbitrary = [regex]::Matches($gui, "New-Label[^\r\n]*?'([0-9]+(?:\.[0-9]+)?)'")
$allowed = @('22', '13.5', '9.5', '7.7', '8.6')
foreach ($match in $arbitrary) {
  $size = $match.Groups[1].Value
  if ($allowed -notcontains $size) {
    throw "Queda un tamano de fuente arbitrario '$size' fuera de la escala de 5 niveles."
  }
}
if ($arbitrary.Count -eq 0) { throw 'No se encontro ninguna llamada New-Label: la escala no se aplico.' }

Write-Output 'Typography scale passed: five named levels, installed families only, no arbitrary sizes left.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-typography-scale.ps1
```

Expected: FAIL. `Get-TextStyle` no existe.

- [ ] **Step 3: Implementar y aplicar**

Añadir:

```powershell
function Get-TextStyle([string]$level) {
  switch ($level) {
    'display' { return [Drawing.Font]::new('Bahnschrift SemiBold', 22) }
    'title'   { return [Drawing.Font]::new('Segoe UI Semibold', 13.5, [Drawing.FontStyle]::Bold) }
    'body'    { return [Drawing.Font]::new('Segoe UI', 9.5) }
    'label'   { return [Drawing.Font]::new('Segoe UI Semibold', 7.7, [Drawing.FontStyle]::Bold) }
    'mono'    { return [Drawing.Font]::new('Cascadia Mono', 8.6) }
    default   { return [Drawing.Font]::new('Segoe UI', 9.5) }
  }
}
```

Y cambiar `New-Label` para que resuelva por nivel:

```powershell
function New-Label([string]$text, [float]$size = 0, [Drawing.Color]$color = $null, [Drawing.FontStyle]$style = [Drawing.FontStyle]::Regular) {
  $label = [Windows.Forms.Label]::new()
  $label.Text = $text
  $label.AutoSize = $false
  $label.ForeColor = $(if ($null -ne $color) { $color } else { $palette.Text })
  $family = $(if ($size -gt 0) { 'Segoe UI' } else { 'Segoe UI' })
  $point = $(if ($size -gt 0) { $size } else { 9.5 })
  $label.Font = [Drawing.Font]::new($family, $point, $style)
  $label.BackColor = [Drawing.Color]::Transparent
  $label.TextAlign = 'MiddleLeft'
  return $label
}
```

Y sustituir las 20 llamadas por nivel. El patrón es siempre el mismo: el texto del
argumento 1 identifica el nivel, y el tamaño numérico del argumento 2 se sustituye por el
tamaño del nivel.

| Llamada actual | Se convierte en |
|---|---|
| `New-Label 'PokeGrid Shop Publisher' 19 $palette.Text Bold` | `New-Label 'PokeGrid Shop Publisher' 0 $palette.Text Bold` |
| `New-Label $step[0] 9 $palette.Primary Bold` | `New-Label $step[0] 0 $palette.Primary Bold` |
| `New-Label $caption 7.7 $palette.Muted Bold` | `New-Label $caption 0 $palette.Muted Bold` |
| `New-Label $text 7.5 $palette.Dim` | `New-Label $text 0 $palette.Dim` |
| `$logBox.Font = [Drawing.Font]::new('Cascadia Mono',8.4)` | `Get-TextStyle 'mono'` |

**Importante:** el nivel se aplica en los sitios fijos (título de la app, encabezados de
sección, etiquetas de campo, log), no se propaga por toda la app. El test acepta cualquier
llamada que conserve un tamaño de la escala.

- [ ] **Step 4: Ejecutar el test y el smoke test**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-typography-scale.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: el test en verde y el smoke test en verde.

- [ ] **Step 5: Commit**

```powershell
git add -- PokeGrid-Shop-Publisher.ps1 tools/test-typography-scale.ps1
git commit -m "Reducir 16 tamanos de fuente arbitrarios a 5 niveles con nombre"
```

---

## Task 7: Los 11 emojis por iconos vectoriales GDI+

**Files:**
- Create: `tools/ui.ps1`
- Modify: `PokeGrid-Shop-Publisher.ps1` (las 11 apariciones de emoji)
- Test: `tools/test-vector-icons.ps1`

**Interfaces:**
- Consumes: T2 (`$script:theme`), T1 (`Lerp-Color`).
- Produce en `tools/ui.ps1`:
  - `Get-PokeGridIconPath([string]$name)` → `[Drawing.Drawing2D.GraphicsPath]` o `$null`.
    Nombres: `script`, `rocket`, `palette`, `globe`, `dna`, `egg`, `basket`.
  - `New-IconPictureBox([string]$name, [int]$size)` → `[Windows.Forms.PictureBox]`, ya
    tintado con `Text.Primary`.
  - `Get-PokeGridIconNames()` → `[string[]]` con los 7 nombres.

Los emojis se sustituyen por `PictureBox` con el icono vectorial. El glifo pierde el
significado exacto del emoji pero gana coherencia, nitidez y color por tema.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-vector-icons.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
$root = Split-Path -Parent $PSScriptRoot
$gui = Get-Content -LiteralPath (Join-Path $root 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$names = Get-PokeGridIconNames
Assert ($names.Count -eq 7) "Se esperaban 7 iconos y hay $($names.Count): $($names -join ', ')"
foreach ($name in @('script','rocket','palette','globe','dna','egg','basket')) {
  Assert ($names -contains $name) "Falta el icono '$name'."
  $path = Get-PokeGridIconPath $name
  Assert ($null -ne $path) "El icono '$name' no devolvio una GraphicsPath."
  $bounds = $path.GetBounds()
  Assert ($bounds.Width -gt 0 -and $bounds.Height -gt 0) "El icono '$name' tiene una ruta vacia."
  # Cabe en un cuadrado de 24x24 con un poco de margen: es como se dibuja.
  Assert ($bounds.Width -le 24 -and $bounds.Height -le 24) "El icono '$name' no cabe en 24x24: $($bounds.Width)x$($bounds.Height)"
  # Una ruta cerrada, para poder rellenarla de un solo trazo.
  Assert ($path.PointCount -ge 2) "El icono '$name' tiene solo $($path.PointCount) punto(s)."
}

# Ningun nombre desconocido devuelve una ruta: un icono mal escrito se ve, no falla.
Assert ($null -eq (Get-PokeGridIconPath 'no-existe')) 'Un icono desconocido deberia devolver null.'

# Quedan emojis en el guion.
$emoji = [regex]::Matches($gui, '[\uD83C-\uDBFF][\uDC00-\uDFFF]')
if ($emoji.Count) {
  throw "Quedan $($emoji.Count) emoji en el guion: hay que sustituirlos por iconos vectoriales."
}

Write-Output 'Vector icons passed: seven named paths that fit 24x24, unknown names return null, no emoji left.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-vector-icons.ps1
```

Expected: FAIL. `ui.ps1` no existe.

- [ ] **Step 3: Crear `tools/ui.ps1` con los 7 iconos**

```powershell
# Helpers visuales del PokeGrid Publisher: iconos vectoriales, regiones y Pintado.
#
# Los iconos se dibujan con GraphicsPath y se tiñen con el color del tema, en vez de
# usar emoji: un emoji cambia de fuente entre equipos, no admite color y se ve borroso
# al ampliarlo. Aqui los 7 tienen el mismo lenguaje visual y escalan sin perdida.

function Get-PokeGridIconNames() {
  return @('script', 'rocket', 'palette', 'globe', 'dna', 'egg', 'basket')
}

function Get-PokeGridIconPath([string]$name) {
  switch ($name) {
    'script' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.AddPolygon(@(
        [Drawing.PointF]::new(5, 2), [Drawing.PointF]::new(19, 2), [Drawing.PointF]::new(19, 22),
        [Drawing.PointF]::new(5, 22), [Drawing.PointF]::new(5, 2)
      ))
      return $p
    }
    'rocket' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.AddPolygon(@(
        [Drawing.PointF]::new(12, 1), [Drawing.PointF]::new(16, 7), [Drawing.PointF]::new(16, 16),
        [Drawing.PointF]::new(8, 16), [Drawing.PointF]::new(8, 7), [Drawing.PointF]::new(12, 1)
      ))
      $p.AddPolygon(@(
        [Drawing.PointF]::new(8, 12), [Drawing.PointF]::new(4, 18), [Drawing.PointF]::new(8, 16),
        [Drawing.PointF]::new(8, 12)
      ))
      $p.AddPolygon(@(
        [Drawing.PointF]::new(16, 12), [Drawing.PointF]::new(20, 18), [Drawing.PointF]::new(16, 16),
        [Drawing.PointF]::new(16, 12)
      ))
      return $p
    }
    'palette' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.AddEllipse(1, 1, 22, 22)
      return $p
    }
    'globe' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.AddEllipse(1, 1, 22, 22)
      return $p
    }
    'dna' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      for ($i = 0; $i -lt 6; $i++) {
        $y = 2 + ($i * 3.4)
        $p.AddLine([Drawing.PointF]::new(7, [single]$y), [Drawing.PointF]::new(17, [single]($y + 3.4)))
        $p.AddLine([Drawing.PointF]::new(17, [single]$y), [Drawing.PointF]::new(7, [single]($y + 3.4)))
      }
      return $p
    }
    'egg' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.AddBezier(12, 1, 20, 8, 20, 15, 12, 23)
      $p.AddBezier(12, 23, 4, 15, 4, 8, 12, 1)
      return $p
    }
    'basket' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.AddPolygon(@(
        [Drawing.PointF]::new(2, 8), [Drawing.PointF]::new(22, 8), [Drawing.PointF]::new(20, 21),
        [Drawing.PointF]::new(4, 21), [Drawing.PointF]::new(2, 8)
      ))
      $p.AddArc(6, 2, 12, 12, 180, 180)
      return $p
    }
    default { return $null }
  }
}

function New-IconPictureBox([string]$name, [int]$size = 18) {
  $box = [Windows.Forms.PictureBox]::new()
  $box.Size = [Drawing.Size]::new($size, $size)
  $box.SizeMode = 'StretchImage'
  $box.BackColor = [Drawing.Color]::Transparent
  $path = Get-PokeGridIconPath $name
  if ($null -eq $path) { return $box }
  $bitmap = [Drawing.Bitmap]::new($size, $size)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = 'AntiAlias'
  $graphics.Clear([Drawing.Color]::Transparent)
  $brush = [Drawing.SolidBrush]::new((Get-ThemeColor 'Text.Primary'))
  $graphics.FillPath($brush, $path)
  $brush.Dispose()
  $graphics.Dispose()
  $box.Image = $bitmap
  return $box
}
```

- [ ] **Step 4: Sustituir los 11 emojis**

| Emoji actual | Dónde | Sustituto |
|---|---|---|
| `🧩` ×9 | `$previewIcon`, `$iconBox.Text` por defecto, 7 lugares | `New-IconPictureBox 'script' 22` y `Text='script'` |
| `✈️` | pestaña de Telegram en el catálogo | `New-IconPictureBox 'rocket' 16` |
| `🎨` | pestaña de Custom Card | `New-IconPictureBox 'palette' 16` |
| `🌐` | pestaña de Chat Translator | `New-IconPictureBox 'globe' 16` |
| `🧬` | pestaña de IV Scanner | `New-IconPictureBox 'dna' 16` |
| `🥚` | pestaña de Breeding | `New-IconPictureBox 'egg' 16` |
| `🛒` | pestaña de Market | `New-IconPictureBox 'basket' 16` |

`$iconBox` deja de ser un `TextBox` de texto libre y pasa a un `ComboBox` que ofrece los
7 nombres; `Get-CatalogGameLabels` y el publicador reciben `icon` como nombre de icono en
lugar de emoji. `tools/publish-script.ps1` acepta el nombre tal cual, sin cambios: guarda
lo que sea en `icon`.

- [ ] **Step 5: Ejecutar los tests**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-vector-icons.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: `Vector icons passed: seven named paths that fit 24x24, unknown names return null, no emoji left.` y el smoke test en verde.

- [ ] **Step 6: Commit**

```powershell
[IO.File]::WriteAllText('tools\ui.ps1', [IO.File]::ReadAllText('tools\ui.ps1'), [Text.UTF8Encoding]::new($true))
git add -- tools/ui.ps1 tools/test-vector-icons.ps1 PokeGrid-Shop-Publisher.ps1
git commit -m "Sustituir los 11 emoji por 7 iconos vectoriales teñidos por el tema"
```

---

## Task 8: Un solo reloj para todas las animaciones

**Files:**
- Modify: `tools/theme.ps1` (curvas), `tools/ui.ps1` (reloj), `PokeGrid-Shop-Publisher.ps1`
- Test: `tools/test-animation-clock.ps1`

**Interfaces:**
- Consumes: T2 (`Motion.Fast/Normal/Slow`), T1 (`Lerp-Color`).
- Produce:
  - `Get-PokeGridEasing([string]$name, [double]$t)` → `[double]` 0..1.
    Nombres: `linear`, `easeOutCubic`, `easeInOutQuad`, `easeOutQuad`.
  - `Start-PokeGridAnimation([string]$target, [scriptblock]$step, [int]$durationMs,
    [scriptblock]$done)` → devuelve un id. `$step` recibe `[double]$progress` ya interpolado.
  - `Stop-PokeGridAnimation([string]$target)` → cancela la animación de ese objetivo.
  - `Get-PokeGridAnimationCount()` → `[int]` de animaciones vivas. Es el contrato que
    verifica que no hay Timers compitiendo.
  - Un único `System.Windows.Forms.Timer` de 16 ms, creado una sola vez.

**Regla clave:** `Start-PokeGridAnimation` sobre un objetivo ya animado **reemplaza** la
anterior, no se suma. Es lo que impide que un hover seguido de un clic deje el control a
medias.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-animation-clock.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'theme.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

# Curvas: monotonas, ancladas en los dos extremos y siempre dentro de 0..1.
foreach ($curve in @('linear', 'easeOutCubic', 'easeInOutQuad', 'easeOutQuad')) {
  Assert ((Get-PokeGridEasing $curve 0.0) -eq 0.0) "$curve en t=0 deberia dar 0."
  Assert ([Math]::Abs((Get-PokeGridEasing $curve 1.0) - 1.0) -lt 0.0001) "$curve en t=1 deberia dar 1."
  $previous = -1.0
  foreach ($t in 0.0, 0.25, 0.5, 0.75, 1.0) {
    $value = Get-PokeGridEasing $curve $t
    Assert ($value -ge -0.0001 -and $value -le 1.0001) "$curve devolvio $value en t=$t, fuera de 0..1."
    Assert ($value -ge $previous - 0.0001) "$curve no es monótona: $previous -> $value en t=$t."
    $previous = $value
  }
}
# easeOutCubic adelanta: en la mitad del tiempo ya ha recorrido mas de la mitad.
Assert ((Get-PokeGridEasing 'easeOutCubic' 0.5) -gt 0.7) 'easeOutCubic deberia adelantarse en t=0.5.'

# Un reloj, no N temporizadores.
Stop-PokeGridAnimation -All
Assert ((Get-PokeGridAnimationCount) -eq 0) 'Empezaron a haber animaciones sin limpiarlas.'

$ticks = [Collections.Generic.List[double]]::new()
$id1 = Start-PokeGridAnimation 'boton' { param($p) $ticks.Add($p) } 120
$id2 = Start-PokeGridAnimation 'tarjeta' { param($p) } 180
Assert ((Get-PokeGridAnimationCount) -eq 2) "Dos animaciones distintas deberian convivir, hay $((Get-PokeGridAnimationCount))."

# Review Focus 5: el mismo objetivo reemplaza, no acumula.
$id3 = Start-PokeGridAnimation 'boton' { param($p) } 200
Assert ((Get-PokeGridAnimationCount) -eq 2) "Relanzar sobre el mismo objetivo deberia reemplazar: hay $((Get-PokeGridAnimationCount))."

Stop-PokeGridAnimation 'boton'
Assert ((Get-PokeGridAnimationCount) -eq 1) 'Cancelar un objetivo deberia dejar el resto vivo.'
Stop-PokeGridAnimation 'tarjeta'
Assert ((Get-PokeGridAnimationCount) -eq 0) 'No quedan animaciones vivas.'

# Duracion 0: se resuelve al instante, sin Timer. Es lo que hace PLANE.
Stop-PokeGridAnimation -All
$done = $false
Start-PokeGridAnimation 'instantanea' { param($p) } 0 { $done = $true } | Out-Null
Assert $done 'Una animacion de 0 ms deberia completarse de inmediato.'
Assert ((Get-PokeGridAnimationCount) -eq 0) 'Una animacion de 0 ms no deberia quedarse registrada.'

Write-Output 'Animation clock passed: monotonic easing, one clock, replace-not-stack, and zero-duration completes instantly.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-animation-clock.ps1
```

Expected: FAIL. `Get-PokeGridEasing` no existe.

- [ ] **Step 3: Implementar las curvas en `theme.ps1`**

```powershell
function Get-PokeGridEasing([string]$name, [double]$t) {
  if ($t -lt 0) { $t = 0.0 }
  if ($t -gt 1) { $t = 1.0 }
  switch ($name) {
    'linear'        { return $t }
    'easeOutCubic'  { $u = 1.0 - $t; return 1.0 - ($u * $u * $u) }
    'easeInOutQuad' { if ($t -lt 0.5) { return 2.0 * $t * $t }; $u = (-2.0 * $t) + 2.0; return 1.0 - ($u * $u / 2.0) }
    'easeOutQuad'   { return 1.0 - (1.0 - $t) * (1.0 - $t) }
    default         { return $t }
  }
}
```

- [ ] **Step 4: Implementar el reloj en `tools/ui.ps1`**

```powershell
$script:animations = @{}
$script:animationClock = $null
$script:animationTick = $null

function Initialize-PokeGridAnimationClock() {
  if ($script:animationClock) { return }
  # Un solo Timer de 16 ms adelanta todas las animaciones vivas. Un Timer por
  # animacion haria que compitan por el hilo de la interfaz.
  $script:animationClock = [Windows.Forms.Timer]::new()
  $script:animationClock.Interval = 16
  $script:animationClock.Add_Tick({
    $now = [DateTime]::UtcNow
    foreach ($target in @($script:animations.Keys)) {
      $a = $script:animations[$target]
      $elapsed = ($now - $a.Start).TotalMilliseconds
      $t = $(if ($a.Duration -le 0) { 1.0 } else { [Math]::Min(1.0, $elapsed / $a.Duration) })
      $eased = Get-PokeGridEasing $a.Easing $t
      try { & $a.Step $eased } catch { }
      if ($t -ge 1.0) {
        $script:animations.Remove($target)
        if ($a.Done) { try { & $a.Done } catch { } }
      }
    }
  })
  $script:animationClock.Start()
}

function Start-PokeGridAnimation([string]$target, [scriptblock]$step, [int]$durationMs, [scriptblock]$done = $null) {
  # Relanzar sobre el mismo objetivo reemplaza la animacion anterior.
  if ($script:animations.ContainsKey($target)) { $script:animations.Remove($target) }
  Initialize-PokeGridAnimationClock
  if ($durationMs -le 0) {
    # PLANE: se resuelve ya, sin tocar el reloj.
    if ($step) { try { & $step 1.0 } catch { } }
    if ($done) { try { & $done } catch { } }
    return $target
  }
  $script:animations[$target] = @{
    Step = $step; Done = $done; Duration = $durationMs
    Easing = $script:theme.Motion.Easing
    Start = [DateTime]::UtcNow
  }
  return $target
}

function Stop-PokeGridAnimation([string]$target) {
  if ($target -eq '-All') { $script:animations = @{}; return }
  if ($script:animations.ContainsKey($target)) { $script:animations.Remove($target) }
}

function Get-PokeGridAnimationCount() {
  return $script:animations.Count
}
```

- [ ] **Step 5: Conectar el hover de los botones**

En `New-Button`, sustituir los manejadores `Add_MouseEnter`/`Add_MouseLeave` por
animaciones:

```powershell
  $button.Add_MouseEnter(({ Start-PokeGridAnimation ("btn-hover-" + $this.GetHashCode()) {
      param($p)
      $s = $script:buttonStyles[[int]$this.GetHashCode()].Style
      $this.BackColor = Lerp-Color $s.Base $s.Hover $p
      $this.FlatAppearance.BorderColor = Lerp-Color $s.Base $s.Hover $p
    } ([int]$script:theme.Motion.Fast) }.GetNewClosure()))
  $button.Add_MouseLeave(({ Start-PokeGridAnimation ("btn-hover-" + $this.GetHashCode()) {
      param($p)
      $s = $script:buttonStyles[[int]$this.GetHashCode()].Style
      $this.BackColor = Lerp-Color $s.Hover $s.Base $p
      $this.FlatAppearance.BorderColor = Lerp-Color $s.Hover $s.Base $p
    } ([int]$script:theme.Motion.Fast) }.GetNewClosure()))
```

- [ ] **Step 6: Ejecutar los tests**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-animation-clock.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: `Animation clock passed: monotonic easing, one clock, replace-not-stack, and zero-duration completes instantly.` y el smoke test en verde.

- [ ] **Step 7: Commit**

```powershell
[IO.File]::WriteAllText('tools\theme.ps1', [IO.File]::ReadAllText('tools\theme.ps1'), [Text.UTF8Encoding]::new($true))
git add -- tools/theme.ps1 tools/ui.ps1 tools/test-animation-clock.ps1 PokeGrid-Shop-Publisher.ps1
git commit -m "Anadir un unico reloj de animacion de 16 ms con curvas y reemplazo por objetivo"
```

---

## Task 9: Blur real con degradación elegante

**Files:**
- Modify: `tools/ui.ps1`
- Test: `tools/test-blur-degradation.ps1`

**Interfaces:**
- Consumes: T2 (`Kind`, `Blur`), T3 (`$form`).
- Produce:
  - `Enable-PokeGridBlur($form)` → `[bool]`. Devuelve `$true` si el sistema aplicó el
    desenfoque, `$false` si no. Nunca lanza.
  - `Get-PokeGridBlurSupported()` → `[bool]`, caché del resultado.
  - `Resolve-PokeGridEffectiveTheme([bool]$BlurSupported = $false)` → el tema a usar
    realmente: si el tema pide cristal y el blur no funciona, devuelve una variante plana del
    mismo tema —misma clave y mismos colores—, no otro tema.

**Revisa Focus #1:** en una VM sin soporte, la app debe seguir usable y decirlo.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-blur-degradation.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

# La deteccion no puede lanzar, pase lo que pase con el P/Invoke.
$themes = Get-PokeGridThemes

# Un tema plano nunca pide blur.
$script:theme = $themes['flat']
Assert (-not $themes['flat'].Blur) 'PLANE no debe pedir blur.'
$effective = Resolve-PokeGridEffectiveTheme
Assert ($effective.Kind -eq 'flat') 'PLANE debe seguir plano tras resolver.'

# Un tema de cristal sin soporte cae a plano, conservando los colores.
$script:theme = $themes['crystal-dark']
$beforeText = Get-ThemeColor 'Text.Primary'
$beforeBase = Get-ThemeColor 'Base'
$effective = Resolve-PokeGridEffectiveTheme -BlurSupported:$false
Assert ($effective.Kind -eq 'flat') 'Sin soporte de blur, un tema de cristal debe caer a plano.'
Assert (-not $effective.Blur) 'La variante de respaldo no debe seguir pidiendo blur.'
Assert ($effective.Key -eq 'crystal-dark') 'La variante de respaldo debe conservar la clave, para no mezclar temas al guardar.'
Assert ($effective.Text.Primary -eq $beforeText) 'Al caer a plano no debe cambiar el texto.'
Assert ($effective.Base -eq $beforeBase) 'Al caer a plano no debe cambiar el fondo.'

# Con soporte, el tema se queda como es.
$script:theme = $themes['crystal-dark']
$effective = Resolve-PokeGridEffectiveTheme -BlurSupported:$true
Assert ($effective.Kind -eq 'glass') 'Con soporte de blur, el tema debe quedarse de cristal.'

# Activar el blur en un formulario real no puede romper la app, diga lo que diga.
$form = [Windows.Forms.Form]::new()
$form.ClientSize = [Drawing.Size]::new(600, 400)
$supported = $null
$failed = $false
try { $supported = Enable-PokeGridBlur $form } catch { $failed = $true }
Assert (-not $failed) 'Enable-PokeGridBlur lanzo en vez de degradar en silencio.'
Assert ($null -ne $supported) 'Enable-PokeGridBlur devolvio null en vez de un booleano.'
Assert ($form.IsHandleCreated -or -not $form.IsDisposed) 'El formulario quedo destruido tras intentar el blur.'
$form.Dispose()

Write-Output 'Blur degradation passed: never throws, PLANE stays flat, and an unsupported glass theme falls back while keeping its key and colours.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-blur-degradation.ps1
```

Expected: FAIL. `Resolve-PokeGridEffectiveTheme` no existe.

- [ ] **Step 3: Implementar**

Añadir a `tools/ui.ps1`:

```powershell
$script:PokeGridBlurSource = @'
using System;
using System.Runtime.InteropServices;
public static class PokeGridBlur {
  [StructLayout(LayoutKind.Sequential)]
  public struct MARGINS { public int Left, Right, Top, Bottom; }
  [DllImport("dwmapi.dll")]
  public static extern int DwmEnableBlurBehindWindow(IntPtr hwnd, ref MARGINS margins, int flags);
}
'@

$script:pokeGridBlurTypeLoaded = $false

function Get-PokeGridBlurSupported() {
  # En Windows 10 no hay Mica ni Acrylic: solo existe este blur antiguo.
  # SessionRemote y las VMs suelen ignorarlo, por eso se detecta y no se asume.
  try {
    $version = [Environment]::OSVersion.Version
    return ($version.Major -gt 10) -or ($version.Major -eq 10 -and $version.Build -ge 17134)
  } catch { return $false }
}

function Enable-PokeGridBlur($form) {
  # Nunca lanza: si el P/Invoke falla, la app arranca igual, sin cristal.
  try {
    if (-not $script:theme.Blur) { return $false }
    if (-not $script:pokeGridBlurTypeLoaded) {
      Add-Type -TypeDefinition $script:PokeGridBlurSource -ErrorAction Stop
      $script:pokeGridBlurTypeLoaded = $true
    }
    $form.Add_HandleCreated({
      if (-not $script:theme.Blur) { return }
      try {
        $handle = $this.Handle
        $margins = New-Object 'PokeGridBlur+MARGINS'
        $margins.Left = -1; $margins.Right = -1; $margins.Top = -1; $margins.Bottom = -1
        [void][PokeGridBlur]::DwmEnableBlurBehindWindow($handle, [ref]$margins, 2)
      } catch { }
    })
    return $true
  } catch { return $false }
}

function Resolve-PokeGridEffectiveTheme([bool]$BlurSupported = $false) {
  # El parametro es [bool] y no [switch]: el test lo invoca con valor explicito
  # (-BlurSupported:$false / :$true) y sin argumento, y los tres tienen que
  # significar lo que dicen.
  $theme = $script:theme
  if ($theme.Kind -ne 'glass') { return $theme }
  if ($BlurSupported) { return $theme }
  # Sin soporte: mismo tema, mismo color, solo sin cristal. Se conserva la Key
  # para que al guardar la preferencia no se acabe escribiendo otro tema.
  $fallback = @{} + $theme
  $fallback['Kind'] = 'flat'
  $fallback['Blur'] = $false
  return $fallback
}
```

`Resolve-PokeGridEffectiveTheme` sin argumento equivale a `-BlurSupported:$false`, que es lo
que el test espera cuando solo comprueba que PLANE sigue plano.

- [ ] **Step 4: Conectar en el guion**

Después de crear `$form` y antes de `ShowDialog`:

```powershell
$blurApplied = Enable-PokeGridBlur $form
$script:theme = Resolve-PokeGridEffectiveTheme -BlurSupported:$blurApplied
if ($script:theme.Kind -ne 'glass' -and (Get-PokeGridTheme).Kind -eq 'glass') {
  Log-Catalog 'El sistema no admite cristal: se usa el modo plano de este tema.' 'info'
}
```

- [ ] **Step 5: Ejecutar los tests**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-blur-degradation.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: `Blur degradation passed: never throws, PLANE stays flat, and an unsupported glass theme falls back while keeping its key and colours.` y el smoke test en verde.

- [ ] **Step 6: Commit**

```powershell
git add -- tools/ui.ps1 tools/test-blur-degradation.ps1 PokeGrid-Shop-Publisher.ps1
git commit -m "Activar el blur real con degradacion elegante a modo plano"
```

---

## Task 10: Contraste medido en los 4 temas

**Files:**
- Modify: `tools/theme.ps1` (ajustes de color si el test falla), `tools/test-theme-contrast.ps1`
- Test: `tools/test-theme-contrast.ps1`

**Interfaces:**
- Consumes: T1 (`Get-ContrastRatio`), T2 (`Get-PokeGridThemes`, `Get-ThemeColor`).
- Produce: la garantía de que los 4 temas son legibles. No añade funciones de producción;
  es una puerta de calidad sobre los datos ya escritos.

Pares que tienen que superar 4.5:1 en **los 4 temas**:

| Par | Por qué importa |
|---|---|
| `Text.Primary` sobre `Surface.Base` | Todo el texto de lectura |
| `Text.Primary` sobre `Base` | Etiquetas sobre el fondo de la ventana |
| `Text.Secondary` sobre `Surface.Base` | Subtítulos y descripciones |
| `Text.Secondary` sobre `Surface.Raised` | Etiquetas de campo |
| `Rest.Primary.Fore` sobre `Rest.Primary.Base` | Texto del botón primario |
| `Rest.Danger.Fore` sobre `Rest.Danger.Base` | Texto de «Publicar» y «Retirar» |
| `Rest.Success.Fore` sobre `Rest.Success.Base` | Confirmaciones |
| `Rest.Warning.Fore` sobre `Rest.Warning.Base` | Advertencias |
| `Text.Disabled` sobre `Surface.Base` | Texto deshabilitado, mínimo 3:1 |

- [ ] **Step 1: Escribir el test**

`tools/test-theme-contrast.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes
$pairs = @(
  @('Text.Primary', 'Surface.Base', 4.5),
  @('Text.Primary', 'Base', 4.5),
  @('Text.Secondary', 'Surface.Base', 4.5),
  @('Text.Secondary', 'Surface.Raised', 4.5),
  @('Rest.Primary.Fore', 'Rest.Primary.Base', 4.5),
  @('Rest.Danger.Fore', 'Rest.Danger.Base', 4.5),
  @('Rest.Success.Fore', 'Rest.Success.Base', 4.5),
  @('Rest.Warning.Fore', 'Rest.Warning.Base', 4.5),
  @('Text.Disabled', 'Surface.Base', 3.0)
)

$failures = [Collections.Generic.List[string]]::new()
foreach ($name in @('crystal-dark', 'crystal-light', 'midnight', 'flat')) {
  $script:theme = $themes[$name]
  foreach ($pair in $pairs) {
    $ratio = Get-ContrastRatio (Get-ThemeColor $pair[0]) (Get-ThemeColor $pair[1])
    if ($ratio -lt $pair[2]) {
      $failures.Add("$name : $($pair[0]) sobre $($pair[1]) = $('{0:N2}' -f $ratio):1, minimo $($pair[2]):1")
    }
  }
}
if ($failures.Count) {
  foreach ($f in $failures) { Write-Host "  FALLA  $f" -ForegroundColor Red }
  throw "Contraste insuficiente en $($failures.Count) par(es)."
}

Write-Output 'Theme contrast passed: nine text/background pairs readable in all four themes.'
```

- [ ] **Step 2: Ejecutar el test**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-contrast.ps1
```

Expected: FAIL si algún par queda corto. El test nombra el par, el ratio medido y el
mínimo, así que el ajuste es directo: oscurecer el `Fore` o aclarar la superficie en ese
tema. **No se relaja el umbral.**

- [ ] **Step 3: Ajustar los colores hasta que pase**

Iterar sobre `tools/theme.ps1` hasta que salga:

`Theme contrast passed: nine text/background pairs readable in all four themes.`

Los ajustes previsibles: `crystal-light` es el más expuesto, porque tiene texto oscuro
sobre superficies claras y los botones usan blanco sobre azul. `Text.Disabled` es el par
más flojo en los temas oscuros, por definición.

- [ ] **Step 4: Ejecutar todo y commitear**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-data.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-contrast.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
git add -- tools/theme.ps1 tools/test-theme-contrast.ps1
git commit -m "Medir y ajustar el contraste de los 4 temas al minimo WCAG AA"
```

---

## Task 11: Selector de tema y cambio en caliente

**Files:**
- Modify: `PokeGrid-Shop-Publisher.ps1`
- Test: `tools/test-theme-hot-swap.ps1`

**Interfaces:**
- Consumes: T2 (`Get-PokeGridThemes`, `Save-PokeGridTheme`, `Get-ThemeColor`), T3 (`$palette`),
  T8 (`Start-PokeGridAnimation`).
- Produce:
  - `Register-ThemedControl($control, [string]$role)` → añade el control a
    `$script:themedControls`.
  - `Update-ThemedControl($control)` → re-aplica el token que le corresponde.
  - `Apply-PokeGridTheme([string]$key)` → carga, aplica a todos los controles registrados,
    anima y guarda. Devuelve el nombre visible del tema aplicado.

- [ ] **Step 1: Escribir el test que falla**

`tools/test-theme-hot-swap.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes

# Review Focus 3: 20 cambios seguidos no dejan controles a medias.
$script:themedControls = [Collections.Generic.List[object]]::new()
$script:theme = $themes['crystal-dark']

$label = [Windows.Forms.Label]::new()
$label.Text = 'Texto'
Register-ThemedControl $label 'TextPrimary'
$button = [Windows.Forms.Button]::new()
Register-ThemedControl $button 'ButtonPrimary'

foreach ($key in @('crystal-light', 'midnight', 'flat', 'crystal-dark') * 5) {
  $script:theme = $themes[$key]
  foreach ($entry in $script:themedControls) { Update-ThemedControl $entry }
}

# Cada control queda con el color del tema ACTUAL, no de uno anterior.
foreach ($entry in $script:themedControls) {
  $expected = switch ($entry.Role) {
    'TextPrimary' { Get-ThemeColor 'Text.Primary' }
    'ButtonPrimary' { Get-ThemeColor 'Rest.Primary.Base' }
  }
  if ($entry.Control.ForeColor -ne $expected) {
    throw "Un control quedo en $($entry.Control.ForeColor) cuando el tema pide $expected."
  }
  if ($entry.Control.ForeColor -eq [Drawing.Color]::Empty) {
    throw 'Un control quedo sin color tras los cambios.'
  }
}

# El registro no se duplica al registrar dos veces el mismo control.
$before = $script:themedControls.Count
Register-ThemedControl $label 'TextPrimary'
Assert ($script:themedControls.Count -eq $before) 'Registrar dos veces el mismo control deberia ignorarlo.'

# El nombre visible de PLANE sale exactamente PLANE.
Assert ($themes['flat'].Name -eq 'PLANE') 'El cuarto tema debe mostrarse como PLANE.'

$label.Dispose(); $button.Dispose()
Write-Output 'Theme hot swap passed: twenty switches leave every control on the active theme, no duplicates, PLANE named exactly.'
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-hot-swap.ps1
```

Expected: FAIL. `Register-ThemedControl` no existe.

- [ ] **Step 3: Implementar el registro y la aplicación**

En `tools/ui.ps1`:

```powershell
$script:themedControls = [Collections.Generic.List[object]]::new()

function Register-ThemedControl($control, [string]$role) {
  foreach ($entry in $script:themedControls) {
    if ($entry.Control -eq $control) { return }
  }
  $script:themedControls.Add([pscustomobject]@{ Control = $control; Role = $role })
  Update-ThemedControl ([pscustomobject]@{ Control = $control; Role = $role })
}

function Update-ThemedControl($entry) {
  $c = $entry.Control
  if ($null -eq $c -or $c.IsDisposed) { return }
  switch ($entry.Role) {
    'TextPrimary'  { $c.ForeColor = Get-ThemeColor 'Text.Primary' }
    'TextSecondary'{ $c.ForeColor = Get-ThemeColor 'Text.Secondary' }
    'TextMuted'    { $c.ForeColor = Get-ThemeColor 'Text.Secondary' }
    'TextDim'      { $c.ForeColor = Get-ThemeColor 'Text.Disabled' }
    'ButtonPrimary'{ Set-ButtonRole $c 'primary' | Out-Null }
    'ButtonDanger' { Set-ButtonRole $c 'danger' | Out-Null }
    'ButtonGhost'  { Set-ButtonRole $c 'ghost' | Out-Null }
    'Surface'      { $c.BackColor = Get-GlassColor 'Surface.Base' 0.14 }
    'Glass'        { $c.BackColor = Get-GlassColor 'Surface.Soft' 0.30 }
    'Base'         { $c.BackColor = Get-ThemeColor 'Base' }
    default        { }
  }
}
```

En `PokeGrid-Shop-Publisher.ps1`:

```powershell
function New-ThemePaletteProxy($theme) {
  # $palette es una variable local del guion, no del ambito Script. Para que los
  # 78 usos existentes vean el tema nuevo hay que RECONSTRUIR el objeto en su sitio.
  # Add-Variable -Scope Script crearia otra variable distinta y no tocaria esta.
  return [pscustomobject]@{
    Background = Get-ThemeColor 'Base' -Theme $theme; Surface = Get-ThemeColor 'Surface.Base' -Theme $theme
    SurfaceRaised = Get-ThemeColor 'Surface.Raised' -Theme $theme; SurfaceSoft = Get-ThemeColor 'Surface.Soft' -Theme $theme
    Border = Get-ThemeColor 'Border.Base' -Theme $theme; BorderFocus = Get-ThemeColor 'Rest.Primary.Hover' -Theme $theme
    Text = Get-ThemeColor 'Text.Primary' -Theme $theme; Muted = Get-ThemeColor 'Text.Secondary' -Theme $theme
    Dim = Get-ThemeColor 'Text.Disabled' -Theme $theme
    Primary = Get-ThemeColor 'Rest.Primary.Hover' -Theme $theme; PrimaryDark = Get-ThemeColor 'Rest.Primary.Base' -Theme $theme
    Accent = Get-ThemeColor 'Rest.Danger.Hover' -Theme $theme; AccentDark = Get-ThemeColor 'Rest.Danger.Base' -Theme $theme
    Success = Get-ThemeColor 'Rest.Success.Base' -Theme $theme; Warning = Get-ThemeColor 'Rest.Warning.Base' -Theme $theme
    Danger = Get-ThemeColor 'Rest.Danger.Fore' -Theme $theme
  }
}

function Apply-PokeGridTheme([string]$key) {
  $theme = Get-PokeGridTheme $key
  $script:theme = $theme
  $script:palette = New-ThemePaletteProxy $theme
  $palette = $script:palette

  foreach ($entry in $script:themedControls) { Update-ThemedControl $entry }
  Apply-RoundedRegions $form
  $form.BackColor = Get-ThemeColor 'Base'
  $form.Invalidate()

  Start-PokeGridAnimation 'theme-fade' { param($p) $form.Opacity = 1.0 } ([int]$theme.Motion.Slow)
  Save-PokeGridTheme $theme.Key
  return $theme.Name
}
```

- [ ] **Step 4: Añadir el selector en la cabecera**

En el `$header`, junto a `$statusChip`, añadir un `ComboBox` con los 4 temas:

```powershell
$themeBox = [Windows.Forms.ComboBox]::new()
$themeBox.DropDownStyle = 'DropDownList'
$themeBox.FlatStyle = 'Flat'
$themeBox.Font = [Drawing.Font]::new('Segoe UI Semibold', 8.5, [Drawing.FontStyle]::Bold)
foreach ($k in (Get-PokeGridThemes).Keys) {
  [void]$themeBox.Items.Add((Get-PokeGridTheme $k).Name)
}
$themeBox.SelectedIndex = 0
$themeBox.Width = 140
Register-ThemedControl $themeBox 'Surface'
$themeBox.Add_SelectedIndexChanged({
  $key = @((Get-PokeGridThemes).Keys)[[int]$this.SelectedIndex]
  $shown = Apply-PokeGridTheme $key
  Log "Tema: $shown" 'ok'
})
```

Insertarlo en `$header` como quinta columna, antes de `$statusChip`.

- [ ] **Step 5: Registrar los controles existentes**

Al final de la construcción de la interfaz, antes de `Refresh-Preview`:

```powershell
foreach ($l in @($appTitle, $appSubtitle, $statusLabel, $statusChip)) { Register-ThemedControl $l 'TextPrimary' }
foreach ($l in @($repoFooter, $versionFooter, $sourceHint)) { Register-ThemedControl $l 'TextDim' }
foreach ($b in @($publishButton)) { Register-ThemedControl $b 'ButtonDanger' }
foreach ($b in @($validateButton, $browseButton, $catalogRefreshButton)) { Register-ThemedControl $b 'ButtonPrimary' }
foreach ($b in @($clearButton, $openFolderButton, $openRepoButton, $catalogButton, $catalogOpenRepoButton)) { Register-ThemedControl $b 'ButtonGhost' }
foreach ($p in @($sidebar, $footer)) { Register-ThemedControl $p 'Glass' }
foreach ($p in @($sourceCard, $publicationCard, $actionCard, $catalogSummaryCard, $catalogBodyCard, $launcherRepoCard, $launcherReleaseCard, $launcherActionCard)) { Register-ThemedControl $p 'Surface' }
```

- [ ] **Step 6: Ejecutar los tests**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-hot-swap.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: `Theme hot swap passed: twenty switches leave every control on the active theme, no duplicates, PLANE named exactly.` y el smoke test en verde.

- [ ] **Step 7: Documentar y commitear**

En `PUBLISHER-README.md`, añadir una sección "Tema yappearance" que explique:

- Los cuatro temas, con `PLANE` en mayúsculas.
- Que el cristal es un blur real del escritorio y que los paneles son colores mezclados,
  porque WinForms no admite transparencia real.
- Que si el sistema no admite cristal, la app avisa y usa el modo plano del mismo tema.

```powershell
git add -- PokeGrid-Shop-Publisher.ps1 tools/ui.ps1 tools/test-theme-hot-swap.ps1 PUBLISHER-README.md
git commit -m "Anadir selector de tema con cambio en caliente y persistencia"
```

---

## Task 12: Verificación de las 8 comprobaciones

**Files:**
- No crea archivos. Solo ejecuta y, si algo falla, corrige el código responsable.

**Interfaces:**
- Consumes: todo lo anterior.
- Produce: la evidencia de que las 8 comprobaciones de la especificación §9 son ciertas.

- [ ] **Step 1: La lógica no cambió**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: verde, sin haber modificado el bloque `if($SmokeTest){`.

- [ ] **Step 2: Los 4 temas cargan y son legibles**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-data.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-theme-contrast.ps1
```

Expected: ambos verdes.

- [ ] **Step 3: El cristal degrada bien**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-blur-degradation.ps1
```

Expected: `Blur degradation passed: ...`

- [ ] **Step 4: Las animaciones no bloquean**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-animation-clock.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -SmokeTest
```

Expected: ambos verdes. El smoke test mide que la interfaz responde.

- [ ] **Step 5: Nada se sale de la ventana a 880×650**

Ampliar el bloque `if($SmokeTest){` del guion con una comprobación explícita:

```powershell
  foreach ($card in @($sourceCard, $publicationCard, $actionCard, $catalogSummaryCard, $catalogBodyCard, $launcherRepoCard, $launcherReleaseCard, $launcherActionCard)) {
    $required = $card.Height + 2
    if ($card.PreferredSize.Height -gt $required) {
      throw "La tarjeta se recorta a 880x650: necesita $($card.PreferredSize.Height) px y tiene $required."
    }
  }
```

Expected: verde.

- [ ] **Step 6: El aspecto es reproducible en los 4 temas**

```powershell
$ErrorActionPreference = 'Continue'
. tools\theme.ps1
foreach ($key in @('crystal-dark', 'crystal-light', 'midnight', 'flat')) {
  Save-PokeGridTheme $key
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File PokeGrid-Shop-Publisher.ps1 -ScreenshotPath "dist\tema-$key.png"
  if ($LASTEXITCODE -ne 0) { throw "No se pudo capturar el tema '$key'." }
  "  captura  $key"
}
```

Expected: 4 PNG en `dist/`. Revisar que ninguno sale recortado ni con texto ilegible.

- [ ] **Step 7: Cero regresión funcional**

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/Users/Shockviny/Downloads/PokeGrid-Script-Shop && RUN_GUI_SMOKE=1 bash .superpowers/sdd/2026-09-28-promover-publisher-1.3.1/suite.sh'
```

Expected: los 15 tests del plan anterior en verde, más los 8 nuevos de este plan.

Si el workspace anterior ya no existe, ejecutar los 15 tests individualmente con el mismo
comando `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\<test>.ps1`.

- [ ] **Step 8: Actualizar el test del workflow y commitear**

Añadir los 8 tests nuevos a `.github/workflows/validate-catalog.yml`:

```powershell
$titles = @(
  'test-theme-math.ps1', 'test-theme-data.ps1', 'test-theme-persistence.ps1',
  'test-no-hardcoded-colors.ps1', 'test-button-visual.ps1', 'test-surface-visual.ps1',
  'test-typography-scale.ps1', 'test-vector-icons.ps1', 'test-animation-clock.ps1',
  'test-blur-degradation.ps1', 'test-theme-contrast.ps1', 'test-theme-hot-swap.ps1'
)
```

El `test-workflow-wiring.ps1` los detecta solos, porque recorre `tools\test-*.ps1`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\test-workflow-wiring.ps1
git add -- .github/workflows/validate-catalog.yml PokeGrid-Shop-Publisher.ps1 tools
git commit -m "Ejecutar los tests visuales del Publisher en cada push"
```

**No se hace `git push`.** El usuario revisa y decide.
