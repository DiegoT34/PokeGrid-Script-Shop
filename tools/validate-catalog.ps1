param(
  [string]$RepositoryRoot = '',
  [int64]$MaxScriptBytes = 10MB
)

$ErrorActionPreference = 'Stop'
$root = if ($RepositoryRoot) { [IO.Path]::GetFullPath($RepositoryRoot) } else { Split-Path -Parent $PSScriptRoot }
$catalogPath = Join-Path $root 'catalog.json'
$schemaPath = Join-Path $root 'catalog.schema.json'
$errors = [Collections.Generic.List[string]]::new()
$downloadBase = 'https://raw.githubusercontent.com/DiegoT34/PokeGrid-Script-Shop/main/scripts'
$rfc3339 = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'

if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw "No se encontro catalog.json en $root" }
$raw = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8
$catalog = $raw | ConvertFrom-Json

# Capa 1: schema. Test-Json solo existe en PowerShell 6+; en 5.1 se omite y
# quedan las comprobaciones explicitas de mas abajo, que son las que importan.
if ((Get-Command Test-Json -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $schemaPath -PathType Leaf)) {
  try {
    if (-not ($raw | Test-Json -SchemaFile $schemaPath -ErrorAction Stop)) {
      $errors.Add('catalog.json no cumple catalog.schema.json.')
    }
  } catch {
    $errors.Add("catalog.json no cumple catalog.schema.json: $($_.Exception.Message)")
  }
}

# Capa 2: formato y unicidad.
if ([int]$catalog.schemaVersion -ne 1) { $errors.Add('schemaVersion debe ser 1.') }
if ([string]$catalog.updatedAt -notmatch $rfc3339) {
  $errors.Add("updatedAt no es RFC 3339: '$($catalog.updatedAt)'")
}
$seen = @{}
foreach ($item in @($catalog.scripts)) {
  $id = [string]$item.id
  if ($id -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$') { $errors.Add("ID invalido: '$id'") }
  $key = $id.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { $errors.Add("ID duplicado: '$id'") } else { $seen[$key] = $true }
  if ([string]$item.version -notmatch '^\d+\.\d+\.\d+(?:[-+].*)?$') { $errors.Add("Version invalida: '$id'") }
  if ([string]$item.sha256 -notmatch '^[a-f0-9]{64}$') { $errors.Add("SHA-256 invalido: '$id'") }
  $expectedUrl = "$downloadBase/$id.user.js"
  if ([string]$item.downloadUrl -ne $expectedUrl) { $errors.Add("URL invalida: '$id'") }
}

# Capa 3: archivo en disco.
foreach ($item in @($catalog.scripts)) {
  $id = [string]$item.id
  $file = Join-Path $root "scripts\$id.user.js"
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $errors.Add("No existe scripts\$id.user.js"); continue }
  $length = (Get-Item -LiteralPath $file).Length
  if ($length -gt $MaxScriptBytes) {
    $errors.Add("scripts\$id.user.js ocupa $length bytes y supera el limite de 10 MB")
    continue
  }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne [string]$item.sha256) { $errors.Add("SHA-256 no coincide: '$id'") }
  $code = Get-Content -LiteralPath $file -Raw -Encoding UTF8
  # El publicador escribe siempre la version ya normalizada: sin prefijo v y
  # con tres componentes. Cualquier otra forma en el archivo publicado es una
  # edicion manual posterior a la publicacion, y por tanto deriva: se rechaza.
  # Se comparan las cadenas sin normalizar para que la regla sea simetrica con
  # el caso de dos componentes, que tampoco se acepta.
  $fileVersion = [regex]::Match($code, '(?im)^\s*//\s*@version\s+(.+?)\s*$').Groups[1].Value.Trim()
  if ($fileVersion -ne [string]$item.version) { $errors.Add("@version no coincide: '$id' (archivo '$fileVersion', catalogo '$($item.version)')") }
  $fileNamespace = [regex]::Match($code, '(?im)^\s*//\s*@namespace\s+(.+?)\s*$').Groups[1].Value.Trim()
  if ($fileNamespace -ne [string]$item.namespace) { $errors.Add("@namespace no coincide: '$id'") }
}

if ($errors.Count) {
  foreach ($message in $errors) { Write-Host "  ERROR  $message" -ForegroundColor Red }
  throw "Catalogo invalido: $($errors.Count) problema(s)."
}
Write-Host "Catalogo valido: $(@($catalog.scripts).Count) script(s), limite de $MaxScriptBytes bytes."
