/**
 * 豚宝宝互动彩蛋与背景气泡动画模块
 */
const DUDU_QUOTES = [
    "点击大号验证码就能一键叼走哦，超方便的！🫧",
    "哇！谢谢你的摸摸，豚宝宝能量满满，继续为你站岗！🐬✨",
    "如果倒计时变成珊瑚粉色，说明马上要刷新下一个验证码啦！⏳"
];
let lastQuoteIndex = -1;

function initBackgroundBubbles() {
    const field = document.getElementById('bubbleField');
    if (!field) return;
    const bubbleCount = 14;
    for (let i = 0; i < bubbleCount; i++) {
        const b = document.createElement('div');
        const size = 10 + Math.random() * 24;
        b.className = 'bg-bubble bg-sky-300/35 dark:bg-sky-400/15 border border-white/50 dark:border-sky-300/20';
        b.style.width = `${size}px`;
        b.style.height = `${size}px`;
        b.style.left = `${Math.random() * 100}%`;
        b.style.animationDuration = `${10 + Math.random() * 14}s`;
        b.style.animationDelay = `${-Math.random() * 15}s`;
        field.appendChild(b);
    }
}

function triggerDuduInteraction() {
    const sprite = document.getElementById('duduSprite');
    const wrapper = document.getElementById('duduMascotWrapper');
    const speech = document.getElementById('duduSpeechText');
    if (!sprite || !wrapper || !speech) return;

    sprite.classList.remove('animate-dudu-jump');
    void sprite.offsetWidth;
    sprite.classList.add('animate-dudu-jump');

    const emojis = ['💧', '💙', '🫧', '✨', '🐚', '🩵'];
    for (let i = 0; i < 7; i++) {
        const p = document.createElement('span');
        p.className = 'splash-particle text-base sm:text-lg';
        p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
        const angle = (-150 + Math.random() * 120) * (Math.PI / 180);
        const dist = 42 + Math.random() * 45;
        p.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
        p.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
        p.style.left = '50%';
        p.style.top = '30%';
        wrapper.appendChild(p);
        setTimeout(() => p.remove(), 900);
    }

    let nextIdx;
    do {
        nextIdx = Math.floor(Math.random() * DUDU_QUOTES.length);
    } while (nextIdx === lastQuoteIndex && DUDU_QUOTES.length > 1);
    lastQuoteIndex = nextIdx;
    speech.textContent = DUDU_QUOTES[nextIdx];
}
