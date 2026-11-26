package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// 将分离后的前端资源内嵌进编译后的单文件 EXE 中
//go:embed index.html css js images
var embeddedFS embed.FS

func isAllowedStaticPath(cleanPath string) bool {
	if cleanPath == "index.html" {
		return true
	}
	for _, prefix := range []string{"css/", "js/", "images/"} {
		if strings.HasPrefix(cleanPath, prefix) {
			return true
		}
	}
	return false
}

func detectContentType(filePath string) string {
	switch strings.ToLower(path.Ext(filePath)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js":
		return "application/javascript; charset=utf-8"
	case ".svg":
		return "image/svg+xml; charset=utf-8"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".ico":
		return "image/x-icon"
	default:
		if ct := mime.TypeByExtension(path.Ext(filePath)); ct != "" {
			return ct
		}
		return "application/octet-stream"
	}
}

func handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	reqPath := r.URL.Path
	if reqPath == "" || reqPath == "/" {
		reqPath = "index.html"
	} else {
		reqPath = strings.TrimPrefix(path.Clean("/"+reqPath), "/")
	}

	if !isAllowedStaticPath(reqPath) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	data, err := embeddedFS.ReadFile(reqPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", detectContentType(reqPath))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(data)
	}
}

func openBrowser(targetURL string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", targetURL)
	case "darwin":
		cmd = exec.Command("open", targetURL)
	default:
		cmd = exec.Command("xdg-open", targetURL)
	}
	_ = cmd.Start()
}

func main() {
	host := flag.String("host", "127.0.0.1", "监听地址")
	port := flag.Int("port", 8080, "监听端口")
	noBrowser := flag.Bool("no-browser", false, "启动时不自动打开浏览器")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleStatic)

	addr := fmt.Sprintf("%s:%d", *host, *port)
	accessURL := fmt.Sprintf("http://%s", addr)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	fmt.Println("========================================================")
	fmt.Println("  豚宝宝 2FA 验证器")
	fmt.Println("========================================================")
	fmt.Printf("  访问地址 : %s\n", accessURL)
	fmt.Println("  开源项目地址:https://github.com/suorua/dolphin-2fa")
	fmt.Println("  退出方式 : 按 Ctrl+C 停止服务")
	fmt.Println("========================================================")

	if !*noBrowser {
		go func() {
			time.Sleep(500 * time.Millisecond)
			openBrowser(accessURL)
		}()
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\n正在停止服务...")
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("服务启动失败: %v", err)
	}
	fmt.Println("服务已停止。")
}
