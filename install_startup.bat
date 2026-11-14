@echo off
setlocal EnableDelayedExpansion

set "NO_PAUSE=0"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "SRC_BOOTSTRAP=%SCRIPT_DIR%\local_bootstrap.vbs"

set "LOCAL_APP_DIR=%LOCALAPPDATA%\ObsidianAutoOrganizer"
set "LOCAL_BOOTSTRAP=%LOCAL_APP_DIR%\local_bootstrap.vbs"
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ObsidianAutoOrganizer.vbs"
set "TASK_NAME=ObsidianAutoOrganizer"

echo ============================================================
echo   Obsidian Auto-Organizer V5 - Instalacao e Boot Guard
echo ============================================================
echo.

if not exist "%SCRIPT_DIR%\dist\watcher.js" (
  echo [1/5] Compilando TypeScript em "%SCRIPT_DIR%"...
  pushd "%SCRIPT_DIR%"
  call npm run build
  if errorlevel 1 (
    echo [ERRO] Falha ao compilar o projeto.
    popd
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
  )
  popd
) else (
  echo [1/5] Build encontrado em dist\watcher.js.
)

echo [2/5] Instalando bootstrapper local em "%LOCAL_APP_DIR%"...
if not exist "%LOCAL_APP_DIR%" mkdir "%LOCAL_APP_DIR%"
copy /Y "%SRC_BOOTSTRAP%" "%LOCAL_BOOTSTRAP%" >nul
if errorlevel 1 (
  echo [ERRO] Nao foi possivel copiar local_bootstrap.vbs para "%LOCAL_APP_DIR%".
  if "%NO_PAUSE%"=="0" pause
  exit /b 1
)

echo [3/5] Registrando inicializacao na pasta Startup do usuario (sem Admin)...
copy /Y "%LOCAL_BOOTSTRAP%" "%STARTUP_VBS%" >nul
if errorlevel 1 (
  echo [ERRO] Nao foi possivel copiar para a pasta Startup.
  if "%NO_PAUSE%"=="0" pause
  exit /b 1
)

net session >nul 2>&1
if %errorlevel%==0 (
  echo [4/5] Privilegio elevado detectado: atualizando tarefa "%TASK_NAME%" para "%LOCAL_BOOTSTRAP%"...
  schtasks /Create /TN "%TASK_NAME%" /TR "wscript.exe //B \"%LOCAL_BOOTSTRAP%\"" /SC ONLOGON /RL LIMITED /F >nul 2>&1
) else (
  schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
  if %errorlevel%==0 (
    echo [4/5] Tarefa legada "%TASK_NAME%" detectada. Tentando remover via elevacao UAC para evitar popup no boot...
    powershell -NoProfile -Command "Start-Process schtasks.exe -Verb RunAs -ArgumentList '/Delete','/TN','ObsidianAutoOrganizer','/F' -Wait" >nul 2>&1
  ) else (
    echo [4/5] Modo usuario padrao: Startup folder ativo ^(sem tarefa legada no Task Scheduler^).
  )
)

echo [5/5] Reiniciando daemon em background (WMI detached)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*watcher.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'wscript.exe //B \"%LOCAL_BOOTSTRAP%\"' } | Out-Null"

echo.
echo [OK] Daemon instalado e iniciado via WMI detached!
echo      Bootstrapper C:\ : "%LOCAL_BOOTSTRAP%"
echo      Startup Windows  : "%STARTUP_VBS%"
echo      Logs             : "%SCRIPT_DIR%\organizer.log"
echo.
if "%NO_PAUSE%"=="0" pause
