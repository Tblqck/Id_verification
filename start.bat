@echo off
setlocal
title KYC Verify
cd /d "%~dp0"

echo.
echo  KYC Verify Launcher
echo  --------------------------
echo.

set "BROWSER_PROTO=http"
set "SERVER_FLAGS="

rem Optional opt-in to https for reverse-proxy setups (server itself is HTTP only)
if /I "%~1"=="--https" set "BROWSER_PROTO=https"
if /I "%~1"=="https"  set "BROWSER_PROTO=https"

if defined FORCE_HTTPS (
    for %%A in (1 true yes on) do (
        if /I "%FORCE_HTTPS%"=="%%~A" set "BROWSER_PROTO=https"
    )
)

call :find_python || goto :end

echo  Checking dependencies...
%PY% -m pip install cryptography --quiet --disable-pip-version-check 2>nul
echo  Done.
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul & start %BROWSER_PROTO%://localhost:5000/index.html"

call :run_server
goto :end

:find_python
set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY (
    where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
    echo  ERROR: Python not found.
    echo  Install it from https://python.org and check "Add to PATH".
    exit /b 1
)
exit /b 0

:run_server
%PY% server.py
exit /b 0

:end
echo.
pause
endlocal
