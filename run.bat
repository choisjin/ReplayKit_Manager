@echo off
cd /d "%~dp0"

echo === ReplayKit Manager Server ===

:: -------------------------------------------------------
:: Auto-update (git pull)
:: -------------------------------------------------------
if exist ".git" (
    where git.exe >nul 2>nul
    if not errorlevel 1 (
        echo [UPDATE] Fetching latest...
        git remote get-url deploy >nul 2>nul
        if not errorlevel 1 (
            git fetch deploy main
            git reset --hard deploy/main
        ) else (
            git fetch origin main
            git reset --hard origin/main
        )
        echo [UPDATE] Done.
    )
)

:: -------------------------------------------------------
:: Python detection (embedded first, then venv)
:: -------------------------------------------------------
set "PY="
if exist "python\python.exe" set "PY=python\python.exe"
if not defined PY if exist "venv\Scripts\python.exe" set "PY=venv\Scripts\python.exe"

if not defined PY (
    echo [ERROR] Python not found. Run setup.bat first.
    pause
    exit /b 1
)

echo Python: %PY%

:: -------------------------------------------------------
:: Detect production mode
:: -------------------------------------------------------
set "PRODUCTION=0"
if exist "frontend\dist\index.html" (
    if not exist "frontend\package.json" set "PRODUCTION=1"
)

if "%PRODUCTION%"=="1" (
    echo Mode: Production (port 9000)
    echo.
    %PY% -m uvicorn backend.main:app --host 0.0.0.0 --port 9000
) else (
    echo Mode: Development
    echo   Backend:  port 9000
    echo   Frontend: port 9001 (run separately: cd frontend ^&^& npm run dev)
    echo.
    %PY% -m uvicorn backend.main:app --host 0.0.0.0 --port 9000 --reload
)

pause
