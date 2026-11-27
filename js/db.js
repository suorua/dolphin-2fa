/**
 * 纯 SQLite 数据库与登录鉴权访问层（对接 Go 后端 API）
 */
const TokenDB = (() => {
    let connected = false;
    let unauthorizedHandler = null;

    function setUnauthorizedHandler(fn) {
        unauthorizedHandler = typeof fn === 'function' ? fn : null;
    }

    async function requestJson(url, options = {}) {
        const res = await fetch(url, {
            cache: 'no-store',
            credentials: 'same-origin',
            ...options
        });
        let data = null;
        try {
            data = await res.json();
        } catch (e) {
            data = null;
        }
        if (!res.ok) {
            if (res.status === 401 && url !== '/api/auth/login' && unauthorizedHandler) {
                unauthorizedHandler();
            }
            const err = new Error((data && data.error) || `请求失败 (${res.status})`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    async function init() {
        if (!['http:', 'https:'].includes(window.location.protocol)) {
            connected = false;
            return { connected: false };
        }
        try {
            const data = await requestJson('/api/health');
            if (data && data.status === 'ok' && data.db === 'sqlite') {
                connected = true;
                return { connected: true };
            }
        } catch (err) {
            connected = false;
        }
        return { connected: false };
    }

    function ensureConnected() {
        if (!connected) {
            throw new Error('未连接到 SQLite 数据库服务，请通过命令行启动 dolphin-2fa.exe 后访问');
        }
    }

    async function getAuthStatus() {
        ensureConnected();
        return await requestJson('/api/auth/status');
    }

    async function setupAccount(username, password) {
        ensureConnected();
        return await requestJson('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
    }

    async function login(username, password) {
        ensureConnected();
        return await requestJson('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
    }

    async function logout() {
        if (!connected) return;
        await requestJson('/api/auth/logout', { method: 'POST' });
    }

    async function changePassword(oldPassword, newPassword) {
        ensureConnected();
        return await requestJson('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
    }

    async function getAll() {
        ensureConnected();
        return await requestJson('/api/tokens');
    }

    async function add(token) {
        ensureConnected();
        return await requestJson('/api/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(token)
        });
    }

    async function addBatch(tokens) {
        ensureConnected();
        if (!Array.isArray(tokens) || tokens.length === 0) return { added: 0 };
        return await requestJson('/api/tokens/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tokens)
        });
    }

    async function remove(id) {
        ensureConnected();
        return await requestJson(`/api/tokens/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
    }

    async function getSettings() {
        if (!connected) return {};
        try {
            return await requestJson('/api/settings');
        } catch (e) {
            return {};
        }
    }

    async function setSetting(key, value) {
        if (!connected) return;
        try {
            await requestJson('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value })
            });
        } catch (e) {
            // ignore
        }
    }

    function isConnected() {
        return connected;
    }

    return {
        init,
        setUnauthorizedHandler,
        getAuthStatus,
        setupAccount,
        login,
        logout,
        changePassword,
        getAll,
        add,
        addBatch,
        remove,
        getSettings,
        setSetting,
        isConnected
    };
})();
