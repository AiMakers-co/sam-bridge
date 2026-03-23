@echo off
title Sam Bridge - Token Sync
echo.
echo  ============================
echo   Sam Bridge - Token Sync
echo  ============================
echo.

:: Config
set SERVER=https://sam.srv1471466.hstgr.cloud
set /p BRIDGE_TOKEN="Enter your Bridge Token: "

:: Find Claude credentials
set CRED_FILE=
if exist "%APPDATA%\Claude Code\credentials.json" set CRED_FILE=%APPDATA%\Claude Code\credentials.json
if exist "%APPDATA%\claude\credentials.json" set CRED_FILE=%APPDATA%\claude\credentials.json
if exist "%USERPROFILE%\.claude\credentials.json" set CRED_FILE=%USERPROFILE%\.claude\credentials.json
if exist "%LOCALAPPDATA%\AnthropicClaude\credentials.json" set CRED_FILE=%LOCALAPPDATA%\AnthropicClaude\credentials.json

if "%CRED_FILE%"=="" (
    echo.
    echo  ERROR: No Claude credentials found.
    echo  Install Claude Code and run: claude auth login
    echo.
    pause
    exit /b 1
)

echo  Found credentials: %CRED_FILE%
echo.

:: Extract token using PowerShell (available on all modern Windows)
for /f "delims=" %%T in ('powershell -NoProfile -Command "$j = Get-Content '%CRED_FILE%' | ConvertFrom-Json; if ($j.claudeAiOauth) { $j.claudeAiOauth.accessToken } else { $j.accessToken }"') do set ACCESS_TOKEN=%%T

for /f "delims=" %%R in ('powershell -NoProfile -Command "$j = Get-Content '%CRED_FILE%' | ConvertFrom-Json; if ($j.claudeAiOauth) { $j.claudeAiOauth.refreshToken } else { $j.refreshToken }"') do set REFRESH_TOKEN=%%R

for /f "delims=" %%E in ('powershell -NoProfile -Command "$j = Get-Content '%CRED_FILE%' | ConvertFrom-Json; if ($j.claudeAiOauth) { $j.claudeAiOauth.expiresAt } else { $j.expiresAt }"') do set EXPIRES_AT=%%E

if "%ACCESS_TOKEN%"=="" (
    echo  ERROR: Could not read token from credentials file.
    pause
    exit /b 1
)

echo  Token: %ACCESS_TOKEN:~0,25%...
echo  Expires: %EXPIRES_AT%
echo.
echo  Syncing to server...

:: Push to server
powershell -NoProfile -Command ^
  "$body = @{ accessToken='%ACCESS_TOKEN%'; refreshToken='%REFRESH_TOKEN%'; expiresAt=%EXPIRES_AT% } | ConvertTo-Json; ^
   $headers = @{ 'Authorization'='Bearer %BRIDGE_TOKEN%'; 'Content-Type'='application/json' }; ^
   try { ^
     $r = Invoke-RestMethod -Uri '%SERVER%/api/bridge/claude-token' -Method POST -Body $body -Headers $headers; ^
     Write-Host ''; ^
     Write-Host '  SUCCESS! Token synced to server.' -ForegroundColor Green; ^
     Write-Host '  Sam is now connected.' -ForegroundColor Green; ^
   } catch { ^
     Write-Host ''; ^
     Write-Host '  FAILED:' $_.Exception.Message -ForegroundColor Red; ^
   }"

echo.
pause
