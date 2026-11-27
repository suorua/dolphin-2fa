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

set GOPROXY=https://goproxy.cn,direct
set CGO_ENABLED=0
set GOOS=windows
set GOARCH=amd64

if not exist dist mkdir dist

echo [1/2] 正在检查依赖...
go mod tidy
if %errorlevel% neq 0 (
    echo [错误] 依赖下载失败，请检查网络。
    pause
    exit /b 1
)

echo [2/2] 正在编译单文件 Windows EXE...
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
