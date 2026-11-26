# 豚宝宝 2FA 助手 

## 核心特性
1. **零外部依赖，离线秒编译**：后端仅依赖 Go 标准库 + `go:embed`，无需联网下载第三方包，编译体积更小、启动更快。
2. **纯内存实时计算**：不读写任何数据库文件，也不写入浏览器 `IndexedDB` 或 `localStorage`，关闭即清空。
3. **前后端源码分离**：开发时 `index.html`、`css/`、`js/`、`images/` 保持独立，编译时自动打包进单个 `dolphin-2fa.exe`。

## 构建 Windows EXE
双击运行 **`build_exe.bat`**，或在目录打开命令行执行：

1. Windows CMD（推荐）

   ```cmd
   set CGO_ENABLED=0&& set GOOS=linux&& set GOARCH=amd64&& go build -trimpath -ldflags="-s -w" -o dist\dolphin-2fa-linux-amd64 .
   ```

2. Windows PowerShell

```PowerShell
$env:CGO_ENABLED="0"; $env:GOOS="linux"; $env:GOARCH="amd64"; go build -trimpath -ldflags="-s -w" -o dist/dolphin-2fa-linux-amd64 .
```

3. Linux / macOS

4. ```bash
   CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/dolphin-2fa-linux-amd64 .
   ```

## 命令行启动示例

```bash
# 默认启动（监听 127.0.0.1:8080，自动打开浏览器）
dolphin-2fa.exe

# 自定义端口
dolphin-2fa.exe -port 9000

# 启动时不自动打开浏览器
dolphin-2fa.exe -no-browser

# 监听所有网卡（允许外网/局域网访问）且不尝试打开浏览器
./dolphin-2fa-linux-amd64 -host 0.0.0.0 -port 8080 -no-browser
```

## 常见问题

**验证码显示错误**

Windows 上正常：你是通过本机 `[http://127.0.0.1:8080](http://127.0.0.1:8080)` 访问的，属于安全上下文。

Linux 上显示 `ERR`：你是通过 `http://服务器IP:8080` 访问的，非 HTTPS 的远程 IP 会被浏览器禁用 `window.crypto.subtle`，导致 `generateTOTP` 抛出异常并显示 `ERR`。   

由于`js/totp.js` 中使用了浏览器原生的 `window.crypto.subtle`（Web Crypto API）来计算 TOTP 验证码。现代浏览器规定，该接口**仅在 `https://` 或本机 `[http://127.0.0.1](http://127.0.0.1)` / `http://localhost` 下可用**。   

**解决办法**

给 Linux 站点加上 HTTPS，在 Linux 服务器上使用 **Nginx** 或 **Caddy** 做反向代理，将 `https://你的域名` 转发到本地的 `[http://127.0.0.1:8080](http://127.0.0.1:8080)`。

