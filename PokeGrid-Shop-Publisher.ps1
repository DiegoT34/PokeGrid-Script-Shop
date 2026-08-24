param([switch]$SmokeTest)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$programRoot = $PSScriptRoot
$repoRoot = $programRoot
$cliPublisher = Join-Path $programRoot 'tools\publish-script.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
  $repoRoot = Join-Path $env:LOCALAPPDATA 'PokeGrid-Shop-Publisher\repository'
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if (-not $gh -and (Test-Path -LiteralPath 'C:\Program Files\GitHub CLI\gh.exe')) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }
    if (-not $gh) { throw 'Instala GitHub CLI para que el publicador pueda preparar el repositorio.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $repoRoot) -Force | Out-Null
    & $gh repo clone DiegoT34/PokeGrid-Script-Shop $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el repositorio local de la Script Shop.' }
  }
}
$script:loaded = $null

function Color([string]$hex) { return [Drawing.ColorTranslator]::FromHtml($hex) }
function Add-Label($parent, [string]$text, [int]$x, [int]$y, [int]$width = 170) {
  $label = [Windows.Forms.Label]::new()
  $label.Text = $text
  $label.Location = [Drawing.Point]::new($x, $y)
  $label.Size = [Drawing.Size]::new($width, 18)
  $label.ForeColor = Color '#91a4bd'
  $label.Font = [Drawing.Font]::new('Segoe UI', 8, [Drawing.FontStyle]::Bold)
  $parent.Controls.Add($label)
  return $label
}
function Add-TextBox($parent, [int]$x, [int]$y, [int]$width, [int]$height = 27, [switch]$Multiline) {
  $box = [Windows.Forms.TextBox]::new()
  $box.Location = [Drawing.Point]::new($x, $y)
  $box.Size = [Drawing.Size]::new($width, $height)
  $box.Multiline = [bool]$Multiline
  if ($Multiline) { $box.ScrollBars = 'Vertical' }
  $box.BackColor = Color '#081422'
  $box.ForeColor = Color '#eef5ff'
  $box.BorderStyle = 'FixedSingle'
  $box.Font = [Drawing.Font]::new('Segoe UI', 9)
  $parent.Controls.Add($box)
  return $box
}
function Add-Button($parent, [string]$text, [int]$x, [int]$y, [int]$width, [int]$height = 30, [string]$color = '#243650') {
  $button = [Windows.Forms.Button]::new()
  $button.Text = $text
  $button.Location = [Drawing.Point]::new($x, $y)
  $button.Size = [Drawing.Size]::new($width, $height)
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderColor = Color '#45617e'
  $button.BackColor = Color $color
  $button.ForeColor = Color '#f3f7fc'
  $button.Font = [Drawing.Font]::new('Segoe UI', 9, [Drawing.FontStyle]::Bold)
  $button.Cursor = 'Hand'
  $parent.Controls.Add($button)
  return $button
}
function Metadata([string]$code, [string]$name) {
  $match = [regex]::Match($code, "(?im)^\s*//\s*@$([regex]::Escape($name))\s+(.+?)\s*$")
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ''
}
function Slug([string]$value) {
  $normalized = $value.Normalize([Text.NormalizationForm]::FormD)
  $builder = [Text.StringBuilder]::new()
  foreach ($char in $normalized.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($char) -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$builder.Append($char)
    }
  }
  return ($builder.ToString().ToLowerInvariant() -replace '[^a-z0-9]+', '-' -replace '(^-|-$)', '')
}
function Log([string]$message, [string]$kind = 'info') {
  $time = (Get-Date).ToString('HH:mm:ss')
  $logBox.AppendText("[$time] $message`r`n")
  $logBox.SelectionStart = $logBox.TextLength
  $logBox.ScrollToCaret()
  if ($kind -eq 'error') { $statusLabel.ForeColor = Color '#ff8497' }
  elseif ($kind -eq 'ok') { $statusLabel.ForeColor = Color '#65dfa4' }
  else { $statusLabel.ForeColor = Color '#79c8ef' }
  $statusLabel.Text = $message
  [Windows.Forms.Application]::DoEvents()
}
function Read-Script([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Selecciona un archivo existente.' }
  $file = Get-Item -LiteralPath $path
  if ($file.Length -le 0 -or $file.Length -gt 1000000) { throw 'El script está vacío o supera 1 MB.' }
  if ($file.Name -notmatch '(?i)(?:\.user)?\.js$') { throw 'El archivo debe ser JavaScript.' }
  $code = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
  if ($code -notmatch '(?is)//\s*==UserScript==.*?//\s*==/UserScript==') { throw 'No contiene un bloque ==UserScript==.' }
  $name = Metadata $code 'name'
  $namespace = Metadata $code 'namespace'
  $version = (Metadata $code 'version').TrimStart('v')
  if ($version -match '^\d+\.\d+$') { $version = "$version.0" }
  if (-not $name -or -not $namespace -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+].*)?$') {
    throw 'Debe declarar @name, @namespace y @version X.Y.Z.'
  }
  return [pscustomobject]@{
    Path = $file.FullName; Code = $code; Name = $name; Namespace = $namespace; Version = $version
    Description = Metadata $code 'description'; Author = Metadata $code 'author'
  }
}
function Load-SelectedScript {
  try {
    $script:loaded = Read-Script $pathBox.Text
    $nameValue.Text = $script:loaded.Name
    $namespaceValue.Text = $script:loaded.Namespace
    $versionValue.Text = $script:loaded.Version
    if (-not $idBox.Text) { $idBox.Text = Slug $script:loaded.Name }
    if (-not $summaryBox.Text) { $summaryBox.Text = $script:loaded.Description }
    if (-not $descriptionBox.Text) { $descriptionBox.Text = $script:loaded.Description }
    if (-not $authorBox.Text) { $authorBox.Text = $(if ($script:loaded.Author) { $script:loaded.Author } else { 'DiegoT34' }) }
    if (-not $changelogBox.Text) { $changelogBox.Text = "Publicación $($script:loaded.Version)" }
    Log "Script válido: $($script:loaded.Name) v$($script:loaded.Version)" 'ok'
  } catch { Log $_.Exception.Message 'error'; [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Script no válido', 'OK', 'Error') | Out-Null }
}
function Git([string[]]$arguments, [switch]$AllowFailure) {
  $output = & git -C $repoRoot @arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw $output.Trim() }
  return $output.Trim()
}

$form = [Windows.Forms.Form]::new()
$form.Text = 'PokeGrid Script Shop Publisher'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = [Drawing.Size]::new(940, 760)
$form.MinimumSize = [Drawing.Size]::new(880, 720)
$form.BackColor = Color '#07111f'
$form.ForeColor = Color '#eef5ff'
$form.Font = [Drawing.Font]::new('Segoe UI', 9)
$form.AutoScaleMode = 'Dpi'

$title = Add-Label $form 'POKEGRID SCRIPT SHOP PUBLISHER' 22 17 500
$title.Font = [Drawing.Font]::new('Segoe UI Semibold', 17, [Drawing.FontStyle]::Bold)
$title.ForeColor = Color '#f1f6fc'
$subtitle = Add-Label $form 'Publica o actualiza scripts con catálogo, SHA-256, commit y push automáticos.' 24 49 700
$subtitle.Font = [Drawing.Font]::new('Segoe UI', 9)
$statusLabel = Add-Label $form 'Selecciona un userscript para comenzar.' 24 72 750
$statusLabel.ForeColor = Color '#79c8ef'

Add-Label $form 'ARCHIVO USERSCRIPT' 24 103 200 | Out-Null
$pathBox = Add-TextBox $form 24 123 710
$browseButton = Add-Button $form 'Examinar…' 744 121 82 30
$readButton = Add-Button $form 'Leer' 833 121 80 30 '#3c3275'

Add-Label $form 'NOMBRE DETECTADO' 24 166 180 | Out-Null
$nameValue = Add-TextBox $form 24 186 350
$nameValue.ReadOnly = $true
Add-Label $form 'NAMESPACE' 386 166 180 | Out-Null
$namespaceValue = Add-TextBox $form 386 186 350
$namespaceValue.ReadOnly = $true
Add-Label $form 'VERSIÓN' 748 166 120 | Out-Null
$versionValue = Add-TextBox $form 748 186 165
$versionValue.ReadOnly = $true

Add-Label $form 'ID ESTABLE' 24 228 150 | Out-Null
$idBox = Add-TextBox $form 24 248 210
Add-Label $form 'CATEGORÍA' 246 228 150 | Out-Null
$categoryBox = [Windows.Forms.ComboBox]::new()
$categoryBox.Location = [Drawing.Point]::new(246, 248)
$categoryBox.Size = [Drawing.Size]::new(200, 27)
$categoryBox.DropDownStyle = 'DropDown'
$categoryBox.BackColor = Color '#081422'; $categoryBox.ForeColor = Color '#eef5ff'
[void]$categoryBox.Items.AddRange(@('Market','Crianza','Calculadoras','Interfaz','Comunicación','Notificaciones','Utilidades'))
$categoryBox.Text = 'Utilidades'; $form.Controls.Add($categoryBox)
Add-Label $form 'ICONO' 458 228 90 | Out-Null
$iconBox = Add-TextBox $form 458 248 90; $iconBox.Text = '🧩'
Add-Label $form 'LAUNCHER MÍNIMO' 560 228 150 | Out-Null
$minLauncherBox = Add-TextBox $form 560 248 176; $minLauncherBox.Text = '0.22.1'
$featuredBox = [Windows.Forms.CheckBox]::new()
$featuredBox.Text = 'Destacado'; $featuredBox.Location = [Drawing.Point]::new(755, 250); $featuredBox.Size = [Drawing.Size]::new(150, 25)
$featuredBox.ForeColor = Color '#e9cc64'; $featuredBox.BackColor = $form.BackColor; $form.Controls.Add($featuredBox)

Add-Label $form 'AUTOR' 24 291 120 | Out-Null
$authorBox = Add-TextBox $form 24 311 210
Add-Label $form 'ETIQUETAS (separadas por coma)' 246 291 250 | Out-Null
$tagsBox = Add-TextBox $form 246 311 300
Add-Label $form 'RESUMEN PARA LA TARJETA' 558 291 250 | Out-Null
$summaryBox = Add-TextBox $form 558 311 355

Add-Label $form 'DESCRIPCIÓN COMPLETA' 24 354 240 | Out-Null
$descriptionBox = Add-TextBox $form 24 374 430 88 -Multiline
Add-Label $form 'PERMISOS, UNO POR LÍNEA' 466 354 240 | Out-Null
$permissionsBox = Add-TextBox $form 466 374 447 88 -Multiline

Add-Label $form 'CAMBIOS DE ESTA VERSIÓN' 24 477 250 | Out-Null
$changelogBox = Add-TextBox $form 24 497 889 62 -Multiline

$validateButton = Add-Button $form '✓ Validar' 24 576 120 36 '#1b5060'
$openRepoButton = Add-Button $form 'Abrir repositorio' 154 576 150 36
$catalogButton = Add-Button $form 'Ver catálogo' 314 576 125 36
$publishButton = Add-Button $form 'Publicar / Actualizar' 704 576 209 36 '#b34435'

Add-Label $form 'REGISTRO' 24 624 120 | Out-Null
$logBox = Add-TextBox $form 24 644 889 91 -Multiline
$logBox.ReadOnly = $true
$logBox.BackColor = Color '#050b13'

$browseButton.Add_Click({
  $dialog = [Windows.Forms.OpenFileDialog]::new()
  $dialog.Title = 'Seleccionar userscript'
  $dialog.Filter = 'Userscripts (*.user.js;*.js)|*.user.js;*.js|JavaScript (*.js)|*.js'
  if ($dialog.ShowDialog() -eq 'OK') { $pathBox.Text = $dialog.FileName; $idBox.Clear(); Load-SelectedScript }
})
$readButton.Add_Click({ Load-SelectedScript })
$validateButton.Add_Click({ Load-SelectedScript })
$openRepoButton.Add_Click({ Start-Process 'https://github.com/DiegoT34/PokeGrid-Script-Shop' })
$catalogButton.Add_Click({ Start-Process 'https://github.com/DiegoT34/PokeGrid-Script-Shop/blob/main/catalog.json' })
$publishButton.Add_Click({
  $publishButton.Enabled = $false
  try {
    $script:loaded = Read-Script $pathBox.Text
    if ($idBox.Text -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$') { throw 'El ID debe usar minúsculas, números, punto, guion o guion bajo.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) { throw 'Ejecuta el publicador desde un clon Git del repositorio de la Shop.' }
    Log 'Sincronizando el repositorio…'
    [void](Git @('pull','--ff-only'))
    $tags = @($tagsBox.Text -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $permissions = @($permissionsBox.Lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $parameters = @{
      Path = $script:loaded.Path; Id = $idBox.Text; Category = $categoryBox.Text; Tags = $tags
      Permissions = $permissions; Summary = $summaryBox.Text; Description = $descriptionBox.Text
      Changelog = $changelogBox.Text; Author = $authorBox.Text; MinLauncherVersion = $minLauncherBox.Text
      Icon = $iconBox.Text; Featured = $featuredBox.Checked; RepositoryRoot = $repoRoot
    }
    Log 'Generando copia, catálogo y SHA-256…'
    $publisherOutput = & $cliPublisher @parameters 2>&1 | Out-String
    Log $publisherOutput.Trim()
    $target = "scripts/$($idBox.Text).user.js"
    [void](Git @('add','--','catalog.json',$target))
    & git -C $repoRoot diff --cached --quiet
    if ($LASTEXITCODE -eq 0) { Log 'No hay cambios nuevos para publicar.' 'ok'; return }
    $message = "Publicar $($script:loaded.Name) $($script:loaded.Version)"
    Log 'Creando commit…'
    [void](Git @('commit','-m',$message,'--','catalog.json',$target))
    Log 'Subiendo a GitHub…'
    [void](Git @('push'))
    Log "$($script:loaded.Name) fue publicado correctamente." 'ok'
    [Windows.Forms.MessageBox]::Show('El script y su catálogo fueron publicados correctamente.', 'Publicación completada', 'OK', 'Information') | Out-Null
  } catch {
    Log $_.Exception.Message 'error'
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'No se pudo publicar', 'OK', 'Error') | Out-Null
  } finally { $publishButton.Enabled = $true }
})

Log "Repositorio: $repoRoot"
if ($SmokeTest) {
  if (-not $publishButton -or -not $pathBox -or -not $catalogButton -or -not (Test-Path -LiteralPath $cliPublisher)) {
    throw 'La interfaz del publicador no pudo inicializarse.'
  }
  Write-Output 'PokeGrid Shop Publisher GUI smoke passed.'
  $form.Dispose()
  exit 0
}
[void]$form.ShowDialog()
