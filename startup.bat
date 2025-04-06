@echo off
REM Change directory to the location of this batch file
cd /d %~dp0
REM Start the app using PM2 with the ecosystem config file
pm2 start ecosystem.config.cjs
pause
