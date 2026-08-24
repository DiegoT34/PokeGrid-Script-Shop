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
