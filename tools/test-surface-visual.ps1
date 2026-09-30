$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

function Distance([Drawing.Color]$a, [Drawing.Color]$b) {
  return [Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B)
}

$themes = Get-PokeGridThemes
foreach ($name in $themes.Keys) {
  $script:theme = $themes[$name]
  $base = Get-ThemeColor 'Base'
  $surface = Get-ThemeColor 'Surface.Raised'

  # El cristal es una mezcla: se parece mas al fondo que a la superficie pura.
  # Si se pareciese mas a la superficie, el panel se veria como un bloque opaco
  # y no como una capa de cristal.
  $glass = Get-GlassColor 'Surface.Raised' 0.14
  $distanceToBase = Distance $glass $base
  $distanceToSurface = Distance $glass $surface
  Assert ($distanceToBase -lt $distanceToSurface) `
    "El cristal de '$name' no se parece mas al fondo ($distanceToBase) que a la superficie ($distanceToSurface): se veria opaco."

  # Subir el alfa acerca el panel a la superficie pura: eso da la sensacion de
  # capas apiladas. La propiedad que importa es que la distancia a la superficie
  # BAJE al subir el alfa, no que supere a la distancia al fondo en esa mezcla.
  $distanceAt014 = Distance $glass $surface
  $distanceAt060 = Distance (Get-GlassColor 'Surface.Raised' 0.60) $surface
  Assert ($distanceAt060 -lt $distanceAt014) `
    "En '$name' subir el alfa a 0.60 deberia acercar el panel a la superficie: distancia $distanceAt014 -> $distanceAt060."
  Assert ((Distance (Get-GlassColor 'Surface.Raised' 1.0) $surface) -eq 0) `
    "Con alfa 1.0 el panel de '$name' deberia ser la superficie pura."

  # El cristal tiene que seguir siendo legible: el texto principal sobre el panel
  # tiene que pasar 4.5:1 aunque el panel este mezclado.
  $ratio = Get-ContrastRatio (Get-ThemeColor 'Text.Primary') $glass
  Assert ($ratio -ge 4.5) "En '$name' el texto principal sobre el cristal queda en $([Math]::Round($ratio,2)):1, por debajo de 4.5:1."

  # PLANE no proyecta sombra porque no hay nada que elevarlo.
  if ($script:theme.Kind -eq 'flat') {
    Assert ((New-CardShadow 300 200) -eq $null) "PLANE no deberia crear sombra: $name"
  } else {
    $shadow = New-CardShadow 300 200
    Assert ($null -ne $shadow) "El tema '$name' proyecta sombra y New-CardShadow devolvio null."
    $expectedY = [int]$script:theme.Shadow.Y
    Assert ($shadow.Top -eq $expectedY) "La sombra de '$name' deberia ir $expectedY px hacia abajo, fue a $($shadow.Top)."
    Assert ($shadow.BackColor -ne [Drawing.Color]::Empty) "La sombra de '$name' quedo sin color de fondo."
    Assert ($null -ne $shadow.Region) "La sombra de '$name' deberia tener las mismas esquinas redondeadas que la tarjeta."
  }
}

Write-Output 'Surface visual passed: glass is a blend toward the base, higher alpha reads as a layer, text stays readable on it, and PLANE casts no shadow.'
