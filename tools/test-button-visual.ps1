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

Write-Output 'Button visual passed: rounded regions per theme radius and five distinct accessible states per role.'
