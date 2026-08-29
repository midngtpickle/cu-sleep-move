@echo off
title CU SLEEP - Demo Simulation Mode
cd /d "%~dp0bridge"

where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set PYTHON_CMD=python
    goto RUN
)

where py >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set PYTHON_CMD=py
    goto RUN
)

echo [ERROR] Python was not found on your system.
echo Please install Python 3.9+ from https://www.python.org/downloads/
echo and make sure to tick "Add Python to PATH" during installation.
echo.
pause
exit /b 1

:RUN
echo ===================================================
echo     CU SLEEP - Demo Simulation Mode
echo ===================================================
echo.
echo Starting simulated vitals at 1 Hz...
echo Opening browser dashboard at http://localhost:8080
echo.
echo Press Ctrl+C in this window when done.
echo ===================================================
echo.

%PYTHON_CMD% bridge.py --simulate --open %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo [INFO] Simulation stopped.
    pause
)
