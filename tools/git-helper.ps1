function Resolve-PokeGridGitPath {
  $command = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command git -CommandType Application -ErrorAction SilentlyContinue }
  if (-not $command -or -not (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
    throw 'Instala Git antes de abrir PokeGrid Shop Publisher.'
  }
  return $command.Source
}

function Invoke-PokeGridGit {
  param(
    [Parameter(Mandatory=$true)][string]$RepositoryRoot,
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [switch]$AllowFailure
  )

  $resolvedRoot = [IO.Path]::GetFullPath($RepositoryRoot)
  if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "No existe el directorio del repositorio: $resolvedRoot"
  }
  $gitExecutable = Resolve-PokeGridGitPath
  $previousTerminalPrompt = $env:GIT_TERMINAL_PROMPT
  $previousCredentialInteractive = $env:GCM_INTERACTIVE
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Impide que Git abra una solicitud oculta detrás de la ventana gráfica.
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    # Git escribe progreso normal (pull/push) por stderr. PowerShell 5 lo convierte
    # en NativeCommandError cuando la aplicación usa Stop como preferencia global.
    $ErrorActionPreference = 'Continue'
    $lines = & $gitExecutable -C $resolvedRoot @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $env:GIT_TERMINAL_PROMPT = $previousTerminalPrompt
    $env:GCM_INTERACTIVE = $previousCredentialInteractive
  }
  $output = ($lines | Out-String).Trim()
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    if (-not $output) { $output = "Git terminó con el código $exitCode." }
    throw $output
  }
  return [pscustomobject]@{ ExitCode=$exitCode; Output=$output; Executable=$gitExecutable }
}

# Que rutas lleva el `git commit` de la publicacion.
#
# MEDIDO, y este es el fallo que dejo al publicador SIN poder publicar y SIN poder
# retirar nada:
#
#   git add    -- catalog.json scripts/x.user.js screenshots   ->  sale 0
#   git commit -- catalog.json scripts/x.user.js screenshots   ->  sale 1
#       error: pathspec 'screenshots' did not match any file(s) known to git
#
# Los dos con el mismo pathspec y el mismo repositorio. La diferencia es que `add`
# ignora en silencio un directorio que no contiene nada, y `commit -- <rutas>` NO:
# exige que cada ruta sea una ruta que git conoce, y una carpeta vacia no lo es
# porque git no guarda directorios. Solo lo guardaria si tuviera un archivo dentro.
#
# Por eso crear la carpeta antes del `add` no bastaba, aunque asi lo decia el
# comentario de la GUI: tapaba el error del `add` y dejaba vivo el del `commit`, que
# va un paso despues. El efecto era que la publicacion se preparaba entera y moria
# en el ultimo momento, con el indice sucio. En la retirada es peor:
# `remove-script.ps1` ya habia borrado el archivo y la entrada del catalogo, asi que
# reintentar falla con «el script ya no existe en el catalogo» y el boton no puede
# hacer nada.
#
# La regla que se quiere es la del comentario de la GUI: la carpeta va en el commit
# para que las capturas no se queden fuera. Solo hay que cumplirla CUANDO HAY
# CAPTURAS, y quitar `screenshots` cuando no hay ninguna no pierde nada, porque un
# conjunto vacio no se puede dejar atras.
#
# Se consulta el INDICE con `ls-files`, no el disco, y el orden importa: se llama
# DESPUES del `add`. Lo que decide es exactamente lo que el commit va a llevar.
# Consultar el disco mentiria justo en el caso que importa, que es una captura que
# el publicador acaba de copiar y que todavia no esta preparada.
#
# Si `ls-files` falla, no se anade la carpeta: el commit sin ella sale, y el commit
# con ella no. Fallar hacia el lado que funciona.
function Get-PokeGridCommitPathspec {
  param(
    [Parameter(Mandatory=$true)][string]$RepositoryRoot,
    [Parameter(Mandatory=$true)][string[]]$Paths
  )
  $especificacion = @($Paths)
  $preparadas = Invoke-PokeGridGit -RepositoryRoot $RepositoryRoot -Arguments @('ls-files','--','screenshots') -AllowFailure
  if ($preparadas.ExitCode -eq 0 -and $preparadas.Output.Trim()) {
    $especificacion += 'screenshots'
  }
  return $especificacion
}
