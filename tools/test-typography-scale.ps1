$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
$root = Split-Path -Parent $PSScriptRoot
$gui = Get-Content -LiteralPath (Join-Path $root 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

# Los cinco niveles existen y devuelven fuentes reales.
$levels = @('display', 'title', 'body', 'label', 'mono')
foreach ($level in $levels) {
  $font = Get-TextStyle $level
  Assert ($null -ne $font) "Falta el nivel tipografico '$level'."
  Assert ($font -is [Drawing.Font]) "Get-TextStyle '$level' no devolvio una Drawing.Font, devolvio $($font.GetType().Name)."
  Assert ($font.Size -gt 0) "Get-TextStyle '$level' devuelve un tamaño de $($font.Size)."
  Assert (-not [string]::IsNullOrWhiteSpace($font.Name)) "Get-TextStyle '$level' no indica familia de fuente."
}

# Los cinco niveles son distintos entre si: una escala de un solo tamaño no es escala.
$seen = @{}
foreach ($level in $levels) {
  $key = (Get-TextStyle $level).Name + '|' + (Get-TextStyle $level).Size
  if ($seen.ContainsKey($key)) { throw "El nivel '$level' es identico a '$($seen[$key])': la escala no tiene cinco niveles distintos." }
  $seen[$key] = $level
}

# Todas las familias existen en ESTA maquina: si falta una, sale la del sistema
# y la interfaz se ve distinta de lo previsto sin que nada avise.
$installed = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
foreach ($family in (Get-TextStyle $level).Name) { }
foreach ($level in $levels) {
  $font = Get-TextStyle $level
  Assert ($installed -contains $font.Name) "La fuente '$($font.Name)' del nivel '$level' no esta instalada en esta maquina."
}

# El titulo de la app tiene que ser el mayor, y la etiqueta el menor.
Assert ((Get-TextStyle 'display').Size -gt (Get-TextStyle 'title').Size) 'El titulo deberia ser mayor que el titulo de seccion.'
Assert ((Get-TextStyle 'title').Size -gt (Get-TextStyle 'body').Size) 'El titulo de seccion deberia ser mayor que el cuerpo.'
Assert ((Get-TextStyle 'body').Size -gt (Get-TextStyle 'label').Size) 'El cuerpo deberia ser mayor que la etiqueta de campo.'

# Ya no quedan tamanos arbitrarios en el guion: solo los cinco de la escala.
# La regex exige comilla despues de New-Label: la DEFINICION de la funcion
# (function New-Label(...)) no la tiene, y sin esa exigencia el emparejamiento
# empieza en la definicion y nunca captura el numero.
$arbitrary = [regex]::Matches($gui, "New-Label\s+'([^']*)'\s+([0-9]+(?:\.[0-9]+)?)")
if ($arbitrary.Count -eq 0) { throw 'No se encontro ninguna llamada New-Label con tamano: la escala no se aplico.' }
$allowed = @('22', '13.5', '9.5', '7.7', '8.6')
$offenders = @()
foreach ($match in $arbitrary) {
  if ($allowed -notcontains $match.Groups[2].Value) { $offenders += $match.Groups[2].Value }
}
if ($offenders.Count) {
  $unique = ($offenders | Sort-Object -Unique) -join ', '
  throw "Quedan tamanos de fuente fuera de la escala de 5 niveles: $unique"
}

# Y ningun control de TEXTO crea su fuente con un tamano suelto fuera de
# Get-TextStyle. Se excluyen Segoe UI Emoji (los iconos, que T7 sustituye por
# vectores) y Cascadia Mono, que es la fuente del nivel mono por nombre.
$stray = [regex]::Matches($gui, "Font\]::new\('(Segoe UI|Segoe UI Semibold)',\s*([0-9]+(?:\.[0-9]+)?)")
foreach ($match in $stray) {
  $size = $match.Groups[2].Value
  if ($allowed -notcontains $size) { throw "Font::new con tamano '$size' fuera de la escala: $($match.Groups[1].Value)." }
}

# El nivel mono tiene que existir y ser Cascadia Mono: es la fuente del log.
Assert ((Get-TextStyle 'mono').Name -eq 'Cascadia Mono') 'El nivel mono deberia usar Cascadia Mono.'

# Una etiqueta con un nivel grande necesita alto suficiente, o el texto se
# recorta. El nombre del script en la vista previa estaba a 28 px con la fuente
# de cuerpo y paso a nivel title: 22 px de alto calculados en 28 no van juntos.
# El factor 96/72*1.2 es la conversion de puntos a pixeles con DPI 96 y el interlineado
# de Segoe UI, medido con GDI+ en esta maquina.
function Get-RequiredHeightPx([string]$level) {
  return [Math]::Ceiling((Get-TextStyle $level).Size * (96.0 / 72.0) * 1.2)
}
$titlePx = Get-RequiredHeightPx 'title'
Assert ($titlePx -ge 20) "El nivel title necesita $(Get-RequiredHeightPx 'title') px, por debajo de 20."
$previewHeight = [regex]::Match($gui, '\$previewName\.Height=(\d+)').Groups[1].Value
if ($previewHeight) {
  Assert ([int]$previewHeight -ge $titlePx) `
    "La etiqueta del nombre del script mide $previewHeight px y el nivel body necesita $(Get-RequiredHeightPx 'body') px: se recorta."
}

Write-Output 'Typography scale passed: five named levels, installed families only, distinct sizes, no arbitrary sizes left.'
