package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed index.html css js images db/schema.sql
var embeddedFS embed.FS

const (
	sessionCookieName = "dolphin_2fa_session"
	sessionTTL        = 24 * time.Hour
	hashIterations    = 100000
	maxLoginAttempts  = 5
	lockoutDuration   = 15 * time.Minute
	cleanupInterval   = 30 * time.Minute
	encPrefix         = "enc:"
)

type Token struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Secret    string `json:"secret"`
	Digits    int    `json:"digits"`
	Period    int    `json:"period"`
	Algorithm string `json:"algorithm"`
	CreatedAt string `json:"createdAt"`
}

type SettingPayload struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type AuthPayload struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type ChangePasswordPayload struct {
	OldPassword string `json:"oldPassword"`
	NewPassword string `json:"newPassword"`
}

type Session struct {
	Username  string
	DEK       []byte // 32-byte AES-256 数据密钥，仅驻留内存
	ExpiresAt time.Time
}

type loginAttempt struct {
	Count       int
	LastAttempt time.Time
	LockedUntil time.Time
}

type App struct {
	db            *sql.DB
	dbPath        string
	trustProxy    bool
	mu            sync.RWMutex
	sessions      map[string]Session
	loginMu       sync.Mutex
	loginAttempts map[string]*loginAttempt
}

func getAppDir() string {
	exePath, err := os.Executable()
	if err == nil {
		if !strings.Contains(exePath, "go-build") && !strings.HasPrefix(exePath, os.TempDir()) {
			return filepath.Dir(exePath)
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func initDB(dbPath string) (*sql.DB, error) {
	absPath, err := filepath.Abs(dbPath)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, fmt.Errorf("创建数据库目录失败: %w", err)
	}

	db, err := sql.Open("sqlite", absPath)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 数据库失败: %w", err)
	}
	db.SetMaxOpenConns(1)

	schemaBytes, err := embeddedFS.ReadFile("db/schema.sql")
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("读取内嵌 schema.sql 失败: %w", err)
	}

	if _, err := db.Exec(string(schemaBytes)); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化数据表失败: %w", err)
	}

	// 兼容旧版数据库：自动补充 enc_dek 与 enc_salt 字段（已存在时忽略错误）
	_, _ = db.Exec(`ALTER TABLE users ADD COLUMN enc_dek TEXT NOT NULL DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE users ADD COLUMN enc_salt TEXT NOT NULL DEFAULT ''`)

	return db, nil
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func randomHex(nBytes int) (string, error) {
	b, err := randomBytes(nBytes)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// 纯标准库加盐迭代派生 32 字节密钥（HMAC-SHA256 10万次迭代）
func deriveKeyBytes(password, saltHex string) []byte {
	salt, _ := hex.DecodeString(saltHex)
	mac := hmac.New(sha256.New, []byte(password))
	mac.Write(salt)
	sum := mac.Sum(nil)
	for i := 1; i < hashIterations; i++ {
		mac.Reset()
		mac.Write(sum)
		mac.Write(salt)
		sum = mac.Sum(sum[:0])
	}
	out := make([]byte, len(sum))
	copy(out, sum)
	return out
}

func hashPassword(password, saltHex string) string {
	return hex.EncodeToString(deriveKeyBytes(password, saltHex))
}

func verifyPassword(password, saltHex, expectedHash string) bool {
	actual := hashPassword(password, saltHex)
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expectedHash)) == 1
}

// AES-256-GCM 加密，返回格式: enc:<nonce_hex>:<ciphertext_hex>
func encryptAESGCM(key, plaintext []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce, err := randomBytes(gcm.NonceSize())
	if err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)
	return encPrefix + hex.EncodeToString(nonce) + ":" + hex.EncodeToString(ciphertext), nil
}

// AES-256-GCM 解密
func decryptAESGCM(key []byte, encoded string) ([]byte, error) {
	if !strings.HasPrefix(encoded, encPrefix) {
		return nil, errors.New("not encrypted")
	}
	body := strings.TrimPrefix(encoded, encPrefix)
	parts := strings.SplitN(body, ":", 2)
	if len(parts) != 2 {
		return nil, errors.New("invalid ciphertext format")
	}
	nonce, err := hex.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	ciphertext, err := hex.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, nil)
}

func encryptSecret(dek []byte, plainSecret string) (string, error) {
	if len(dek) != 32 {
		return "", errors.New("数据密钥无效")
	}
	return encryptAESGCM(dek, []byte(plainSecret))
}

func decryptSecret(dek []byte, storedSecret string) (string, error) {
	if !strings.HasPrefix(storedSecret, encPrefix) {
		return storedSecret, nil
	}
	if len(dek) != 32 {
		return "", errors.New("数据密钥无效")
	}
	plain, err := decryptAESGCM(dek, storedSecret)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (a *App) isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if a.trustProxy {
		return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	}
	return false
}

func (a *App) getClientIP(r *http.Request) string {
	if a.trustProxy {
		if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
			return ip
		}
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *App) checkLoginLock(ip string) (bool, time.Duration) {
	a.loginMu.Lock()
	defer a.loginMu.Unlock()

	rec, ok := a.loginAttempts[ip]
	if !ok {
		return false, 0
	}
	if !rec.LockedUntil.IsZero() {
		if time.Now().Before(rec.LockedUntil) {
			return true, time.Until(rec.LockedUntil)
		}
		delete(a.loginAttempts, ip)
	}
	return false, 0
}

func (a *App) recordLoginFailure(ip string) (bool, int) {
	a.loginMu.Lock()
	defer a.loginMu.Unlock()

	now := time.Now()
	rec, ok := a.loginAttempts[ip]
	if !ok {
		rec = &loginAttempt{}
		a.loginAttempts[ip] = rec
	}
	rec.Count++
	rec.LastAttempt = now
	if rec.Count >= maxLoginAttempts {
		rec.LockedUntil = now.Add(lockoutDuration)
		return true, 0
	}
	return false, maxLoginAttempts - rec.Count
}

func (a *App) clearLoginFailures(ip string) {
	a.loginMu.Lock()
	defer a.loginMu.Unlock()
	delete(a.loginAttempts, ip)
}

// 后台定时清理过期的会话与陈旧的 IP 失败记录，防止长期运行内存泄漏
func (a *App) startCleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			a.mu.Lock()
			for sid, sess := range a.sessions {
				if now.After(sess.ExpiresAt) {
					delete(a.sessions, sid)
				}
			}
			a.mu.Unlock()

			a.loginMu.Lock()
			for ip, rec := range a.loginAttempts {
				if !rec.LockedUntil.IsZero() && now.After(rec.LockedUntil) {
					delete(a.loginAttempts, ip)
				} else if rec.LockedUntil.IsZero() && now.Sub(rec.LastAttempt) > lockoutDuration {
					delete(a.loginAttempts, ip)
				}
			}
			a.loginMu.Unlock()
		}
	}
}

func truncateRunes(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen])
}

func (a *App) isInitialized() (bool, error) {
	var count int
	err := a.db.QueryRow(`SELECT COUNT(1) FROM users`).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (a *App) createSession(w http.ResponseWriter, r *http.Request, username string, dek []byte) error {
	sid, err := randomHex(32)
	if err != nil {
		return err
	}
	dekCopy := make([]byte, len(dek))
	copy(dekCopy, dek)

	exp := time.Now().Add(sessionTTL)
	a.mu.Lock()
	a.sessions[sid] = Session{
		Username:  username,
		DEK:       dekCopy,
		ExpiresAt: exp,
	}
	a.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sid,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.isHTTPS(r),
		SameSite: http.SameSiteStrictMode,
		Expires:  exp,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	return nil
}

func (a *App) clearSession(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" {
		a.mu.Lock()
		delete(a.sessions, c.Value)
		a.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   a.isHTTPS(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

func (a *App) getSession(r *http.Request) (Session, bool) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil || c.Value == "" {
		return Session{}, false
	}
	a.mu.RLock()
	sess, ok := a.sessions[c.Value]
	a.mu.RUnlock()
	if !ok {
		return Session{}, false
	}
	if time.Now().After(sess.ExpiresAt) {
		a.mu.Lock()
		delete(a.sessions, c.Value)
		a.mu.Unlock()
		return Session{}, false
	}
	return sess, true
}

func (a *App) requireAuth(next func(http.ResponseWriter, *http.Request, Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := a.getSession(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "请先登录"})
			return
		}
		next(w, r, sess)
	}
}

func (a *App) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	initialized, err := a.isInitialized()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	sess, authed := a.getSession(r)
	if !initialized {
		authed = false
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"initialized":   initialized,
		"authenticated": authed,
		"username":      sess.Username,
	})
}

func (a *App) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	initialized, err := a.isInitialized()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if initialized {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "管理员账号已初始化，请直接登录"})
		return
	}

	var p AuthPayload
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的请求体"})
		return
	}
	username := truncateRunes(strings.TrimSpace(p.Username), 40)
	if len([]rune(username)) < 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "账号至少需要 2 个字符"})
		return
	}
	if len(p.Password) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "密码至少需要 6 位"})
		return
	}

	salt, err := randomHex(16)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "生成随机盐失败"})
		return
	}
	encSalt, err := randomHex(16)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "生成加密盐失败"})
		return
	}
	dek, err := randomBytes(32)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "生成数据密钥失败"})
		return
	}

	pwHash := hashPassword(p.Password, salt)
	kek := deriveKeyBytes(p.Password, encSalt)
	encDEK, err := encryptAESGCM(kek, dek)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "加密数据密钥失败"})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	_, err = a.db.Exec(
		`INSERT INTO users (id, username, password_hash, salt, enc_dek, enc_salt, created_at, updated_at)
		 VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
		username, pwHash, salt, encDEK, encSalt, now, now,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存账号失败: " + err.Error()})
		return
	}

	if err := a.createSession(w, r, username, dek); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "创建会话失败"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "username": username})
}

func (a *App) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	// 1. 先检查 IP 锁定状态，直接返回 429，不执行耗时的密码哈希校验
	ip := a.getClientIP(r)
	if locked, wait := a.checkLoginLock(ip); locked {
		mins := int(wait.Minutes()) + 1
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": fmt.Sprintf("尝试次数过多，请 %d 分钟后再试", mins),
		})
		return
	}

	var p AuthPayload
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的请求体"})
		return
	}
	username := strings.TrimSpace(p.Username)

	var dbUser, dbHash, dbSalt, dbEncDEK, dbEncSalt string
	err := a.db.QueryRow(
		`SELECT username, password_hash, salt, enc_dek, enc_salt FROM users WHERE id = 1`,
	).Scan(&dbUser, &dbHash, &dbSalt, &dbEncDEK, &dbEncSalt)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "尚未初始化账号，请先设置初始账号密码"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// 2. 校验账号密码
	if username != dbUser || !verifyPassword(p.Password, dbSalt, dbHash) {
		locked, remaining := a.recordLoginFailure(ip)
		if locked {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{
				"error": "连续输错 5 次，已锁定 15 分钟",
			})
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error": fmt.Sprintf("账号或密码错误（还可尝试 %d 次）", remaining),
		})
		return
	}

	// 3. 登录成功，清空失败记录
	a.clearLoginFailures(ip)

	// 4. 解密 DEK（若从旧版无加密库升级，则自动初始化 DEK）
	var dek []byte
	if dbEncDEK == "" || dbEncSalt == "" {
		newEncSalt, err := randomHex(16)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "初始化加密盐失败"})
			return
		}
		newDEK, err := randomBytes(32)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "初始化数据密钥失败"})
			return
		}
		kek := deriveKeyBytes(p.Password, newEncSalt)
		newEncDEK, err := encryptAESGCM(kek, newDEK)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "加密数据密钥失败"})
			return
		}
		_, _ = a.db.Exec(
			`UPDATE users SET enc_dek = ?, enc_salt = ?, updated_at = ? WHERE id = 1`,
			newEncDEK, newEncSalt, time.Now().UTC().Format(time.RFC3339),
		)
		dek = newDEK
	} else {
		kek := deriveKeyBytes(p.Password, dbEncSalt)
		dek, err = decryptAESGCM(kek, dbEncDEK)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "解密数据密钥失败"})
			return
		}
	}

	if err := a.createSession(w, r, dbUser, dek); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "创建会话失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "username": dbUser})
}

func (a *App) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	a.clearSession(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleAuthChangePassword(w http.ResponseWriter, r *http.Request, sess Session) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	var p ChangePasswordPayload
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的请求体"})
		return
	}
	if len(p.NewPassword) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "新密码至少需要 6 位"})
		return
	}

	var dbHash, dbSalt string
	err := a.db.QueryRow(`SELECT password_hash, salt FROM users WHERE id = 1`).Scan(&dbHash, &dbSalt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !verifyPassword(p.OldPassword, dbSalt, dbHash) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "当前密码不正确"})
		return
	}

	newSalt, err := randomHex(16)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "生成随机盐失败"})
		return
	}
	newEncSalt, err := randomHex(16)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "生成加密盐失败"})
		return
	}

	newHash := hashPassword(p.NewPassword, newSalt)
	newKEK := deriveKeyBytes(p.NewPassword, newEncSalt)
	newEncDEK, err := encryptAESGCM(newKEK, sess.DEK)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "重加密数据密钥失败"})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	_, err = a.db.Exec(
		`UPDATE users SET password_hash = ?, salt = ?, enc_dek = ?, enc_salt = ?, updated_at = ? WHERE id = 1`,
		newHash, newSalt, newEncDEK, newEncSalt, now,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "更新密码失败"})
		return
	}

	// 清空所有旧会话，并为当前客户端签发新会话
	a.mu.Lock()
	a.sessions = make(map[string]Session)
	a.mu.Unlock()
	_ = a.createSession(w, r, sess.Username, sess.DEK)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func normalizeToken(t Token, defaultLabel string) (Token, error) {
	t.ID = strings.TrimSpace(t.ID)
	t.Secret = strings.ToUpper(strings.TrimSpace(t.Secret))
	if t.ID == "" || t.Secret == "" {
		return t, errors.New("id 和 secret 不能为空")
	}

	t.Label = strings.TrimSpace(t.Label)
	if t.Label == "" {
		t.Label = defaultLabel
	}
	t.Label = truncateRunes(t.Label, 80)

	if t.Digits != 6 && t.Digits != 8 {
		t.Digits = 6
	}
	if t.Period < 5 || t.Period > 300 {
		t.Period = 30
	}
	switch t.Algorithm {
	case "SHA-1", "SHA-256", "SHA-512":
	default:
		t.Algorithm = "SHA-1"
	}
	if strings.TrimSpace(t.CreatedAt) == "" {
		t.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	return t, nil
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	// 不再返回服务器本地绝对路径，防止目录结构泄露
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
		"db":     "sqlite",
	})
}

func (a *App) handleTokens(w http.ResponseWriter, r *http.Request, sess Session) {
	switch r.Method {
	case http.MethodGet:
		rows, err := a.db.Query(
			`SELECT id, label, secret, digits, period, algorithm, created_at
			 FROM tokens ORDER BY created_at DESC`,
		)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer rows.Close()

		tokens := make([]Token, 0)
		for rows.Next() {
			var t Token
			var storedSecret string
			if err := rows.Scan(&t.ID, &t.Label, &storedSecret, &t.Digits, &t.Period, &t.Algorithm, &t.CreatedAt); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			plainSecret, err := decryptSecret(sess.DEK, storedSecret)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "解密密钥失败: " + err.Error()})
				return
			}
			t.Secret = plainSecret
			tokens = append(tokens, t)
		}
		writeJSON(w, http.StatusOK, tokens)

	case http.MethodPost:
		var raw Token
		if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&raw); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的 JSON 请求体"})
			return
		}
		token, err := normalizeToken(raw, "未命名")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		encSecret, err := encryptSecret(sess.DEK, token.Secret)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "加密密钥失败"})
			return
		}

		_, err = a.db.Exec(
			`INSERT OR REPLACE INTO tokens (id, label, secret, digits, period, algorithm, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			token.ID, token.Label, encSecret, token.Digits, token.Period, token.Algorithm, token.CreatedAt,
		)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, token)

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

func (a *App) handleTokensBatch(w http.ResponseWriter, r *http.Request, sess Session) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	var items []Token
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&items); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "需要传入 JSON 数组"})
		return
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(
		`INSERT OR REPLACE INTO tokens (id, label, secret, digits, period, algorithm, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer stmt.Close()

	added := 0
	for _, raw := range items {
		token, err := normalizeToken(raw, "恢复的小贝壳")
		if err != nil {
			continue
		}
		encSecret, err := encryptSecret(sess.DEK, token.Secret)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "加密密钥失败"})
			return
		}
		if _, err := stmt.Exec(
			token.ID, token.Label, encSecret, token.Digits, token.Period, token.Algorithm, token.CreatedAt,
		); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		added++
	}

	if err := tx.Commit(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int{"added": added})
}

func (a *App) handleTokenByID(w http.ResponseWriter, r *http.Request, _ Session) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}

	rawID := strings.TrimPrefix(r.URL.Path, "/api/tokens/")
	tokenID, err := url.PathUnescape(strings.TrimSpace(rawID))
	if err != nil || tokenID == "" || strings.Contains(tokenID, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的 token id"})
		return
	}

	res, err := a.db.Exec(`DELETE FROM tokens WHERE id = ?`, tokenID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	affected, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted": affected > 0,
		"id":      tokenID,
	})
}

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request, _ Session) {
	switch r.Method {
	case http.MethodGet:
		rows, err := a.db.Query(`SELECT key, value FROM settings`)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer rows.Close()

		result := make(map[string]string)
		for rows.Next() {
			var k, v string
			if err := rows.Scan(&k, &v); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			result[k] = v
		}
		writeJSON(w, http.StatusOK, result)

	case http.MethodPost:
		var payload SettingPayload
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的 JSON 请求体"})
			return
		}
		key := truncateRunes(strings.TrimSpace(payload.Key), 64)
		val := truncateRunes(payload.Value, 256)
		if key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key 不能为空"})
			return
		}
		if _, err := a.db.Exec(
			`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
			key, val,
		); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"key": key, "value": val})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

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
	defaultDB := filepath.Join(getAppDir(), "data", "dolphin_2fa.db")

	host := flag.String("host", "127.0.0.1", "监听地址")
	port := flag.Int("port", 8080, "监听端口")
	dbPathFlag := flag.String("db", defaultDB, "SQLite 数据库文件路径")
	noBrowser := flag.Bool("no-browser", false, "启动时不自动打开浏览器")
	trustProxy := flag.Bool("trust-proxy", false, "信任 Nginx/Caddy 反向代理传递的 X-Real-IP 与 X-Forwarded-Proto 请求头")
	flag.Parse()

	absDBPath, err := filepath.Abs(*dbPathFlag)
	if err != nil {
		log.Fatalf("解析数据库路径失败: %v", err)
	}

	db, err := initDB(absDBPath)
	if err != nil {
		log.Fatalf("数据库初始化失败: %v", err)
	}
	defer db.Close()

	app := &App{
		db:            db,
		dbPath:        absDBPath,
		trustProxy:    *trustProxy,
		sessions:      make(map[string]Session),
		loginAttempts: make(map[string]*loginAttempt),
	}

	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()
	go app.startCleanupLoop(bgCtx)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", app.handleHealth)
	mux.HandleFunc("/api/auth/status", app.handleAuthStatus)
	mux.HandleFunc("/api/auth/setup", app.handleAuthSetup)
	mux.HandleFunc("/api/auth/login", app.handleAuthLogin)
	mux.HandleFunc("/api/auth/logout", app.handleAuthLogout)
	mux.HandleFunc("/api/auth/change-password", app.requireAuth(app.handleAuthChangePassword))
	mux.HandleFunc("/api/tokens", app.requireAuth(app.handleTokens))
	mux.HandleFunc("/api/tokens/batch", app.requireAuth(app.handleTokensBatch))
	mux.HandleFunc("/api/tokens/", app.requireAuth(app.handleTokenByID))
	mux.HandleFunc("/api/settings", app.requireAuth(app.handleSettings))
	mux.HandleFunc("/", handleStatic)

	addr := fmt.Sprintf("%s:%d", *host, *port)
	displayHost := *host
	if displayHost == "0.0.0.0" || displayHost == "" {
		displayHost = "127.0.0.1"
	}
	accessURL := fmt.Sprintf("http://%s:%d", displayHost, *port)

	srv := &http.Server{
		Addr:              addr,
		Handler:           withSecurityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	fmt.Println("========================================================")
	fmt.Println("  豚宝宝 2FA 助手 (版本 v2.0)")
	fmt.Println("========================================================")
	fmt.Println("  开源项目地址：https://github.com/suorua/dolphin-2fa.git")
	fmt.Printf("  访问地址 : %s\n", accessURL)
	fmt.Printf("  数据文件 : %s\n", absDBPath)
	fmt.Printf("  信任代理 : %v\n", *trustProxy)
	fmt.Println("  安全策略 : IP防爆破(5次锁15分) | AES-256-GCM | Strict Cookie")
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
		bgCancel()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("服务启动失败: %v", err)
	}
	fmt.Println("服务已停止。")
}
