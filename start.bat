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
    goto PROMPT
)

where py >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set PYTHON_CMD=py
    goto PROMPT
)

echo [ERROR] Python was not found on your system.
echo Please install Python 3.9+ from https://www.python.org/downloads/
echo and make sure to tick "Add Python to PATH" during installation.
echo.
pause
exit /b 1

:PROMPT
if "%1" neq "" (
    %PYTHON_CMD% bridge.py --open %*
    goto END
)

echo Select Mode:
echo   [1] Live ESP32 Monitor  (Default - press Enter)
echo   [2] Demo / Simulation   (Fake vitals, no hardware needed)
echo.
set /p MODE="Choose [1 or 2, default is 1]: "

if "%MODE%"=="2" (
    echo.
    echo Starting CU SLEEP in DEMO SIMULATION Mode...
    %PYTHON_CMD% bridge.py --simulate --open
    goto END
)

echo.
echo Starting CU SLEEP in LIVE MONITOR Mode...
%PYTHON_CMD% bridge.py --open

:END
if %ERRORLEVEL% neq 0 (
    echo.
    echo [INFO] Bridge stopped or exited.
    pause
)
