/**
 * 核心加密算法模块：RFC 4648 Base32 解码 与 RFC 6238 TOTP 生成
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function sanitizeAndValidateBase32(rawInput) {
    if (!rawInput || !rawInput.trim()) {
        return { valid: false, clean: '', error: '' };
    }
    const cleaned = rawInput.replace(/[\s\-]/g, '').toUpperCase().replace(/=+$/, '');
    if (cleaned.length === 0) {
        return { valid: false, clean: '', error: '不能为空哦~' };
    }
    const invalidMatch = cleaned.match(/[^A-Z2-7]/);
    if (invalidMatch) {
        return {
            valid: false,
            clean: cleaned,
            error: `发现调皮的无效字符 "${invalidMatch[0]}"（Base32 只能包含字母 A-Z 和数字 2-7）`
        };
    }
    if (cleaned.length < 8) {
        return {
            valid: false,
            clean: cleaned,
            error: '有点太短啦（通常至少需要 16 位字符）'
        };
    }
    return { valid: true, clean: cleaned };
}

function base32ToBytes(base32) {
    let bits = 0;
    let value = 0;
    const output = new Uint8Array(Math.floor((base32.length * 5) / 8));
    let index = 0;

    for (let i = 0; i < base32.length; i++) {
        const charIdx = BASE32_ALPHABET.indexOf(base32[i]);
        if (charIdx === -1) throw new Error('Invalid Base32');
        value = (value << 5) | charIdx;
        bits += 5;

        if (bits >= 8) {
            output[index++] = (value >>> (bits - 8)) & 255;
            bits -= 8;
        }
    }
    return output;
}

async function generateTOTP({ secret, digits = 6, period = 30, algorithm = 'SHA-1', timestamp = Date.now() }) {
    const keyBytes = base32ToBytes(secret);
    const epochSeconds = Math.floor(timestamp / 1000);
    const counter = Math.floor(epochSeconds / period);
    const counterBuffer = new ArrayBuffer(8);
    const counterView = new DataView(counterBuffer);
    counterView.setUint32(0, Math.floor(counter / 0x100000000), false);
    counterView.setUint32(4, counter >>> 0, false);

    const cryptoKey = await window.crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: { name: algorithm } },
        false,
        ['sign']
    );

    const signature = await window.crypto.subtle.sign('HMAC', cryptoKey, counterBuffer);
    const hmac = new Uint8Array(signature);

    const offset = hmac[hmac.length - 1] & 0x0f;
    const binaryCode =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);

    const otp = binaryCode % Math.pow(10, digits);
    return otp.toString().padStart(digits, '0');
}

function formatOTPCode(code) {
    if (!code) return '--- ---';
    const mid = Math.floor(code.length / 2);
    return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

function parseOtpAuthUri(uri) {
    try {
        const url = new URL(uri.trim());
        if (url.protocol !== 'otpauth:' || url.host.toLowerCase() !== 'totp') {
            return null;
        }
        const params = url.searchParams;
        const secret = params.get('secret');
        if (!secret) return null;

        const rawLabel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        let issuer = params.get('issuer') || '';
        let account = rawLabel;

        if (rawLabel.includes(':')) {
            const parts = rawLabel.split(':');
            if (!issuer) issuer = parts[0].trim();
            account = parts.slice(1).join(':').trim();
        }

        const label = issuer && account ? `${issuer} (${account})` : (issuer || account || '未命名');
        const digits = parseInt(params.get('digits') || '6', 10);
        const period = parseInt(params.get('period') || '30', 10);
        let algo = (params.get('algorithm') || 'SHA1').toUpperCase();
        if (algo === 'SHA1') algo = 'SHA-1';
        if (algo === 'SHA256') algo = 'SHA-256';
        if (algo === 'SHA512') algo = 'SHA-512';

        return {
            secret,
            label,
            digits: [6, 8].includes(digits) ? digits : 6,
            period: period >= 5 && period <= 300 ? period : 30,
            algorithm: ['SHA-1', 'SHA-256', 'SHA-512'].includes(algo) ? algo : 'SHA-1'
        };
    } catch (e) {
        return null;
    }
}
