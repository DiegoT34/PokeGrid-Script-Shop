$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$gui = Get-Content -LiteralPath (Join-Path $root 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

# 1. No queda ningun color de tema escrito a mano.
$literals = [regex]::Matches($gui, "Color '#([0-9A-Fa-f]{6})'")
if ($literals.Count) {
  $values = ($literals | ForEach-Object { '#' + $_.Groups[1].Value.ToUpper() } | Sort-Object -Unique) -join ', '
  throw "Quedan $($literals.Count) colores hardcodeados en el guion: $values"
}

# 2. $palette existe pero solo como proxy al tema, no como tabla de hex.
$paletteBlock = [regex]::Match($gui, '(?s)\$palette\s*=\s*\[pscustomobject\]@\{.*?\}').Value
if (-not $paletteBlock) { throw 'No se encontro la tabla $palette: deberia ser un proxy al tema activo.' }
if ($paletteBlock -match "#[0-9A-Fa-f]{6}") { throw '$palette vuelve a contener hex: el aspecto tiene que venir del tema.' }
foreach ($key in @('Background', 'Surface', 'SurfaceRaised', 'SurfaceSoft', 'Border', 'Text', 'Muted', 'Dim')) {
  if ($paletteBlock -notmatch "\b$key\s*=") { throw "El proxy de `$palette no expone la clave '$key' que ya usaba el guion." }
}
# Y cada clave sale de un token, no de un literal.
$tokenCalls = ([regex]::Matches($paletteBlock, "Get-ThemeColor\s+'")).Count
Assert ($tokenCalls -ge 8) "El proxy de `$palette solo tiene $tokenCalls llamadas a Get-ThemeColor y deberia tener al menos 8."

# 3. El guion hace dot-source del tema y elige el tema guardado.
Assert ($gui -match 'theme\.ps1') 'El guion no carga tools/theme.ps1.'
Assert ($gui -match 'Read-PokeGridThemeKey') 'El guion no restaura el tema guardado: se perderia en cada arranque.'

# 4. Los usos que ya existian siguen ahí: la migracion no debe borrar trabajo.
$uses = ([regex]::Matches($gui, '\$palette\.[A-Za-z]+')).Count
Assert ($uses -ge 70) "Solo quedan $uses usos de `$palette.X; se esperaban al menos 70, la migracion no debe perder ninguno."

Write-Output "No hardcoded colours passed: $($uses) token lookups, zero literal colours, saved theme restored."
