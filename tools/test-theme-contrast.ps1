$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes

# Los 9 pares de texto sobre superficie, en los 4 temas.
$surfacePairs = @(
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
foreach ($name in $themes.Keys) {
  $theme = $themes[$name]
  foreach ($pair in $surfacePairs) {
    $ratio = Get-ContrastRatio (Get-ThemeColor -Theme $theme -Path $pair[0]) (Get-ThemeColor -Theme $theme -Path $pair[1])
    if ($ratio -lt $pair[2]) {
      $failures.Add("$name : $($pair[0]) sobre $($pair[1]) = $([Math]::Round($ratio,2)):1, minimo $($pair[2]):1")
    }
  }
}

# En un tema claro, el texto DE LECTURA tiene que ser oscuro. Los Fore de los
# botones si son blancos a proposito: van sobre azul/rojo/verde oscuros y eso ya
# esta cubierto en los 9 pares de arriba. Comprobar el Fore del boton contra la
# superficie de la pagina daria falsos positivos.
$light = $themes['crystal-light']
$lightReading = @('Text.Primary', 'Text.Secondary', 'Text.Disabled')
foreach ($token in $lightReading) {
  $color = Get-ThemeColor -Theme $light -Path $token
  $luminance = Get-RelativeLuminance $color
  if ($luminance -gt 0.5) {
    $failures.Add("crystal-light : $token es claro (luminancia $([Math]::Round($luminance,3))) y sobre un tema claro seria ilegible")
  }
}

# Y al reves: en los temas oscuros, el texto de lectura tiene que ser claro.
foreach ($name in @('crystal-dark', 'midnight', 'flat')) {
  $theme = $themes[$name]
  $color = Get-ThemeColor -Theme $theme -Path 'Text.Primary'
  $luminance = Get-RelativeLuminance $color
  if ($luminance -lt 0.5) {
    $failures.Add("$name : Text.Primary es oscuro (luminancia $([Math]::Round($luminance,3))) y sobre un tema oscuro seria ilegible")
  }
}

if ($failures.Count) {
  foreach ($f in $failures) { Write-Host "  FALLA  $f" -ForegroundColor Red }
  throw "Contraste insuficiente en $($failures.Count) par(es)."
}

Write-Output 'Theme contrast passed: nine text/background pairs readable in all four themes, and light theme never puts white text on a light surface.'
