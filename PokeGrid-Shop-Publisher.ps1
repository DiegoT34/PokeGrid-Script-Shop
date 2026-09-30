param(
  [switch]$SmokeTest,
  [string]$ScreenshotPath = '',
  [ValidateSet('Shop','Catalog','Launcher')][string]$InitialTab = 'Shop'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$programRoot = $PSScriptRoot
$repoRoot = $programRoot
$cliPublisher = Join-Path $programRoot 'tools\publish-script.ps1'
$catalogRemover = Join-Path $programRoot 'tools\remove-script.ps1'
$launcherPublisher = Join-Path $programRoot 'tools\publish-launcher.ps1'
$gitHelper = Join-Path $programRoot 'tools\git-helper.ps1'
$script:MaxScriptBytes = 10MB
$ghPath = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $ghPath -and (Test-Path -LiteralPath 'C:\Program Files\GitHub CLI\gh.exe')) { $ghPath = 'C:\Program Files\GitHub CLI\gh.exe' }
if (-not (Test-Path -LiteralPath $cliPublisher -PathType Leaf)) { throw 'No se encontró tools\publish-script.ps1.' }
if (-not (Test-Path -LiteralPath $catalogRemover -PathType Leaf)) { throw 'No se encontró tools\remove-script.ps1.' }
if (-not (Test-Path -LiteralPath $launcherPublisher -PathType Leaf)) { throw 'No se encontró tools\publish-launcher.ps1.' }
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
$script:publicationMode = 'New'
$script:isBusy = $false
$script:buttonStyles = @{}
$script:catalogEntries = @()
$script:catalogSelected = $null
$script:launcherInfo = $null
$launcherRepoRoot = @(
  (Join-Path (Split-Path -Parent $programRoot) 'PokeGrid-Launcher'),
  (Join-Path $env:USERPROFILE 'Downloads\PokeGrid-Launcher'),
  (Join-Path $env:LOCALAPPDATA 'PokeGrid-Shop-Publisher\launcher-repository')
) | Where-Object { Test-Path -LiteralPath (Join-Path $_ '.git') -PathType Container } | Select-Object -First 1
if (-not $launcherRepoRoot) { $launcherRepoRoot = Join-Path $env:USERPROFILE 'Downloads\PokeGrid-Launcher' }

function Color([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }

# Los tokens visuales viven en tools/theme.ps1 como DATOS, no como codigo: cambiar
# el aspecto de la aplicacion es cambiar el tema activo, no editar esta tabla.
$themePath = Join-Path $PSScriptRoot 'tools\theme.ps1'
if (-not (Test-Path -LiteralPath $themePath -PathType Leaf)) { throw 'No se encontró tools\theme.ps1.' }
. $themePath
$script:theme = Get-PokeGridTheme (Read-PokeGridThemeKey)

# $palette se mantiene como proxy para no tocar los usos ya escritos: cada clave
# apunta a un token del tema activo, no a un color fijo. Los botones usan tokens
# Rest.*, que en el tema oscuro son mas saturados que los antiguos Primary y Accent.
$palette = [pscustomobject]@{
  Background   = Get-ThemeColor 'Base'
  Surface      = Get-ThemeColor 'Surface.Base'
  SurfaceRaised= Get-ThemeColor 'Surface.Raised'
  SurfaceSoft  = Get-ThemeColor 'Surface.Soft'
  Border       = Get-ThemeColor 'Border.Base'
  BorderFocus  = Get-ThemeColor 'Rest.Primary.Hover'
  Text         = Get-ThemeColor 'Text.Primary'
  Muted        = Get-ThemeColor 'Text.Secondary'
  Dim          = Get-ThemeColor 'Text.Disabled'
  Primary      = Get-ThemeColor 'Rest.Primary.Hover'
  PrimaryDark  = Get-ThemeColor 'Rest.Primary.Base'
  Accent       = Get-ThemeColor 'Rest.Danger.Hover'
  AccentDark   = Get-ThemeColor 'Rest.Danger.Base'
  Success      = Get-ThemeColor 'Rest.Success.Base'
  Warning      = Get-ThemeColor 'Rest.Warning.Base'
  Danger       = Get-ThemeColor 'Rest.Danger.Fore'
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
  $control.BackColor = $(if ($ReadOnly) { $palette.SurfaceSoft } else { Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.14 })
  $control.ForeColor = $(if ($ReadOnly) { Get-ThemeColor 'Text.Secondary' } else { $palette.Text })
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
  $button.Font = [Drawing.Font]::new('Segoe UI Semibold', 9.5, [Drawing.FontStyle]::Bold)
  $button.Cursor = 'Hand'
  $button.Margin = [Windows.Forms.Padding]::new(4)
  $button.UseVisualStyleBackColor = $false
  # 'accent' es el nombre antiguo del boton de accion; el rol se llama 'danger'.
  # Las 15 llamadas existentes siguen pasando 'accent' y no se tocan.
  $role = if ($kind -eq 'accent') { 'danger' } else { $kind }
  Set-ButtonRole $button $role | Out-Null
  $button.Add_MouseEnter(({ if ($this.Enabled) { $s = $script:buttonStyles[[int]$this.GetHashCode()].Style; $this.BackColor = $s.Hover; $this.FlatAppearance.BorderColor = $s.Hover } }.GetNewClosure()))
  $button.Add_MouseLeave(({ $s = $script:buttonStyles[[int]$this.GetHashCode()].Style; $this.BackColor = $s.Base; $this.FlatAppearance.BorderColor = $s.Border; $this.Region = New-RoundedRegion $this.Width $this.Height ([int]$script:theme.Radius) }.GetNewClosure()))
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
  $badge.Dock = 'Fill'; $badge.TextAlign = 'MiddleCenter'; $badge.BackColor = Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Primary.Base') 0.22; $badge.Margin = [Windows.Forms.Padding]::new(3, 5, 8, 5)
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

function Find-CatalogEntry($catalog, $loaded) {
  if (-not $catalog -or -not $loaded) { return $null }
  $matches = @(@($catalog.scripts) | Where-Object {
    ([string]$_.name).Trim() -ieq ([string]$loaded.Name).Trim() -and
    ([string]$_.namespace).Trim() -ieq ([string]$loaded.Namespace).Trim()
  })
  if ($matches.Count -gt 1) { throw "El catálogo contiene más de una entrada para $($loaded.Name) y su namespace. Corrige el catálogo antes de publicar." }
  return $matches | Select-Object -First 1
}

function Get-UniqueScriptId($catalog, [string]$name) {
  $base = Slug $name
  if (-not $base) { $base = 'nuevo-script' }
  $used = @(@($catalog.scripts) | ForEach-Object { ([string]$_.id).ToLowerInvariant() })
  if ($used -notcontains $base.ToLowerInvariant()) { return $base }
  for ($suffix = 2; $suffix -le 999; $suffix += 1) {
    $candidate = "$base-$suffix"
    if ($used -notcontains $candidate.ToLowerInvariant()) { return $candidate }
  }
  throw "No se pudo generar un ID disponible para $name."
}

function Read-Script([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Selecciona un archivo existente.' }
  $file = Get-Item -LiteralPath $path
  if ($file.Length -le 0 -or $file.Length -gt $script:MaxScriptBytes) { throw 'El script está vacío o supera 10 MB.' }
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
  foreach ($control in @($publishButton,$validateButton,$browseButton,$catalogRefreshButton,$catalogDeleteButton,$launcherBrowseButton,$launcherRefreshButton,$launcherValidateButton,$launcherPublishButton)) {
    if ($control) { $control.Enabled = -not $busy }
  }
  $form.UseWaitCursor = $busy
  [Windows.Forms.Application]::DoEvents()
}

function Log([string]$message, [string]$kind = 'info') {
  $time = (Get-Date).ToString('HH:mm:ss')
  $logBox.AppendText("[$time] $message`r`n"); $logBox.SelectionStart = $logBox.TextLength; $logBox.ScrollToCaret()
  $statusDot.ForeColor = $(if ($kind -eq 'error') { $palette.Danger } elseif ($kind -eq 'ok') { $palette.Success } else { $palette.Primary })
  $statusLabel.ForeColor = $statusDot.ForeColor; $statusLabel.Text = $message
  $statusChip.Text = $(if ($kind -eq 'error') { '  REVISAR  ' } elseif ($kind -eq 'ok') { '  LISTO  ' } else { '  EN PROCESO  ' })
  $statusChip.BackColor = $(if ($kind -eq 'error') { Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Danger.Base') 0.22 } elseif ($kind -eq 'ok') { Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Success.Base') 0.22 } else { Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Primary.Base') 0.22 })
  [Windows.Forms.Application]::DoEvents()
}

function Refresh-Preview {
  $previewIcon.Text = $(if ($iconBox.Text.Trim()) { $iconBox.Text.Trim() } else { '🧩' })
  $previewName.Text = $(if ($nameValue.Text.Trim()) { $nameValue.Text.Trim() } else { 'Nombre del script' })
  $previewMeta.Text = $(if ($versionValue.Text.Trim()) { "v$($versionValue.Text)  •  $($categoryBox.Text)" } else { 'Selecciona un userscript' })
  $previewId.Text = $(if ($idBox.Text.Trim()) { $idBox.Text.Trim() } else { 'id-estable' })
  $isUpdate = $script:publicationMode -eq 'Update'
  $modeLabel.Text = $(if ($isUpdate) { 'ACTUALIZACIÓN EXISTENTE' } else { 'SCRIPT NUEVO' })
  $modeLabel.ForeColor = $(if ($isUpdate) { $palette.Warning } else { $palette.Primary })
  $publishButton.Text = $(if ($isUpdate) { '↑ Publicar actualización' } else { '↑ Agregar nuevo script' })
}

function Clear-PublicationFields {
  $script:loaded = $null; $script:existing = $null; $script:publicationMode = 'New'
  $idBox.ReadOnly = $false
  @($pathBox,$nameValue,$namespaceValue,$versionValue,$idBox,$authorBox,$tagsBox,$summaryBox,$descriptionBox,$permissionsBox,$changelogBox) | ForEach-Object { $_.Clear() }
  $categoryBox.Text = 'Utilidades'; $iconBox.Text = '🧩'; $minLauncherBox.Text = '0.22.1'; $featuredBox.Checked = $false
  $sourceHint.Text = 'Arrastra un archivo aquí o utiliza Examinar.'
  Refresh-Preview; Log 'Formulario limpio. Selecciona un userscript para comenzar.'
}

function Apply-CatalogEntry($entry) {
  $script:existing = $entry; $script:publicationMode = 'Update'
  $idBox.ReadOnly = $true
  $idBox.Text=[string]$entry.id; $categoryBox.Text=[string]$entry.category; $iconBox.Text=[string]$entry.icon; $minLauncherBox.Text=[string]$entry.minLauncherVersion
  $authorBox.Text=[string]$entry.author; $tagsBox.Text=@($entry.tags)-join ', '; $summaryBox.Text=[string]$entry.summary; $descriptionBox.Text=[string]$entry.description
  $permissionsBox.Lines=@($entry.permissions); $changelogBox.Text="Actualización $($script:loaded.Version)"; $featuredBox.Checked=$entry.featured -eq $true
}

function Load-SelectedScript {
  try {
    $script:loaded = Read-Script $pathBox.Text; $script:existing = $null; $script:publicationMode = 'New'
    $idBox.ReadOnly = $false
    @($idBox,$authorBox,$tagsBox,$summaryBox,$descriptionBox,$permissionsBox,$changelogBox) | ForEach-Object { $_.Clear() }
    $categoryBox.Text='Utilidades';$iconBox.Text='🧩';$minLauncherBox.Text = '0.22.1';$featuredBox.Checked=$false
    $nameValue.Text=$script:loaded.Name; $namespaceValue.Text=$script:loaded.Namespace; $versionValue.Text=$script:loaded.Version
    $catalogPath=Join-Path $repoRoot 'catalog.json'; $entry=$null; $catalog=[pscustomobject]@{scripts=@()}
    if(Test-Path -LiteralPath $catalogPath){
      $catalog=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8|ConvertFrom-Json
      $entry=Find-CatalogEntry $catalog $script:loaded
    }
    if($entry){
      Apply-CatalogEntry $entry
      $sourceHint.Text="Actualización detectada • versión publicada $($entry.version) • $(Get-SourceSizeText $script:loaded.Size)"
      Log "Actualización detectada: $($script:loaded.Name) $($entry.version) → $($script:loaded.Version)" 'ok'
    }else{
      $idBox.Text=Get-UniqueScriptId $catalog $script:loaded.Name; $authorBox.Text=$(if($script:loaded.Author){$script:loaded.Author}else{'DiegoT34'})
      $summaryBox.Text=$script:loaded.Description; $descriptionBox.Text=$script:loaded.Description; $changelogBox.Text="Publicación $($script:loaded.Version)"
      $sourceHint.Text="Script nuevo • $(Get-SourceSizeText $script:loaded.Size) • metadatos correctos"
      Log "Nuevo script detectado: $($script:loaded.Name) v$($script:loaded.Version) • ID propuesto: $($idBox.Text)" 'ok'
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

function Get-SourceSizeText([int64]$SizeBytes) {
  $limitMB = $script:MaxScriptBytes / 1MB
  $mb = [Math]::Round($SizeBytes / 1MB, 2)
  $ratio = $SizeBytes / $script:MaxScriptBytes
  if ($ratio -gt 0.5) {
    $sourceHint.ForeColor = $palette.Warning
    return "$mb MB - $("{0:N0}" -f ($ratio * 100))% del limite de $limitMB MB"
  }
  $sourceHint.ForeColor = $palette.Dim
  return "$mb MB de un maximo de $limitMB MB"
}

function Get-PushFailureMessage([string]$Name, [string]$Version, [string]$ErrorText) {
  return @(
    "El commit de $Name v$Version se creó correctamente en el repositorio local, pero no se pudo subir a GitHub.",
    '',
    'El catálogo online NO ha cambiado: los usuarios siguen viendo la versión anterior.',
    'El trabajo no se ha perdido. Es un problema de autenticación o de red: revisa la sesión de GitHub CLI.',
    'Para completar la publicación, ejecuta en esa carpeta:',
    '',
    '    git push',
    '',
    'Detalle del error:',
    $ErrorText
  ) -join "`r`n"
}

function Verify-OnlineRemoval([string]$id){
  for($attempt=1;$attempt -le 6;$attempt+=1){
    try{
      $stamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $catalog=Invoke-RestMethod -Uri "https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/catalog.json?v=$stamp" -Headers @{'Cache-Control'='no-cache';'User-Agent'='PokeGrid-Shop-Publisher'}
      if(-not(@($catalog.scripts)|Where-Object{[string]$_.id -ceq $id}|Select-Object -First 1)){return $true}
    }catch{}
    Start-Sleep -Milliseconds 900;[Windows.Forms.Application]::DoEvents()
  }
  return $false
}

function Log-Catalog([string]$message,[string]$kind='info'){
  $time=(Get-Date).ToString('HH:mm:ss')
  if($catalogLogBox){$catalogLogBox.AppendText("[$time] $message`r`n");$catalogLogBox.SelectionStart=$catalogLogBox.TextLength;$catalogLogBox.ScrollToCaret()}
  $statusDot.ForeColor=$(if($kind -eq 'error'){$palette.Danger}elseif($kind -eq 'ok'){$palette.Success}else{$palette.Primary})
  $statusLabel.ForeColor=$statusDot.ForeColor;$statusLabel.Text=$message
  $statusChip.Text=$(if($kind -eq 'error'){'  REVISAR  '}elseif($kind -eq 'ok'){'  LISTO  '}else{'  EN PROCESO  '})
  $statusChip.BackColor=$(if($kind -eq 'error'){Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Danger.Base') 0.22}elseif($kind -eq 'ok'){Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Success.Base') 0.22}else{Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Primary.Base') 0.22})
  [Windows.Forms.Application]::DoEvents()
}

function Show-CatalogEntry($entry){
  $script:catalogSelected=$entry
  $hasEntry=$null -ne $entry
  $catalogDeleteButton.Enabled=$hasEntry -and -not $script:isBusy
  $catalogOpenScriptButton.Enabled=$hasEntry
  if(-not $hasEntry){
    $catalogDetailIcon.Text='◌';$catalogDetailName.Text='Selecciona una publicación';$catalogDetailMeta.Text='La información completa aparecerá aquí.'
    $catalogDetailGames.Text='—';$catalogDetailDescription.Text='';$catalogDetailId.Text='';$catalogDetailHash.Text='';return
  }
  $catalogDetailIcon.Text=$(if([string]$entry.icon){[string]$entry.icon}else{'🧩'})
  $catalogDetailName.Text=[string]$entry.name
  $catalogDetailMeta.Text="v$($entry.version)  •  $($entry.category)  •  $($entry.author)"
  $catalogDetailGames.Text=$(if(@($entry.games).Count){@($entry.games)-join '  •  '}else{'Juego no declarado'})
  $catalogDetailDescription.Text=$(if([string]$entry.description){[string]$entry.description}else{[string]$entry.summary})
  $catalogDetailId.Text="ID: $($entry.id)  •  Publicado: $($entry.publishedAt)"
  $catalogDetailHash.Text="SHA-256: $($entry.sha256)"
}

function Get-CatalogGameLabels($entry){
  $declared=@($entry.games|ForEach-Object{([string]$_).Trim()}|Where-Object{$_}|Select-Object -Unique)
  if($declared.Count){return $declared}
  $scriptPath=Join-Path $repoRoot "scripts\$($entry.id).user.js"
  if(Test-Path -LiteralPath $scriptPath -PathType Leaf){
    $code=Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8
    $metadataGames=@([regex]::Matches($code,'(?im)^\s*//\s*@game\s+(.+?)\s*$')|ForEach-Object{$_.Groups[1].Value.Trim()}|Where-Object{$_}|Select-Object -Unique)
    if($metadataGames.Count){return $metadataGames}
    $patterns=@([regex]::Matches($code,'(?im)^\s*//\s*@(match|include)\s+(.+?)\s*$')|ForEach-Object{$_.Groups[2].Value.Trim()})
    $labels=@()
    foreach($pattern in $patterns){
      if($pattern -eq '<all_urls>'){$labels+='Todos los juegos';continue}
      $gameHost=[regex]::Match($pattern,'^(?:\*|https?)://([^/]+)',[Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value.ToLowerInvariant() -replace '^\*\.','' -replace '^www\.',''
      if($gameHost -eq 'poke.idleworld.online'){$labels+='Poke Idle World'}elseif($gameHost -and $gameHost -ne '*'){$labels+=$gameHost}
    }
    $labels=@($labels|Select-Object -Unique)
    if($labels.Count){return $labels}
  }
  return @('Poke Idle World')
}

function Render-CatalogManagement {
  $query=$catalogSearchBox.Text.Trim().ToLowerInvariant()
  $rows=@($script:catalogEntries|Where-Object{
    -not $query -or (@($_.name,$_.id,$_.category,$_.author,@($_.games)-join ' ',@($_.tags)-join ' ') -join ' ').ToLowerInvariant().Contains($query)
  })
  $catalogGrid.Rows.Clear()
  foreach($entry in $rows){
    $index=$catalogGrid.Rows.Add($(if([string]$entry.icon){[string]$entry.icon}else{'🧩'}),[string]$entry.name,"v$($entry.version)",$(if(@($entry.games).Count){@($entry.games)-join ', '}else{'Sin etiqueta'}),[string]$entry.category)
    $catalogGrid.Rows[$index].Tag=$entry
  }
  $catalogCountValue.Text=[string]@($script:catalogEntries).Count
  $catalogFeaturedValue.Text=[string]@($script:catalogEntries|Where-Object{$_.featured -eq $true}).Count
  $catalogGamesValue.Text=[string]@($script:catalogEntries|ForEach-Object{@($_.games)}|Where-Object{$_}|ForEach-Object{[string]$_}|Sort-Object -Unique).Count
  $catalogVisibleLabel.Text="$($rows.Count) publicación$(if($rows.Count -eq 1){''}else{'es'}) visible$(if($rows.Count -eq 1){''}else{'s'})"
  if($catalogGrid.Rows.Count){$catalogGrid.Rows[0].Selected=$true;Show-CatalogEntry $catalogGrid.Rows[0].Tag}else{Show-CatalogEntry $null}
}

function Refresh-CatalogManagement([switch]$SkipPull){
  try{
    if(-not $SkipPull){Log-Catalog 'Sincronizando catálogo con GitHub…';[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('pull','--ff-only'))}
    $catalogPath=Join-Path $repoRoot 'catalog.json'
    if(-not(Test-Path -LiteralPath $catalogPath -PathType Leaf)){throw 'No se encontró catalog.json.'}
    $catalog=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8|ConvertFrom-Json
    if([int]$catalog.schemaVersion -ne 1){throw 'El catálogo utiliza un formato no compatible.'}
    foreach($entry in @($catalog.scripts)){$entry|Add-Member -NotePropertyName games -NotePropertyValue @(Get-CatalogGameLabels $entry) -Force}
    $script:catalogEntries=@($catalog.scripts|Sort-Object -Property @{Expression={[bool]$_.featured};Descending=$true},@{Expression={[string]$_.name};Descending=$false})
    Render-CatalogManagement
    $catalogSyncLabel.Text="Sincronizado $((Get-Date).ToString('HH:mm:ss'))  •  rama main"
    Log-Catalog "$(@($script:catalogEntries).Count) scripts cargados desde GitHub." 'ok'
    return $true
  }catch{Log-Catalog $_.Exception.Message 'error';return $false}
}

function Log-Launcher([string]$message, [string]$kind = 'info') {
  $time = (Get-Date).ToString('HH:mm:ss')
  if ($launcherLogBox) { $launcherLogBox.AppendText("[$time] $message`r`n"); $launcherLogBox.SelectionStart=$launcherLogBox.TextLength; $launcherLogBox.ScrollToCaret() }
  $statusDot.ForeColor = $(if ($kind -eq 'error') { $palette.Danger } elseif ($kind -eq 'ok') { $palette.Success } else { $palette.Primary })
  $statusLabel.ForeColor=$statusDot.ForeColor; $statusLabel.Text=$message
  $statusChip.Text=$(if($kind -eq 'error'){'  REVISAR  '}elseif($kind -eq 'ok'){'  LISTO  '}else{'  EN PROCESO  '})
  $statusChip.BackColor=$(if($kind -eq 'error'){Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Danger.Base') 0.22}elseif($kind -eq 'ok'){Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Success.Base') 0.22}else{Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Primary.Base') 0.22})
  [Windows.Forms.Application]::DoEvents()
}

function Get-LauncherRepositoryInfo([string]$root) {
  $resolved=[IO.Path]::GetFullPath($root.Trim())
  $packagePath=Join-Path $resolved 'package.json'
  if(-not(Test-Path -LiteralPath (Join-Path $resolved '.git') -PathType Container)){throw 'Selecciona la carpeta Git de PokeGrid Launcher.'}
  if(-not(Test-Path -LiteralPath $packagePath -PathType Leaf)){throw 'No se encontró package.json en el repositorio seleccionado.'}
  $package=Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8|ConvertFrom-Json
  if([string]$package.name -ne 'pokegrid-launcher' -or [string]$package.version -notmatch '^\d+\.\d+\.\d+$'){throw 'La carpeta no corresponde a una versión válida de PokeGrid Launcher.'}
  $remote=(Invoke-PokeGridGit -RepositoryRoot $resolved -Arguments @('remote','get-url','origin')).Output
  if($remote -notmatch '(?i)(?:github\.com[:/])DiegoT34/PokeGrid-Launcher(?:\.git)?$'){throw "El remoto origin no corresponde al launcher oficial: $remote"}
  $branch=(Invoke-PokeGridGit -RepositoryRoot $resolved -Arguments @('branch','--show-current')).Output
  $pending=(Invoke-PokeGridGit -RepositoryRoot $resolved -Arguments @('status','--short','--untracked-files=all','--','.',':(exclude,top,glob)*.user.js',':(exclude,top,glob)*.js',':(exclude,top,glob)*.rar',':(exclude,top,glob)*.zip',':(exclude,top,glob)*.7z')).Output
  $latest=''
  try{$release=Invoke-RestMethod -Uri 'https://api.github.com/repos/DiegoT34/PokeGrid-Launcher/releases/latest' -Headers @{'User-Agent'='PokeGrid-Shop-Publisher';'Accept'='application/vnd.github+json'};$latest=([string]$release.tag_name).TrimStart('v')}catch{}
  $base=[Version][string]$package.version
  if($latest -match '^\d+\.\d+\.\d+$' -and [Version]$latest -gt $base){$base=[Version]$latest}
  $nextVersion='{0}.{1}.{2}' -f $base.Major,$base.Minor,($base.Build+1)
  return [pscustomobject]@{Root=$resolved;Current=[string]$package.version;Latest=$latest;Next=$nextVersion;Branch=$branch;Remote=$remote;Pending=$pending}
}

function Refresh-LauncherRepository {
  try{
    $script:launcherInfo=Get-LauncherRepositoryInfo $launcherPathBox.Text
    $launcherPathBox.Text=$script:launcherInfo.Root;$launcherCurrentValue.Text="v$($script:launcherInfo.Current)";$launcherLatestValue.Text=$(if($script:launcherInfo.Latest){"v$($script:launcherInfo.Latest)"}else{'No disponible'})
    if(-not $launcherVersionBox.Text.Trim() -or $launcherVersionBox.Text -eq $script:launcherInfo.Current){$launcherVersionBox.Text=$script:launcherInfo.Next}
    $pendingLines=@($script:launcherInfo.Pending -split "`r?`n"|Where-Object{$_})
    $launcherChangesValue.Text=$(if($pendingLines.Count){"$($pendingLines.Count) archivo(s) pendiente(s)"}else{'Sin cambios pendientes'})
    $launcherChangesValue.ForeColor=$(if($pendingLines.Count){$palette.Warning}else{$palette.Success})
    $launcherRepoHint.Text="Rama $($script:launcherInfo.Branch)  •  origin verificado  •  GitHub Actions crea ZIP + SHA-256"
    Log-Launcher "Launcher detectado: v$($script:launcherInfo.Current) → propuesta v$($launcherVersionBox.Text)" 'ok'
    return $true
  }catch{$script:launcherInfo=$null;Log-Launcher $_.Exception.Message 'error';return $false}
}

function Wait-LauncherRelease([string]$version) {
  $url="https://api.github.com/repos/DiegoT34/PokeGrid-Launcher/releases/tags/v$version"
  for($attempt=1;$attempt -le 36;$attempt+=1){
    try{
      $release=Invoke-RestMethod -Uri $url -Headers @{'User-Agent'='PokeGrid-Shop-Publisher';'Accept'='application/vnd.github+json'}
      $names=@($release.assets|ForEach-Object{$_.name})
      if($names -contains "IDLE-POKE-LAUNCHER-$version-portatil.zip" -and $names -contains "IDLE-POKE-LAUNCHER-$version-portatil.zip.sha256"){return [string]$release.html_url}
    }catch{}
    if($attempt -lt 36){$launcherProgress.Text="GitHub está compilando… intento $attempt/36";Start-Sleep -Seconds 2;[Windows.Forms.Application]::DoEvents()}
  }
  return ''
}

$workingArea=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form=[Windows.Forms.Form]::new();$form.Text='PokeGrid Publisher 1.3.1';$form.StartPosition='CenterScreen'
$form.ClientSize=[Drawing.Size]::new([Math]::Min(1280,[Math]::Max(900,$workingArea.Width-90)),[Math]::Min(860,[Math]::Max(660,$workingArea.Height-80)))
$form.MinimumSize=[Drawing.Size]::new(880,650);$form.BackColor=$palette.Background;$form.ForeColor=$palette.Text;$form.Font=[Drawing.Font]::new('Segoe UI',9);$form.AutoScaleMode='Dpi';$form.KeyPreview=$true;$form.AllowDrop=$true

$header=[Windows.Forms.TableLayoutPanel]::new();$header.Dock='Top';$header.Height=88;$header.Padding=[Windows.Forms.Padding]::new(20,12,20,10);$header.BackColor=$palette.Surface;$header.ColumnCount=2;$header.RowCount=2
$header.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$header.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',130))|Out-Null;$header.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',62))|Out-Null;$header.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',38))|Out-Null
$appTitle=New-Label 'PokeGrid Publisher' 19 $palette.Text ([Drawing.FontStyle]::Bold);$appTitle.Dock='Fill'
$appSubtitle=New-Label 'Publica userscripts y nuevas versiones del launcher desde un solo lugar.' 8.5 $palette.Muted;$appSubtitle.Dock='Fill'
$statusChip=New-Label '  PREPARADO  ' 7.5 $palette.Primary ([Drawing.FontStyle]::Bold);$statusChip.Dock='Fill';$statusChip.TextAlign='MiddleCenter';$statusChip.BackColor=Blend-Color (Get-ThemeColor 'Base') (Get-ThemeColor 'Rest.Primary.Base') 0.22;$statusChip.Margin=[Windows.Forms.Padding]::new(10,7,0,7)
$header.Controls.Add($appTitle,0,0);$header.Controls.Add($appSubtitle,0,1);$header.Controls.Add($statusChip,1,0);$header.SetRowSpan($statusChip,2)

$footer=[Windows.Forms.TableLayoutPanel]::new();$footer.Dock='Bottom';$footer.Height=38;$footer.Padding=[Windows.Forms.Padding]::new(17,3,17,3);$footer.BackColor=Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.22;$footer.ColumnCount=4
$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',18))|Out-Null;$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',330))|Out-Null;$footer.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',90))|Out-Null
$statusDot=New-Label '●' 9 $palette.Primary ([Drawing.FontStyle]::Bold);$statusDot.Dock='Fill';$statusLabel=New-Label 'Preparando interfaz…' 8 $palette.Primary;$statusLabel.Dock='Fill'
$repoFooter=New-Label ("Repositorio: "+$repoRoot) 7.5 $palette.Dim;$repoFooter.Dock='Fill';$repoFooter.TextAlign='MiddleRight';$repoFooter.AutoEllipsis=$true
$versionFooter=New-Label 'v1.3.1' 7.5 $palette.Dim ([Drawing.FontStyle]::Bold);$versionFooter.Dock='Fill';$versionFooter.TextAlign='MiddleRight'
$footer.Controls.Add($statusDot,0,0);$footer.Controls.Add($statusLabel,1,0);$footer.Controls.Add($repoFooter,2,0);$footer.Controls.Add($versionFooter,3,0)

$sidebar=[Windows.Forms.Panel]::new();$sidebar.Dock='Left';$sidebar.Width=224;$sidebar.Padding=[Windows.Forms.Padding]::new(14);$sidebar.BackColor=Get-ThemeColor 'Surface.Soft'
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
$modeLabel=New-Label 'SCRIPT NUEVO' 7.2 $palette.Primary ([Drawing.FontStyle]::Bold);$modeLabel.Dock='Top';$modeLabel.Height=22
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
$sourceHint=New-Label 'Arrastra un archivo aquí o utiliza Examinar. Tamaño máximo: 10 MB.' 8 $palette.Dim;$sourceHint.Dock='Fill';$sourceHint.Margin=[Windows.Forms.Padding]::new(6,0,0,0);$sourceLayout.Controls.Add($sourceHint,0,3);$sourceCard.Controls.Add($sourceLayout)

$publicationCard=New-Card 493;$publicationLayout=[Windows.Forms.TableLayoutPanel]::new();$publicationLayout.Dock='Fill';$publicationLayout.ColumnCount=1;$publicationLayout.RowCount=6
foreach($height in @(55,66,66,126,89,45)){ $publicationLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',$height))|Out-Null };$publicationLayout.Controls.Add((New-SectionHeader '02' 'Completa la ficha de la Shop' 'Esta información será visible para todos los usuarios del launcher.'),0,0)
$identityGrid=[Windows.Forms.TableLayoutPanel]::new();$identityGrid.Dock='Fill';$identityGrid.ColumnCount=4;foreach($width in @(32,27,13,28)){ $identityGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',$width))|Out-Null }
$idBox=New-TextBox;$categoryBox=[Windows.Forms.ComboBox]::new();Style-Input $categoryBox|Out-Null;$categoryBox.DropDownStyle='DropDown';[void]$categoryBox.Items.AddRange(@('Market','Crianza','Calculadoras','Interfaz','Comunicación','Notificaciones','Utilidades'));$categoryBox.Text='Utilidades';$iconBox=New-TextBox;$iconBox.Font=[Drawing.Font]::new('Segoe UI Emoji',10);$iconBox.Text='🧩';$minLauncherBox=New-TextBox;$minLauncherBox.Text = '0.22.1'
$identityGrid.Controls.Add((New-Field 'ID ESTABLE' $idBox 'Conserva exactamente el mismo ID en cada actualización.'),0,0);$identityGrid.Controls.Add((New-Field 'CATEGORÍA' $categoryBox),1,0);$identityGrid.Controls.Add((New-Field 'ICONO' $iconBox 'Emoji que aparecerá en la tarjeta.'),2,0);$identityGrid.Controls.Add((New-Field 'LAUNCHER MÍNIMO' $minLauncherBox),3,0);$publicationLayout.Controls.Add($identityGrid,0,1)
$summaryGrid=[Windows.Forms.TableLayoutPanel]::new();$summaryGrid.Dock='Fill';$summaryGrid.ColumnCount=3;$summaryGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',24))|Out-Null;$summaryGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',35))|Out-Null;$summaryGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',41))|Out-Null
$authorBox=New-TextBox;$tagsBox=New-TextBox;$summaryBox=New-TextBox;$summaryGrid.Controls.Add((New-Field 'AUTOR' $authorBox),0,0);$summaryGrid.Controls.Add((New-Field 'ETIQUETAS' $tagsBox 'Sepáralas mediante comas.'),1,0);$summaryGrid.Controls.Add((New-Field 'RESUMEN PARA LA TARJETA' $summaryBox),2,0);$publicationLayout.Controls.Add($summaryGrid,0,2)
$detailsGrid=[Windows.Forms.TableLayoutPanel]::new();$detailsGrid.Dock='Fill';$detailsGrid.ColumnCount=2;$detailsGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',52))|Out-Null;$detailsGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',48))|Out-Null
$descriptionBox=New-TextBox -Multiline;$permissionsBox=New-TextBox -Multiline;$detailsGrid.Controls.Add((New-Field 'DESCRIPCIÓN COMPLETA' $descriptionBox),0,0);$detailsGrid.Controls.Add((New-Field 'PERMISOS · UNO POR LÍNEA' $permissionsBox),1,0);$publicationLayout.Controls.Add($detailsGrid,0,3)
$changelogBox=New-TextBox -Multiline;$publicationLayout.Controls.Add((New-Field 'CAMBIOS DE ESTA VERSIÓN' $changelogBox),0,4)
$featureBar=[Windows.Forms.TableLayoutPanel]::new();$featureBar.Dock='Fill';$featureBar.ColumnCount=2;$featureBar.Padding=[Windows.Forms.Padding]::new(6,2,6,2);$featureBar.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$featureBar.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',190))|Out-Null
$featureHint=New-Label 'Nombre + namespace exactos identifican una actualización; cualquier identidad nueva se agrega a la Shop.' 7.7 $palette.Dim;$featureHint.Dock='Fill';$featuredBox=[Windows.Forms.CheckBox]::new();$featuredBox.Text='★ Marcar como destacado';$featuredBox.Dock='Fill';$featuredBox.ForeColor=$palette.Warning;$featuredBox.BackColor=$palette.Surface;$featuredBox.Font=[Drawing.Font]::new('Segoe UI Semibold',8.5,[Drawing.FontStyle]::Bold)
$featureBar.Controls.Add($featureHint,0,0);$featureBar.Controls.Add($featuredBox,1,0);$publicationLayout.Controls.Add($featureBar,0,5);$publicationCard.Controls.Add($publicationLayout)

$actionCard=New-Card 245;$actionLayout=[Windows.Forms.TableLayoutPanel]::new();$actionLayout.Dock='Fill';$actionLayout.ColumnCount=1;$actionLayout.RowCount=3;$actionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',55))|Out-Null;$actionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',51))|Out-Null;$actionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',100))|Out-Null
$actionLayout.Controls.Add((New-SectionHeader '03' 'Valida y publica' 'La aplicación sincroniza, calcula SHA-256, crea el commit y hace push.'),0,0)
$actions=[Windows.Forms.TableLayoutPanel]::new();$actions.Dock='Fill';$actions.ColumnCount=5;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',122))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',110))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',110))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$actions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',220))|Out-Null
$validateButton=New-Button '✓ Validar' 'primary';$validateButton.Dock='Fill';$clearButton=New-Button 'Limpiar' 'ghost';$clearButton.Dock='Fill';$openFolderButton=New-Button 'Carpeta local' 'ghost';$openFolderButton.Dock='Fill';$publishButton=New-Button '↑ Agregar nuevo script' 'accent';$publishButton.Dock='Fill'
$actions.Controls.Add($validateButton,0,0);$actions.Controls.Add($clearButton,1,0);$actions.Controls.Add($openFolderButton,2,0);$actions.Controls.Add($publishButton,4,0);$actionLayout.Controls.Add($actions,0,1)
$logBox=New-TextBox -Multiline -ReadOnly;$logBox.BackColor=Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.25;$logBox.Font=[Drawing.Font]::new('Cascadia Mono',8.4);$logBox.Margin=[Windows.Forms.Padding]::new(5,4,5,3);$actionLayout.Controls.Add($logBox,0,2);$actionCard.Controls.Add($actionLayout)

$contentStack.Controls.AddRange(@($sourceCard,$publicationCard,$actionCard))

# Pestaña del launcher: repositorio, versión, validación y publicación asistida.
$launcherStack=[Windows.Forms.FlowLayoutPanel]::new();$launcherStack.Dock='Fill';$launcherStack.FlowDirection='TopDown';$launcherStack.WrapContents=$false;$launcherStack.AutoScroll=$true;$launcherStack.Padding=[Windows.Forms.Padding]::new(18,18,18,20);$launcherStack.BackColor=$palette.Background

$launcherRepoCard=New-Card 174;$launcherRepoLayout=[Windows.Forms.TableLayoutPanel]::new();$launcherRepoLayout.Dock='Fill';$launcherRepoLayout.ColumnCount=1;$launcherRepoLayout.RowCount=3
$launcherRepoLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',55))|Out-Null;$launcherRepoLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',50))|Out-Null;$launcherRepoLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',100))|Out-Null
$launcherRepoLayout.Controls.Add((New-SectionHeader '01' 'Conecta el repositorio del launcher' 'Selecciona la carpeta local vinculada con DiegoT34/PokeGrid-Launcher.'),0,0)
$launcherPathRow=[Windows.Forms.TableLayoutPanel]::new();$launcherPathRow.Dock='Fill';$launcherPathRow.ColumnCount=3;$launcherPathRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$launcherPathRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',120))|Out-Null;$launcherPathRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',112))|Out-Null
$launcherPathBox=New-TextBox;$launcherPathBox.Text=$launcherRepoRoot;$launcherPathBox.Dock='Fill';$launcherPathBox.Margin=[Windows.Forms.Padding]::new(5)
$launcherBrowseButton=New-Button 'Elegir carpeta…' 'primary';$launcherBrowseButton.Dock='Fill';$launcherRefreshButton=New-Button '↻ Detectar';$launcherRefreshButton.Dock='Fill'
$launcherPathRow.Controls.Add($launcherPathBox,0,0);$launcherPathRow.Controls.Add($launcherBrowseButton,1,0);$launcherPathRow.Controls.Add($launcherRefreshButton,2,0);$launcherRepoLayout.Controls.Add($launcherPathRow,0,1)
$launcherRepoHint=New-Label 'Selecciona el repositorio para detectar versión, rama y cambios pendientes.' 8 $palette.Dim;$launcherRepoHint.Dock='Fill';$launcherRepoHint.Margin=[Windows.Forms.Padding]::new(6,2,0,0);$launcherRepoLayout.Controls.Add($launcherRepoHint,0,2);$launcherRepoCard.Controls.Add($launcherRepoLayout)

$launcherReleaseCard=New-Card 292;$launcherReleaseLayout=[Windows.Forms.TableLayoutPanel]::new();$launcherReleaseLayout.Dock='Fill';$launcherReleaseLayout.ColumnCount=1;$launcherReleaseLayout.RowCount=4
foreach($height in @(55,66,61,88)){$launcherReleaseLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',$height))|Out-Null}
$launcherReleaseLayout.Controls.Add((New-SectionHeader '02' 'Prepara la nueva versión' 'La herramienta propone el siguiente parche y conserva todos los cambios del proyecto.'),0,0)
$launcherSummaryGrid=[Windows.Forms.TableLayoutPanel]::new();$launcherSummaryGrid.Dock='Fill';$launcherSummaryGrid.ColumnCount=3;foreach($width in @(25,25,50)){$launcherSummaryGrid.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',$width))|Out-Null}
$launcherCurrentValue=New-TextBox -ReadOnly;$launcherLatestValue=New-TextBox -ReadOnly;$launcherChangesValue=New-TextBox -ReadOnly
$launcherSummaryGrid.Controls.Add((New-Field 'VERSIÓN LOCAL' $launcherCurrentValue),0,0);$launcherSummaryGrid.Controls.Add((New-Field 'ÚLTIMA RELEASE' $launcherLatestValue),1,0);$launcherSummaryGrid.Controls.Add((New-Field 'CAMBIOS A PUBLICAR' $launcherChangesValue),2,0);$launcherReleaseLayout.Controls.Add($launcherSummaryGrid,0,1)
$launcherVersionRow=[Windows.Forms.TableLayoutPanel]::new();$launcherVersionRow.Dock='Fill';$launcherVersionRow.ColumnCount=2;$launcherVersionRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',230))|Out-Null;$launcherVersionRow.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null
$launcherVersionBox=New-TextBox;$launcherVersionRow.Controls.Add((New-Field 'NUEVA VERSIÓN · X.Y.Z' $launcherVersionBox 'Debe ser superior a la versión local y a la última Release.'),0,0)
$launcherVersionHint=New-Label 'El número se escribe en package.json y se usa para la etiqueta, el ZIP y el actualizador.' 8 $palette.Muted;$launcherVersionHint.Dock='Fill';$launcherVersionHint.Margin=[Windows.Forms.Padding]::new(12,5,0,0);$launcherVersionRow.Controls.Add($launcherVersionHint,1,0);$launcherReleaseLayout.Controls.Add($launcherVersionRow,0,2)
$launcherNotesBox=New-TextBox -Multiline;$launcherNotesBox.Text='Actualización manual del launcher';$launcherReleaseLayout.Controls.Add((New-Field 'RESUMEN DE LOS CAMBIOS' $launcherNotesBox 'La primera línea se utiliza en el commit y aparecerá en las notas generadas por GitHub.'),0,3);$launcherReleaseCard.Controls.Add($launcherReleaseLayout)

$launcherActionCard=New-Card 286;$launcherActionLayout=[Windows.Forms.TableLayoutPanel]::new();$launcherActionLayout.Dock='Fill';$launcherActionLayout.ColumnCount=1;$launcherActionLayout.RowCount=5
$launcherActionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',55))|Out-Null;$launcherActionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',37))|Out-Null;$launcherActionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',51))|Out-Null;$launcherActionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',27))|Out-Null;$launcherActionLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',100))|Out-Null
$launcherActionLayout.Controls.Add((New-SectionHeader '03' 'Valida y publica el launcher' 'GitHub Actions construirá el ZIP, generará SHA-256 y creará la Release estable.'),0,0)
$launcherOptions=[Windows.Forms.FlowLayoutPanel]::new();$launcherOptions.Dock='Fill';$launcherOptions.FlowDirection='LeftToRight';$launcherOptions.WrapContents=$false;$launcherOptions.Padding=[Windows.Forms.Padding]::new(6,2,0,0)
$launcherChecksBox=[Windows.Forms.CheckBox]::new();$launcherChecksBox.Text='Ejecutar pruebas locales antes de publicar';$launcherChecksBox.AutoSize=$true;$launcherChecksBox.ForeColor=$palette.Text;$launcherChecksBox.BackColor=$palette.Surface;$launcherChecksBox.Margin=[Windows.Forms.Padding]::new(3,5,18,0)
$launcherBuildBox=[Windows.Forms.CheckBox]::new();$launcherBuildBox.Text='Compilar también una copia local';$launcherBuildBox.AutoSize=$true;$launcherBuildBox.ForeColor=$palette.Text;$launcherBuildBox.BackColor=$palette.Surface;$launcherBuildBox.Margin=[Windows.Forms.Padding]::new(3,5,0,0)
$launcherOptions.Controls.AddRange(@($launcherChecksBox,$launcherBuildBox));$launcherActionLayout.Controls.Add($launcherOptions,0,1)
$launcherActions=[Windows.Forms.TableLayoutPanel]::new();$launcherActions.Dock='Fill';$launcherActions.ColumnCount=5;$launcherActions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',132))|Out-Null;$launcherActions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',132))|Out-Null;$launcherActions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',132))|Out-Null;$launcherActions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$launcherActions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',245))|Out-Null
$launcherValidateButton=New-Button '✓ Validar versión' 'primary';$launcherValidateButton.Dock='Fill';$launcherOpenRepoButton=New-Button '↗ Repositorio' 'ghost';$launcherOpenRepoButton.Dock='Fill';$launcherOpenActionsButton=New-Button '↗ Compilaciones' 'ghost';$launcherOpenActionsButton.Dock='Fill';$launcherPublishButton=New-Button '↑ Publicar nueva versión' 'accent';$launcherPublishButton.Dock='Fill'
$launcherActions.Controls.Add($launcherValidateButton,0,0);$launcherActions.Controls.Add($launcherOpenRepoButton,1,0);$launcherActions.Controls.Add($launcherOpenActionsButton,2,0);$launcherActions.Controls.Add($launcherPublishButton,4,0);$launcherActionLayout.Controls.Add($launcherActions,0,2)
$launcherProgress=New-Label 'Preparado para validar el repositorio.' 7.8 $palette.Dim;$launcherProgress.Dock='Fill';$launcherProgress.Margin=[Windows.Forms.Padding]::new(6,0,0,0);$launcherActionLayout.Controls.Add($launcherProgress,0,3)
$launcherLogBox=New-TextBox -Multiline -ReadOnly;$launcherLogBox.BackColor=Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.25;$launcherLogBox.Font=[Drawing.Font]::new('Cascadia Mono',8.4);$launcherLogBox.Margin=[Windows.Forms.Padding]::new(5,2,5,3);$launcherActionLayout.Controls.Add($launcherLogBox,0,4);$launcherActionCard.Controls.Add($launcherActionLayout)
$launcherStack.Controls.AddRange(@($launcherRepoCard,$launcherReleaseCard,$launcherActionCard))

# Catálogo remoto: consulta visual y retirada segura de publicaciones.
$catalogStack=[Windows.Forms.FlowLayoutPanel]::new();$catalogStack.Dock='Fill';$catalogStack.FlowDirection='TopDown';$catalogStack.WrapContents=$false;$catalogStack.AutoScroll=$true;$catalogStack.Padding=[Windows.Forms.Padding]::new(18,18,18,20);$catalogStack.BackColor=$palette.Background
$catalogSummaryCard=New-Card 202;$catalogSummaryLayout=[Windows.Forms.TableLayoutPanel]::new();$catalogSummaryLayout.Dock='Fill';$catalogSummaryLayout.ColumnCount=1;$catalogSummaryLayout.RowCount=4
foreach($height in @(55,58,48,20)){$catalogSummaryLayout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',$height))|Out-Null}
$catalogSummaryLayout.Controls.Add((New-SectionHeader '01' 'Catálogo publicado' 'Consulta los userscripts visibles en GitHub y administra su disponibilidad en la Shop.'),0,0)
$catalogStats=[Windows.Forms.TableLayoutPanel]::new();$catalogStats.Dock='Fill';$catalogStats.ColumnCount=3;foreach($width in @(33,33,34)){$catalogStats.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',$width))|Out-Null}
$catalogCountValue=New-TextBox -ReadOnly;$catalogFeaturedValue=New-TextBox -ReadOnly;$catalogGamesValue=New-TextBox -ReadOnly
$catalogStats.Controls.Add((New-Field 'PUBLICACIONES' $catalogCountValue),0,0);$catalogStats.Controls.Add((New-Field 'DESTACADOS' $catalogFeaturedValue),1,0);$catalogStats.Controls.Add((New-Field 'JUEGOS ETIQUETADOS' $catalogGamesValue),2,0);$catalogSummaryLayout.Controls.Add($catalogStats,0,1)
$catalogToolbar=[Windows.Forms.TableLayoutPanel]::new();$catalogToolbar.Dock='Fill';$catalogToolbar.ColumnCount=3;$catalogToolbar.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100))|Out-Null;$catalogToolbar.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',130))|Out-Null;$catalogToolbar.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',145))|Out-Null
$catalogSearchBox=New-TextBox;$catalogSearchBox.Dock='Fill';$catalogSearchBox.Margin=[Windows.Forms.Padding]::new(5);$catalogRefreshButton=New-Button '↻ Sincronizar' 'primary';$catalogRefreshButton.Dock='Fill';$catalogOpenRepoButton=New-Button '↗ Abrir GitHub' 'ghost';$catalogOpenRepoButton.Dock='Fill'
$catalogToolbar.Controls.Add($catalogSearchBox,0,0);$catalogToolbar.Controls.Add($catalogRefreshButton,1,0);$catalogToolbar.Controls.Add($catalogOpenRepoButton,2,0);$catalogSummaryLayout.Controls.Add($catalogToolbar,0,2)
$catalogSyncLabel=New-Label 'Pulsa Sincronizar para cargar la última versión del catálogo.' 7.6 $palette.Dim;$catalogSyncLabel.Dock='Fill';$catalogSyncLabel.Margin=[Windows.Forms.Padding]::new(6,0,0,0);$catalogSummaryLayout.Controls.Add($catalogSyncLabel,0,3);$catalogSummaryCard.Controls.Add($catalogSummaryLayout)

$catalogBodyCard=New-Card 570;$catalogSplit=[Windows.Forms.TableLayoutPanel]::new();$catalogSplit.Dock='Fill';$catalogSplit.ColumnCount=2;$catalogSplit.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',58))|Out-Null;$catalogSplit.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',42))|Out-Null
$catalogListPanel=[Windows.Forms.TableLayoutPanel]::new();$catalogListPanel.Dock='Fill';$catalogListPanel.RowCount=2;$catalogListPanel.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',36))|Out-Null;$catalogListPanel.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent',100))|Out-Null;$catalogListPanel.Margin=[Windows.Forms.Padding]::new(0,0,8,0)
$catalogVisibleLabel=New-Label '0 publicaciones visibles' 9 $palette.Muted ([Drawing.FontStyle]::Bold);$catalogVisibleLabel.Dock='Fill';$catalogVisibleLabel.Padding=[Windows.Forms.Padding]::new(5,0,0,0);$catalogListPanel.Controls.Add($catalogVisibleLabel,0,0)
$catalogGrid=[Windows.Forms.DataGridView]::new();$catalogGrid.Dock='Fill';$catalogGrid.BackgroundColor=Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.10;$catalogGrid.BorderStyle='None';$catalogGrid.RowHeadersVisible=$false;$catalogGrid.AllowUserToAddRows=$false;$catalogGrid.AllowUserToDeleteRows=$false;$catalogGrid.AllowUserToResizeRows=$false;$catalogGrid.ReadOnly=$true;$catalogGrid.MultiSelect=$false;$catalogGrid.SelectionMode='FullRowSelect';$catalogGrid.AutoGenerateColumns=$false;$catalogGrid.EnableHeadersVisualStyles=$false;$catalogGrid.ColumnHeadersHeight=34;$catalogGrid.RowTemplate.Height=46;$catalogGrid.GridColor=$palette.Border
$catalogGrid.ColumnHeadersDefaultCellStyle.BackColor=$palette.SurfaceRaised;$catalogGrid.ColumnHeadersDefaultCellStyle.ForeColor=$palette.Muted;$catalogGrid.ColumnHeadersDefaultCellStyle.Font=[Drawing.Font]::new('Segoe UI Semibold',8,[Drawing.FontStyle]::Bold);$catalogGrid.DefaultCellStyle.BackColor=$palette.SurfaceSoft;$catalogGrid.DefaultCellStyle.ForeColor=$palette.Text;$catalogGrid.DefaultCellStyle.SelectionBackColor=Blend-Color (Get-ThemeColor 'Surface.Raised') (Get-ThemeColor 'Rest.Primary.Base') 0.45;$catalogGrid.DefaultCellStyle.SelectionForeColor=$palette.Text;$catalogGrid.DefaultCellStyle.Font=[Drawing.Font]::new('Segoe UI',8.5);$catalogGrid.DefaultCellStyle.Padding=[Windows.Forms.Padding]::new(4)
$iconColumn=[Windows.Forms.DataGridViewTextBoxColumn]::new();$iconColumn.HeaderText='';$iconColumn.Width=42;$iconColumn.DefaultCellStyle.Font=[Drawing.Font]::new('Segoe UI Emoji',13);$iconColumn.DefaultCellStyle.Alignment='MiddleCenter'
$nameColumn=[Windows.Forms.DataGridViewTextBoxColumn]::new();$nameColumn.HeaderText='SCRIPT';$nameColumn.AutoSizeMode='Fill';$nameColumn.MinimumWidth=160
$versionColumn=[Windows.Forms.DataGridViewTextBoxColumn]::new();$versionColumn.HeaderText='VERSIÓN';$versionColumn.Width=74
$gameColumn=[Windows.Forms.DataGridViewTextBoxColumn]::new();$gameColumn.HeaderText='JUEGO';$gameColumn.Width=145
$categoryColumn=[Windows.Forms.DataGridViewTextBoxColumn]::new();$categoryColumn.HeaderText='CATEGORÍA';$categoryColumn.Width=105
foreach($column in @($iconColumn,$nameColumn,$versionColumn,$gameColumn,$categoryColumn)){[void]$catalogGrid.Columns.Add($column)};$catalogListPanel.Controls.Add($catalogGrid,0,1)

$catalogDetailPanel=[Windows.Forms.Panel]::new();$catalogDetailPanel.Dock='Fill';$catalogDetailPanel.BackColor=$palette.SurfaceRaised;$catalogDetailPanel.BorderStyle='FixedSingle';$catalogDetailPanel.Padding=[Windows.Forms.Padding]::new(16);$catalogDetailPanel.Margin=[Windows.Forms.Padding]::new(8,0,0,0)
$catalogDetailIcon=New-Label '◌' 28 $palette.Primary;$catalogDetailIcon.Font=[Drawing.Font]::new('Segoe UI Emoji',26);$catalogDetailIcon.Dock='Top';$catalogDetailIcon.Height=55;$catalogDetailIcon.TextAlign='MiddleLeft'
$catalogDetailName=New-Label 'Selecciona una publicación' 15 $palette.Text ([Drawing.FontStyle]::Bold);$catalogDetailName.Dock='Top';$catalogDetailName.Height=38;$catalogDetailName.AutoEllipsis=$true
$catalogDetailMeta=New-Label 'La información completa aparecerá aquí.' 8.5 $palette.Muted;$catalogDetailMeta.Dock='Top';$catalogDetailMeta.Height=28;$catalogDetailMeta.AutoEllipsis=$true
$catalogDetailGames=New-Label '—' 8 $palette.Primary ([Drawing.FontStyle]::Bold);$catalogDetailGames.Dock='Top';$catalogDetailGames.Height=32;$catalogDetailGames.AutoEllipsis=$true
$catalogDetailDescription=New-TextBox -Multiline -ReadOnly;$catalogDetailDescription.Dock='Top';$catalogDetailDescription.Height=118;$catalogDetailDescription.Margin=[Windows.Forms.Padding]::new(0,4,0,4);$catalogDetailDescription.BackColor=$palette.SurfaceSoft
$catalogDetailId=New-Label '' 7.5 $palette.Muted;$catalogDetailId.Dock='Top';$catalogDetailId.Height=26;$catalogDetailId.AutoEllipsis=$true
$catalogDetailHash=New-Label '' 7 $palette.Dim;$catalogDetailHash.Dock='Top';$catalogDetailHash.Height=25;$catalogDetailHash.AutoEllipsis=$true
$catalogActions=[Windows.Forms.TableLayoutPanel]::new();$catalogActions.Dock='Top';$catalogActions.Height=48;$catalogActions.ColumnCount=2;$catalogActions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',42))|Out-Null;$catalogActions.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',58))|Out-Null
$catalogOpenScriptButton=New-Button '↗ Ver archivo' 'ghost';$catalogOpenScriptButton.Dock='Fill';$catalogOpenScriptButton.Enabled=$false;$catalogDeleteButton=New-Button '🗑 Retirar de la Shop' 'accent';$catalogDeleteButton.Dock='Fill';$catalogDeleteButton.Enabled=$false;$catalogActions.Controls.Add($catalogOpenScriptButton,0,0);$catalogActions.Controls.Add($catalogDeleteButton,1,0)
$catalogLogBox=New-TextBox -Multiline -ReadOnly;$catalogLogBox.Dock='Fill';$catalogLogBox.BackColor=Blend-Color (Get-ThemeColor 'Base') ([Drawing.Color]::Black) 0.25;$catalogLogBox.Font=[Drawing.Font]::new('Cascadia Mono',8);$catalogLogBox.Margin=[Windows.Forms.Padding]::new(0,8,0,0)
$catalogDetailPanel.Controls.Add($catalogLogBox);$catalogDetailPanel.Controls.Add($catalogActions);$catalogDetailPanel.Controls.Add($catalogDetailHash);$catalogDetailPanel.Controls.Add($catalogDetailId);$catalogDetailPanel.Controls.Add($catalogDetailDescription);$catalogDetailPanel.Controls.Add($catalogDetailGames);$catalogDetailPanel.Controls.Add($catalogDetailMeta);$catalogDetailPanel.Controls.Add($catalogDetailName);$catalogDetailPanel.Controls.Add($catalogDetailIcon)
$catalogSplit.Controls.Add($catalogListPanel,0,0);$catalogSplit.Controls.Add($catalogDetailPanel,1,0);$catalogBodyCard.Controls.Add($catalogSplit);$catalogStack.Controls.AddRange(@($catalogSummaryCard,$catalogBodyCard))

$tabs=[Windows.Forms.TabControl]::new();$tabs.Dock='Fill';$tabs.Appearance='FlatButtons';$tabs.SizeMode='Fixed';$tabs.ItemSize=[Drawing.Size]::new(190,34);$tabs.Font=[Drawing.Font]::new('Segoe UI Semibold',9,[Drawing.FontStyle]::Bold);$tabs.Padding=[Drawing.Point]::new(14,5)
$shopPage=[Windows.Forms.TabPage]::new('  🧩  Shop de scripts  ');$shopPage.BackColor=$palette.Background;$shopPage.Padding=[Windows.Forms.Padding]::new(0)
$catalogPage=[Windows.Forms.TabPage]::new('  ☁  Catálogo publicado  ');$catalogPage.BackColor=$palette.Background;$catalogPage.Padding=[Windows.Forms.Padding]::new(0)
$launcherPage=[Windows.Forms.TabPage]::new('  🚀  Versiones del launcher  ');$launcherPage.BackColor=$palette.Background;$launcherPage.Padding=[Windows.Forms.Padding]::new(0)
$shopPage.Controls.Add($contentStack);$shopPage.Controls.Add($sidebar);$catalogPage.Controls.Add($catalogStack);$launcherPage.Controls.Add($launcherStack);$tabs.TabPages.AddRange(@($shopPage,$catalogPage,$launcherPage))
$tabs.SelectedTab=$(if($InitialTab -eq 'Launcher'){$launcherPage}elseif($InitialTab -eq 'Catalog'){$catalogPage}else{$shopPage})
$form.Controls.Add($tabs);$form.Controls.Add($footer);$form.Controls.Add($header)

function Apply-ResponsiveLayout {
  $compact=$form.ClientSize.Width -lt 1040;$sidebar.Visible=-not $compact;$available=$contentStack.ClientSize.Width-$contentStack.Padding.Horizontal-24
  foreach($card in @($sourceCard,$publicationCard,$actionCard)){ $card.Width=[Math]::Max(700,$available) }
  $catalogAvailable=$catalogStack.ClientSize.Width-$catalogStack.Padding.Horizontal-24
  foreach($card in @($catalogSummaryCard,$catalogBodyCard)){ $card.Width=[Math]::Max(700,$catalogAvailable) }
  $launcherAvailable=$launcherStack.ClientSize.Width-$launcherStack.Padding.Horizontal-24
  foreach($card in @($launcherRepoCard,$launcherReleaseCard,$launcherActionCard)){ $card.Width=[Math]::Max(700,$launcherAvailable) }
  $repoFooter.Visible=$form.ClientSize.Width -ge 1080
  $repoFooter.Text=$(if($tabs.SelectedTab -eq $launcherPage){"Launcher: "+$launcherPathBox.Text}elseif($tabs.SelectedTab -eq $catalogPage){"Catálogo: "+$repoRoot}else{"Repositorio: "+$repoRoot})
  Apply-RoundedRegions $form
}

$form.Add_Resize({Apply-ResponsiveLayout});$form.Add_Shown({Apply-ResponsiveLayout;if($tabs.SelectedTab -eq $launcherPage -and $launcherPathBox.Text){[void](Refresh-LauncherRepository)};if($tabs.SelectedTab -eq $catalogPage){[void](Refresh-CatalogManagement)}})
$browseButton.Add_Click({$dialog=[Windows.Forms.OpenFileDialog]::new();$dialog.Title='Seleccionar userscript';$dialog.Filter='Userscripts (*.user.js;*.js)|*.user.js;*.js|JavaScript (*.js)|*.js';if($dialog.ShowDialog() -eq 'OK'){$pathBox.Text=$dialog.FileName;Load-SelectedScript}})
$readButton.Add_Click({Load-SelectedScript});$validateButton.Add_Click({Load-SelectedScript});$clearButton.Add_Click({Clear-PublicationFields})
$openRepoButton.Add_Click({Start-Process 'https://github.com/DiegoT34/PokeGrid-Script-Shop'});$catalogButton.Add_Click({Start-Process 'https://github.com/DiegoT34/PokeGrid-Script-Shop/blob/main/catalog.json'});$openFolderButton.Add_Click({Start-Process explorer.exe -ArgumentList $repoRoot})
$dragEnter={if($_.Data.GetDataPresent([Windows.Forms.DataFormats]::FileDrop)){$_.Effect=[Windows.Forms.DragDropEffects]::Copy}};$dragDrop={$files=@($_.Data.GetData([Windows.Forms.DataFormats]::FileDrop));$file=$files|Where-Object{$_ -match '(?i)(?:\.user)?\.js$'}|Select-Object -First 1;if($file){$pathBox.Text=$file;Load-SelectedScript}}
$form.Add_DragEnter($dragEnter);$form.Add_DragDrop($dragDrop);$sourceCard.AllowDrop=$true;$sourceCard.Add_DragEnter($dragEnter);$sourceCard.Add_DragDrop($dragDrop)
foreach($control in @($idBox,$iconBox,$nameValue,$versionValue)){$control.Add_TextChanged({Refresh-Preview})};$categoryBox.Add_TextChanged({Refresh-Preview})
$tabs.Add_SelectedIndexChanged({
  Apply-ResponsiveLayout
  if($tabs.SelectedTab -eq $launcherPage -and -not $script:launcherInfo){[void](Refresh-LauncherRepository)}
  if($tabs.SelectedTab -eq $catalogPage -and -not @($script:catalogEntries).Count){[void](Refresh-CatalogManagement)}
})
$catalogSearchBox.Add_TextChanged({Render-CatalogManagement})
$catalogGrid.Add_SelectionChanged({if($catalogGrid.SelectedRows.Count){Show-CatalogEntry $catalogGrid.SelectedRows[0].Tag}})
$catalogRefreshButton.Add_Click({if($script:isBusy){return};Set-Busy $true;try{[void](Refresh-CatalogManagement)}finally{Set-Busy $false;Show-CatalogEntry $script:catalogSelected}})
$catalogOpenRepoButton.Add_Click({Start-Process 'https://github.com/DiegoT34/PokeGrid-Script-Shop'})
$catalogOpenScriptButton.Add_Click({if($script:catalogSelected){Start-Process "https://github.com/DiegoT34/PokeGrid-Script-Shop/blob/main/scripts/$($script:catalogSelected.id).user.js"}})
$catalogDeleteButton.Add_Click({
  if($script:isBusy -or -not $script:catalogSelected){return}
  $selected=$script:catalogSelected
  $question="¿Retirar '$($selected.name)' v$($selected.version) de la Shop?`r`n`r`nSe eliminarán exclusivamente:`r`n• su entrada en catalog.json`r`n• scripts/$($selected.id).user.js`r`n`r`nLos usuarios que ya lo instalaron conservarán su copia local, pero dejará de aparecer para nuevas instalaciones."
  if([Windows.Forms.MessageBox]::Show($question,'Confirmar retirada de publicación','YesNo','Warning') -ne 'Yes'){Log-Catalog 'Retirada cancelada por el usuario.';return}
  Set-Busy $true
  try{
    Log-Catalog 'Sincronizando antes de retirar la publicación…';[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('pull','--ff-only'))
    $catalog=Get-Content -LiteralPath (Join-Path $repoRoot 'catalog.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $current=@($catalog.scripts)|Where-Object{[string]$_.id -ceq [string]$selected.id}|Select-Object -First 1
    if(-not $current){throw 'La publicación ya fue retirada desde otra copia del repositorio.'}
    Log-Catalog "Retirando $($current.name) del catálogo local…"
    $removeOutput=& $catalogRemover -Id ([string]$current.id) -RepositoryRoot $repoRoot 2>&1|Out-String
    if($removeOutput.Trim()){Log-Catalog $removeOutput.Trim()}
    $target="scripts/$($current.id).user.js"
    [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('add','--','catalog.json',$target))
    $diffResult=Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('diff','--cached','--quiet') -AllowFailure
    if($diffResult.ExitCode -eq 0){throw 'No se detectaron cambios para retirar la publicación.'}
    if($diffResult.ExitCode -ne 1){throw $(if($diffResult.Output){$diffResult.Output}else{'No se pudo revisar la retirada preparada.'})}
    $commitMessage="Retirar $($current.name) $($current.version) de la Shop"
    [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('commit','-m',$commitMessage,'--','catalog.json',$target))
    Log-Catalog 'Subiendo la retirada a GitHub…';[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('push'))
    if(Verify-OnlineRemoval ([string]$current.id)){Log-Catalog "$($current.name) ya no aparece en la Shop online." 'ok'}else{Log-Catalog 'GitHub recibió el cambio; el catálogo online aún se está propagando.' 'ok'}
    [Windows.Forms.MessageBox]::Show("$($current.name) fue retirado correctamente de la Shop.`r`n`r`nLas instalaciones existentes no fueron eliminadas de los equipos de los usuarios.",'Publicación retirada','OK','Information')|Out-Null
    $script:catalogSelected=$null;[void](Refresh-CatalogManagement -SkipPull)
  }catch{Log-Catalog $_.Exception.Message 'error';[Windows.Forms.MessageBox]::Show($_.Exception.Message,'No se pudo retirar el script','OK','Error')|Out-Null}finally{Set-Busy $false;Show-CatalogEntry $script:catalogSelected}
})
$launcherBrowseButton.Add_Click({$dialog=[Windows.Forms.FolderBrowserDialog]::new();$dialog.Description='Selecciona la carpeta local de PokeGrid Launcher';$dialog.SelectedPath=$launcherPathBox.Text;if($dialog.ShowDialog() -eq 'OK'){$launcherPathBox.Text=$dialog.SelectedPath;[void](Refresh-LauncherRepository)}})
$launcherRefreshButton.Add_Click({[void](Refresh-LauncherRepository)})
$launcherOpenRepoButton.Add_Click({Start-Process 'https://github.com/DiegoT34/PokeGrid-Launcher'});$launcherOpenActionsButton.Add_Click({Start-Process 'https://github.com/DiegoT34/PokeGrid-Launcher/actions'})
$launcherValidateButton.Add_Click({
  if(-not(Refresh-LauncherRepository)){return}
  try{
    $target=$launcherVersionBox.Text.Trim().TrimStart('v');if($target -notmatch '^\d+\.\d+\.\d+$'){throw 'Escribe la nueva versión con formato X.Y.Z.'}
    if([Version]$target -le [Version]$script:launcherInfo.Current){throw "La versión debe ser superior a v$($script:launcherInfo.Current)."}
    if($script:launcherInfo.Latest -match '^\d+\.\d+\.\d+$' -and [Version]$target -le [Version]$script:launcherInfo.Latest){throw "La versión debe ser superior a la última Release v$($script:launcherInfo.Latest)."}
    if($script:launcherInfo.Branch -ne 'main'){throw "Cambia a la rama main antes de publicar. Rama actual: $($script:launcherInfo.Branch)"}
    $launcherProgress.Text="v$target lista para publicación · se generarán ZIP y SHA-256";Log-Launcher "Validación correcta: la próxima Release será v$target." 'ok'
  }catch{Log-Launcher $_.Exception.Message 'error';[Windows.Forms.MessageBox]::Show($_.Exception.Message,'Revisión necesaria','OK','Warning')|Out-Null}
})
$launcherPublishButton.Add_Click({
  if($script:isBusy){return};Set-Busy $true
  try{
    if(-not(Refresh-LauncherRepository)){throw 'No se pudo validar el repositorio del launcher.'}
    $target=$launcherVersionBox.Text.Trim().TrimStart('v');if($target -notmatch '^\d+\.\d+\.\d+$'){throw 'La nueva versión debe tener el formato X.Y.Z.'}
    if([Version]$target -le [Version]$script:launcherInfo.Current){throw "La versión debe ser superior a v$($script:launcherInfo.Current)."}
    if($script:launcherInfo.Latest -match '^\d+\.\d+\.\d+$' -and [Version]$target -le [Version]$script:launcherInfo.Latest){throw "La versión debe ser superior a la última Release v$($script:launcherInfo.Latest)."}
    if(-not $launcherNotesBox.Text.Trim()){throw 'Describe brevemente los cambios de esta versión.'}
    $pending=$(if($script:launcherInfo.Pending){$script:launcherInfo.Pending}else{'(solo se actualizará package.json)'})
    $question="¿Publicar PokeGrid Launcher v$target?`r`n`r`nLa herramienta incluirá estos cambios:`r`n$pending`r`n`r`nDespués hará push de main y creará la etiqueta v$target. GitHub Actions compilará el ZIP y su SHA-256."
    if([Windows.Forms.MessageBox]::Show($question,'Confirmar nueva versión','YesNo','Question') -ne 'Yes'){Log-Launcher 'Publicación cancelada por el usuario.';return}
    $launcherProgress.Text='Preparando repositorio y versión…';Log-Launcher "Iniciando publicación manual de v$target…"
    $parameters=@{RepositoryRoot=$script:launcherInfo.Root;Version=$target;ReleaseNotes=$launcherNotesBox.Text}
    if($launcherChecksBox.Checked){$parameters.RunLocalChecks=$true};if($launcherBuildBox.Checked){$parameters.BuildLocal=$true}
    $output=& $launcherPublisher @parameters 2>&1|Out-String
    if($output.Trim()){Log-Launcher $output.Trim()}
    $launcherProgress.Text='Etiqueta publicada. Esperando el paquete de GitHub Actions…';Log-Launcher 'GitHub recibió la versión. Esperando ZIP y SHA-256…'
    $releaseUrl=Wait-LauncherRelease $target
    if($releaseUrl){$launcherProgress.Text="Release v$target disponible para el actualizador";Log-Launcher "PokeGrid Launcher v$target ya está publicado correctamente." 'ok';[Windows.Forms.MessageBox]::Show("La versión v$target está disponible.`r`n`r`nEl ZIP portátil y su SHA-256 fueron verificados en la Release. El botón Actualizar del launcher ya puede detectarla.",'Publicación completada','OK','Information')|Out-Null;Start-Process $releaseUrl}
    else{$launcherProgress.Text='La compilación continúa en GitHub Actions';Log-Launcher 'La etiqueta fue subida, pero GitHub continúa compilando. Revisa la pestaña Compilaciones.' 'ok';[Windows.Forms.MessageBox]::Show('La versión fue enviada correctamente. GitHub Actions todavía está construyendo el paquete; puedes seguirla desde Compilaciones.','Publicación enviada','OK','Information')|Out-Null}
    $script:launcherInfo=$null;[void](Refresh-LauncherRepository)
  }catch{Log-Launcher $_.Exception.Message 'error';$launcherProgress.Text='No se pudo completar la publicación';[Windows.Forms.MessageBox]::Show($_.Exception.Message,'No se pudo publicar el launcher','OK','Error')|Out-Null}finally{Set-Busy $false}
})
$form.Add_KeyDown({
  if($_.Control -and $_.KeyCode -eq 'O'){if($tabs.SelectedTab -eq $launcherPage){$launcherBrowseButton.PerformClick()}else{$browseButton.PerformClick()};$_.SuppressKeyPress=$true}
  if($_.Control -and $_.KeyCode -eq 'Enter'){if($tabs.SelectedTab -eq $launcherPage){$launcherValidateButton.PerformClick()}else{$validateButton.PerformClick()};$_.SuppressKeyPress=$true}
})

$publishButton.Add_Click({
  if($script:isBusy){return};Set-Busy $true
  try{
    $script:loaded=Read-Script $pathBox.Text
    if($idBox.Text -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$'){throw 'El ID estable debe usar minúsculas, números, punto, guion o guion bajo.'}
    if(-not $summaryBox.Text.Trim()){throw 'Añade un resumen para la tarjeta de la Shop.'};if(-not $descriptionBox.Text.Trim()){throw 'Añade una descripción completa.'};if(-not $changelogBox.Text.Trim()){throw 'Describe los cambios de esta versión.'}
    if(-not(Test-Path -LiteralPath (Join-Path $repoRoot '.git'))){throw 'No se encontró el repositorio Git de la Shop.'}
    $publicationLabel=$(if($script:publicationMode -eq 'Update'){'ACTUALIZACIÓN'}else{'NUEVO SCRIPT'})
    $question="¿Publicar $($script:loaded.Name) v$($script:loaded.Version)?`r`n`r`nModo: $publicationLabel`r`nID: $($idBox.Text)`r`nCategoría: $($categoryBox.Text)"
    if([Windows.Forms.MessageBox]::Show($question,'Confirmar publicación','YesNo','Question') -ne 'Yes'){Log 'Publicación cancelada por el usuario.';return}
    Log 'Sincronizando el repositorio…';[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('pull','--ff-only'))
    $tags=@($tagsBox.Text -split ','|ForEach-Object{$_.Trim()}|Where-Object{$_});$permissions=@($permissionsBox.Lines|ForEach-Object{$_.Trim()}|Where-Object{$_})
    $parameters=@{Path=$script:loaded.Path;Id=$idBox.Text;PublicationMode=$script:publicationMode;Category=$categoryBox.Text;Tags=$tags;Permissions=$permissions;Summary=$summaryBox.Text;Description=$descriptionBox.Text;Changelog=$changelogBox.Text;Author=$authorBox.Text;MinLauncherVersion=$minLauncherBox.Text;Icon=$iconBox.Text;Featured=$featuredBox.Checked;RepositoryRoot=$repoRoot}
    Log 'Generando archivo publicado, catálogo y SHA-256…';$publisherOutput=& $cliPublisher @parameters 2>&1|Out-String;Log $publisherOutput.Trim()
    $target="scripts/$($idBox.Text).user.js";[void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('add','--','catalog.json',$target));$diffResult=Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('diff','--cached','--quiet') -AllowFailure
    if($diffResult.ExitCode -eq 0){Log 'No hay cambios nuevos para publicar.' 'ok';return};if($diffResult.ExitCode -ne 1){throw $(if($diffResult.Output){$diffResult.Output}else{'No se pudieron comprobar los cambios preparados.'})}
    $message="Publicar $($script:loaded.Name) $($script:loaded.Version)";Log 'Creando commit local…'
    [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('commit','-m',$message,'--','catalog.json',$target))
    Log 'Subiendo la publicación a GitHub…'
    try {
      [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('push'))
    } catch {
      $detail = $_.Exception.Message
      Log 'El commit es local; la publicación online no se actualizó.' 'error'
      [Windows.Forms.MessageBox]::Show((Get-PushFailureMessage $script:loaded.Name $script:loaded.Version $detail),'Publicación pendiente de subir','OK','Warning')|Out-Null
      return
    }
    Log 'Verificando que el catálogo ya sea visible online…'
    if(Verify-OnlinePublication $idBox.Text $script:loaded.Version){Log "$($script:loaded.Name) v$($script:loaded.Version) está visible en la Shop." 'ok';[Windows.Forms.MessageBox]::Show('El script fue publicado y ya aparece en el catálogo online.','Publicación completada','OK','Information')|Out-Null}else{Log 'GitHub recibió la publicación; la propagación del catálogo aún está en curso.' 'ok';[Windows.Forms.MessageBox]::Show('La publicación fue subida correctamente. GitHub puede tardar unos segundos en reflejarla en el catálogo.','Publicación enviada','OK','Information')|Out-Null}
  }catch{Log $_.Exception.Message 'error';[Windows.Forms.MessageBox]::Show($_.Exception.Message,'No se pudo publicar','OK','Error')|Out-Null}finally{Set-Busy $false}
})

Refresh-Preview;Log "Repositorio de scripts listo: $repoRoot" 'ok';$catalogLogBox.Text='Sincroniza para consultar las publicaciones visibles en la Shop.'+"`r`n";$launcherLogBox.Text='Selecciona o detecta el repositorio del launcher para comenzar.'+"`r`n"

if($SmokeTest){
  $form.Show();[Windows.Forms.Application]::DoEvents();Apply-ResponsiveLayout
  if(-not $publishButton -or -not $pathBox -or -not $contentStack.AutoScroll -or -not(Test-Path -LiteralPath $cliPublisher)){throw 'La interfaz adaptable del publicador no pudo inicializarse.'}
  if($tabs.TabPages.Count -ne 3 -or -not $catalogGrid -or -not $catalogDeleteButton -or -not $catalogStack.AutoScroll -or -not(Test-Path -LiteralPath $catalogRemover)){throw 'La pestaña de catálogo publicado no pudo inicializarse.'}
  if(-not $launcherPublishButton -or -not $launcherPathBox -or -not $launcherStack.AutoScroll -or -not(Test-Path -LiteralPath $launcherPublisher)){throw 'La pestaña de publicación del launcher no pudo inicializarse.'}
  $identityProbe=[pscustomobject]@{scripts=@([pscustomobject]@{id='anterior';name='Script anterior';namespace='http://tampermonkey.net/'})}
  $newProbe=[pscustomobject]@{Name='Script completamente nuevo';Namespace='http://tampermonkey.net/'}
  if(Find-CatalogEntry $identityProbe $newProbe){throw 'Un ID anterior o namespace compartido está clasificando scripts nuevos como actualizaciones.'}
  if((Get-UniqueScriptId ([pscustomobject]@{scripts=@([pscustomobject]@{id='script-completamente-nuevo'})}) 'Script completamente nuevo') -ne 'script-completamente-nuevo-2'){throw 'La generación segura de ID para scripts nuevos no funciona.'}
  $largeWidth=$sourceCard.Width;$form.ClientSize=[Drawing.Size]::new(900,680);[Windows.Forms.Application]::DoEvents();Apply-ResponsiveLayout
  if($sidebar.Visible -or $sourceCard.Width -ge $largeWidth -or $sourceCard.Width -lt 700 -or $catalogSummaryCard.Width -lt 700 -or $launcherRepoCard.Width -lt 700){throw "La respuesta compacta del layout no funciona. Shop=$($sourceCard.Width), Catalog=$($catalogSummaryCard.Width), Launcher=$($launcherRepoCard.Width), Large=$largeWidth"}
  $script:catalogEntries=@([pscustomobject]@{id='smoke';name='Script Smoke';version='1.0.0';category='Utilidades';author='PokeGrid';icon='🧩';games=@('Juego Smoke');tags=@('test');featured=$true;description='Prueba';publishedAt='2026-01-01';sha256=('a'*64)})
  Render-CatalogManagement
  if($catalogGrid.Rows.Count -ne 1 -or $catalogCountValue.Text -ne '1' -or -not $catalogDeleteButton.Enabled){throw 'La vista visual del catálogo no pudo representar una publicación seleccionable.'}
  [void](Invoke-PokeGridGit -RepositoryRoot $repoRoot -Arguments @('status','--porcelain=v1'))
  if($script:MaxScriptBytes -ne 10MB){throw 'El límite de userscripts del publicador no está configurado en 10 MB.'}
  $pushMessage = Get-PushFailureMessage 'Script de Ejemplo' '1.2.3' 'fatal: Authentication failed'
  foreach($required in @('1.2.3','git push','autentic')){ if($pushMessage -notmatch [regex]::Escape($required)){throw "El aviso de push fallido no menciona '$required'."} }
  $smallText = Get-SourceSizeText 100KB
  if($smallText -notmatch '10 MB'){throw "El texto de peso no indica el limite de 10 MB: $smallText"}
  if($smallText -match '%'){throw "Un archivo pequeno no deberia mostrar un porcentaje: $smallText"}
  $largeText = Get-SourceSizeText (6MB)
  if($largeText -notmatch '60'){throw "Un archivo de 6 MB deberia mostrar 60% del limite, no: $largeText"}
  if($sourceHint.ForeColor -ne $palette.Warning){throw 'El aviso de peso deberia resaltarse en ambar por encima del 50% del limite.'}
  Write-Output 'PokeGrid Publisher 1.3.1 catalog management, 10 MB userscripts, removal controls, publication tabs, responsive GUI and Git smoke passed.';$form.Dispose();exit 0
}

if($ScreenshotPath){
  $timer=[Windows.Forms.Timer]::new();$timer.Interval=1000
  $timer.Add_Tick({$timer.Stop();$target=[IO.Path]::GetFullPath($ScreenshotPath);New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;$bitmap=[Drawing.Bitmap]::new($form.Width,$form.Height);$form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height));$bitmap.Save($target,[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose();$form.Close()});$timer.Start()
}

[void]$form.ShowDialog()
