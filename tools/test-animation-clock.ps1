$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'theme.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
$script:theme = Get-PokeGridTheme 'crystal-dark'
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

# Curvas: ancladas en los extremos, siempre en 0..1 y monotonas.
foreach ($curve in @('linear', 'easeOutCubic', 'easeInOutQuad', 'easeOutQuad')) {
  Assert ([Math]::Abs((Get-PokeGridEasing $curve 0.0) - 0.0) -lt 0.0001) "$curve en t=0 deberia dar 0."
  Assert ([Math]::Abs((Get-PokeGridEasing $curve 1.0) - 1.0) -lt 0.0001) "$curve en t=1 deberia dar 1."
  $previous = -1.0
  foreach ($t in 0.0, 0.25, 0.5, 0.75, 1.0) {
    $value = Get-PokeGridEasing $curve $t
    Assert ($value -ge -0.0001 -and $value -le 1.0001) "$curve devolvio $value en t=$t, fuera de 0..1."
    Assert ($value -ge $previous - 0.0001) "$curve no es monotona: $previous -> $value en t=$t."
    $previous = $value
  }
  # Fuera de rango se recorta, no lanza.
  Assert ([Math]::Abs((Get-PokeGridEasing $curve -0.5) - 0.0) -lt 0.0001) "$curve con t negativo deberia recortar a 0."
  Assert ([Math]::Abs((Get-PokeGridEasing $curve 1.5) - 1.0) -lt 0.0001) "$curve con t>1 deberia recortar a 1."
}
# easeOutCubic adelanta: en la mitad del tiempo ya recorrio mas de la mitad.
Assert ((Get-PokeGridEasing 'easeOutCubic' 0.5) -gt 0.7) 'easeOutCubic deberia adelantarse en t=0.5.'
# easeInOutQuad arranca lento: en el cuarto del tiempo apenas ha empezado.
Assert ((Get-PokeGridEasing 'easeInOutQuad' 0.25) -lt 0.2) 'easeInOutQuad deberia arrancar lento en t=0.25.'

# Un reloj, no N temporizadores.
Stop-PokeGridAnimation -All
Assert ((Get-PokeGridAnimationCount) -eq 0) 'Empezaron a haber animaciones sin limpiarlas.'
Initialize-PokeGridAnimationClock
Assert ($null -ne $script:animationClock) 'El reloj de animaciones no se creo.'
# 10 ms, no 16: medido en esta maquina, 16 da 19 ticks de los 31 teoricos porque
# el reloj del sistema va a ~15.6 ms y el intervalo cae justo encima.
Assert ($script:animationClock.Interval -eq 10) "El reloj deberia ir a 10 ms, va a $($script:animationClock.Interval)."
Assert ($script:animationClock.Enabled) 'El reloj deberia estar arrancado.'

# Dos objetivos distintos conviven.
Start-PokeGridAnimation 'boton' { param($p) } 120 | Out-Null
Start-PokeGridAnimation 'tarjeta' { param($p) } 180 | Out-Null
Assert ((Get-PokeGridAnimationCount) -eq 2) "Dos animaciones distintas deberian convivir, hay $((Get-PokeGridAnimationCount))."

# Relanzar sobre el mismo objetivo reemplaza, no acumula: un hover seguido de un
# clic no puede dejar el control a medias.
Start-PokeGridAnimation 'boton' { param($p) } 200 | Out-Null
Assert ((Get-PokeGridAnimationCount) -eq 2) "Relanzar sobre el mismo objetivo deberia reemplazar: hay $((Get-PokeGridAnimationCount))."

Stop-PokeGridAnimation 'boton'
Assert ((Get-PokeGridAnimationCount) -eq 1) 'Cancelar un objetivo deberia dejar el resto vivo.'
Stop-PokeGridAnimation 'tarjeta'
Assert ((Get-PokeGridAnimationCount) -eq 0) 'No quedan animaciones vivas.'

# Duracion 0: se resuelve al instante, sin tocar el reloj. Es lo que hace PLANE.
$done = $false
$progress = $null
Start-PokeGridAnimation 'instantanea' { param($p) $script:lastProgress = $p } 0 { $script:doneRan = $true } | Out-Null
Assert ($script:doneRan) 'Una animacion de 0 ms deberia ejecutar su final.'
Assert ([Math]::Abs($script:lastProgress - 1.0) -lt 0.0001) "Una animacion de 0 ms deberia entregar progreso 1.0, entrego $($script:lastProgress)."
Assert ((Get-PokeGridAnimationCount) -eq 0) 'Una animacion de 0 ms no deberia quedarse registrada.'

# PLANE no anima: su Motion es 0 en los tres niveles.
$script:theme = Get-PokeGridTheme 'flat'
foreach ($level in @('Fast', 'Normal', 'Slow')) {
  Assert ($script:theme.Motion.$level -eq 0) "PLANE deberia tener Motion.$level en 0."
}
$script:theme = Get-PokeGridTheme 'crystal-dark'

# Un paso que lanza no detiene el reloj ni las demas animaciones.
Start-PokeGridAnimation 'rota' { param($p) throw 'fallo intencional del test' } 120 | Out-Null
Start-PokeGridAnimation 'sana' { param($p) } 120 | Out-Null
Assert ((Get-PokeGridAnimationCount) -eq 2) 'Un paso que lanza no deberia borrar las demas animaciones.'
Stop-PokeGridAnimation -All

# El reloj tiene que AVANZAR de verdad. System.Windows.Forms.Timer solo dispara
# cuando hay un bucle de mensajes activo, igual que hace ShowDialog en la app.
# Sin esta comprobacion, un reloj que no tickea pasa todos los tests anteriores.
Initialize-PokeGridAnimationClock
$form = [Windows.Forms.Form]::new()
$form.Show()
$script:tickCount = 0
$script:animationClock.Add_Tick({ $script:tickCount++ })
$watch = [Diagnostics.Stopwatch]::StartNew()
# Sin Start-Sleep: el propio DoEvents bombea la cola de mensajes y el Timer
# dispara con normalidad. Añadir una espera aqui compite con el reloj y lo
# estrangula, midiendo el fallo del test en vez del comportamiento real.
# Se mide 1 s, no 500 ms: el reloj se crea justo antes del bucle y su primer
# tick llega tarde, asi que una ventana corta mide el arranque, no el regimen.
while ($watch.ElapsedMilliseconds -lt 1000) { [Windows.Forms.Application]::DoEvents() }
$watch.Stop()
$form.Close(); $form.Dispose()
Assert ($script:tickCount -ge 40) `
  "El reloj dio solo $($script:tickCount) ticks en 1 s; medidos 56 en regimen, hacen falta unos 40 para que una animacion se vea fluida."
Stop-PokeGridAnimation -All

Write-Output "Animation clock passed: monotonic easing, one 10 ms clock ticking, replace-not-stack, zero-duration completes instantly, and a throwing step is contained."
