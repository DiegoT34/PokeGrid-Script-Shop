$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$schemaPath = Join-Path $root 'catalog.schema.json'
$catalogPath = Join-Path $root 'catalog.json'
$schema = Get-Content -LiteralPath $schemaPath -Raw -Encoding UTF8 | ConvertFrom-Json
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json

$documented = @('id','name','namespace','version','summary','description','category','minLauncherVersion','downloadUrl','sha256','author','tags','games','permissions','changelog','icon','featured','publishedAt','homepage')
foreach ($property in $documented) {
  if (-not $schema.properties.scripts.items.properties.$property) {
    throw "catalog.schema.json no documenta la propiedad '$property'."
  }
}
if (-not $schema.properties.scripts.items.additionalProperties) {
  throw 'Los items del schema deben mantener additionalProperties en true: el launcher debe seguir leyendo campos nuevos.'
}
if (@($schema.properties.scripts.items.required).Count -ne 10) {
  throw "El schema debe exigir exactamente 10 campos, no $(@($schema.properties.scripts.items.required).Count)."
}
if ($schema.properties.scripts.maxItems -ne 200) { throw 'El schema debe seguir limitando a 200 scripts.' }

# Comprobaciones explicitas: funcionan en Windows PowerShell 5.1, donde Test-Json no existe.
foreach ($item in @($catalog.scripts)) {
  foreach ($field in @($schema.properties.scripts.items.required)) {
    if (-not $item.PSObject.Properties[$field]) { throw "El catalogo real no tiene '$field' en '$($item.id)'." }
  }
  if ([string]$item.id -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$') { throw "id invalido en el catalogo real: $($item.id)" }
  if ([string]$item.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+].*)?$') { throw "version invalida: $($item.id)" }
  if ([string]$item.sha256 -notmatch '^[a-f0-9]{64}$') { throw "sha256 invalida: $($item.id)" }
}

if (Get-Command Test-Json -ErrorAction SilentlyContinue) {
  $raw = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8
  if (-not ($raw | Test-Json -SchemaFile $schemaPath)) { throw 'El catalogo real no valida contra el schema.' }
  Write-Output '  (validacion Test-Json ejecutada en PowerShell 7+)'
} else {
  Write-Output '  (Test-Json no disponible en Windows PowerShell 5.1; solo comprobaciones explicitas)'
}
Write-Output 'Catalog schema passed: documented properties, required set, additionalProperties and the real catalog.'
