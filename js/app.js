/**
 * 应用状态管理、登录鉴权与纯 SQLite 口袋管理
 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 33;

let savedTokens = [];
let currentRawCode = '';
let pendingDeleteId = null;
let lastWindowIndex = -1;
let authMode = 'login'; // 'setup' | 'login'
let tickStarted = false;

const els = {
    // Auth screen
    authScreen: document.getElementById('authScreen'),
    authTitle: document.getElementById('authTitle'),
    authSubtitle: document.getElementById('authSubtitle'),
    authOfflineAlert: document.getElementById('authOfflineAlert'),
    authForm: document.getElementById('authForm'),
    authUsername: document.getElementById('authUsername'),
    authPassword: document.getElementById('authPassword'),
    authConfirmGroup: document.getElementById('authConfirmGroup'),
    authConfirmPassword: document.getElementById('authConfirmPassword'),
    authErrorMsg: document.getElementById('authErrorMsg'),
    btnAuthSubmit: document.getElementById('btnAuthSubmit'),

    // Main app shell
    appShell: document.getElementById('appShell'),
    currentUserBadge: document.getElementById('currentUserBadge'),
    btnOpenChangePwd: document.getElementById('btnOpenChangePwd'),
    btnLogout: document.getElementById('btnLogout'),

    // Change password modal
    changePasswordModal: document.getElementById('changePasswordModal'),
    changePwdForm: document.getElementById('changePwdForm'),
    oldPasswordInput: document.getElementById('oldPasswordInput'),
    newPasswordInput: document.getElementById('newPasswordInput'),
    confirmNewPasswordInput: document.getElementById('confirmNewPasswordInput'),
    changePwdErrorMsg: document.getElementById('changePwdErrorMsg'),
    btnCloseChangePwd: document.getElementById('btnCloseChangePwd'),
    btnCancelChangePwd: document.getElementById('btnCancelChangePwd'),

    // 2FA UI
    secretInput: document.getElementById('secretInput'),
    btnClearInput: document.getElementById('btnClearInput'),
    btnPaste: document.getElementById('btnPaste'),
    btnDemoKey: document.getElementById('btnDemoKey'),
    validationFeedback: document.getElementById('validationFeedback'),
    btnToggleAdvanced: document.getElementById('btnToggleAdvanced'),
    advancedChevron: document.getElementById('advancedChevron'),
    advancedPanel: document.getElementById('advancedPanel'),
    paramDigits: document.getElementById('paramDigits'),
    paramPeriod: document.getElementById('paramPeriod'),
    paramAlgorithm: document.getElementById('paramAlgorithm'),
    currentIssuerLabel: document.getElementById('currentIssuerLabel'),
    ringProgressCircle: document.getElementById('ringProgressCircle'),
    secondsRemaining: document.getElementById('secondsRemaining'),
    otpDisplayWrapper: document.getElementById('otpDisplayWrapper'),
    otpCodeDisplay: document.getElementById('otpCodeDisplay'),
    btnCopyMain: document.getElementById('btnCopyMain'),
    copyBtnEmoji: document.getElementById('copyBtnEmoji'),
    copyBtnText: document.getElementById('copyBtnText'),
    accountLabelInput: document.getElementById('accountLabelInput'),
    btnSaveToken: document.getElementById('btnSaveToken'),
    savedCountBadge: document.getElementById('savedCountBadge'),
    dbStatusBadge: document.getElementById('dbStatusBadge'),
    savedTokensGrid: document.getElementById('savedTokensGrid'),
    emptyState: document.getElementById('emptyState'),
    btnExportJson: document.getElementById('btnExportJson'),
    inputImportJson: document.getElementById('inputImportJson'),
    themeToggle: document.getElementById('themeToggle'),
    deleteModal: document.getElementById('deleteModal'),
    deleteTargetName: document.getElementById('deleteTargetName'),
    btnCancelDelete: document.getElementById('btnCancelDelete'),
    btnConfirmDelete: document.getElementById('btnConfirmDelete'),
    toastContainer: document.getElementById('toastContainer'),
    duduMascotWrapper: document.getElementById('duduMascotWrapper')
};

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    const styles = {
        success: 'bg-emerald-500 text-white border-emerald-400',
        error: 'bg-coral-500 text-white border-coral-400',
        info: 'bg-sky-600 dark:bg-indigo-600 text-white border-sky-400'
    };
    toast.className = `${styles[type] || styles.info} border-2 px-4 py-3 rounded-2xl shadow-xl text-xs sm:text-sm font-bold flex items-center gap-2 transform transition-all duration-300 translate-y-3 opacity-0`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-3', 'opacity-0');
    });

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-3');
        setTimeout(() => toast.remove(), 300);
    }, 2600);
}

function copyToClipboard(text, onSuccess) {
    if (!text) return;
    const fallbackCopy = () => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            if (onSuccess) onSuccess();
        } catch (err) {
            showToast('复制没成功，请手动选中数字复制哦~', 'error');
        }
        document.body.removeChild(textarea);
    };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            if (onSuccess) onSuccess();
        }).catch(fallbackCopy);
    } else {
        fallbackCopy();
    }
}

function showAuthError(msg) {
    if (!msg) {
        els.authErrorMsg.classList.add('hidden');
        els.authErrorMsg.textContent = '';
    } else {
        els.authErrorMsg.textContent = '⚠️ ' + msg;
        els.authErrorMsg.classList.remove('hidden');
    }
}

function showAuthScreen(mode) {
    authMode = mode;
    els.appShell.classList.add('hidden');
    els.appShell.classList.remove('flex');
    els.authScreen.classList.remove('hidden');
    els.authForm.classList.remove('hidden');
    els.authOfflineAlert.classList.add('hidden');
    showAuthError('');

    els.authPassword.value = '';
    els.authConfirmPassword.value = '';

    if (mode === 'setup') {
        els.authTitle.textContent = '首次部署 · 设置管理员账号';
        els.authSubtitle.textContent = '请设置你的登录账号与密码，设置后即可进入豚宝宝 2FA 助手';
        els.authConfirmGroup.classList.remove('hidden');
        els.authConfirmPassword.required = true;
        els.authPassword.setAttribute('autocomplete', 'new-password');
        els.btnAuthSubmit.textContent = '完成设置并进入';
    } else {
        els.authTitle.textContent = '欢迎回来 · 豚宝宝 2FA 助手';
        els.authSubtitle.textContent = '请输入管理员账号与密码登录';
        els.authConfirmGroup.classList.add('hidden');
        els.authConfirmPassword.required = false;
        els.authPassword.setAttribute('autocomplete', 'current-password');
        els.btnAuthSubmit.textContent = '🔓 立即登录';
    }
    setTimeout(() => els.authUsername.focus(), 50);
}

async function enterApp(username) {
    els.authScreen.classList.add('hidden');
    els.appShell.classList.remove('hidden');
    els.appShell.classList.add('flex');

    if (username) {
        els.currentUserBadge.textContent = `👤 ${username}`;
        els.currentUserBadge.classList.remove('hidden');
    }
    await initThemeFromDB();
    await loadSavedTokens();

    if (!tickStarted) {
        tickStarted = true;
        requestAnimationFrame(tickLoop);
    }
}

async function initThemeFromDB() {
    const settings = await TokenDB.getSettings();
    const savedTheme = settings.theme;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}

function openChangePwdModal() {
    els.oldPasswordInput.value = '';
    els.newPasswordInput.value = '';
    els.confirmNewPasswordInput.value = '';
    els.changePwdErrorMsg.classList.add('hidden');
    els.changePasswordModal.classList.remove('hidden');
    els.changePasswordModal.classList.add('flex');
    setTimeout(() => els.oldPasswordInput.focus(), 50);
}

function closeChangePwdModal() {
    els.changePasswordModal.classList.add('hidden');
    els.changePasswordModal.classList.remove('flex');
}

function handleSecretInputChange() {
    const raw = els.secretInput.value;
    els.btnClearInput.classList.toggle('hidden', raw.length === 0);

    if (raw.trim().toLowerCase().startsWith('otpauth://')) {
        const parsed = parseOtpAuthUri(raw);
        if (parsed) {
            els.secretInput.value = parsed.secret;
            els.paramDigits.value = parsed.digits;
            els.paramPeriod.value = parsed.period;
            els.paramAlgorithm.value = parsed.algorithm;
            if (!els.accountLabelInput.value) {
                els.accountLabelInput.value = parsed.label;
            }
            els.currentIssuerLabel.textContent = parsed.label;
            showToast('🐬 豚宝宝已自动解析好 otpauth:// 链接参数！', 'success');
        } else {
            setValidationStatus(false, '这个 otpauth:// 链接格式好像不对哦，请检查是否为 TOTP 类型');
            return;
        }
    }

    const check = sanitizeAndValidateBase32(els.secretInput.value);
    if (!els.secretInput.value.trim()) {
        setValidationStatus(null, '豚宝宝会自动帮你过滤空格与大小写，符合国际 RFC 6238 标准哦~');
        currentRawCode = '';
        els.otpCodeDisplay.textContent = '--- ---';
        els.btnCopyMain.disabled = true;
        els.currentIssuerLabel.textContent = '当前实时动态口令';
        return;
    }

    if (!check.valid) {
        setValidationStatus(false, check.error);
        currentRawCode = '';
        els.otpCodeDisplay.textContent = '--- ---';
        els.btnCopyMain.disabled = true;
    } else {
        setValidationStatus(true, `校验通过啦！(${check.clean.length} 位标准 Base32 字符)`);
        els.btnCopyMain.disabled = false;
        refreshAllCodes();
    }
}

function setValidationStatus(isValid, message) {
    if (isValid === null) {
        els.validationFeedback.innerHTML = `<span class="text-slate-400 dark:text-slate-400">${message}</span>`;
    } else if (isValid) {
        els.validationFeedback.innerHTML = `
            <span class="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-semibold">
                <span>✅</span>
                <span>${message}</span>
            </span>`;
    } else {
        els.validationFeedback.innerHTML = `
            <span class="text-coral-500 flex items-center gap-1 font-semibold">
                <span>⚠️</span>
                <span>${message}</span>
            </span>`;
    }
}

async function refreshAllCodes() {
    const now = Date.now();
    const check = sanitizeAndValidateBase32(els.secretInput.value);
    if (check.valid) {
        const digits = parseInt(els.paramDigits.value, 10) || 6;
        const period = Math.max(5, parseInt(els.paramPeriod.value, 10) || 30);
        const algorithm = els.paramAlgorithm.value || 'SHA-1';

        try {
            const code = await generateTOTP({
                secret: check.clean,
                digits,
                period,
                algorithm,
                timestamp: now
            });
            currentRawCode = code;
            els.otpCodeDisplay.textContent = formatOTPCode(code);
        } catch (err) {
            els.otpCodeDisplay.textContent = 'ERR';
        }
    }

    for (const item of savedTokens) {
        const codeEl = document.getElementById(`saved-code-${item.id}`);
        if (!codeEl) continue;
        try {
            const code = await generateTOTP({
                secret: item.secret,
                digits: item.digits || 6,
                period: item.period || 30,
                algorithm: item.algorithm || 'SHA-1',
                timestamp: now
            });
            codeEl.dataset.rawCode = code;
            codeEl.textContent = formatOTPCode(code);
        } catch (e) {
            codeEl.textContent = '无效';
        }
    }
}

function tickLoop() {
    const now = Date.now();
    const period = Math.max(5, parseInt(els.paramPeriod.value, 10) || 30);
    const periodMs = period * 1000;

    const elapsedInWindow = now % periodMs;
    const remainingMs = periodMs - elapsedInWindow;
    const remainingSec = Math.ceil(remainingMs / 1000);
    const ratio = remainingMs / periodMs;

    els.secondsRemaining.textContent = `${remainingSec}s`;
    const offset = RING_CIRCUMFERENCE * (1 - ratio);
    els.ringProgressCircle.style.strokeDashoffset = offset.toFixed(2);

    if (remainingSec <= 5) {
        els.ringProgressCircle.setAttribute('stroke', '#fda4af');
        els.secondsRemaining.className = 'font-mono font-bold text-sm sm:text-base text-rose-200 animate-pulse';
    } else {
        els.ringProgressCircle.setAttribute('stroke', '#ffffff');
        els.secondsRemaining.className = 'font-mono font-bold text-sm sm:text-base text-white';
    }

    for (const item of savedTokens) {
        const p = (item.period || 30) * 1000;
        const rem = p - (now % p);
        const remSec = Math.ceil(rem / 1000);
        const barEl = document.getElementById(`saved-bar-${item.id}`);
        const secEl = document.getElementById(`saved-sec-${item.id}`);
        if (barEl && secEl) {
            barEl.style.width = `${(rem / p) * 100}%`;
            secEl.textContent = `${remSec}s`;
            if (remSec <= 5) {
                barEl.className = 'h-full bg-coral-400 rounded-full transition-all duration-100 ease-linear';
                secEl.className = 'text-xs font-mono font-bold text-coral-500';
            } else {
                barEl.className = 'h-full bg-gradient-to-r from-sky-400 to-teal-400 rounded-full transition-all duration-100 ease-linear';
                secEl.className = 'text-xs font-mono font-semibold text-sky-600 dark:text-sky-400';
            }
        }
    }

    const currentSecFloor = Math.floor(now / 1000);
    if (currentSecFloor !== lastWindowIndex) {
        lastWindowIndex = currentSecFloor;
        refreshAllCodes();
    }

    requestAnimationFrame(tickLoop);
}

async function loadSavedTokens() {
    try {
        savedTokens = await TokenDB.getAll();
    } catch (e) {
        if (e.status === 401) {
            showAuthScreen('login');
            showToast('登录已过期，请重新登录', 'info');
            return;
        }
        savedTokens = [];
        showToast(e.message || '读取 SQLite 数据库失败', 'error');
    }
    renderSavedTokens();
    refreshAllCodes();
}

function maskSecret(secret) {
    if (secret.length <= 8) return '••••••••';
    return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderSavedTokens() {
    els.savedCountBadge.textContent = savedTokens.length;
    els.savedTokensGrid.innerHTML = '';

    if (savedTokens.length === 0) {
        els.emptyState.classList.remove('hidden');
        return;
    }
    els.emptyState.classList.add('hidden');

    const shellIcons = ['🐚', '🦪', '🐠', '🐳', '🪼', '⭐'];

    savedTokens.forEach((item, idx) => {
        const icon = shellIcons[idx % shellIcons.length];
        const card = document.createElement('div');
        card.className = 'group bg-white/95 dark:bg-slate-900/90 backdrop-blur-sm rounded-3xl border-2 border-sky-200/80 dark:border-sky-800/70 p-5 shadow-candy hover:-translate-y-0.5 hover:border-sky-400 dark:hover:border-sky-600 transition-all flex flex-col justify-between';

        card.innerHTML = `
            <div class="flex items-start justify-between gap-2 mb-3">
                <div class="flex items-center gap-2.5 min-w-0">
                    <span class="w-9 h-9 rounded-2xl bg-sky-100 dark:bg-sky-950 flex items-center justify-center text-lg shrink-0">${icon}</span>
                    <div class="min-w-0">
                        <h3 class="font-bold text-sm sm:text-base text-slate-800 dark:text-white truncate" title="${escapeHtml(item.label)}">
                            ${escapeHtml(item.label)}
                        </h3>
                        <p class="text-[11px] font-mono text-slate-400 dark:text-sky-300/60 truncate">
                            ${maskSecret(item.secret)} · ${item.digits || 6}位/${item.period || 30}s
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        data-action="load"
                        data-id="${item.id}"
                        title="放到上方大屏查看"
                        class="p-2 rounded-xl text-slate-400 hover:text-sky-500 hover:bg-sky-50 dark:hover:bg-slate-800 transition-colors"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg>
                    </button>
                    <button
                        type="button"
                        data-action="delete"
                        data-id="${item.id}"
                        title="从数据库移除"
                        class="p-2 rounded-xl text-slate-400 hover:text-coral-500 hover:bg-rose-50 dark:hover:bg-slate-800 transition-colors"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </div>
            </div>

            <div class="flex items-center justify-between gap-2 my-1">
                <button
                    type="button"
                    data-action="copy"
                    data-id="${item.id}"
                    class="flex items-center gap-2.5 text-left group/code py-1.5 px-3 -mx-2 rounded-2xl hover:bg-sky-50 dark:hover:bg-sky-950/70 transition-all active:scale-95"
                >
                    <span id="saved-code-${item.id}" class="font-mono text-2xl sm:text-3xl font-bold tracking-wider text-sky-600 dark:text-sky-300">
                        --- ---
                    </span>
                    <span class="text-xs font-bold px-2.5 py-1 rounded-full bg-sky-100 dark:bg-sky-900 text-sky-600 dark:text-sky-200 group-hover/code:bg-sky-500 group-hover/code:text-white transition-colors">
                        复制
                    </span>
                </button>
                <span id="saved-sec-${item.id}" class="text-xs font-mono font-semibold text-sky-600 dark:text-sky-400">30s</span>
            </div>

            <div class="w-full h-2 bg-sky-100 dark:bg-slate-800 rounded-full overflow-hidden mt-3 p-0.5">
                <div id="saved-bar-${item.id}" class="h-full bg-gradient-to-r from-sky-400 to-teal-400 rounded-full transition-all duration-100 ease-linear" style="width: 100%;"></div>
            </div>
        `;
        els.savedTokensGrid.appendChild(card);
    });
}

function triggerMainCopy() {
    if (!currentRawCode) return;
    copyToClipboard(currentRawCode, () => {
        els.copyBtnEmoji.textContent = '🎉';
        els.copyBtnText.textContent = '已复制好啦！';
        showToast(`🐬 豚宝宝已帮你复制好啦！(${currentRawCode})`, 'success');

        setTimeout(() => {
            els.copyBtnEmoji.textContent = '🫧';
            els.copyBtnText.textContent = '复制验证码';
        }, 1600);
    });
}

function bindEvents() {
    // Auth form submit
    els.authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showAuthError('');

        const username = els.authUsername.value.trim();
        const password = els.authPassword.value;

        if (authMode === 'setup') {
            const confirmPwd = els.authConfirmPassword.value;
            if (username.length < 2) {
                showAuthError('账号至少需要 2 个字符');
                return;
            }
            if (password.length < 6) {
                showAuthError('密码至少需要 6 位');
                return;
            }
            if (password !== confirmPwd) {
                showAuthError('两次输入的密码不一致');
                return;
            }
            try {
                els.btnAuthSubmit.disabled = true;
                const res = await TokenDB.setupAccount(username, password);
                showToast('🎉 初始账号设置成功，欢迎进入豚宝宝 2FA 助手！', 'success');
                await enterApp(res.username);
            } catch (err) {
                showAuthError(err.message || '设置失败');
            } finally {
                els.btnAuthSubmit.disabled = false;
            }
        } else {
            try {
                els.btnAuthSubmit.disabled = true;
                const res = await TokenDB.login(username, password);
                showToast(`🐬 欢迎回来，${res.username}！`, 'success');
                await enterApp(res.username);
            } catch (err) {
                showAuthError(err.message || '账号或密码错误');
            } finally {
                els.btnAuthSubmit.disabled = false;
            }
        }
    });

    // Logout
    els.btnLogout.addEventListener('click', async () => {
        await TokenDB.logout();
        savedTokens = [];
        els.savedTokensGrid.innerHTML = '';
        els.secretInput.value = '';
        handleSecretInputChange();
        showAuthScreen('login');
        showToast('👋 已安全退出登录', 'info');
    });

    // Change Password modal
    els.btnOpenChangePwd.addEventListener('click', openChangePwdModal);
    els.btnCloseChangePwd.addEventListener('click', closeChangePwdModal);
    els.btnCancelChangePwd.addEventListener('click', closeChangePwdModal);

    els.changePwdForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        els.changePwdErrorMsg.classList.add('hidden');

        const oldPwd = els.oldPasswordInput.value;
        const newPwd = els.newPasswordInput.value;
        const confirmNewPwd = els.confirmNewPasswordInput.value;

        if (newPwd.length < 6) {
            els.changePwdErrorMsg.textContent = '⚠️ 新密码至少需要 6 位';
            els.changePwdErrorMsg.classList.remove('hidden');
            return;
        }
        if (newPwd !== confirmNewPwd) {
            els.changePwdErrorMsg.textContent = '⚠️ 两次输入的新密码不一致';
            els.changePwdErrorMsg.classList.remove('hidden');
            return;
        }

        try {
            await TokenDB.changePassword(oldPwd, newPwd);
            closeChangePwdModal();
            showToast('✅ 密码修改成功，已自动更新登录状态！', 'success');
        } catch (err) {
            els.changePwdErrorMsg.textContent = '⚠️ ' + (err.message || '修改密码失败');
            els.changePwdErrorMsg.classList.remove('hidden');
        }
    });

    els.themeToggle.addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
        TokenDB.setSetting('theme', isDark ? 'dark' : 'light');
        showToast(isDark ? '🌙 已切换至「深海星夜模式」，豚宝宝戴上睡帽啦~' : '☀️ 已切换至「阳光海洋模式」~', 'info');
    });

    els.duduMascotWrapper.addEventListener('click', triggerDuduInteraction);
    els.duduMascotWrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            triggerDuduInteraction();
        }
    });

    els.secretInput.addEventListener('input', handleSecretInputChange);
    els.paramDigits.addEventListener('change', refreshAllCodes);
    els.paramPeriod.addEventListener('input', refreshAllCodes);
    els.paramAlgorithm.addEventListener('change', refreshAllCodes);

    els.btnClearInput.addEventListener('click', () => {
        els.secretInput.value = '';
        els.accountLabelInput.value = '';
        handleSecretInputChange();
        els.secretInput.focus();
    });

    els.btnPaste.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                els.secretInput.value = text;
                handleSecretInputChange();
            }
        } catch (err) {
            showToast('浏览器需要你手动按 Ctrl+V / Cmd+V 粘贴哦~', 'info');
            els.secretInput.focus();
        }
    });

    els.btnDemoKey.addEventListener('click', () => {
        els.secretInput.value = 'JBSWY3DPEHPK3PXP';
        els.accountLabelInput.value = '豚宝宝测试账号';
        els.currentIssuerLabel.textContent = '豚宝宝测试账号';
        handleSecretInputChange();
        triggerDuduInteraction();
        showToast('✨ 豚宝宝已经帮你填好示例啦！', 'info');
    });

    els.btnToggleAdvanced.addEventListener('click', () => {
        const isHidden = els.advancedPanel.classList.contains('hidden');
        if (isHidden) {
            els.advancedPanel.classList.remove('hidden');
            els.advancedPanel.classList.add('grid');
            els.advancedChevron.classList.add('rotate-90');
        } else {
            els.advancedPanel.classList.add('hidden');
            els.advancedPanel.classList.remove('grid');
            els.advancedChevron.classList.remove('rotate-90');
        }
    });

    els.btnCopyMain.addEventListener('click', triggerMainCopy);
    els.otpDisplayWrapper.addEventListener('click', triggerMainCopy);

    els.btnSaveToken.addEventListener('click', async () => {
        const check = sanitizeAndValidateBase32(els.secretInput.value);
        if (!check.valid) {
            showToast(check.error || '请先输入有效的 2FA 哦~', 'error');
            els.secretInput.focus();
            return;
        }

        const label = els.accountLabelInput.value.trim() || `小账号 #${savedTokens.length + 1}`;
        const digits = parseInt(els.paramDigits.value, 10) || 6;
        const period = Math.max(5, parseInt(els.paramPeriod.value, 10) || 30);
        const algorithm = els.paramAlgorithm.value || 'SHA-1';

        const newToken = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            label,
            secret: check.clean,
            digits,
            period,
            algorithm,
            createdAt: new Date().toISOString()
        };

        try {
            await TokenDB.add(newToken);
            await loadSavedTokens();
            els.accountLabelInput.value = '';
            triggerDuduInteraction();
            showToast(`🐚 已将「${label}」写入 SQLite 数据库！`, 'success');
        } catch (err) {
            showToast(err.message || '写入数据库失败', 'error');
        }
    });

    els.savedTokensGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const item = savedTokens.find(t => t.id === id);
        if (!item) return;

        if (action === 'copy') {
            const codeEl = document.getElementById(`saved-code-${id}`);
            const rawCode = codeEl ? codeEl.dataset.rawCode : '';
            if (rawCode) {
                copyToClipboard(rawCode, () => {
                    showToast(`🐬 豚宝宝已帮你复制好「${item.label}」的验证码：${rawCode}`, 'success');
                });
            }
        } else if (action === 'load') {
            els.secretInput.value = item.secret;
            els.paramDigits.value = item.digits || 6;
            els.paramPeriod.value = item.period || 30;
            els.paramAlgorithm.value = item.algorithm || 'SHA-1';
            els.currentIssuerLabel.textContent = item.label;
            handleSecretInputChange();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            showToast(`✨ 已将「${item.label}」放到上方大屏啦~`, 'info');
        } else if (action === 'delete') {
            pendingDeleteId = id;
            els.deleteTargetName.textContent = item.label;
            els.deleteModal.classList.remove('hidden');
            els.deleteModal.classList.add('flex');
        }
    });

    els.btnCancelDelete.addEventListener('click', () => {
        pendingDeleteId = null;
        els.deleteModal.classList.add('hidden');
        els.deleteModal.classList.remove('flex');
    });

    els.btnConfirmDelete.addEventListener('click', async () => {
        if (pendingDeleteId) {
            try {
                await TokenDB.remove(pendingDeleteId);
                await loadSavedTokens();
                showToast('🌊 已从 SQLite 数据库中删除该记录~', 'info');
            } catch (err) {
                showToast(err.message || '删除失败', 'error');
            }
        }
        pendingDeleteId = null;
        els.deleteModal.classList.add('hidden');
        els.deleteModal.classList.remove('flex');
    });

    els.btnExportJson.addEventListener('click', () => {
        if (savedTokens.length === 0) {
            showToast('数据库口袋里还没有账号可以导出哦~', 'info');
            return;
        }
        const dataStr = JSON.stringify(savedTokens, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateTag = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `dolphin-dudu-2fa-backup-${dateTag}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('📤 备份导出成功，请妥善收好哦！', 'success');
    });

    els.inputImportJson.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const imported = JSON.parse(event.target.result);
                if (!Array.isArray(imported)) throw new Error('格式错误');

                const validBatch = [];
                imported.forEach((entry) => {
                    const check = sanitizeAndValidateBase32(entry.secret || '');
                    if (check.valid) {
                        validBatch.push({
                            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                            label: String(entry.label || '恢复的小贝壳').slice(0, 60),
                            secret: check.clean,
                            digits: [6, 8].includes(Number(entry.digits)) ? Number(entry.digits) : 6,
                            period: Number(entry.period) >= 5 ? Number(entry.period) : 30,
                            algorithm: ['SHA-1', 'SHA-256', 'SHA-512'].includes(entry.algorithm) ? entry.algorithm : 'SHA-1',
                            createdAt: entry.createdAt || new Date().toISOString()
                        });
                    }
                });

                await TokenDB.addBatch(validBatch);
                await loadSavedTokens();
                triggerDuduInteraction();
                showToast(`📥 成功向 SQLite 数据库导入 ${validBatch.length} 条记录！`, 'success');
            } catch (err) {
                showToast('导入失败啦：JSON 备份文件格式好像不对哦', 'error');
            }
            e.target.value = '';
        };
        reader.readAsText(file);
    });
}

window.addEventListener('DOMContentLoaded', async () => {
    initBackgroundBubbles();
    bindEvents();

    TokenDB.setUnauthorizedHandler(() => {
        if (els.authScreen.classList.contains('hidden')) {
            closeChangePwdModal();
            savedTokens = [];
            els.savedTokensGrid.innerHTML = '';
            showAuthScreen('login');
            showToast('登录已过期，请重新登录', 'info');
        }
    });

    const { connected } = await TokenDB.init();
    if (!connected) {
        els.authTitle.textContent = '未连接到后端服务';
        els.authSubtitle.textContent = '请先启动 dolphin-2fa.exe 或 go run .';
        els.authOfflineAlert.classList.remove('hidden');
        return;
    }

    try {
        const status = await TokenDB.getAuthStatus();
        if (!status.initialized) {
            showAuthScreen('setup');
        } else if (!status.authenticated) {
            showAuthScreen('login');
        } else {
            await enterApp(status.username);
        }
    } catch (err) {
        els.authTitle.textContent = '初始化状态检查失败';
        els.authSubtitle.textContent = err.message || '请刷新重试';
    }
});
