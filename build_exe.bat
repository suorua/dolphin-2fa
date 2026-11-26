@echo off
chcp 65001 >nul
setlocal

echo ====================================================
echo   正在使用 Golang 构建 豚宝宝 2FA 助手 Windows EXE...
echo ====================================================

where go >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Go 环境，请先安装 Go 1.22+：https://golang.google.cn/dl/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('go version') do echo [环境] %%i

set CGO_ENABLED=0
set GOOS=windows
set GOARCH=amd64

if not exist dist mkdir dist

echo [构建] 零外部依赖，正在直接编译单文件 Windows EXE...
go build -trimpath -ldflags="-s -w" -o dist\dolphin-2fa.exe .
if %errorlevel% neq 0 (
    echo [错误] 编译失败，请查看上方日志。
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   构建成功！输出文件：dist\dolphin-2fa.exe
echo ====================================================
pause
