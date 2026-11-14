@echo off
setlocal

set "NO_PAUSE=0"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"

set "LOCAL_APP_DIR=%LOCALAPPDATA%\ObsidianAutoOrganizer"
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ObsidianAutoOrganizer.vbs"
set "TASK_NAME=ObsidianAutoOrganizer"

echo Encerrando daemon em execucao e removendo inicializacao automatica...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*watcher.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

if exist "%STARTUP_VBS%" (
  del /F /Q "%STARTUP_VBS%"
  echo [OK] Removido Startup: "%STARTUP_VBS%"
)
if exist "%LOCAL_APP_DIR%" (
  rmdir /S /Q "%LOCAL_APP_DIR%"
  echo [OK] Removido diretorio local: "%LOCAL_APP_DIR%"
)

schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
if not %errorlevel%==0 (
  schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
  if %errorlevel%==0 (
    echo Solicitando UAC para remover tarefa "%TASK_NAME%"...
    powershell -NoProfile -Command "Start-Process schtasks.exe -Verb RunAs -ArgumentList '/Delete','/TN','ObsidianAutoOrganizer','/F' -Wait" >nul 2>&1
  )
)
echo [OK] Desinstalacao concluida.
if "%NO_PAUSE%"=="0" pause
