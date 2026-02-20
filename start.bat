@echo off
title MIDI Assistant

echo Starting Backend...
start "Backend" cmd /k "cd /d %~dp0 && python run.py"

echo Starting Frontend...
start "Frontend" cmd /k "cd /d %~dp0 && npm run dev"

timeout /t 3 >nul
start http://localhost:5173

echo.
echo MIDI Assistant is running!
echo - Frontend: http://localhost:5173
echo - Backend:  http://localhost:8000
echo.
pause