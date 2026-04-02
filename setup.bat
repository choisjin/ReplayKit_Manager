@echo off
echo ============================================
echo   ReplayKit Manager - Setup
echo ============================================
echo.

cd /d "%~dp0"

:: Detect production mode
set "PRODUCTION=0"
if exist "frontend\dist\index.html" (
    if not exist "frontend\package.json" set "PRODUCTION=1"
)

:: -------------------------------------------------------
:: [1/4] Python setup
:: -------------------------------------------------------
echo [1/4] Setting up Python...

:: --- Mode A: Embedded Python (zip in current dir) ---
if exist "python\python.exe" goto :python_ready

set "EMBED_ZIP="
for %%f in (python-*-embed-amd64.zip) do set "EMBED_ZIP=%%f"
if not defined EMBED_ZIP goto :try_system_python

echo       Extracting embedded Python: %EMBED_ZIP%
mkdir python 2>nul
tar -xf "%EMBED_ZIP%" -C python
:: Enable import site (required for pip)
for %%f in (python\python*._pth) do (
    findstr /v "^#import site" "%%f" > "%%f.tmp"
    echo import site>> "%%f.tmp"
    move /y "%%f.tmp" "%%f" >nul
)
echo       Embedded Python extracted
goto :python_ready

:: --- Mode B: System Python fallback (dev mode) ---
:try_system_python
:: Refresh PATH from registry
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%b"
if defined SYS_PATH set "PATH=%SYS_PATH%"
if defined USR_PATH set "PATH=%PATH%;%USR_PATH%"

set "PYTHON="
python --version >nul 2>&1
if %ERRORLEVEL% equ 0 set "PYTHON=python"
if defined PYTHON goto :system_python_ok

echo       [ERROR] Python not found.
echo       Place python-*-embed-amd64.zip in this folder, or install Python.
pause
exit /b 1

:system_python_ok
for /f "tokens=*" %%v in ('%PYTHON% --version 2^>nul') do echo       System %PYTHON%: %%v
echo [2/4] Creating venv...
if not exist "venv" (
    %PYTHON% -m venv venv
    if not exist "venv\Scripts\python.exe" (
        echo       [ERROR] venv creation failed
        pause
        exit /b 1
    )
    echo       venv created
) else (
    echo       venv already exists - skipped
)
set "PY=venv\Scripts\python.exe"
set "PIP=venv\Scripts\pip.exe"
goto :install_packages

:: --- Embedded Python ready ---
:python_ready
set "PY=python\python.exe"
echo       Embedded Python ready

:: Install pip if not present
echo [2/4] Checking pip...
%PY% -m pip --version >nul 2>&1
if %ERRORLEVEL% equ 0 goto :pip_ok
if not exist "get-pip.py" goto :pip_ok
echo       Installing pip...
%PY% get-pip.py --no-warn-script-location -q
:pip_ok
set "PIP=%PY% -m pip"
echo       pip ready

:: -------------------------------------------------------
:: [3/4] Install packages
:: -------------------------------------------------------
:install_packages
echo [3/4] Installing Python packages...
if exist "python\python.exe" (
    :: Embedded Python with pre-installed packages
    %PY% -m pip --version >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        %PIP% install -r backend\requirements.txt -q --no-warn-script-location
    ) else (
        echo       Embedded Python — pip not available, assuming packages pre-installed
    )
) else (
    %PY% -m pip install --upgrade pip -q --no-warn-script-location 2>nul
    %PIP% install -r backend\requirements.txt -q --no-warn-script-location
)

:: -------------------------------------------------------
:: [4/4] Node.js (dev mode only)
:: -------------------------------------------------------
if "%PRODUCTION%"=="1" (
    echo [4/4] Production mode - skipping Node.js
    goto :skip_npm
)

echo [4/4] Checking Node.js...
where npm.cmd >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo       [Warning] Node.js not found - frontend dev mode unavailable.
    echo       Install Node.js LTS from https://nodejs.org
    goto :skip_npm
)

for /f "tokens=*" %%v in ('node --version 2^>nul') do echo       Node.js %%v detected
if exist "frontend\package.json" (
    echo       Installing frontend packages...
    cd frontend
    call npm install
    cd ..
    echo       npm install done
) else (
    echo       [Warning] frontend/package.json not found - skipped
)

:skip_npm

echo.
echo ============================================
echo   Setup complete!
if "%PRODUCTION%"=="1" (
    echo   Run run.bat to start.
) else (
    echo   Run run.bat to start server.
)
echo ============================================
pause
