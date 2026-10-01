# Levanta ContextPilot: daemon (127.0.0.1:47800) y monitor (tray + dashboard), cada uno en su ventana.
# Si ya hay un daemon o un monitor corriendo, los cierra antes (evita el choque de puerto 47800).
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1 [-NoMonitor]
param([switch]$NoMonitor)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# 1. Cerrar instancias previas.
$conn = Get-NetTCPConnection -LocalPort 47800 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Host "Cerrando daemon anterior (pid $($conn.OwningProcess))"
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
}
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$repo*" } | Stop-Process -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 20 -and (Get-NetTCPConnection -LocalPort 47800 -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 300 }

# 2. Daemon en su propia ventana (sobrevive al cierre de quien lo lanzó).
$daemonCmd = "`$Host.UI.RawUI.WindowTitle='ContextPilot daemon'; Set-Location '$repo'; node scripts/with-ca.mjs npm run start -w '@contextpilot/daemon'"
Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $daemonCmd -WindowStyle Minimized
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  if (Get-NetTCPConnection -LocalPort 47800 -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $up) { Write-Host 'El daemon no respondió en 20 s: revisá la ventana «ContextPilot daemon».'; exit 1 }
Write-Host 'Daemon escuchando en 127.0.0.1:47800'

# 3. Monitor.
if (-not $NoMonitor) {
  $monCmd = "`$Host.UI.RawUI.WindowTitle='ContextPilot monitor'; Set-Location '$repo'; npm run start -w '@contextpilot/desktop' -- --dashboard"
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $monCmd -WindowStyle Minimized
  Write-Host 'Monitor iniciado (dashboard + tray)'
}
