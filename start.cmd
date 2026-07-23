@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js hittades inte. Installera det fran https://nodejs.org och forsok igen.
  pause
  exit /b 1
)

node dev.js
if errorlevel 1 pause
