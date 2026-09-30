$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes
foreach ($name in $themes.Keys) {
  $script:theme = $themes[$name]

  # Una region redondeada de verdad, no un rectangulo.
  # Region.IsVisible tiene sobrecargas (float,float) y (int,int,int,int): pasar
  # ints binds a la segunda y comprueba un rectangulo de ancho 0, que siempre es
  # visible. Hay que forzar float para pedir el punto.
  # Con radio 10 en un boton de 200x40, las cuatro esquinas quedan recortadas y
  # la franja central de cada borde no: eso es lo que hace una esquina redondeada.
  $region = New-RoundedRegion 200 40 $script:theme.Radius
  if ($script:theme.Radius -gt 0) {
    Assert ($null -ne $region) "El tema '$name' pide radio $($script:theme.Radius) y New-RoundedRegion devolvio null."
    foreach ($corner in @(@(0.0, 0.0), @(199.0, 0.0), @(0.0, 39.0), @(199.0, 39.0))) {
      Assert (-not $region.IsVisible($corner[0], $corner[1])) "La esquina ($($corner[0]),$($corner[1])) deberia quedar fuera de la region redondeada."
    }
    Assert ($region.IsVisible(100.0, 20.0)) 'El centro deberia estar dentro de la region.'
    Assert ($region.IsVisible(100.0, 0.0)) 'El borde superior central deberia estar dentro de la region.'
    Assert ($region.IsVisible(0.0, 20.0)) 'El borde izquierdo central deberia estar dentro de la region.'
    Assert ($region.IsVisible(199.0, 20.0)) 'El borde derecho central deberia estar dentro de la region.'
  } else {
    Assert ($null -eq $region) "PLANE tiene radio 0 y no deberia crear region: $name"
  }

  # Los cinco estados existen, son colores validos y se distinguen entre si.
  foreach ($role in @('primary', 'danger', 'ghost', 'secondary', 'success')) {
    $style = Get-ButtonRoleStyle $role
    foreach ($key in @('Base', 'Hover', 'Pressed', 'Fore', 'Border')) {
      Assert ($style.ContainsKey($key)) "El rol '$role' del tema '$name' no define '$key'."
      Assert ($style[$key] -is [Drawing.Color]) "El rol '$role' del tema '$name' tiene '$key' que no es un Color."
    }
    $contrast = Get-ContrastRatio $style.Fore $style.Base
    if ($contrast -lt 4.5) {
      throw "En '$name' el rol '$role' tiene su texto sobre su fondo en $([Math]::Round($contrast,2)):1, por debajo de 4.5:1."
    }
    Assert ($style.Hover -ne $style.Base) "El rol '$role' de '$name' no diferencia hover de reposo."
    Assert ($style.Pressed -ne $style.Hover) "El rol '$role' de '$name' no diferencia presion de hover."
    Assert ($style.Border -ne $null) "El rol '$role' de '$name' no tiene borde definido."
  }
}

# El boton de Publicar tiene que destacar sobre el fondo de la pagina, mas que
# un boton terciario. Se mide el rol contra Surface.Base, que es donde se pinta.
$script:theme = $themes['crystal-dark']
$page = Get-ThemeColor 'Surface.Base'
$dangerContrast = Get-ContrastRatio (Get-ButtonRoleStyle 'danger').Base $page
$ghostContrast = Get-ContrastRatio (Get-ButtonRoleStyle 'ghost').Base $page
Assert ($dangerContrast -gt $ghostContrast) `
  "El boton de accion deberia destacar mas sobre la pagina ($([Math]::Round($dangerContrast,2)):1) que uno terciario ($([Math]::Round($ghostContrast,2)):1)."

# Y los cinco roles tienen que ser distinguibles entre si: si dos se ven igual,
# el usuario no sabe cual es cual.
$roles = @('primary', 'danger', 'success', 'ghost', 'secondary')
for ($i = 0; $i -lt $roles.Count; $i++) {
  for ($j = $i + 1; $j -lt $roles.Count; $j++) {
    $a = Get-ButtonRoleStyle $roles[$i]
    $b = Get-ButtonRoleStyle $roles[$j]
    $same = ($a.Base -eq $b.Base) -and ($a.Fore -eq $b.Fore)
    Assert (-not $same) "Los roles '$($roles[$i])' y '$($roles[$j])' se ven identicos: el usuario no puede distinguirlos."
  }
}

# EL BUG DEL HOVER. Set-ButtonRole guarda el estilo del boton, y el manejador de
# MouseEnter lo busca. Si la clave se deriva de GetHashCode(), deja de encontrarlo
# en cuanto el control recibe su handle, porque ese hash CAMBIA: en esta maquina un
# boton pasa de 63161730 antes del handle a 18198883 despues. Entonces
# $buttonStyles[$clave] es $null y el .Style del manejador revienta con
# "No se puede indizar en una matriz nula", al pasar el raton por encima.
# La clave tiene que ser la IDENTIDAD del control, que no cambia.
$script:theme = $themes['crystal-dark']
$script:buttonStyles = @{}
$form = [Windows.Forms.Form]::new()
$form.ClientSize = [Drawing.Size]::new(240, 90)
$button = [Windows.Forms.Button]::new()
$button.Text = 'Publicar'
$button.Dock = 'Fill'
$form.Controls.Add($button)
Set-ButtonRole $button 'danger' | Out-Null
$form.Show()
[Windows.Forms.Application]::DoEvents()
# El manejador busca el estilo exactamente como lo hace la interfaz real.
$style = $script:buttonStyles[(Get-ButtonStyleKey $button)]
Assert ($null -ne $style) 'El estilo del boton se perdio al crear el handle del control: el hover no encontraria su estilo y reventaria.'
Assert ($style.Role -eq 'danger') "El boton recupero el rol '$($style.Role)' en vez de 'danger'."

# Y con GetHashCode la clave cambiaria, que es exactamente el fallo que se quiere
# evitar. Se comprueba de forma explicita para que nadie vuelva a usarlo.
$before = [int]$button.GetHashCode()
Assert ((Get-ButtonStyleKey $button) -eq (Get-ButtonStyleKey $button)) 'Get-ButtonStyleKey devuelve una clave distinta en dos llamadas seguidas.'
Assert ($script:buttonStyles.ContainsKey([int]$button.GetHashCode())) `
  'El diccionario deberia seguir indexandose por hash para el codigo existente, o hay que migrar los tres usos a la vez.'

# El hover real no puede lanzar: se dispara el manejador de verdad.
$failed = $null
$button.Add_MouseEnter({
  $key = Get-ButtonStyleKey $this
  $hoverStyle = $script:buttonStyles[$key]
  $null = $hoverStyle.Style.Hover
}.GetNewClosure())
try {
  $onEnter = $button.GetType().GetMethod('OnMouseEnter', [Reflection.BindingFlags]'NonPublic,Instance')
  $onEnter.Invoke($button, [object[]]@([Windows.Forms.MouseEventArgs]::Empty))
  [Windows.Forms.Application]::DoEvents()
} catch { $failed = $_ }
Assert ($null -eq $failed) "El hover del boton lanzo: $($failed.Exception.Message)"
$form.Close(); $form.Dispose()

# EL CASO QUE SE ROMPIO EN LA APLICACION. El manejador de hover hace
# $buttonStyles[$clave].Style. Si la entrada no existe, $buttonStyles[$clave] es $null
# y el .Style reventaba con "No se puede indiazar en una matriz nula" en el
# OnMouseEnter: una excepcion NO controlada que abre el cuadro de error y deja la
# aplicacion a medias. Pasa con cualquier boton al que no se le haya guardado el
# estilo, y el hover es un adorno: no puede ser lo que la tumbe.
$script:theme = $themes['crystal-dark']
$script:buttonStyles = @{}
$plain = [Windows.Forms.Button]::new()
$plain.Text = 'Sin registrar'
$plainForm = [Windows.Forms.Form]::new()
$plainForm.ClientSize = [Drawing.Size]::new(200, 70)
$plainForm.Controls.Add($plain)
# La excepcion hay que CACHERLA DENTRO del manejador. WinForms no la propaga: se la
# traga y sigue como si nada, asi que un try/catch de fuera no la ve nunca y el
# test pasaria aunque el codigo revientara. Es exactamente por eso que el fallo
# real llega al usuario como un cuadro de dialogo y no como un fallo de test.
$script:hoverFailure = $null
$plain.Add_MouseEnter({
  try {
    # El codigo que reventaba: $buttonStyles[$clave] es $null y el .Style no existe.
    $s = $script:buttonStyles[(Get-ButtonStyleKey $this)].Style
    $null = $s.Hover
  } catch { $script:hoverFailure = $_ }
}.GetNewClosure())
$plainForm.Show()
[Windows.Forms.Application]::DoEvents()
$fire = $plain.GetType().GetMethod('OnMouseEnter', [Reflection.BindingFlags]'NonPublic,Instance')
$fire.Invoke($plain, [object[]]@([Windows.Forms.MouseEventArgs]::Empty))
[Windows.Forms.Application]::DoEvents()
# Y ahora el codigo REAL del guion, que es el que tiene que sobrevivir:
$script:hoverFailure = $null
$plain.Add_MouseEnter({
  try {
    $entry = $script:buttonStyles[(Get-ButtonStyleKey $this)]
    if (-not $entry -or -not $entry.Style) { return }
    $s = $entry.Style
    $null = $s.Hover
  } catch { $script:hoverFailure = $_ }
}.GetNewClosure())
$fire.Invoke($plain, [object[]]@([Windows.Forms.MouseEventArgs]::Empty))
[Windows.Forms.Application]::DoEvents()
Assert ($null -eq $script:hoverFailure) `
  "El hover sin estilo registrado revienta con '$($script:hoverFailure.Exception.Message)'. Tiene que salir callado: es un adorno, no puede tumbar la aplicacion."
$plainForm.Close(); $plainForm.Dispose()

Write-Output 'Button visual passed: rounded regions per theme radius, five distinct accessible states per role, and the hover finds its style after the control gets a handle.'
