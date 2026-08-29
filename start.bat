@echo off
title CU SLEEP - WiFi Sleep Monitor
cd /d "%~dp0bridge"

echo ===================================================
echo     CU SLEEP - WiFi Sleep Monitor
echo ===================================================
echo.

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
echo Starting CU SLEEP bridge...
echo Opening browser dashboard at http://localhost:8080
echo.
echo Press Ctrl+C in this window in the morning to finish recording.
echo ===================================================
echo.

%PYTHON_CMD% bridge.py --open %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo [INFO] Bridge stopped or exited.
    pause
)
