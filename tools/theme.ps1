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
    if ($cursor -is [hashtable]) {
      if (-not $cursor.ContainsKey($segment)) { $cursor = $null; break }
      $cursor = $cursor[$segment]
    } elseif ($cursor.PSObject.Properties[$segment]) {
      $cursor = $cursor.PSObject.Properties[$segment].Value
    } else { $cursor = $null; break }
  }
  if ($null -eq $cursor -or $cursor -is [string]) {
    if ($Fallback) { return [Drawing.ColorTranslator]::FromHtml($Fallback) }
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
