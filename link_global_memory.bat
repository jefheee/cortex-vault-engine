@echo off
setlocal EnableDelayedExpansion

set "NO_PAUSE=0"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"

set "SOURCE_GEMINI=G:\Meu Drive\Obsidian\GEMINI.md"
set "TARGET_DIR=%USERPROFILE%\.gemini"
set "TARGET_GEMINI=%TARGET_DIR%\GEMINI.md"

echo ============================================================
echo   Ponte Global de Memoria - Segundo Cerebro Obsidian
echo ============================================================
echo.

if not exist "%SOURCE_GEMINI%" (
  echo [ERRO] Arquivo origem nao encontrado: "%SOURCE_GEMINI%"
  if "%NO_PAUSE%"=="0" pause
  exit /b 1
)

if not exist "%TARGET_DIR%" (
  mkdir "%TARGET_DIR%"
)

if exist "%TARGET_GEMINI%" (
  set "BACKUP_FILE=%TARGET_DIR%\GEMINI.md.bak"
  copy /Y "%TARGET_GEMINI%" "!BACKUP_FILE!" >nul
  echo [INFO] Backup criado em: "!BACKUP_FILE!"
)

> "%TARGET_GEMINI%" (
  echo # Global Second Brain Pointer ^(Lazy Loading^)
  echo.
  echo ^> Leia sob demanda o mapa compacto do Segundo Cerebro antes de planejar ou codar:
  echo @G:\Meu Drive\Obsidian\GEMINI.md
  echo.
  echo ## Regras Rapidas
  echo - Consulte sob demanda apenas as notas aplicaveis em `G:\Meu Drive\Obsidian\04_Padroes_e_Prompts\`.
  echo - Ao salvar aprendizados ou decisoes de projeto, grave diretamente na nota correspondente em `G:\Meu Drive\Obsidian\02_Projetos_e_Negocios\`.
)

echo [OK] Ponte global criada em: "%TARGET_GEMINI%"
echo      Apontando para: "%SOURCE_GEMINI%"
echo.
if "%NO_PAUSE%"=="0" pause
