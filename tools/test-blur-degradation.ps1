$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes

# PLANE nunca pide blur.
Assert (-not $themes['flat'].Blur) 'PLANE no deberia pedir blur.'
$script:theme = $themes['flat']
Assert ((Resolve-PokeGridEffectiveTheme -BlurSupported $true).Kind -eq 'flat') 'PLANE debe seguir plano aun con soporte de blur.'

# Un tema de cristal sin soporte cae a plano, conservando clave y colores.
$script:theme = $themes['crystal-dark']
# Get-ThemeColor devuelve Drawing.Color; el token crudo del tema es la cadena
# '#RRGGBB'. Para comparar sin mezclar tipos se pasan los dos por hex.
function Hex($color) { return '{0:X2}{1:X2}{2:X2}' -f $color.R, $color.G, $color.B }
$beforeText = Hex (Get-ThemeColor 'Text.Primary')
$beforeBase = Hex (Get-ThemeColor 'Base')
$beforeSurface = Hex (Get-ThemeColor 'Surface.Base')
$effective = Resolve-PokeGridEffectiveTheme -BlurSupported $false
Assert ($effective.Kind -eq 'flat') 'Sin soporte de blur, un tema de cristal debe caer a plano.'
Assert (-not $effective.Blur) 'La variante de respaldo no debe seguir pidiendo blur.'
Assert ($effective.Key -eq 'crystal-dark') 'La variante debe conservar la clave, para no escribir otro tema al guardar.'
Assert ((Hex (Get-ThemeColor -Theme $effective -Path 'Text.Primary')) -eq $beforeText) 'Al caer a plano cambio el texto.'
Assert ((Hex (Get-ThemeColor -Theme $effective -Path 'Base')) -eq $beforeBase) 'Al caer a plano cambio el fondo.'
Assert ((Hex (Get-ThemeColor -Theme $effective -Path 'Surface.Base')) -eq $beforeSurface) 'Al caer a plano cambio la superficie.'

# Con soporte, el tema se queda como es.
foreach ($key in @('crystal-dark', 'crystal-light', 'midnight')) {
  $script:theme = $themes[$key]
  Assert ((Resolve-PokeGridEffectiveTheme -BlurSupported $true).Kind -eq 'glass') "$key con soporte deberia quedarse de cristal."
}

# La variante de respaldo tiene que SEGUIR SIENDO LEGIBLE: caer a plano no puede
# cambiar el contraste, y cambiar Kind no lo hace porque no toca los colores.
$script:theme = $themes['crystal-light']
$fallback = Resolve-PokeGridEffectiveTheme -BlurSupported $false
$ratio = Get-ContrastRatio (Get-ThemeColor -Theme $fallback -Path 'Text.Primary') (Get-ThemeColor -Theme $fallback -Path 'Surface.Base')
Assert ($ratio -ge 4.5) "El tema claro sin soporte queda en $([Math]::Round($ratio,2)):1 tras caer a plano."

# Activar el blur en un formulario real no puede romper la app, diga lo que diga.
$form = [Windows.Forms.Form]::new()
$form.ClientSize = [Drawing.Size]::new(600, 400)
$supported = $null
$failed = $false
try { $supported = Enable-PokeGridBlur $form } catch { $failed = $true }
Assert (-not $failed) 'Enable-PokeGridBlur lanzo en vez de degradar en silencio.'
Assert ($null -ne $supported) 'Enable-PokeGridBlur devolvio null en vez de un booleano.'
Assert (-not $form.IsDisposed) 'El formulario quedo destruido tras intentar el blur.'

# El P/Invoke se registra una sola vez: llamarlo dos veces no debe fallar.
$second = $null
try { $second = Enable-PokeGridBlur $form } catch { }
Assert ($null -ne $second) 'La segunda llamada a Enable-PokeGridBlur devolvio null.'

# PLANE ni siquiera intenta el P/Invoke.
$script:theme = $themes['flat']
$form2 = [Windows.Forms.Form]::new()
Assert ((Enable-PokeGridBlur $form2) -eq $false) 'Con PLANE el blur deberia desactivarse sin llamar al sistema.'
$form.Dispose(); $form2.Dispose()

# El guion engancha el blur antes de ShowDialog y avisa cuando cae a plano: sin
# ese aviso, el usuario ve una ventana sin cristal y no sabe por que.
$gui = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
Assert ($gui -match 'Enable-PokeGridBlur \$form') 'El guion no engancha el blur al formulario.'
Assert ($gui -match 'Resolve-PokeGridEffectiveTheme') 'El guion no resuelve el tema efectivo segun el soporte de blur.'
Assert ($gui -match 'no admite cristal') 'El guion no avisa al usuario cuando el cristal no se aplica.'

Write-Output 'Blur degradation passed: never throws, PLANE stays flat and never calls the system, an unsupported glass theme falls back keeping its key, colours and legibility, and the GUI announces the fallback.'
