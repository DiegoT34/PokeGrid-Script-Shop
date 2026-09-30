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
      # Nosece con ventana y dos aletas: cuerpo recto, punta redondeada arriba.
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
      # Pinta: circulo con un hueco de mezcla en la esquina inferior derecha.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $p.FillMode = 'Alternate'
      $outer = [Drawing.Drawing2D.GraphicsPath]::new()
      $outer.AddEllipse(1, 1, 22, 22)
      $hole = [Drawing.Drawing2D.GraphicsPath]::new()
      $hole.AddEllipse(13, 13, 8, 8)
      $outer.AddPath($hole, $false); $hole.Dispose()
      $p.AddPath($outer, $false); $outer.Dispose()
      return $p
    }
    'globe' {
      # Globo terra: circulo con dos meridianos y dos paralelos.
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
      # Helice: dos curvas que se cruzan en el centro, con barras horizontales
      # que las unen. Las curvas se dibujan con mas recorrido horizontal para que
      # el cruce se lea como una X y no como dos hojas sueltas.
      $p = [Drawing.Drawing2D.GraphicsPath]::new()
      $left = [Drawing.Drawing2D.GraphicsPath]::new()
      $left.StartFigure()
      $left.AddBezier(6, 1, 18, 5, 18, 19, 6, 23)
      $p.AddPath($left, $false); $left.Dispose()
      $right = [Drawing.Drawing2D.GraphicsPath]::new()
      $right.StartFigure()
      $right.AddBezier(18, 1, 6, 5, 6, 19, 18, 23)
      $p.AddPath($right, $false); $right.Dispose()
      # Barras en tres alturas, con la separacion que da el cruce de las curvas.
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
  # con AddPath(ruta, connect) sobre una matriz de escala.
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
