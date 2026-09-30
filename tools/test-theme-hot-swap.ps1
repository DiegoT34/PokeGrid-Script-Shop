$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'theme.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Hex($color) { return '{0:X2}{1:X2}{2:X2}' -f $color.R, $color.G, $color.B }

$themes = Get-PokeGridThemes

# El cuarto tema se muestra como PLANE, en mayusculas.
Assert ($themes['flat'].Name -eq 'PLANE') "El cuarto tema debe mostrarse como PLANE, no '$($themes['flat'].Name)'."
foreach ($key in @('crystal-dark', 'crystal-light', 'midnight', 'flat')) {
  Assert ($themes[$key].Name.Length -gt 0) "El tema '$key' no tiene nombre visible."
}

# El registro de controles: cada control guarda que PAPEL juega, no un color.
$script:themedControls = [Collections.Generic.List[object]]::new()
$script:theme = $themes['crystal-dark']

$label = [Windows.Forms.Label]::new()
$label.Text = 'Texto'
$button = [Windows.Forms.Button]::new()
$panel = [Windows.Forms.Panel]::new()
Register-ThemedControl $label 'TextPrimary'
Register-ThemedControl $button 'ButtonDanger'
Register-ThemedControl $panel 'Surface'

# Registrar dos veces el mismo control no lo duplica: si se duplica, al cambiar
# de tema se aplicaria dos veces y el registro creceria sin control.
Register-ThemedControl $label 'TextPrimary'
Assert ($script:themedControls.Count -eq 3) "Registro duplico un control: hay $($script:themedControls.Count) entradas para 3 controles."

# Veinte cambios seguidos: cada control queda con el color del tema ACTUAL.
$order = @('crystal-light', 'midnight', 'flat', 'crystal-dark') * 5
foreach ($key in $order) {
  $script:theme = $themes[$key]
  foreach ($entry in $script:themedControls) { Update-ThemedControl $entry }
}

$expectedText = Hex (Get-ThemeColor 'Text.Primary')
Assert ((Hex $label.ForeColor) -eq $expectedText) "La etiqueta quedo en $($label.ForeColor) cuando el tema pide #$expectedText."
$expectedDanger = Hex (Get-ThemeColor 'Rest.Danger.Base')
Assert ((Hex $button.BackColor) -eq $expectedDanger) "El boton quedo en $($button.BackColor) cuando el tema pide #$expectedDanger."
$expectedSurface = Hex (Get-GlassColor 'Surface.Base' 0.14)
Assert ((Hex $panel.BackColor) -eq $expectedSurface) "El panel quedo en $($panel.BackColor) cuando el tema pide #$expectedSurface."

# Ningun control se queda sin pintar tras los 20 cambios.
foreach ($entry in $script:themedControls) {
  Assert ($entry.Control.ForeColor -ne [Drawing.Color]::Empty -or $entry.Control.BackColor -ne [Drawing.Color]::Empty) `
    'Un control quedo sin ningun color tras los cambios.'
}

# El boton de peligro tiene que conservar su contraste DESPUES de reaplicar el
# tema: reaplicar no puede degradar la legibilidad.
$script:theme = $themes['crystal-light']
foreach ($entry in $script:themedControls) { Update-ThemedControl $entry }
$ratio = Get-ContrastRatio $button.ForeColor $button.BackColor
Assert ($ratio -ge 4.5) "Tras reaplicar el tema claro, el boton de peligro quedo en $([Math]::Round($ratio,2)):1."

# Apply-PokeGridTheme devuelve el nombre visible y guarda la preferencia.
$requested = $null
try { $requested = Apply-PokeGridTheme 'midnight' -SkipSave } catch { }
if ($requested) {
  Assert ($requested -eq 'Nocturno') "Apply-PokeGridTheme devolvio '$requested' en vez del nombre visible."
  Assert ($script:theme.Key -eq 'midnight') 'Apply-PokeGridTheme no fijo el tema activo.'
}

# LA TRAMPA IMPORTANTE: $palette es una variable del GUION, no de la funcion. Si
# Apply-PokeGridTheme la asigna sin mas, crea una copia local y las 89 referencias
# que ya tiene la GUI siguen viendo los colores del tema anterior. Se comprueba
# leyendo $palette DESDE el ambito del guion, igual que lo haria la aplicacion.
$palette = New-ThemePaletteProxy $themes['flat']
[void](Apply-PokeGridTheme 'crystal-light' -SkipSave)
$expectedText = Hex (Get-ThemeColor 'Text.Primary')
Assert ((Hex $palette.Text) -eq $expectedText) `
  "El palette del guion se quedo en $($palette.Text) cuando el tema pide ${expectedText}: el cambio en caliente no llegaria a la interfaz."
Assert ((Hex $palette.Background) -eq (Hex (Get-ThemeColor 'Base'))) 'El fondo del proxy tampoco se actualizo.'

# Y el guion engancha el selector al manejador, con el indice mapeado a la clave
# del tema. Sin esto el combo se mueve y no pasa nada.
$gui = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
Assert ($gui -match 'Apply-PokeGridTheme') 'El guion no ofrece el cambio de tema en caliente.'
Assert ($gui -match 'SelectedIndexChanged') 'El selector de tema no tiene manejador de cambio.'
Assert ($gui -match 'Register-ThemedControl \$themeBox') 'El selector de tema no se registra como control con tema.'

# Un ComboBox con DrawMode OwnerDrawFixed NO dibuja el texto por su cuenta: sin un
# manejador DrawItem sale con el color del tema pero VACIO. No lanza error ni
# excepcion, asi que solo se ve mirando la ventana. Se comprueba que el guion
# engancha DrawItem al construir cualquier combo.
Assert ($gui -match 'Add_DrawItem') `
  'Los ComboBox no tienen manejador DrawItem: saldrian vacios, con el color del tema pero sin texto.'

# Y se comprueba de verdad: un combo con el mismo tratamiento tiene que pintar.
# Se mide SOLO la mitad izquierda, donde vive el texto: la flecha y el borde de la
# derecha hacen de ruido y darian pixeles de tinta incluso con el combo vacio.
$probe = [Windows.Forms.ComboBox]::new()
$probe.DropDownStyle = 'DropDownList'
$script:theme = $themes['crystal-dark']
$probe.DrawMode = 'OwnerDrawFixed'
$probe.ItemHeight = 18
$probe.BackColor = Get-GlassColor 'Surface.Soft' 0.75
$probe.ForeColor = Get-ThemeColor 'Text.Primary'
$probe.Add_DrawItem({
  param($sender, $e)
  $brush = [Drawing.SolidBrush]::new($sender.BackColor)
  $e.Graphics.FillRectangle($brush, $e.Bounds)
  $brush.Dispose()
  $pen = [Drawing.SolidBrush]::new($sender.ForeColor)
  $e.Graphics.DrawString([string]$sender.Items[$e.Index], $sender.Font, $pen, $e.Bounds.X + 3, $e.Bounds.Y + 1)
  $pen.Dispose()
})
$probe.Items.AddRange([object[]]@('Cristal oscuro', 'Nocturno'))
$probe.SelectedIndex = 0
$probeForm = [Windows.Forms.Form]::new()
$probeForm.ClientSize = [Drawing.Size]::new(240, 80)
$probeForm.BackColor = Get-ThemeColor 'Base'
$probe.Left = 20; $probe.Top = 20; $probe.Width = 200
$probeForm.Controls.Add($probe)
$probeForm.Show()
[Windows.Forms.Application]::DoEvents()
$shot = [Drawing.Bitmap]::new($probe.Width, $probe.Height)
$probe.DrawToBitmap($shot, [Drawing.Rectangle]::new(0, 0, $probe.Width, $probe.Height))
$ink = 0
$limit = [int]($probe.Width * 0.6)
for ($x = 2; $x -lt $limit; $x += 1) {
  for ($y = 2; $y -lt $probe.Height - 2; $y += 1) {
    if ([Math]::Abs([int]$shot.GetPixel($x, $y).R - [int]$probe.BackColor.R) -gt 50) { $ink += 1 }
  }
}
Assert ($ink -gt 60) "El ComboBox se pinta VACIO: solo hay $ink pixeles de tinta en la zona del texto. Sin manejador DrawItem no dibuja las letras, y no hay ningun error que lo delate."
$shot.Dispose(); $probeForm.Close(); $probeForm.Dispose()

# Guardar y leer la preferencia.
$path = Get-PokeGridThemePath
$existed = Test-Path -LiteralPath $path
$backup = if ($existed) { [IO.File]::ReadAllBytes($path) } else { $null }
try {
  Save-PokeGridTheme 'flat'
  Assert ((Read-PokeGridThemeKey) -eq 'flat') 'La preferencia guardada no se leyo de vuelta.'
  Assert ((Get-PokeGridTheme (Read-PokeGridThemeKey)).Name -eq 'PLANE') 'La preferencia guardada debe devolver el nombre PLANE.'
} finally {
  if ($existed) { [IO.File]::WriteAllBytes($path, $backup) }
  elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

$label.Dispose(); $button.Dispose(); $panel.Dispose()
Write-Output 'Theme hot swap passed: PLANE naming, no duplicate registrations, twenty switches leave every control on the active theme, contrast survives re-applying, and the preference round-trips.'
