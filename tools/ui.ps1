# Helpers visuales del PokeGrid Publisher: iconos vectoriales.
#
# Los iconos se dibujan con GraphicsPath y se tiñen con el color del tema, en vez de
# usar emoji: un emoji cambia de fuente entre equipos, no admite color y se ve borroso
# al ampliarlo. Aqui los 7 tienen el mismo lenguaje visual y escalan sin perdida.
#
# Cada ruta cabe en 24x24 y se dibuja escalada al tamano que pida el control.

function Get-PokeGridIconNames() {
  return @('script', 'rocket', 'palette', 'globe', 'dna', 'egg', 'basket')
}

function Get-PokeGridIconPath([string]$name) {
  switch ($name) {
    'script' {
      # Documento con esquina doblada: la silueta de un userscript.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.StartFigure()
      $p.AddLine(5, 2, 15, 2); $p.AddLine(15, 2, 19, 6); $p.AddLine(19, 6, 19, 22)
      $p.AddLine(19, 22, 5, 22); $p.AddLine(5, 22, 5, 2); $p.CloseFigure()
      $fold = [Drawing.Drawing2D.GraphicsPath]::new()
      $fold.StartFigure()
      $fold.AddLine(15, 2, 15, 6); $fold.AddLine(15, 6, 19, 6)
      $p.AddPath($fold, $false); $fold.Dispose()
      return $p
    }
    'rocket' {
      # Nosece con punta redondeada y dos aletas.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $body = [Drawing.Drawing2D.GraphicsPath]::new()
      $body.StartFigure()
      $body.AddBezier(12, 1, 14.5, 4, 15, 7, 15, 10)
      $body.AddLine(15, 10, 15, 17); $body.AddLine(15, 17, 9, 17); $body.AddLine(9, 17, 9, 10)
      $body.AddBezier(9, 10, 9, 7, 9.5, 4, 12, 1)
      $body.CloseFigure()
      $p.AddPath($body, $false); $body.Dispose()
      $left = [Drawing.Drawing2D.GraphicsPath]::new()
      $left.StartFigure()
      $left.AddLine(9, 13, 5, 20); $left.AddLine(5, 20, 9, 17); $left.AddLine(9, 17, 9, 13)
      $left.CloseFigure(); $p.AddPath($left, $false); $left.Dispose()
      $right = [Drawing.Drawing2D.GraphicsPath]::new()
      $right.StartFigure()
      $right.AddLine(15, 13, 19, 20); $right.AddLine(19, 20, 15, 17); $right.AddLine(15, 17, 15, 13)
      $right.CloseFigure(); $p.AddPath($right, $false); $right.Dispose()
      return $p
    }
    'palette' {
      # Pinta: circulo con el hueco de mezcla en la esquina inferior derecha.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $outer = [Drawing.Drawing2D.GraphicsPath]::new()
      $outer.AddEllipse(1, 1, 22, 22)
      $hole = [Drawing.Drawing2D.GraphicsPath]::new()
      $hole.AddEllipse(13, 13, 8, 8)
      $outer.AddPath($hole, $false); $hole.Dispose()
      $p.AddPath($outer, $false); $outer.Dispose()
      return $p
    }
    'globe' {
      # Globo terra: circulo con dos meridianos que se cruzan en los polos.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.AddEllipse(1, 1, 22, 22)
      $inner = [Drawing.Drawing2D.GraphicsPath]::new()
      $inner.StartFigure()
      $inner.AddBezier(12, 1, 8, 6, 8, 12, 12, 12)
      $inner.AddBezier(12, 12, 16, 12, 16, 6, 12, 1)
      $inner.AddBezier(12, 12, 8, 12, 8, 18, 12, 23)
      $inner.AddBezier(12, 23, 16, 18, 16, 12, 12, 12)
      $p.AddPath($inner, $false); $inner.Dispose()
      return $p
    }
    'dna' {
      # Helice: dos curvas que se cruzan en el centro, con barras horizontales.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $left = [Drawing.Drawing2D.GraphicsPath]::new()
      $left.StartFigure()
      $left.AddBezier(6, 1, 18, 5, 18, 19, 6, 23)
      $p.AddPath($left, $false); $left.Dispose()
      $right = [Drawing.Drawing2D.GraphicsPath]::new()
      $right.StartFigure()
      $right.AddBezier(18, 1, 6, 5, 6, 19, 18, 23)
      $p.AddPath($right, $false); $right.Dispose()
      foreach ($pair in @(@(4.5, 3.6), @(12, 0.0), @(19.5, -3.6))) {
        $bar = [Drawing.Drawing2D.GraphicsPath]::new()
        $bar.StartFigure()
        $bar.AddLine((6 - $pair[1]), $pair[0], (18 + $pair[1]), $pair[0])
        $p.AddPath($bar, $false); $bar.Dispose()
      }
      return $p
    }
    'egg' {
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.StartFigure()
      $p.AddBezier(12, 1, 20, 9, 20, 15, 12, 23)
      $p.AddBezier(12, 23, 4, 15, 4, 9, 12, 1)
      $p.CloseFigure()
      return $p
    }
    'basket' {
      # Cesta de la compra: cuerpo trapecial y asa.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $body = [Drawing.Drawing2D.GraphicsPath]::new()
      $body.StartFigure()
      $body.AddLine(2, 9, 22, 9); $body.AddLine(22, 9, 19, 21)
      $body.AddLine(19, 21, 5, 21); $body.AddLine(5, 21, 2, 9)
      $body.CloseFigure(); $p.AddPath($body, $false); $body.Dispose()
      $handle = [Drawing.Drawing2D.GraphicsPath]::new()
      $handle.StartFigure()
      $handle.AddArc(7, 2, 10, 12, 180, 180)
      $p.AddPath($handle, $false); $handle.Dispose()
      return $p
    }
    default { return $null }
  }
}

function New-IconPictureBox([string]$name, [int]$size = 18) {
  # Un PictureBox con la imagen ya tintada: en vez de un Label con emoji, que no
  # admite color y cambia de fuente segun el equipo.
  $box = [Windows.Forms.PictureBox]::new()
  $box.Size = [Drawing.Size]::new($size, $size)
  $box.SizeMode = 'StretchImage'
  $box.BackColor = [Drawing.Color]::Transparent
  $path = Get-PokeGridIconPath $name
  if ($null -eq $path) { return $box }
  $bitmap = [Drawing.Bitmap]::new($size, $size)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = 'AntiAlias'
  $graphics.Clear([Drawing.Color]::Transparent)
  # La ruta esta pensada en 24x24 y se escala al tamano pedido, de modo que el
  # icono se ve igual a 16, 18 o 22 px.
  # GraphicsPath no tiene constructor que reciba otra ruta: la copia se hace
  # con AddPath(ruta, connect) y despues Transform sobre una Matrix de escala.
  $scale = [single]($size / 24.0)
  $matrix = [Drawing.Drawing2D.Matrix]::new()
  $matrix.Scale($scale, $scale)
  $scaled = [Drawing.Drawing2D.GraphicsPath]::new()
  $scaled.AddPath($path, $false)
  $scaled.Transform($matrix)
  $brush = [Drawing.SolidBrush]::new((Get-ThemeColor 'Text.Primary'))
  $graphics.FillPath($brush, $scaled)
  $brush.Dispose(); $scaled.Dispose(); $matrix.Dispose(); $graphics.Dispose()
  $box.Image = $bitmap
  return $box
}

# ---------------------------------------------------------------------------
# El reloj de animaciones.
#
# Un unico Timer de 10 ms adelanta TODAS las animaciones vivas. Un Timer por
# animacion los haria competir por el hilo de la interfaz, que en Windows Forms
# es un solo hilo: varias animaciones simultaneas se ralentizarian entre si.
#
# El intervalo es 10 y no 16: el reloj del sistema de Windows va a ~15.6 ms, y un
# intervalo de 16 cae justo encima y da 19 ticks de los 31 teoricos. Medido en
# esta maquina, con 10 se obtienen 56 ticks por segundo.
# ---------------------------------------------------------------------------

$script:animations = @{}
$script:animationClock = $null

function Initialize-PokeGridAnimationClock {
  if ($script:animationClock) { return }
  $script:animationClock = [Windows.Forms.Timer]::new()
  $script:animationClock.Interval = 10
  $script:animationClock.Add_Tick({
    $now = [DateTime]::UtcNow
    foreach ($target in @($script:animations.Keys)) {
      if (-not $script:animations.ContainsKey($target)) { continue }
      $a = $script:animations[$target]
      $elapsed = ($now - $a.Start).TotalMilliseconds
      $t = $(if ($a.Duration -le 0) { 1.0 } else { [Math]::Min(1.0, $elapsed / $a.Duration) })
      $eased = Get-PokeGridEasing $a.Easing $t
      # Un paso que lanza no puede tumbar el reloj ni borrar las demas: se
      # atrapa aqui y la animacion sigue su curso.
      try { & $a.Step $eased } catch { }
      if ($t -ge 1.0) {
        $script:animations.Remove($target)
        if ($a.Done) { try { & $a.Done } catch { } }
      }
    }
  })
  $script:animationClock.Start()
}

function Start-PokeGridAnimation([string]$target, [scriptblock]$step, [int]$durationMs, [scriptblock]$done = $null) {
  # Relanzar sobre el mismo objetivo REEMPLAZA la animacion anterior. Sin esto,
  # un hover seguido de un clic deja dos animaciones peleandose por el mismo
  # control y se queda a medias.
  if ($script:animations.ContainsKey($target)) { $script:animations.Remove($target) }
  if ($durationMs -le 0) {
    # PLANE: duracion 0, se resuelve ya sin tocar el reloj.
    if ($step) { try { & $step 1.0 } catch { } }
    if ($done) { try { & $done } catch { } }
    return $target
  }
  Initialize-PokeGridAnimationClock
  $script:animations[$target] = @{
    Step = $step; Done = $done; Duration = $durationMs
    Easing = $script:theme.Motion.Easing
    Start = [DateTime]::UtcNow
  }
  return $target
}

function Stop-PokeGridAnimation([string]$target) {
  if ($target -eq '-All') { $script:animations = @{}; return }
  if ($script:animations.ContainsKey($target)) { $script:animations.Remove($target) }
}

function Get-PokeGridAnimationCount() {
  return $script:animations.Count
}

# ---------------------------------------------------------------------------
# El cristal del fondo.
#
# En Windows 10 no hay Mica ni Acrylic: solo existe este blur antiguo de dwmapi.
# Las VMs y las sesiones remotas suelen ignorarlo, por eso se DETECTA y no se asume.
#
# Lo que es verdad y lo que no: el FONDO de la ventana se difumina de verdad y el
# escritorio se ve borroso detras. Los PANELES encima son colores opacos
# pre-mezclados, porque WinForms no pinta paneles con alfa por pixel.
# ---------------------------------------------------------------------------

$script:PokeGridBlurSource = "using System;`nusing System.Runtime.InteropServices;`npublic static class PokeGridBlur {`n  [StructLayout(LayoutKind.Sequential)]`n  public struct MARGINS { public int Left, Right, Top, Bottom; }`n  [DllImport(`"dwmapi.dll`")]`n  public static extern int DwmEnableBlurBehindWindow(IntPtr hwnd, ref MARGINS margins, int flags);`n}`n"

$script:pokeGridBlurTypeLoaded = $false

function Get-PokeGridBlurSupported() {
  # Windows 10 1803 (17134) en adelante es donde este blur esta disponible.
  try {
    $version = [Environment]::OSVersion.Version
    return ($version.Major -gt 10) -or ($version.Major -eq 10 -and $version.Build -ge 17134)
  } catch { return $false }
}

function Enable-PokeGridBlur($form) {
  # Nunca lanza: si el P/Invoke falla, la app arranca igual, sin cristal. Un error
  # al abrir la aplicacion seria mucho peor que perder un efecto visual.
  try {
    if (-not $script:theme.Blur) { return $false }
    if (-not $script:pokeGridBlurTypeLoaded) {
      Add-Type -TypeDefinition $script:PokeGridBlurSource -ErrorAction Stop
      $script:pokeGridBlurTypeLoaded = $true
    }
    $handler = {
      if (-not $script:theme.Blur) { return }
      try {
        $margins = New-Object 'PokeGridBlur+MARGINS'
        $margins.Left = -1; $margins.Right = -1; $margins.Top = -1; $margins.Bottom = -1
        [void][PokeGridBlur]::DwmEnableBlurBehindWindow($this.Handle, [ref]$margins, 2)
      } catch { }
    }.GetNewClosure()
    $form.Add_HandleCreated($handler)
    return $true
  } catch { return $false }
}

function Resolve-PokeGridEffectiveTheme([bool]$BlurSupported = $false) {
  # Sin soporte: mismo tema, mismos colores, solo sin cristal. Se conserva la Key
  # para que al guardar la preferencia no se acabe escribiendo otro tema, y no se
  # toca ningun color porque la legibilidad no depende de que haya blur.
  $theme = $script:theme
  if ($theme.Kind -ne 'glass') { return $theme }
  if ($BlurSupported) { return $theme }
  $fallback = @{} + $theme
  $fallback['Kind'] = 'flat'
  $fallback['Blur'] = $false
  return $fallback
}
# ---------------------------------------------------------------------------
# El registro de controles con tema.
#
# Cada control se registra UNA vez diciendo que PAPEL juega: TextPrimary,
# ButtonDanger, Surface... Nunca un color. Asi el unico sitio que sabe que
# "el boton de peligro es rojo en este tema" es la tabla del tema, y cambiar de
# tema es sustituirla.
# ---------------------------------------------------------------------------

$script:themedControls = [Collections.Generic.List[object]]::new()

function Register-ThemedControl($control, [string]$role) {
  foreach ($entry in $script:themedControls) {
    if ($entry.Control -eq $control) { return }
  }
  $entry = [pscustomobject]@{ Control = $control; Role = $role }
  $script:themedControls.Add($entry)
  Update-ThemedControl $entry
}

function Update-ThemedControl($entry) {
  $c = $entry.Control
  if ($null -eq $c -or $c.IsDisposed) { return }
  switch ($entry.Role) {
    'TextPrimary'   { $c.ForeColor = Get-ThemeColor 'Text.Primary' }
    'TextSecondary' { $c.ForeColor = Get-ThemeColor 'Text.Secondary' }
    'TextMuted'     { $c.ForeColor = Get-ThemeColor 'Text.Secondary' }
    'TextDim'       { $c.ForeColor = Get-ThemeColor 'Text.Disabled' }
    'ButtonPrimary' { Set-ButtonRole $c 'primary' | Out-Null }
    'ButtonDanger'  { Set-ButtonRole $c 'danger' | Out-Null }
    'ButtonGhost'   { Set-ButtonRole $c 'ghost' | Out-Null }
    'ButtonSecondary' { Set-ButtonRole $c 'secondary' | Out-Null }
    'Surface'       { $c.BackColor = Get-GlassColor 'Surface.Base' 0.14 }
    'Glass'         { $c.BackColor = Get-GlassColor 'Surface.Soft' 0.35 }
    'GlassStrong'   { $c.BackColor = Get-GlassColor 'Surface.Soft' 0.45 }
    'Input'         {
      # Un campo es MAS opaco que la tarjeta que lo contiene: si comparte su
      # cristal, el texto se pierde contra el de al lado.
      $c.BackColor = Get-GlassColor 'Surface.Soft' 0.75
      $c.ForeColor = Get-ThemeColor 'Text.Primary'
      if ($c -is [Windows.Forms.ComboBox]) {
        # Sin esto un ComboBox ignora BackColor/ForeColor y sale con el gris de Windows.
        $c.DrawMode = 'OwnerDrawFixed'
        $c.BackColor = $c.BackColor
        $c.ForeColor = $c.ForeColor
      }
    }
    'Base'          { $c.BackColor = Get-ThemeColor 'Base' }
    'LogSurface'    { $c.BackColor = Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.25 }
    'Grid'          {
      $c.BackgroundColor = Get-ThemeColor 'Base'
      $c.DefaultCellStyle.BackColor = Get-ThemeColor 'Surface.Soft'
      $c.DefaultCellStyle.ForeColor = Get-ThemeColor 'Text.Primary'
      $c.DefaultCellStyle.SelectionBackColor = Blend-Color (Get-ThemeColor 'Surface.Raised') (Get-ThemeColor 'Rest.Primary.Base') 0.45
      $c.ColumnHeadersDefaultCellStyle.BackColor = Get-ThemeColor 'Surface.Raised'
      $c.ColumnHeadersDefaultCellStyle.ForeColor = Get-ThemeColor 'Text.Secondary'
      $c.GridColor = Get-ThemeColor 'Border.Base'
    }
    default { }
  }
}

function New-ThemePaletteProxy($theme) {
  # $palette es una variable local del guion, no del ambito Script. Para que los
  # usos existentes vean el tema nuevo hay que RECONSTRUIR el objeto en su sitio.
  # Add-Variable -Scope Script crearia otra variable distinta y no tocaria esta.
  return [pscustomobject]@{
    Background = Get-ThemeColor 'Base' -Theme $theme
    Surface = Get-ThemeColor 'Surface.Base' -Theme $theme
    SurfaceRaised = Get-ThemeColor 'Surface.Raised' -Theme $theme
    SurfaceSoft = Get-ThemeColor 'Surface.Soft' -Theme $theme
    Border = Get-ThemeColor 'Border.Base' -Theme $theme
    BorderFocus = Get-ThemeColor 'Rest.Primary.Hover' -Theme $theme
    Text = Get-ThemeColor 'Text.Primary' -Theme $theme
    Muted = Get-ThemeColor 'Text.Secondary' -Theme $theme
    Dim = Get-ThemeColor 'Text.Disabled' -Theme $theme
    Primary = Get-ThemeColor 'Rest.Primary.Hover' -Theme $theme
    PrimaryDark = Get-ThemeColor 'Rest.Primary.Base' -Theme $theme
    Accent = Get-ThemeColor 'Rest.Danger.Hover' -Theme $theme
    AccentDark = Get-ThemeColor 'Rest.Danger.Base' -Theme $theme
    Success = Get-ThemeColor 'Rest.Success.Base' -Theme $theme
    Warning = Get-ThemeColor 'Rest.Warning.Base' -Theme $theme
    Danger = Get-ThemeColor 'Rest.Danger.Fore' -Theme $theme
  }
}
function Apply-PokeGridTheme([string]$key, [switch]$SkipSave) {
  # Cambiar de tema es sustituir una tabla de datos y repintar lo registrado.
  $theme = Get-PokeGridTheme $key
  $script:theme = $theme

  # $palette vive en el ambito del GUION, no en el de esta funcion. Asignarla aqui
  # crearia una copia local y las 89 referencias ya escritas en la interfaz seguirian
  # viendo los colores del tema anterior: la ventana se repintaria a medias.
  # Set-Variable con -Force es lo que sustituye de verdad la variable del guion.
  Set-Variable -Name palette -Value (New-ThemePaletteProxy $theme) -Scope Script -Force

  foreach ($entry in $script:themedControls) { Update-ThemedControl $entry }
  if ($form) {
    $form.BackColor = Get-ThemeColor 'Base'
    $form.ForeColor = Get-ThemeColor 'Text.Primary'
    Apply-RoundedRegions $form
    $form.Invalidate()
  }
  if (-not $SkipSave) { Save-PokeGridTheme $theme.Key }
  return $theme.Name
}