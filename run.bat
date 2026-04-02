@echo off
cd /d "%~dp0"
echo === ReplayKit Manager Server ===
echo Backend: port 9000
echo Frontend dev: port 9001
echo.

if not exist "venv" (
    echo [1/3] Creating venv...
    python -m venv venv
)

call venv\Scripts\activate.bat

echo [2/3] Installing Python dependencies...
pip install -r backend\requirements.txt -q

echo [3/3] Starting server...
python -m uvicorn backend.main:app --host 0.0.0.0 --port 9000 --reload
