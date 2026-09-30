# Tokens visuales del PokeGrid Publisher.
#
# Este archivo contiene DATOS y MATEMATICA PURA: no dibuja nada. Eso lo hace
# verificable sin abrir la interfaz, que es donde se va a comprobar el contraste
# de los 4 temas.
#
# El guion principal pide tokens por rol ('Text.Primary') y nunca un color fijo,
# de modo que cambiar de tema es sustituir $script:theme y nada mas.

# El acelerador [Drawing] lo registra System.Windows.Forms, no System.Drawing.
# Sin esto, cualquier consumidor que solo haya cargado System.Drawing falla con
# "No se encuentra el tipo [Drawing.Color]".
if (-not ('Drawing.Color' -as [type])) {
  Add-Type -AssemblyName System.Windows.Forms
}

function Get-ThemeColor([string]$Path, [string]$Fallback = '', $Theme = $null) {
  # $Theme explicito permite validar un tema que aun no es el activo: asi
  # Test-PokeGridTheme puede comprobar los 4 sin cambiar el global.
  $cursor = $(if ($Theme) { $Theme } else { $script:theme })
  foreach ($segment in ($Path -split '\.')) {
    if ($null -eq $cursor) { break }
    # Los temas se declaran con [ordered]@{}, que es un OrderedDictionary y no
    # tiene ContainsKey: hay que usar Contains en los diccionarios ordenados.
    if ($cursor -is [Collections.IDictionary]) {
      if (-not $cursor.Contains($segment)) { $cursor = $null; break }
      $cursor = $cursor[$segment]
    } elseif ($cursor.PSObject.Properties[$segment]) {
      $cursor = $cursor.PSObject.Properties[$segment].Value
    } else { $cursor = $null; break }
  }
  if ($null -eq $cursor -or $cursor -is [string]) {
    if ($Fallback) { return [Drawing.ColorTranslator]::FromHtml($Fallback) }
    # Los colores del tema se guardan como cadenas '#RRGGBB': se convierten
    # aqui, en un solo sitio, en vez de en los 78 puntos de uso.
    if ($cursor -is [string] -and $cursor -match '^#[0-9A-Fa-f]{6}$') {
      return [Drawing.ColorTranslator]::FromHtml($cursor)
    }
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
  # El acelerador [Drawing] lo registra System.Windows.Forms, no System.Drawing:
  # quien cargue este archivo tiene que haber cargado Forms antes.
  if ($null -eq $Color) { throw 'Get-RelativeLuminance recibio un color nulo.' }
  $linear = 0.0
  $weighted = @(
    @{ Value = $Color.R; Weight = 0.2126 }
    @{ Value = $Color.G; Weight = 0.7152 }
    @{ Value = $Color.B; Weight = 0.0722 }
  )
  foreach ($channel in $weighted) {
    $srgb = $channel.Value / 255.0
    if ($srgb -le 0.03928) { $linear += $channel.Weight * ($srgb / 12.92) }
    else { $linear += $channel.Weight * [Math]::Pow((($srgb + 0.055) / 1.055), 2.4) }
  }
  return $linear
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

# ---------------------------------------------------------------------------
# Los cuatro temas.
#
# Son datos, no codigo: cambiar el aspecto de la aplicacion es sustituir esta
# tabla. El guion principal pide tokens por rol y nunca un color fijo.
#
# Los cuatro comparten exactamente las mismas claves, para que un cambio de tema
# no pueda dejar un control Asking por un token que no existe.
# ---------------------------------------------------------------------------

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
    Text = [ordered]@{ Primary = '#101A26'; Secondary = '#46586E'; Disabled = '#6B7C91' }
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
      # El amarillo de advertencia original daba 4.03:1 con texto blanco, por
      # debajo de 4.5:1. Oscurecido a #7A6209 para llegar a 5.4:1 sin perder
      # la lectura de "aviso".
      Warning = [ordered]@{ Base = '#7A6209'; Hover = '#96781B'; Fore = '#FFFFFF' }
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
  # Comprueba que cada token EXISTE, no que sea un color: Key, Name, Kind y
  # Font.* son cadenas o flags, y Get-ThemeColor solo convierte los '#RRGGBB'.
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
  $cursor = $Theme
  foreach ($token in $required) {
    $found = $true
    foreach ($segment in ($token -split '\.')) {
      if ($null -eq $cursor) { $found = $false; break }
      if ($cursor -is [Collections.IDictionary]) {
        if (-not $cursor.Contains($segment)) { $found = $false; break }
        $cursor = $cursor[$segment]
      } elseif ($cursor.PSObject.Properties[$segment]) {
        $cursor = $cursor.PSObject.Properties[$segment].Value
      } else { $found = $false; break }
    }
    if (-not $found) { $missing.Add($token) }
    # El cursor se reinicia SIEMPRE: sin esto, tras fallar un token de una hoja
    # el cursor queda a null y todos los siguientes se marcan como ausentes.
    $cursor = $Theme
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
  # Cualquier archivo ilegible cae al tema por defecto: un tema corrupto no
  # puede impedir que la aplicacion abra.
  $path = Get-PokeGridThemePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return 'crystal-dark' }
  try {
    $key = ([IO.File]::ReadAllText($path) -split "`r?`n")[0].Trim()
    if (-not $key) { return 'crystal-dark' }
    if (-not $script:PokeGridThemeSettings.Contains($key)) { return 'crystal-dark' }
    return $key
  } catch { return 'crystal-dark' }
}

# ---------------------------------------------------------------------------
# Botones: region redondeada y los cinco estados por rol.
#
# Vive aqui y no en el guion para que la GUI y los tests compartan exactamente
# la misma implementacion.
# ---------------------------------------------------------------------------

$script:buttonStyles = @{}

function New-RoundedRegion([int]$Width, [int]$Height, [int]$Radius) {
  # PLANE tiene radio 0 y no gasta region: se devuelve null.
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
  } elseif ($role -eq 'ghost') {
    # Boton terciario: sin relleno, solo texto y borde al pasar por encima.
    # Antes caia en la rama por defecto y salia igual que 'secondary'.
    $base = Get-ThemeColor 'Surface.Soft'
    $hover = Get-ThemeColor 'Surface.Hover'
    $fore = Get-ThemeColor 'Text.Secondary'
    $pressed = Blend-Color $hover ([Drawing.Color]::Black) 0.12
    $border = Get-ThemeColor 'Border.Strong'
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

function Get-PokeGridThemeMotion([string]$Name) {
  # Lee una duracion de la tabla Motion del tema activo. Existe como funcion, y no
  # como acceso directo a $script:theme.Motion, porque los manejadores de evento de
  # WinForms se ejecutan en un ambito donde $script: no resuelve al ambito del guion.
  $motion = $script:theme.Motion
  if ($null -eq $motion) { return 120 }
  $value = $motion[$Name]
  if ($null -eq $value) { return 120 }
  return $value
}

function Get-ButtonStyleKey($button) {
  # La clave NO es GetHashCode(). Ese hash de un control WinForms CAMBIA cuando el
  # control recibe su handle: en esta maquina un boton pasa de 63161730 a 18198883
  # entre construirse y dibujarse. Set-ButtonRole guarda el estilo antes del handle
  # y el hover lo busca despues, con la otra clave: $buttonStyles[$clave] sale $null
  # y el manejador revienta con "No se puede indizar en una matriz nula" en cuanto
  # el raton pasa por encima de un boton.
  # RuntimeHelpers.GetHashCode da la identidad real del objeto y no cambia nunca.
  if ($null -eq $button) { return 0 }
  return [Runtime.CompilerServices.RuntimeHelpers]::GetHashCode($button)
}

function Set-ButtonRole($button, [string]$role) {
  $style = Get-ButtonRoleStyle $role
  $button.BackColor = $style.Base
  $button.ForeColor = $style.Fore
  $button.FlatAppearance.BorderColor = $style.Border
  $button.FlatAppearance.MouseDownBackColor = $style.Pressed
  $script:buttonStyles[(Get-ButtonStyleKey $button)] = @{ Role = $role; Style = $style }
  return $style
}

function Get-PokeGridEasing([string]$name, [double]$t) {
  # Curvas de interpolacion. Todas van de 0 a 1 y son monotonas: una curva que
  # retrocede hace que un boton "rebote" al entrar en vez de asentarse.
  # t se recorta en lugar de lanzar, para que un llamador con 1.5 no tumbe la app.
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

function Get-TextStyle([string]$level) {
  # Cinco niveles y ni uno mas. Antes el guion tenia quince tamanos sueltos
  # repartidos por las llamadas, y no se podia saber cual era el titulo y cual
  # un texto auxiliar sin mirar el numero.
  # Las familias se comprueban contra las instaladas: Bahnschrift y Cascadia Mono
  # vienen con Windows 10; Inter o Aptos NO estan y no se usan.
  switch ($level) {
    'display' { return [Drawing.Font]::new('Bahnschrift SemiBold', 22, [Drawing.FontStyle]::Bold) }
    'title'   { return [Drawing.Font]::new('Segoe UI Semibold', 13.5, [Drawing.FontStyle]::Bold) }
    'body'    { return [Drawing.Font]::new('Segoe UI', 9.5) }
    'label'   { return [Drawing.Font]::new('Segoe UI Semibold', 7.7, [Drawing.FontStyle]::Bold) }
    'mono'    { return [Drawing.Font]::new('Cascadia Mono', 8.6) }
    default   { return [Drawing.Font]::new('Segoe UI', 9.5) }
  }
}

function Get-GlassColor([string]$token, [double]$opacity = 0.14) {
  # El cristal es una mezcla del token contra el fondo de la ventana. WinForms no
  # pinta paneles con alfa por pixel, asi que esto NO es transparencia real: es
  # un color opaco que aparenta estar a esa fraccion de capa. La tridimensionalidad
  # la aporta el borde claro, no la mezcla.
  return (Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor $token) $opacity)
}

function New-CardShadow([int]$width, [int]$height) {
  # PLANE tiene Shadow.Depth 0 y no gasta panel de sombra.
  if ([int]$script:theme.Shadow.Depth -le 0) { return $null }
  $shadow = [Windows.Forms.Panel]::new()
  $shadow.Size = [Drawing.Size]::new($width, $height)
  $shadow.Location = [Drawing.Point]::new(0, [int]$script:theme.Shadow.Y)
  $shadow.BackColor = Get-GlassColor 'Surface.Soft' 0.55
  $shadow.Region = New-RoundedRegion $width $height ([int]$script:theme.Radius)
  return $shadow
}

function Apply-RoundedRegions($control) {
  # Se recorre el arbol entero porque el tamano de un boton no se conoce hasta
  # despues de que el contenedor lo ha colocado.
  if ($control -is [Windows.Forms.Button]) {
    $control.Region = New-RoundedRegion $control.Width $control.Height ([int]$script:theme.Radius)
  }
  # Las tarjetas llevan Tag='card' y comparten las esquinas de los botones: es
  # el mismo radio del tema, para que toda la interfaz tenga una sola medida.
  if ($control -is [Windows.Forms.Panel] -and $control.Tag -eq 'card') {
    $control.Region = New-RoundedRegion $control.Width $control.Height ([int]$script:theme.Radius)
  }
  foreach ($child in $control.Controls) { Apply-RoundedRegions $child }
}
