$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'theme.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

$themes = Get-PokeGridThemes
Assert ($themes.Count -eq 4) "Se esperaban 4 temas y hay $($themes.Count)."
# Los temas son [ordered]@{}, es decir OrderedDictionary: la comprobacion es
# Contains, no ContainsKey, que solo existe en hashtable.
foreach ($key in @('crystal-dark', 'crystal-light', 'midnight', 'flat')) {
  Assert ($themes.Contains($key)) "Falta el tema '$key'."
}

# PLANE es el nombre visible del cuarto tema; su clave interna sigue siendo flat.
Assert ($themes['flat'].Name -eq 'PLANE') "El tema flat debe mostrarse como PLANE, no como '$($themes['flat'].Name)'."

# Los 4 comparten estructura: un token que falta en uno, esta en todos.
$required = @(
  'Key', 'Name', 'Kind', 'Blur', 'Base', 'Radius', 'Spacing',
  'Text.Primary', 'Text.Secondary', 'Text.Disabled',
  'Surface.Base', 'Surface.Raised', 'Surface.Soft', 'Surface.Hover',
  'Border.Base', 'Border.Strong',
  'Rest.Primary.Base', 'Rest.Primary.Hover', 'Rest.Primary.Fore',
  'Rest.Danger.Base', 'Rest.Danger.Hover', 'Rest.Danger.Fore',
  'Rest.Success.Base', 'Rest.Warning.Base',
  'Shadow.Depth', 'Shadow.Alpha',
  'Motion.Fast', 'Motion.Normal', 'Motion.Slow',
  'Font.Display', 'Font.Body', 'Font.Mono'
)
foreach ($name in $themes.Keys) {
  $missing = Test-PokeGridTheme $themes[$name]
  if ($missing.Count) { throw "El tema '$name' no define: $($missing -join ', ')" }
}

# PLANE no usa cristal y sus animaciones son instantaneas.
Assert ($themes['flat'].Kind -eq 'flat') 'PLANE debe ser un tema plano.'
Assert (-not $themes['flat'].Blur) 'PLANE no debe pedir blur.'
Assert ($themes['flat'].Motion.Fast -eq 0 -and $themes['flat'].Motion.Slow -eq 0) 'PLANE no debe animar.'
foreach ($name in @('crystal-dark', 'crystal-light', 'midnight')) {
  Assert ($themes[$name].Kind -eq 'glass') "$name deberia ser de cristal."
  Assert ($themes[$name].Blur) "$name deberia pedir blur."
  Assert ($themes[$name].Motion.Fast -gt 0) "$name deberia animar."
}

# Ningun color mal formado, y el radio y la rejilla son razonables.
foreach ($name in $themes.Keys) {
  $theme = $themes[$name]
  foreach ($token in @($theme.Base, $theme.Text.Primary, $theme.Text.Secondary, $theme.Surface.Base, $theme.Border.Base)) {
    Assert ([string]$token -match '^#[0-9A-Fa-f]{6}$') "El tema '$name' tiene un color mal formado: '$token'."
  }
  Assert ($theme.Radius -ge 0 -and $theme.Radius -le 16) "El radio de '$name' fuera de rango: $($theme.Radius)."
  Assert ($theme.Spacing -ge 2 -and $theme.Spacing -le 8) "La rejilla de '$name' fuera de rango: $($theme.Spacing)."
}

# El texto principal de cada tema se lee sobre su propia superficie.
foreach ($name in $themes.Keys) {
  $script:theme = $themes[$name]
  $ratio = Get-ContrastRatio (Get-ThemeColor 'Text.Primary') (Get-ThemeColor 'Surface.Base')
  if ($ratio -lt 4.5) {
    throw "El tema '$name' tiene texto principal sobre superficie en $('{0:N2}' -f $ratio):1, por debajo de 4.5:1."
  }
}

# Un token inexistente da error claro, no un color negro silencioso.
$script:theme = $themes['crystal-dark']
$missingFailed = $false
try { [void](Get-ThemeColor 'No.Existe') } catch { $missingFailed = $true }
Assert $missingFailed 'Get-ThemeColor debio fallar con un token inexistente en vez de devolver negro.'
$fallback = Get-ThemeColor 'No.Existe' '#123456'
Assert ($fallback.R -eq 0x12 -and $fallback.G -eq 0x34) 'Get-ThemeColor no respeto el color de reserva.'

Write-Output 'Theme data passed: four themes, PLANE naming, full token coverage, valid colours and readable text.'
