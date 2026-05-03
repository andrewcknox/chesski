@echo off
title Chesski
cd /d "%~dp0"
echo Starting Chesski...
echo (close this window to stop the server)
echo.
call npm exec vite -- --open
echo.
echo Server stopped. Press any key to close.
pause >nul
