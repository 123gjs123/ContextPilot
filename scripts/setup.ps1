# Instalación de ContextPilot desde cero (Windows). Ejecutar desde una terminal PowerShell propia:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 [-Yes]
# Revisa requisitos, instala y compila, y ofrece (preguntando antes) los pasos que cambian la
# configuración de Claude Code: hooks, statusline y el MCP de Playwright. Idempotente: lo que ya
# está hecho se saltea. -Yes responde «sí» a todo (instalaciones desatendidas).
param([switch]$Yes)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    !   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "    X   $text" -ForegroundColor Red }
function Ask($question) {
  if ($Yes) { return $true }
  $a = Read-Host "    $question [S/n]"
  return ($a -eq '' -or $a -match '^(s|si|sí|y|yes)$')
}
function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "ContextPilot · instalación" -ForegroundColor White
Write-Host "Repositorio: $repo"

# 1. Node y npm
Step 1 'Node.js y npm'
if (-not (Has 'node') -or -not (Has 'npm')) {
  Fail 'Falta Node.js. Instalalo (versión 24 o superior) desde https://nodejs.org y volvé a ejecutar este script.'
  exit 1
}
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { Fail "Node $(node --version): hace falta la versión 24 o superior."; exit 1 }
Ok "Node $(node --version) · npm $(npm --version)"

# 2. Dependencias y build
Step 2 'Dependencias y compilación'
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Fail 'npm install falló (detrás de un proxy corporativo: ver docs/INSTALL.md, «with-ca»).'; exit 1 }
npm run build
if ($LASTEXITCODE -ne 0) { Fail 'La compilación falló.'; exit 1 }
Ok 'Instalado y compilado'

# 3. Claude Code CLI
Step 3 'Claude Code (CLI)'
if (-not (Has 'claude')) {
  Warn 'No encontré el comando «claude». El chat y los hooks lo necesitan.'
  if (Ask '¿Lo instalo con npm (npm install -g @anthropic-ai/claude-code)?') {
    npm install -g @anthropic-ai/claude-code
    if ($LASTEXITCODE -ne 0) { Fail 'No se pudo instalar Claude Code.'; exit 1 }
  }
}
if (Has 'claude') { Ok "claude $((claude --version) -join ' ')" } else { Warn 'Seguimos sin Claude Code: el monitor funciona, el chat no.' }

# 4. Login
if (Has 'claude') {
  Step 4 'Sesión de Claude Code'
  $logged = $false
  try { $logged = ((claude auth status --json | Out-String | ConvertFrom-Json).loggedIn -eq $true) } catch { $logged = $false }
  if ($logged) { Ok 'Sesión iniciada' }
  else {
    Warn 'No hay sesión iniciada: el chat usa tu cuenta de Claude.'
    if (Ask '¿Iniciar sesión ahora? (se abre el navegador)') { claude auth login }
  }
}

# 5. Hooks y statusline
Step 5 'Hooks de Claude Code (recomendado)'
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$settings = Join-Path $claudeDir 'settings.json'
$hasHooks = (Test-Path $settings) -and ((Get-Content $settings -Raw) -match 'hook\.mjs')
if ($hasHooks) { Ok 'Ya instalados' }
elseif (Ask '¿Instalo los hooks? (aceleran los avisos; se guarda backup de settings.json)') {
  node scripts/install-hooks.mjs
  if ($LASTEXITCODE -eq 0) { Ok 'Hooks instalados' } else { Warn 'No se pudieron instalar los hooks' }
}
if (-not ((Test-Path $settings) -and ((Get-Content $settings -Raw) -match 'statusline\.mjs'))) {
  if (Ask '¿Agrego la statusline de ContextPilot a Claude Code? (no pisa una existente)') { node scripts/install-hooks.mjs --statusline }
}

# 6. MCP de Playwright
if (Has 'claude') {
  Step 6 'MCP de Playwright (tareas de navegador en el chat)'
  # En PowerShell 5.1, stderr redirigido con 'Stop' aborta el script: esta consulta corre con 'Continue'.
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $pw = (claude mcp get playwright 2>&1 | Out-String)
  $ErrorActionPreference = $prev
  if ($pw -match 'Scope:') { Ok 'Ya configurado' }
  elseif (Ask '¿Agrego el MCP de Playwright a tu Claude Code (scope usuario)?') {
    claude mcp add --scope user playwright -- npx @playwright/mcp@latest
    if ($LASTEXITCODE -eq 0) { Ok 'Playwright agregado' } else { Warn 'No se pudo agregar Playwright' }
  }
}

# 7. Arrancar
Step 7 'Listo'
Write-Host '    Opcional: Claude Desktop se detecta solo si está instalado; la extensión del navegador'
Write-Host '    se carga desde apps/extension/dist (docs/INSTALL.md §3).'
Write-Host '    Para arrancar más adelante: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1'
if (Ask '¿Arranco ContextPilot ahora?') {
  & (Join-Path $PSScriptRoot 'start.ps1')
  Write-Host '    En el dashboard, la pestaña «Puesta en marcha» muestra si falta algo.'
}
