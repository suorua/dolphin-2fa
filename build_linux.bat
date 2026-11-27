@echo off
setlocal

set GOPROXY=https://goproxy.cn,direct
set CGO_ENABLED=0
set GOOS=linux
set GOARCH=amd64

go mod tidy
if %errorlevel% neq 0 (
    echo [ERROR] go mod tidy failed
    pause
    exit /b 1
)

if not exist dist mkdir dist
go build -trimpath -ldflags="-s -w" -o dist\dolphin-2fa .
if %errorlevel% neq 0 (
    echo [ERROR] go build failed
    pause
    exit /b 1
)

echo [OK] Build success: dist\dolphin-2fa
pause
