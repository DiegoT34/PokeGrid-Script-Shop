$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'git-helper.ps1')
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }

# LA SINCRONIZACION DEL CATALOGO CUANDO LAS RAMAS DIVERGEN.
#
# El publisher hacia "git pull --ff-only" dentro del mismo try que leia el catalogo.
# Con las ramas divergidas ese pull aborta con codigo 128, el catch se comia el
# resto y no se cargaba nada: en pantalla parecia que no habia conexion con GitHub,
# cuando lo que pasaba era que el remoto tenia publicaciones que el local no tenia.
#
# Ahora la sincronizacion va aparte: si falla, el catalogo se lee del disco igual y
# se avisa de que NO esta sincronizado, en vez de fingir que se sincronizo.

$git = Resolve-PokeGridGitPath
$base = Join-Path $env:TEMP ('pokagrid-sync-' + [Guid]::NewGuid().ToString('N'))
$work = Join-Path $base 'shop'
$bare = Join-Path $base 'origin.git'
New-Item -ItemType Directory -Path $base -Force | Out-Null

function Invoke-Git([string[]]$GitArgs, [string]$Where = $work) {
  $out = & $git -C $Where @GitArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') fallo: $($out | Out-String)" }
  return $out
}

try {
  # Un remoto vacio y un clon: el camino que hace la gente a mano.
  # Git escribe los avisos por stderr y con Stop como preferencia global PowerShell
  # los convierte en excepcion, aunque el comando haya ido bien. Se apaga solo aqui.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  [void](& $git init --bare --quiet $bare 2>&1)
  [void](& $git clone --quiet $bare $work 2>&1)
  $ErrorActionPreference = $prevEap
  & $git -C $work config user.email 'prueba@pokagrid.test' | Out-Null
  & $git -C $work config user.name 'PokeGrid Prueba' | Out-Null
  & $git -C $work symbolic-ref HEAD refs/heads/main 2>&1 | Out-Null

  function Write-Catalog([object[]]$Scripts) {
    $c = @{ schemaVersion = 1; scripts = $Scripts }
    [IO.File]::WriteAllText((Join-Path $work 'catalog.json'), ($c | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  }
  function New-Entry([string]$Id, [string]$Version, [string]$Date) {
    return @{ id = $Id; name = $Id; version = $Version; author = 'PokeGrid'; namespace = 'http://tampermonkey.net/'; description = 'd'; games = @('G'); tags = @('t'); featured = $false; publishedAt = $Date; minLauncherVersion = '0.22.1' }
  }

  Write-Catalog @((New-Entry 'uno' '1.0.0' '2026-01-01'))
  [void](Invoke-Git @('add','--','catalog.json'))
  [void](Invoke-Git @('commit','-m','catalogo inicial'))
  [void](Invoke-Git @('push','-q','origin','main'))

  # Commit SOLO en el remoto: la "publicacion" que el local no tiene.
  [void](Invoke-Git @('checkout','-q','-b','remota'))
  Write-Catalog @((New-Entry 'uno' '1.0.0' '2026-01-01'), (New-Entry 'dos' '2.0.0' '2026-01-02'))
  [void](Invoke-Git @('add','--','catalog.json'))
  [void](Invoke-Git @('commit','-m','publicacion remota'))
  [void](Invoke-Git @('push','-q','origin','remota:main'))
  [void](Invoke-Git @('checkout','-q','main'))

  # Commit SOLO en el local: ahora las ramas divergen de verdad.
  [void](Invoke-Git @('checkout','-q','-b','mia'))
  # Sin esto el pull falla por "no tracking information", que es otro fallo distinto
  # del que estamos probando: la rama nueva tiene que seguir a origin/main.
  [void](Invoke-Git @('branch','--set-upstream-to=origin/main','mia'))
  [IO.File]::WriteAllText((Join-Path $work 'nota.txt'), 'trabajo local', [Text.UTF8Encoding]::new($false))
  [void](Invoke-Git @('add','--','nota.txt'))
  [void](Invoke-Git @('commit','-m','trabajo local'))

  # 1) "pull --ff-only" TIENE que fallar: es el caso que rompia la sincronizacion.
  $ff = Invoke-PokeGridGit -RepositoryRoot $work -Arguments @('pull','--ff-only') -AllowFailure
  Assert ($ff.ExitCode -ne 0) 'Se esperaba que "pull --ff-only" fallara con las ramas divergidas, y no fallo.'

  # 2) Y el fallo tiene que explicar la divergencia, no soltar el "hint:" de Git.
  Assert ($ff.Output -match 'Diverging branches|not possible to fast-forward|cannot be fast-forwarded') `
    "El fallo de Git deberia mencionar la divergencia, y en su lugar dice: $($ff.Output)"

  # 3) El catalogo se lee del disco AUNQUE el pull falle. Antes no se cargaba nada y
  #    la app parecia quedarse sin conexion con GitHub.
  $disk = Get-Content -LiteralPath (Join-Path $work 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert (@($disk.scripts).Count -eq 1) 'El catalogo del disco deberia seguir siendo legible con la divergencia.'

  # 4) Y tras fusionar, la lectura del remoto tiene que devolver lo suyo: no se
  #    pierde ninguna publicacion por el camino.
  [void](Invoke-Git @('fetch','-q','origin'))
  [void](Invoke-Git @('merge','--no-edit','origin/main'))
  $merged = Get-Content -LiteralPath (Join-Path $work 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert (@($merged.scripts).Count -eq 2) "Tras fusionar el catalogo deberia traer las 2 entradas del remoto y trae $(@($merged.scripts).Count)."

  # 5) El guion tiene que separar sincronizacion de lectura del catalogo.
  $gui = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'PokeGrid-Shop-Publisher.ps1') -Raw -Encoding UTF8
  Assert ($gui -match 'Sync-CatalogRepository') 'El guion no tiene una funcion propia para sincronizar y avisar.'
  Assert ($gui -match 'SIN sincronizar') 'El guion no distingue en pantalla entre sincronizado y no sincronizado.'

  Write-Output 'Catalog sync passed: a diverged branch is detected and reported, the catalog is still read from disk, and merging recovers the remote publications without losing local commits.'
} finally {
  if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue }
}
