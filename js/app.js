/**
 * 应用状态管理与实时 TOTP 交互逻辑（纯内存计算，无数据库、无口袋、无本地存储）
 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 33;

let currentRawCode = '';
let lastWindowIndex = -1;

const els = {
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
    themeToggle: document.getElementById('themeToggle'),
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

function initTheme() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
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
        refreshCode();
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

async function refreshCode() {
    const now = Date.now();
    const check = sanitizeAndValidateBase32(els.secretInput.value);
    if (!check.valid) return;

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

    const currentSecFloor = Math.floor(now / 1000);
    if (currentSecFloor !== lastWindowIndex) {
        lastWindowIndex = currentSecFloor;
        refreshCode();
    }

    requestAnimationFrame(tickLoop);
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
    els.themeToggle.addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
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
    els.paramDigits.addEventListener('change', refreshCode);
    els.paramPeriod.addEventListener('input', refreshCode);
    els.paramAlgorithm.addEventListener('change', refreshCode);

    els.btnClearInput.addEventListener('click', () => {
        els.secretInput.value = '';
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
}

window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initBackgroundBubbles();
    bindEvents();
    requestAnimationFrame(tickLoop);
});
