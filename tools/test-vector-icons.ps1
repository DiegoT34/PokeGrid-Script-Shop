$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$uiFile = Join-Path $PSScriptRoot 'ui.ps1'
if (-not (Test-Path -LiteralPath $uiFile -PathType Leaf)) {
  throw "No existe ${uiFile}: los iconos vectoriales se prueban antes de existir."
}
. (Join-Path $PSScriptRoot 'theme.ps1')
. $uiFile
$root = Split-Path -Parent $PSScriptRoot
$gui = Get-Content -LiteralPath (Join-Path $root 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$script:theme = Get-PokeGridTheme 'crystal-dark'

$names = Get-PokeGridIconNames
Assert ($names.Count -eq 7) "Se esperaban 7 iconos y hay $($names.Count): $($names -join ', ')"
foreach ($name in @('script', 'rocket', 'palette', 'globe', 'dna', 'egg', 'basket')) {
  Assert ($names -contains $name) "Falta el icono '$name'."
  $path = Get-PokeGridIconPath $name
  Assert ($null -ne $path) "El icono '$name' no devolvio una GraphicsPath."
  $bounds = $path.GetBounds()
  Assert ($bounds.Width -gt 0 -and $bounds.Height -gt 0) "El icono '$name' tiene una ruta vacia."
  # Cabe en un cuadrado de 24x24 con margen: es como se dibuja.
  Assert ($bounds.Width -le 24 -and $bounds.Height -le 24) "El icono '$name' no cabe en 24x24: $([Math]::Round($bounds.Width,1))x$([Math]::Round($bounds.Height,1))"
  Assert ($path.PointCount -ge 2) "El icono '$name' tiene solo $($path.PointCount) punto(s)."
}

# Un nombre desconocido devuelve null en vez de romper: un icono mal escrito se
# ve como un hueco, y la app sigue arrancando.
Assert ($null -eq (Get-PokeGridIconPath 'no-existe')) 'Un icono desconocido deberia devolver null.'

# Cada icono se dibuja de verdad, sin excepciones, y produce imagen no vacia.
foreach ($name in $names) {
  $box = New-IconPictureBox $name 18
  Assert ($null -ne $box) "New-IconPictureBox '$name' devolvio null."
  Assert ($null -ne $box.Image) "El icono '$name' no genero imagen."
  # La imagen tiene que tener pixeles pintados: un icono en blanco sobre blanco
  # no se veria y el test pasaria si solo comprobara que existe.
  $painted = 0
  for ($y = 0; $y -lt $box.Image.Height; $y += 2) {
    for ($x = 0; $x -lt $box.Image.Width; $x += 2) {
      if ($box.Image.GetPixel($x, $y).A -gt 0) { $painted++ }
    }
  }
  Assert ($painted -gt 0) "El icono '$name' genero una imagen totalmente vacia."
  Assert ($painted -lt 400) "El icono '$name' pinta casi todo el cuadrado, no tiene forma reconocible."
  $box.Image.Dispose(); $box.Dispose()
}

# Quedan emojis en el guion.
$emoji = [regex]::Matches($gui, '[\uD83C-\uDBFF][\uDC00-\uDFFF]')
if ($emoji.Count) {
  throw "Quedan $($emoji.Count) emoji en el guion: hay que sustituirlos por iconos vectoriales."
}

# Los siete iconos tienen que ser distinguibles entre si: dos siluetas iguales
# hacen que el usuario no sepa cual esta mirando. Se comparan las cajas y el
# numero de puntos de cada ruta.
$shapes = @{}
foreach ($name in $names) {
  $path = Get-PokeGridIconPath $name
  $b = $path.GetBounds()
  $key = '{0}x{1}/{2}' -f [Math]::Round($b.Width), [Math]::Round($b.Height), $path.PointCount
  if ($shapes.ContainsKey($key)) {
    throw "Los iconos '$($shapes[$key])' y '$name' tienen la misma silueta ($key): no se distinguen."
  }
  $shapes[$key] = $name
}

Write-Output "Vector icons passed: seven named paths that fit 24x24, every one renders non-empty, all seven distinguishable, no emoji left."
