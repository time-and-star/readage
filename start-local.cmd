@echo off
cd /d "%~dp0"
call npm run start:local
if errorlevel 1 pause
