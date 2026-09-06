@echo off
E:/OpenHarness/node_modules/7zip-bin/win/x64/7za.exe %*
if %errorlevel%==2 exit /b 0
if %errorlevel%==1 exit /b 0
exit /b 0
