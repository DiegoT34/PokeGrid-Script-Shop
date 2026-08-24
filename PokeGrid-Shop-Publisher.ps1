param(
  [switch]$SmokeTest,
  [string]$ScreenshotPath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$programRoot = $PSScriptRoot
$repoRoot = $programRoot
$cliPublisher = Join-Path $programRoot 'tools\publish-script.ps1'
$gitHelper = Join-Path $programRoot 'tools\git-helper.ps1'
$ghPath = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $ghPath -and (Test-Path -LiteralPath 'C:\Program Files\GitHub CLI\gh.exe')) { $ghPath = 'C:\Program Files\GitHub CLI\gh.exe' }
if (-not (Test-Path -LiteralPath $cliPublisher -PathType Leaf)) { throw 'No se encontró tools\publish-script.ps1.' }
if (-not (Test-Path -LiteralPath $gitHelper -PathType Leaf)) { throw 'No se encontró tools\git-helper.ps1.' }
. $gitHelper
$gitPath = Resolve-PokeGridGitPath

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
  $repoRoot = Join-Path $env:LOCALAPPDATA 'PokeGrid-Shop-Publisher\repository'
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    if (-not $ghPath) { throw 'Instala y autoriza GitHub CLI para preparar el repositorio de la Script Shop.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $repoRoot) -Force | Out-Null
    & $ghPath repo clone DiegoT34/PokeGrid-Script-Shop $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el repositorio local de la Script Shop.' }
  }
}

$script:loaded = $null
$script:existing = $null
$script:isBusy = $false

function Color([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }

$palette = @{
  Background = Color '#07111D'; Surface = Color '#0C1928'; SurfaceRaised = Color '#112238'
  SurfaceSoft = Color '#0A1624'; Border = Color '#263D56'; BorderFocus = Color '#42C8EF'
  Text = Color '#F2F6FC'; Muted = Color '#8396AE'; Dim = Color '#5E728B'
  Primary = Color '#35C4EB'; PrimaryDark = Color '#167B9B'; Accent = Color '#FF715B'
  AccentDark = Color '#A43F34'; Success = Color '#48D49B'; Warning = Color '#F1C75B'; Danger = Color '#FF7D8F'
}

$toolTip = [Windows.Forms.ToolTip]::new()
$toolTip.AutoPopDelay = 8000
$toolTip.InitialDelay = 1500
$toolTip.ReshowDelay = 100

function New-Label([string]$text, [float]$size = 9, [Drawing.Color]$color = $palette.Text, [Drawing.FontStyle]$style = [Drawing.FontStyle]::Regular) {
  $label = [Windows.Forms.Label]::new()
  $label.Text = $text
  $label.AutoSize = $false
  $label.ForeColor = $color
  $label.Font = [Drawing.Font]::new('Segoe UI', $size, $style)
  $label.BackColor = [Drawing.Color]::Transparent
  $label.TextAlign = 'MiddleLeft'
  return $label
}

function Style-Input($control, [switch]$ReadOnly) {
  $control.BackColor = $(if ($ReadOnly) { $palette.SurfaceSoft } else { Color '#081523' })
  $control.ForeColor = $(if ($ReadOnly) { Color '#A8B8CA' } else { $palette.Text })
  $control.Font = [Drawing.Font]::new('Segoe UI', 9.25)
  $control.Margin = [Windows.Forms.Padding]::new(0, 2, 0, 0)
  if ($control -is [Windows.Forms.TextBox]) { $control.BorderStyle = 'FixedSingle'; $control.ReadOnly = [bool]$ReadOnly }
  return $control
}

function New-TextBox([switch]$Multiline, [switch]$ReadOnly) {
  $box = [Windows.Forms.TextBox]::new()
  $box.Multiline = [bool]$Multiline
  if ($Multiline) { $box.AcceptsReturn = $true; $box.ScrollBars = 'Vertical' }
  Style-Input $box -ReadOnly:$ReadOnly | Out-Null
  return $box
}

function New-Button([string]$text, [string]$kind = 'secondary') {
  $button = [Windows.Forms.Button]::new()
  $button.Text = $text
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 1
  $button.Font = [Drawing.Font]::new('Segoe UI Semibold', 9.25, [Drawing.FontStyle]::Bold)
  $button.ForeColor = $palette.Text
  $button.Cursor = 'Hand'
  $button.Margin = [Windows.Forms.Padding]::new(4)
  $normal = $palette.SurfaceRaised; $hover = Color '#19314B'; $border = $palette.Border
  if ($kind -eq 'primary') { $normal = $palette.PrimaryDark; $hover = Color '#1B91B4'; $border = $palette.Primary }
  if ($kind -eq 'accent') { $normal = $palette.AccentDark; $hover = Color '#C95143'; $border = $palette.Accent }
  if ($kind -eq 'ghost') { $normal = $palette.SurfaceSoft; $hover = $palette.SurfaceRaised; $border = $palette.Border }
  $button.BackColor = $normal
  $button.FlatAppearance.BorderColor = $border
  $button.FlatAppearance.MouseDownBackColor = $hover
  $button.Add_MouseEnter(({ if ($this.Enabled) { $this.BackColor = $hover } }.GetNewClosure()))
  $button.Add_MouseLeave(({ $this.BackColor = $normal }.GetNewClosure()))
  return $button
}

function New-Field([string]$caption, $control, [string]$hint = '') {
  $field = [Windows.Forms.Panel]::new()
  $field.Dock = 'Fill'
  $field.Margin = [Windows.Forms.Padding]::new(5, 3, 5, 4)
  $label = New-Label $caption 7.7 $palette.Muted ([Drawing.FontStyle]::Bold)
  $label.Dock = 'Top'; $label.Height = 19
  $control.Dock = 'Fill'
  $field.Controls.Add($control); $field.Controls.Add($label)
  if ($hint) { $toolTip.SetToolTip($label, $hint); $toolTip.SetToolTip($control, $hint) }
  return $field
}

function New-SectionHeader([string]$number, [string]$title, [string]$subtitle) {
  $header = [Windows.Forms.TableLayoutPanel]::new()
  $header.Dock = 'Fill'; $header.ColumnCount = 2; $header.RowCount = 2
  $header.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute', 48)) | Out-Null
  $header.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent', 100)) | Out-Null
  $header.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent', 58)) | Out-Null
  $header.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent', 42)) | Out-Null
  $badge = New-Label $number 11 $palette.Primary ([Drawing.FontStyle]::Bold)
  $badge.Dock = 'Fill'; $badge.TextAlign = 'MiddleCenter'; $badge.BackColor = Color '#102D40'; $badge.Margin = [Windows.Forms.Padding]::new(3, 5, 8, 5)
  $heading = New-Label $title 12.5 $palette.Text ([Drawing.FontStyle]::Bold)
  $heading.Dock = 'Fill'; $heading.Margin = [Windows.Forms.Padding]::new(0, 2, 0, 0)
  $copy = New-Label $subtitle 8 $palette.Muted
  $copy.Dock = 'Fill'; $copy.Margin = [Windows.Forms.Padding]::new(0, 0, 0, 2)
  $header.Controls.Add($badge, 0, 0); $header.SetRowSpan($badge, 2)
  $header.Controls.Add($heading, 1, 0); $header.Controls.Add($copy, 1, 1)
  return $header
}

function New-Card([int]$height) {
  $panel = [Windows.Forms.Panel]::new()
  $panel.Height = $height; $panel.BackColor = $palette.Surface; $panel.BorderStyle = 'FixedSingle'
  $panel.Padding = [Windows.Forms.Padding]::new(12); $panel.Margin = [Windows.Forms.Padding]::new(0, 0, 0, 13)
  return $panel
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
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($char) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$builder.Append($char) }
  }
  return ($builder.ToString().ToLowerInvariant() -replace '[^a-z0-9]+', '-' -replace '(^-|-$)', '')
}

function Read-Script([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Selecciona un archivo existente.' }
  $file = Get-Item -LiteralPath $path
  if ($file.Length -le 0 -or $file.Length -gt 1000000) { throw 'El script está vacío o supera 1 MB.' }
  if ($file.Name -notmatch '(?i)(?:\.user)?\.js$') { throw 'El archivo debe terminar en .js o .user.js.' }
  $code = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
  if ($code -notmatch '(?is)//\s*==UserScript==.*?//\s*==/UserScript==') { throw 'No contiene un bloque ==UserScript==.' }
  $name = Metadata $code 'name'; $namespace = Metadata $code 'namespace'; $version = (Metadata $code 'version').TrimStart('v')
  if ($version -match '^\d+\.\d+$') { $version = "$version.0" }
  if (-not $name -or -not $namespace -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+].*)?$') { throw 'Debe declarar @name, @namespace y @version X.Y.Z.' }
  return [pscustomobject]@{ Path=$file.FullName; Code=$code; Name=$name; Namespace=$namespace; Version=$version; Description=(Metadata $code 'description'); Author=(Metadata $code 'author'); Size=$file.Length }
}

function Set-Busy([bool]$busy) {
  $script:isBusy = $busy
  $publishButton.Enabled = -not $busy; $validateButton.Enabled = -not $busy; $browseButton.Enabled = -not $busy
  $form.UseWaitCursor = $busy
  [Windows.Forms.Application]::DoEvents()
}

function Log([string]$message, [string]$kind = 'info') {
  $time = (Get-Date).ToString('HH:mm:ss')
  $logBox.AppendText("[$time] $message`r`n"); $logBox.SelectionStart = $logBox.TextLength; $logBox.ScrollToCaret()
  $statusDot.ForeColor = $(if ($kind -eq 'error') { $palette.Danger } elseif ($kind -eq 'ok') { $palette.Success } else { $palette.Primary })
  $statusLabel.ForeColor = $statusDot.ForeColor; $statusLabel.Text = $message
  $statusChip.Text = $(if ($kind -eq 'error') { '  REVISAR  ' } elseif ($kind -eq 'ok') { '  LISTO  ' } else { '  EN PROCESO  ' })
  $statusChip.BackColor = $(if ($kind -eq 'error') { Color '#3B1821' } elseif ($kind -eq 'ok') { Color '#123329' } else { Color '#102D40' })
  [Windows.Forms.Application]::DoEvents()
}

function Refresh-Preview {
  $previewIcon.Text = $(if ($iconBox.Text.Trim()) { $iconBox.Text.Trim() } else { '🧩' })
  $previewName.Text = $(if ($nameValue.Text.Trim()) { $nameValue.Text.Trim() } else { 'Nombre del script' })
  $previewMeta.Text = $(if ($versionValue.Text.Trim()) { "v$($versionValue.Text)  •  $($categoryBox.Text)" } else { 'Selecciona un userscript' })
  $previewId.Text = $(if ($idBox.Text.Trim()) { $idBox.Text.Trim() } else { 'id-estable' })
  $modeLabel.Text = $(if ($script:existing) { 'ACTUALIZACIÓN' } else { 'NUEVA PUBLICACIÓN' })
  $modeLabel.ForeColor = $(if ($script:existing) { $palette.Warning } else { $palette.Primary })
  $publishButton.Text = $(if ($script:existing) { '↑ Publicar actualización' } else { '↑ Publicar en la Shop' })
}

function Clear-PublicationFields {
  $script:loaded = $null; $script:existing = $null
  @($pathBox,$nameValue,$namespaceValue,$versionValue,$idBox,$authorBox,$tagsBox,$summaryBox,$descriptionBox,$permissionsBox,$changelogBox) | ForEach-Object { $_.Clear() }
  $categoryBox.Text = 'Utilidades'; $iconBox.Text = '🧩'; $minLauncherBox.Text = '0.22.3'; $featuredBox.Checked = $false
  $sourceHint.Text = 'Arrastra un archivo aquí o utiliza Examinar.'
  Refresh-Preview; Log 'Formulario limpio. Selecciona un userscript para comenzar.'
}

function Apply-CatalogEntry($entry) {
  $script:existing = $entry
  $idBox.Text=[string]$entry.id; $categoryBox.Text=[string]$entry.category; $iconBox.Text=[string]$entry.icon; $minLauncherBox.Text=[string]$entry.minLauncherVersion
  $authorBox.Text=[string]$entry.author; $tagsBox.Text=@($entry.tags)-join ', '; $summaryBox.Text=[string]$entry.summary; $descriptionBox.Text=[string]$entry.description
  $permissionsBox.Lines=@($entry.permissions); $changelogBox.Text="Actualización $($script:loaded.Version)"; $featuredBox.Checked=$entry.featured -eq $true
}

function Load-SelectedScript {
  try {
    $script:loaded = Read-Script $pathBox.Text; $script:existing = $null
    $nameValue.Text=$script:loaded.Name; $namespaceValue.Text=$script:loaded.Namespace; $versionValue.Text=$script:loaded.Version
    $catalogPath=Join-Path $repoRoot 'catalog.json'; $entry=$null
    if(Test-Path -LiteralPath $catalogPath){
      $catalog=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8|ConvertFrom-Json
      $entry=@($catalog.scripts)|Where-Object{($_.name -eq $script:loaded.Name -and $_.namespace -eq $script:loaded.Namespace)-or($idBox.Text -and $_.id -eq $idBox.Text)}|Select-Object -First 1
    }
    if($entry){
      Apply-CatalogEntry $entry
      $sourceHint.Text="Actualización detectada • versión publicada $($entry.version) • $([Math]::Round($script:loaded.Size/1KB)) KB"
      Log "Actualización detectada: $($script:loaded.Name) $($entry.version) → $($script:loaded.Version)" 'ok'
    }else{
      $idBox.Text=Slug $script:loaded.Name; $authorBox.Text=$(if($script:loaded.Author){$script:loaded.Author}else{'DiegoT34'})
      $summaryBox.Text=$script:loaded.Description; $descriptionBox.Text=$script:loaded.Description; $changelogBox.Text="Publicación $($script:loaded.Version)"
      $sourceHint.Text="Script nuevo • $([Math]::Round($script:loaded.Size/1KB)) KB • metadatos correctos"
      Log "Script válido: $($script:loaded.Name) v$($script:loaded.Version)" 'ok'
    }
    Refresh-Preview
  }catch{ Log $_.Exception.Message 'error'; [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Script no válido','OK','Error')|Out-Null }
}

function Verify-OnlinePublication([string]$id,[string]$version){
  for($attempt=1;$attempt -le 5;$attempt+=1){
    try{$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$catalog=Invoke-RestMethod -Uri "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/catalog.json?v=$stamp" -Headers @{'Cache-Control'='no-cache'};$online=@($catalog.scripts)|Where-Object{$_.id -eq $id -and $_.version -eq $version}|Select-Object -First 1;if($online){return $true}}catch{}
    Start-Sleep -Milliseconds 900;[Windows.Forms.Application]::DoEvents()
  }
  return $false
}

$workingArea=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form=[Windows.Forms.Form]::new();$form.Text='PokeGrid Shop Publisher 1.1.2';$form.StartPosition='CenterScreen'
$form.ClientSize=[Drawing.Size]::new([Math]::Min(1280,[Math]::Max(900,$workingArea.Width-90)),[Math]::Min(860,[Math]::Max(660,$workingArea.Height-80)))
$form.MinimumSize=[Drawing.Size]::new(880,650);$form.BackColor=$palette.Background;$form.ForeColor=$palette.Text;$form.Font=[Drawing.Font]::new('Segoe UI',9);$form.AutoScaleMode='Dpi';$form.KeyPreview=$true;$form.AllowDrop=$true

$header=[Windows.Forms.TableLayoutPanel]::new();$header.Dock='Top';$header.Height=88;$header.Padding=[Windows.Forms.Padding]::new(20,12,20,10);$header.BackColor=$palette.Surface;$header.ColumnCount=2;$header.RowCount=2
$header.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$header.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',130))|Out-Null;$header.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',62))|Out-Null;$header.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',38))|Out-Null
$appTitle=New-Label 'PokeGrid Shop Publisher' 19 $palette.Text ([Drawing.FontStyle]::Bold);$appTitle.Dock='Fill'
$appSubtitle=New-Label 'Publicación segura de userscripts, catálogo y actualizaciones.' 8.5 $palette.Muted;$appSubtitle.Dock='Fill'
$statusChip=New-Label '  PREPARADO  ' 7.5 $palette.Primary ([Drawing.FontStyle]::Bold);$statusChip.Dock='Fill';$statusChip.TextAlign='MiddleCenter';$statusChip.BackColor=Color '#102D40';$statusChip.Margin=[Windows.Forms.Padding]::new(10,7,0,7)
$header.Controls.Add($appTitle,0,0);$header.Controls.Add($appSubtitle,0,1);$header.Controls.Add($statusChip,1,0);$header.SetRowSpan($statusChip,2)

$footer=[Windows.Forms.TableLayoutPanel]::new();$footer.Dock='Bottom';$footer.Height=38;$footer.Padding=[Windows.Forms.Padding]::new(17,3,17,3);$footer.BackColor=Color '#08131F';$footer.ColumnCount=4
$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',18))|Out-Null;$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',330))|Out-Null;$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',90))|Out-Null
$statusDot=New-Label '●' 9 $palette.Primary ([Drawing.FontStyle]::Bold);$statusDot.Dock='Fill';$statusLabel=New-Label 'Preparando interfaz…' 8 $palette.Primary;$statusLabel.Dock='Fill'
$repoFooter=New-Label ("Repositorio: "+$repoRoot) 7.5 $palette.Dim;$repoFooter.Dock='Fill';$repoFooter.TextAlign='MiddleRight';$repoFooter.AutoEllipsis=$true
$versionFooter=New-Label 'v1.1.2' 7.5 $palette.Dim ([Drawing.FontStyle]::Bold);$versionFooter.Dock='Fill';$versionFooter.TextAlign='MiddleRight'
$footer.Controls.Add($statusDot,0,0);$footer.Controls.Add($statusLabel,1,0);$footer.Controls.Add($repoFooter,2,0);$footer.Controls.Add($versionFooter,3,0)

$sidebar=[Windows.Forms.Panel]::new();$sidebar.Dock='Left';$sidebar.Width=224;$sidebar.Padding=[Windows.Forms.Padding]::new(14);$sidebar.BackColor=Color '#091523'
$sideBrand=New-Label '◈  POKEGRID' 11 $palette.Primary ([Drawing.FontStyle]::Bold);$sideBrand.Dock='Top';$sideBrand.Height=42
$sideIntro=New-Label 'Flujo de publicación' 8 $palette.Muted ([Drawing.FontStyle]::Bold);$sideIntro.Dock='Top';$sideIntro.Height=24
$stepsPanel=[Windows.Forms.FlowLayoutPanel]::new();$stepsPanel.Dock='Top';$stepsPanel.Height=200;$stepsPanel.FlowDirection='TopDown';$stepsPanel.WrapContents=$false
foreach($step in @(@('01','Selecciona el script','Lee y valida los metadatos.'),@('02','Completa la ficha','Información visible en la Shop.'),@('03','Publica','Catálogo, hash, commit y push.'))){
  $stepPanel=[Windows.Forms.Panel]::new();$stepPanel.Size=[Drawing.Size]::new(190,59);$stepPanel.BackColor=$palette.Surface;$stepPanel.Margin=[Windows.Forms.Padding]::new(0,0,0,6)
  $stepNumber=New-Label $step[0] 9 $palette.Primary ([Drawing.FontStyle]::Bold);$stepNumber.Location=[Drawing.Point]::new(10,9);$stepNumber.Size=[Drawing.Size]::new(30,22)
  $stepTitle=New-Label $step[1] 9 $palette.Text ([Drawing.FontStyle]::Bold);$stepTitle.Location=[Drawing.Point]::new(43,7);$stepTitle.Size=[Drawing.Size]::new(137,24)
  $stepCopy=New-Label $step[2] 7.3 $palette.Muted;$stepCopy.Location=[Drawing.Point]::new(43,30);$stepCopy.Size=[Drawing.Size]::new(137,30)
  $stepPanel.Controls.AddRange(@($stepNumber,$stepTitle,$stepCopy));$stepsPanel.Controls.Add($stepPanel)
}
$previewPanel=[Windows.Forms.Panel]::new();$previewPanel.Dock='Top';$previewPanel.Height=120;$previewPanel.BackColor=$palette.SurfaceRaised;$previewPanel.Padding=[Windows.Forms.Padding]::new(12)
$modeLabel=New-Label 'NUEVA PUBLICACIÓN' 7.2 $palette.Primary ([Drawing.FontStyle]::Bold);$modeLabel.Dock='Top';$modeLabel.Height=22
$previewIcon=New-Label '🧩' 23 $palette.Text;$previewIcon.Font=[Drawing.Font]::new('Segoe UI Emoji',22);$previewIcon.Dock='Left';$previewIcon.Width=54;$previewIcon.TextAlign='MiddleCenter'
$previewCopy=[Windows.Forms.Panel]::new();$previewCopy.Dock='Fill';$previewCopy.Padding=[Windows.Forms.Padding]::new(8,6,0,0)
$previewName=New-Label 'Nombre del script' 9.5 $palette.Text ([Drawing.FontStyle]::Bold);$previewName.Dock='Top';$previewName.Height=28;$previewName.AutoEllipsis=$true
$previewMeta=New-Label 'Selecciona un userscript' 7.5 $palette.Muted;$previewMeta.Dock='Top';$previewMeta.Height=23
$previewId=New-Label 'id-estable' 7 $palette.Dim;$previewId.Dock='Top';$previewId.Height=22;$previewId.AutoEllipsis=$true
$previewCopy.Controls.Add($previewId);$previewCopy.Controls.Add($previewMeta);$previewCopy.Controls.Add($previewName);$previewPanel.Controls.Add($previewCopy);$previewPanel.Controls.Add($previewIcon);$previewPanel.Controls.Add($modeLabel)
$sideLinks=[Windows.Forms.FlowLayoutPanel]::new();$sideLinks.Dock='Bottom';$sideLinks.Height=88;$sideLinks.FlowDirection='TopDown';$sideLinks.WrapContents=$false
$openRepoButton=New-Button '↗ Abrir repositorio' 'ghost';$openRepoButton.Size=[Drawing.Size]::new(188,36);$openRepoButton.Margin=[Windows.Forms.Padding]::new(0,0,0,5);$catalogButton=New-Button '↗ Ver catálogo online' 'ghost';$catalogButton.Size=[Drawing.Size]::new(188,36);$catalogButton.Margin=[Windows.Forms.Padding]::new(0);$sideLinks.Controls.AddRange(@($openRepoButton,$catalogButton))
$sidebar.Controls.Add($previewPanel);$sidebar.Controls.Add($stepsPanel);$sidebar.Controls.Add($sideIntro);$sidebar.Controls.Add($sideBrand);$sidebar.Controls.Add($sideLinks)

$contentStack=[Windows.Forms.FlowLayoutPanel]::new();$contentStack.Dock='Fill';$contentStack.FlowDirection='TopDown';$contentStack.WrapContents=$false;$contentStack.AutoScroll=$true;$contentStack.Padding=[Windows.Forms.Padding]::new(18,18,18,20);$contentStack.BackColor=$palette.Background

$sourceCard=New-Card 222;$sourceLayout=[Windows.Forms.TableLayoutPanel]::new();$sourceLayout.Dock='Fill';$sourceLayout.ColumnCount=1;$sourceLayout.RowCount=4
foreach($height in @(55,45,65)){ $sourceLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',$height))|Out-Null };$sourceLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',100))|Out-Null
$sourceLayout.Controls.Add((New-SectionHeader '01' 'Selecciona el userscript' 'Arrastra el archivo o búscalo en tu equipo.'),0,0)
$pathRow=[Windows.Forms.TableLayoutPanel]::new();$pathRow.Dock='Fill';$pathRow.ColumnCount=3;$pathRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$pathRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',112))|Out-Null;$pathRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',96))|Out-Null
$pathBox=New-TextBox;$pathBox.Dock='Fill';$pathBox.Margin=[Windows.Forms.Padding]::new(5);$browseButton=New-Button 'Examinar…' 'primary';$browseButton.Dock='Fill';$readButton=New-Button 'Leer datos';$readButton.Dock='Fill'
$pathRow.Controls.Add($pathBox,0,0);$pathRow.Controls.Add($browseButton,1,0);$pathRow.Controls.Add($readButton,2,0);$sourceLayout.Controls.Add($pathRow,0,1)
$detectedGrid=[Windows.Forms.TableLayoutPanel]::new();$detectedGrid.Dock='Fill';$detectedGrid.ColumnCount=3;$detectedGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',42))|Out-Null;$detectedGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',42))|Out-Null;$detectedGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',16))|Out-Null
$nameValue=New-TextBox -ReadOnly;$namespaceValue=New-TextBox -ReadOnly;$versionValue=New-TextBox -ReadOnly
$detectedGrid.Controls.Add((New-Field 'NOMBRE DETECTADO' $nameValue),0,0);$detectedGrid.Controls.Add((New-Field 'NAMESPACE' $namespaceValue),1,0);$detectedGrid.Controls.Add((New-Field 'VERSIÓN' $versionValue),2,0);$sourceLayout.Controls.Add($detectedGrid,0,2)
$sourceHint=New-Label 'Arrastra un archivo aquí o utiliza Examinar.' 8 $palette.Dim;$sourceHint.Dock='Fill';$sourceHint.Margin=[Windows.Forms.Padding]::new(6,0,0,0);$sourceLayout.Controls.Add($sourceHint,0,3);$sourceCard.Controls.Add($sourceLayout)

$publicationCard=New-Card 493;$publicationLayout=[Windows.Forms.TableLayoutPanel]::new();$publicationLayout.Dock='Fill';$publicationLayout.ColumnCount=1;$publicationLayout.RowCount=6
foreach($height in @(55,66,66,126,89,45)){ $publicationLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',$height))|Out-Null };$publicationLayout.Controls.Add((New-SectionHeader '02' 'Completa la ficha de la Shop' 'Esta información será visible para todos los usuarios del launcher.'),0,0)
$identityGrid=[Windows.Forms.TableLayoutPanel]::new();$identityGrid.Dock='Fill';$identityGrid.ColumnCount=4;foreach($width in @(32,27,13,28)){ $identityGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',$width))|Out-Null }
$idBox=New-TextBox;$categoryBox=[Windows.Forms.ComboBox]::new();Style-Input $categoryBox|Out-Null;$categoryBox.DropDownStyle='DropDown';[void]$categoryBox.Items.AddRange(@('Market','Crianza','Calculadoras','Interfaz','Comunicación','Notificaciones','Utilidades'));$categoryBox.Text='Utilidades';$iconBox=New-TextBox;$iconBox.Font=[Drawing.Font]::new('Segoe UI Emoji',10);$iconBox.Text='🧩';$minLauncherBox=New-TextBox;$minLauncherBox.Text='0.22.3'
$identityGrid.Controls.Add((New-Field 'ID ESTABLE' $idBox 'Conserva exactamente el mismo ID en cada actualización.'),0,0);$identityGrid.Controls.Add((New-Field 'CATEGORÍA' $categoryBox),1,0);$identityGrid.Controls.Add((New-Field 'ICONO' $iconBox 'Emoji que aparecerá en la tarjeta.'),2,0);$identityGrid.Controls.Add((New-Field 'LAUNCHER MÍNIMO' $minLauncherBox),3,0);$publicationLayout.Controls.Add($identityGrid,0,1)
$summaryGrid=[Windows.Forms.TableLayoutPanel]::new();$summaryGrid.Dock='Fill';$summaryGrid.ColumnCount=3;$summaryGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',24))|Out-Null;$summaryGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',35))|Out-Null;$summaryGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',41))|Out-Null
$authorBox=New-TextBox;$tagsBox=New-TextBox;$summaryBox=New-TextBox;$summaryGrid.Controls.Add((New-Field 'AUTOR' $authorBox),0,0);$summaryGrid.Controls.Add((New-Field 'ETIQUETAS' $tagsBox 'Sepáralas mediante comas.'),1,0);$summaryGrid.Controls.Add((New-Field 'RESUMEN PARA LA TARJETA' $summaryBox),2,0);$publicationLayout.Controls.Add($summaryGrid,0,2)
$detailsGrid=[Windows.Forms.TableLayoutPanel]::new();$detailsGrid.Dock='Fill';$detailsGrid.ColumnCount=2;$detailsGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',52))|Out-Null;$detailsGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',48))|Out-Null
$descriptionBox=New-TextBox -Multiline;$permissionsBox=New-TextBox -Multiline;$detailsGrid.Controls.Add((New-Field 'DESCRIPCIÓN COMPLETA' $descriptionBox),0,0);$detailsGrid.Controls.Add((New-Field 'PERMISOS · UNO POR LÍNEA' $permissionsBox),1,0);$publicationLayout.Controls.Add($detailsGrid,0,3)
$changelogBox=New-TextBox -Multiline;$publicationLayout.Controls.Add((New-Field 'CAMBIOS DE ESTA VERSIÓN' $changelogBox),0,4)
$featureBar=[Windows.Forms.TableLayoutPanel]::new();$featureBar.Dock='Fill';$featureBar.ColumnCount=2;$featureBar.Padding=[Windows.Forms.Padding]::new(6,2,6,2);$featureBar.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$featureBar.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',190))|Out-Null
$featureHint=New-Label 'El ID, namespace y nombre identifican una actualización existente.' 7.7 $palette.Dim;$featureHint.Dock='Fill';$featuredBox=[Windows.Forms.CheckBox]::new();$featuredBox.Text='★ Marcar como destacado';$featuredBox.Dock='Fill';$featuredBox.ForeColor=$palette.Warning;$featuredBox.BackColor=$palette.Surface;$featuredBox.Font=[Drawing.Font]::new('Segoe UI Semibold',8.5,[Drawing.FontStyle]::Bold)
$featureBar.Controls.Add($featureHint,0,0);$featureBar.Controls.Add($featuredBox,1,0);$publicationLayout.Controls.Add($featureBar,0,5);$publicationCard.Controls.Add($publicationLayout)

$actionCard=New-Card 245;$actionLayout=[Windows.Forms.TableLayoutPanel]::new();$actionLayout.Dock='Fill';$actionLayout.ColumnCount=1;$actionLayout.RowCount=3;$actionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',55))|Out-Null;$actionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',51))|Out-Null;$actionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',100))|Out-Null
$actionLayout.Controls.Add((New-SectionHeader '03' 'Valida y publica' 'La aplicación sincroniza, calcula SHA-256, crea el commit y hace push.'),0,0)
$actions=[Windows.Forms.TableLayoutPanel]::new();$actions.Dock='Fill';$actions.ColumnCount=5;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',122))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',110))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',110))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',220))|Out-Null
$validateButton=New-Button '✓ Validar' 'primary';$validateButton.Dock='Fill';$clearButton=New-Button 'Limpiar' 'ghost';$clearButton.Dock='Fill';$openFolderButton=New-Button 'Carpeta local' 'ghost';$openFolderButton.Dock='Fill';$publishButton=New-Button '↑ Publicar en la Shop' 'accent';$publishButton.Dock='Fill'
$actions.Controls.Add($validateButton,0,0);$actions.Controls.Add($clearButton,1,0);$actions.Controls.Add($openFolderButton,2,0);$actions.Controls.Add($publishButton,4,0);$actionLayout.Controls.Add($actions,0,1)
$logBox=New-TextBox -Multiline -ReadOnly;$logBox.BackColor=Color '#06101B';$logBox.Font=[Drawing.Font]::new('Cascadia Mono',8.4);$logBox.Margin=[Windows.Forms.Padding]::new(5,4,5,3);$actionLayout.Controls.Add($logBox,0,2);$actionCard.Controls.Add($actionLayout)

$contentStack.Controls.AddRange(@($sourceCard,$publicationCard,$actionCard));$form.Controls.Add($contentStack);$form.Controls.Add($sidebar);$form.Controls.Add($footer);$form.Controls.Add($header)

function Apply-ResponsiveLayout {
  $compact=$form.ClientSize.Width -lt 1040;$sidebar.Visible=-not $compact;$available=$contentStack.ClientSize.Width-$contentStack.Padding.Horizontal-24
  foreach($card in @($sourceCard,$publicationCard,$actionCard)){ $card.Width=[Math]::Max(700,$available) }
  $repoFooter.Visible=$form.ClientSize.Width -ge 1080
}

$form.Add_Resize({Apply-ResponsiveLayout});$form.Add_Shown({Apply-ResponsiveLayout})
$browseButton.Add_Click({$dialog=[Windows.Forms.OpenFileDialog]::new();$dialog.Title='Seleccionar userscript';$dialog.Filter='Userscripts (*.user.js;*.js)|*.user.js;*.js|JavaScript (*.js)|*.js';if($dialog.ShowDialog() -eq 'OK'){$pathBox.Text=$dialog.FileName;Load-SelectedScript}})
$readButton.Add_Click({Load-SelectedScript});$validateButton.Add_Click({Load-SelectedScript});$clearButton.Add_Click({Clear-PublicationFields})
$openRepoButton.Add_Click({Start-Process 'https://github.com/DiegoT34/PokeGrid-Script-Shop'});$catalogButton.Add_Click({Start-Process 'https://github.com/DiegoT34/PokeGrid-Script-Shop/blob/main/catalog.json'});$openFolderButton.Add_Click({Start-Process explorer.exe -ArgumentList $repoRoot})
$dragEnter={if($_.Data.GetDataPresent([Windows.Forms.DataFormats]::FileDrop)){$_.Effect=[Windows.Forms.DragDropEffects]::Copy}};$dragDrop={$files=@($_.Data.GetData([Windows.Forms.DataFormats]::FileDrop));$file=$files|Where-Object{$_ -match '(?i)(?:\.user)?\.js$'}|Select-Object -First 1;if($file){$pathBox.Text=$file;Load-SelectedScript}}
$form.Add_DragEnter($dragEnter);$form.Add_DragDrop($dragDrop);$sourceCard.AllowDrop=$true;$sourceCard.Add_DragEnter($dragEnter);$sourceCard.Add_DragDrop($dragDrop)
foreach($control in @($idBox,$iconBox,$nameValue,$versionValue)){$control.Add_TextChanged({Refresh-Preview})};$categoryBox.Add_TextChanged({Refresh-Preview})
$form.Add_KeyDown({if($_.Control -and $_.KeyCode -eq 'O'){$browseButton.PerformClick();$_.SuppressKeyPress=$true};if($_.Control -and $_.KeyCode -eq 'Enter'){$validateButton.PerformClick();$_.SuppressKeyPress=$true}})

$publishButton.Add_Click({
  if($script:isBusy){return};Set-Busy $true
  try{
    $script:loaded=Read-Script $pathBox.Text
    if($idBox.Text -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$'){throw 'El ID estable debe usar minúsculas, números, punto, guion o guion bajo.'}
    if(-not $summaryBox.Text.Trim()){throw 'Añade un resumen para la tarjeta de la Shop.'};if(-not $descriptionBox.Text.Trim()){throw 'Añade una descripción completa.'};if(-not $changelogBox.Text.Trim()){throw 'Describe los cambios de esta versión.'}
    if(-not(Test-Path -LiteralPath (Join-Path $repoRoot '.git'))){throw 'No se encontró el repositorio Git de la Shop.'}
    $question="¿Publicar $($script:loaded.Name) v$($script:loaded.Version)?`r`n`r`nID: $($idBox.Text)`r`nCategoría: $($categoryBox.Text)"
    if([Windows.Forms.MessageBox]::Show($question,'Confirmar publicación','YesNo','Question') -ne 'Yes'){Log 'Publicación cancelada por el usuario.';return}
    Log 'Sincronizando el repositorio…';[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('pull','--ff-only'))
    $tags=@($tagsBox.Text -split ','|ForEach-Object{$_.Trim()}|Where-Object{$_});$permissions=@($permissionsBox.Lines|ForEach-Object{$_.Trim()}|Where-Object{$_})
    $parameters=@{Path=$script:loaded.Path;Id=$idBox.Text;Category=$categoryBox.Text;Tags=$tags;Permissions=$permissions;Summary=$summaryBox.Text;Description=$descriptionBox.Text;Changelog=$changelogBox.Text;Author=$authorBox.Text;MinLauncherVersion=$minLauncherBox.Text;Icon=$iconBox.Text;Featured=$featuredBox.Checked;RepositoryRoot=$repoRoot}
    Log 'Generando archivo publicado, catálogo y SHA-256…';$publisherOutput=& $cliPublisher @parameters 2>&1|Out-String;Log $publisherOutput.Trim()
    $target="scripts/$($idBox.Text).user.js";[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('add','--','catalog.json',$target));$diffResult=Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('diff','--cached','--quiet') -AllowFailure
    if($diffResult.ExitCode -eq 0){Log 'No hay cambios nuevos para publicar.' 'ok';return};if($diffResult.ExitCode -ne 1){throw $(if($diffResult.Output){$diffResult.Output}else{'No se pudieron comprobar los cambios preparados.'})}
    $message="Publicar $($script:loaded.Name) $($script:loaded.Version)";Log 'Creando commit local…';[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('commit','-m',$message,'--','catalog.json',$target));Log 'Subiendo la publicación a GitHub…';[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('push'))
    Log 'Verificando que el catálogo ya sea visible online…'
    if(Verify-OnlinePublication $idBox.Text $script:loaded.Version){Log "$($script:loaded.Name) v$($script:loaded.Version) está visible en la Shop." 'ok';[Windows.Forms.MessageBox]::Show('El script fue publicado y ya aparece en el catálogo online.','Publicación completada','OK','Information')|Out-Null}else{Log 'GitHub recibió la publicación; la propagación del catálogo aún está en curso.' 'ok';[Windows.Forms.MessageBox]::Show('La publicación fue subida correctamente. GitHub puede tardar unos segundos en reflejarla en el catálogo.','Publicación enviada','OK','Information')|Out-Null}
  }catch{Log $_.Exception.Message 'error';[Windows.Forms.MessageBox]::Show($_.Exception.Message,'No se pudo publicar','OK','Error')|Out-Null}finally{Set-Busy $false}
})

Refresh-Preview;Log "Repositorio listo: $repoRoot" 'ok'

if($SmokeTest){
  Apply-ResponsiveLayout
  if(-not $publishButton -or -not $pathBox -or -not $contentStack.AutoScroll -or -not(Test-Path -LiteralPath $cliPublisher)){throw 'La interfaz adaptable del publicador no pudo inicializarse.'}
  $largeWidth=$sourceCard.Width;$form.ClientSize=[Drawing.Size]::new(900,680);Apply-ResponsiveLayout
  if($sidebar.Visible -or $sourceCard.Width -ge $largeWidth){throw 'La respuesta compacta del layout no funciona.'}
  [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('status','--porcelain=v1'))
  Write-Output 'PokeGrid Shop Publisher 1.1.2 responsive GUI and Git smoke passed.';$form.Dispose();exit 0
}

if($ScreenshotPath){
  $timer=[Windows.Forms.Timer]::new();$timer.Interval=1000
  $timer.Add_Tick({$timer.Stop();$target=[IO.Path]::GetFullPath($ScreenshotPath);New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;$bitmap=[Drawing.Bitmap]::new($form.Width,$form.Height);$graphics=[Drawing.Graphics]::FromImage($bitmap);$graphics.CopyFromScreen($form.Location,[Drawing.Point]::Empty,$form.Size);$bitmap.Save($target,[Drawing.Imaging.ImageFormat]::Png);$graphics.Dispose();$bitmap.Dispose();$form.Close()});$timer.Start()
}

[void]$form.ShowDialog()
