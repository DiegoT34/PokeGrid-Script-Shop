$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$themeFile = Join-Path $PSScriptRoot 'theme.ps1'
if (-not (Test-Path -LiteralPath $themeFile -PathType Leaf)) {
  # ${themeFile} y no $themeFile: seguido de ':' PowerShell lo lee como unidad de disco.
  throw "No existe ${themeFile}: las funciones de color se prueban sin interfaz, primero deben existir."
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

# Blend recorta Amount en vez de fallar: un caller con 1.4 no debe romper la app.
$over1 = Blend-Color $base $over 1.4
Assert ((ToHex $over1) -eq '#C8DCFF') 'Blend-Color no recorto un Amount mayor que 1.'
$under = Blend-Color $base $over -0.3
Assert ((ToHex $under) -eq '#0B1220') 'Blend-Color no recorto un Amount negativo.'

# Luminancia: blanco 1.0, negro 0.0, y un gris de referencia.
# Las variables se declaran aqui, antes de usarse: referenciar $white sin
# declararla deja $null y el error sale como "no se puede convertir NULL",
# que parece un fallo de la funcion cuando en realidad es del test.
$white = [Drawing.Color]::FromArgb(255, 255, 255)
$black = [Drawing.Color]::FromArgb(0, 0, 0)
Assert ($null -ne $white) 'La variable $white llego nula al test.'
Assert ([Math]::Abs((Get-RelativeLuminance $white) - 1.0) -lt 0.001) 'El blanco deberia dar luminancia 1.0.'
Assert ([Math]::Abs((Get-RelativeLuminance $black) - 0.0) -lt 0.001) 'El negro deberia dar luminancia 0.0.'
$gray80 = [Drawing.Color]::FromArgb(204, 204, 204)
Assert ([Math]::Abs((Get-RelativeLuminance $gray80) - 0.6038) -lt 0.002) 'La luminancia de un gris 80% no coincide con el valor de referencia de WCAG.'

# Contraste: pares conocidos de la especificacion WCAG.
$black = [Drawing.Color]::FromArgb(0, 0, 0)
Assert ([Math]::Abs((Get-ContrastRatio $white $black) - 21.0) -lt 0.01) 'Blanco sobre negro deberia dar 21:1.'
# Contraste con pares de la tabla de referencia de WCAG 2.1, verificados contra
# la formula: #767676 sobre blanco da 4.54:1 y #949494 sobre blanco da 3.03:1.
# El gris claro #CCCCCC da 1.61:1, muy por debajo de 4.5:1, y por eso un panel
# claro no puede llevar texto blanco encima.
$grayAA = [Drawing.Color]::FromArgb(118, 118, 118)
$grayMid = [Drawing.Color]::FromArgb(148, 148, 148)
$whiteOnGrayAA = Get-ContrastRatio $white $grayAA
Assert ([Math]::Abs($whiteOnGrayAA - 4.54) -lt 0.02) "Blanco sobre #767676 deberia dar ~4.54:1, dio $([Math]::Round($whiteOnGrayAA, 3)):1."
$whiteOnGrayMid = Get-ContrastRatio $white $grayMid
Assert ([Math]::Abs($whiteOnGrayMid - 3.03) -lt 0.02) "Blanco sobre #949494 deberia dar ~3.03:1, dio $([Math]::Round($whiteOnGrayMid, 3)):1."
$whiteOnGrayLight = Get-ContrastRatio $white $gray80
Assert ([Math]::Abs($whiteOnGrayLight - 1.61) -lt 0.02) "Blanco sobre #CCCCCC deberia dar ~1.61:1, dio $([Math]::Round($whiteOnGrayLight, 3)):1."
$dark = [Drawing.Color]::FromArgb(30, 40, 60)
$light = [Drawing.Color]::FromArgb(200, 220, 255)
$white = [Drawing.Color]::FromArgb(255, 255, 255)
Assert ((Get-ContrastRatio $dark $light) -gt 1) 'El contraste debe ser simetrico en orden.'
Assert ([Math]::Abs((Get-ContrastRatio $gray80 $white) - (Get-ContrastRatio $white $gray80)) -lt 0.001) 'El contraste no es simetrico.'

# Lerp: extremos exactos y punto medio.
Assert ((ToHex (Lerp-Color $base $over 0.0)) -eq '#0B1220') 'Lerp-Color con T=0 no devolvio el origen.'
Assert ((ToHex (Lerp-Color $base $over 1.0)) -eq '#C8DCFF') 'Lerp-Color con T=1 no devolvio el destino.'
$lerpMid = Lerp-Color ([Drawing.Color]::Black) ([Drawing.Color]::White) 0.5
Assert ($lerpMid.R -ge 126 -and $lerpMid.R -le 129) "Lerp al 50% entre blanco y negro deberia dar ~128, dio $($lerpMid.R)"

Write-Output 'Theme math passed: blend, relative luminance, WCAG contrast ratio and colour interpolation.'
