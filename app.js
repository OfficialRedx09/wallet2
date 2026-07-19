const express = require('express');
const cors = require('cors');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1');
const axios = require('axios');

// --- 1. Firebase Realtime Database (Public REST API) ---
const DB_BASE = "https://marketwave-727e8-default-rtdb.firebaseio.com";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'] }));
app.use(express.json({ limit: '1mb' }));

// ── /health — lightweight uptime probe (no logger overhead) ──────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        users: strategySessions.size,
        addresses: addressToUserId.size,
        tokenOk: !!(duelToken && Date.now() < duelTokenExpiresAt),
        timestamp: new Date().toISOString()
    });
});

// ── /telegram/test — sends a test message to verify bot config ───────────────
app.post('/telegram/test', async (req, res) => {
    const chatId = req.body?.chat_id || TELEGRAM_CHAT_ID;
    if (!chatId) return res.status(400).json({ success: false, error: 'No chat_id' });
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const resp = await axios.post(url,
            { chat_id: Number(chatId) || chatId, text: `\u2705 Marketwave server test message\nBot: ${TELEGRAM_BOT_TOKEN.split(':')[0]}\nChat ID: ${chatId}\nTime: ${new Date().toISOString()}` },
            { timeout: 12000 }
        );
        if (resp.data?.ok) return res.json({ success: true, telegram: resp.data });
        return res.status(400).json({ success: false, telegram: resp.data });
    } catch (err) {
        const desc = err.response?.data?.description || err.message;
        return res.status(500).json({ success: false, error: desc, detail: err.response?.data || null });
    }
});

// ── Global request/response logger ──────────────────────────────────────────
// Logs every inbound HTTP request and its final response status/time.
app.use((req, res, next) => {
    const start = Date.now();
    const ip = req.headers['x-forwarded-for'] || req.ip;
    console.log(`\n[HTTP] ► ${req.method} ${req.originalUrl} | IP: ${ip}`);
    if (req.body && Object.keys(req.body).length > 0) {
        // Redact no sensitive fields here — full visibility requested
        console.log(`[HTTP]   Body: ${JSON.stringify(req.body)}`);
    }
    if (Object.keys(req.query).length > 0) {
        console.log(`[HTTP]   Query: ${JSON.stringify(req.query)}`);
    }
    const origJson = res.json.bind(res);
    res.json = (data) => {
        const ms = Date.now() - start;
        console.log(`[HTTP] ◄ ${req.method} ${req.originalUrl} | Status: ${res.statusCode} | ${ms}ms | Response: ${JSON.stringify(data)}`);
        return origJson(data);
    };
    next();
});
// ────────────────────────────────────────────────────────────────────────────

// --- 2. Litecoin Network Setup ---
// ── Blockchain API tier config ────────────────────────────────────────────────
// Tier 1: litecoinspace.org — Esplora, free, no API key
// Tier 2: Blockchair       — free, no API key, generous limits, reliable
// Tier 3: BlockCypher      — free tier (3 req/s, 200/hr), no API key
// Tier 4: Tatum            — paid/limited; used only when all above fail
const LTCSPACE_BASE      = "https://litecoinspace.org/api";           // Tier 1
const BLOCKCHAIR_BASE    = "https://api.blockchair.com/litecoin";    // Tier 2
const BLOCKCYPHER_BASE   = "https://api.blockcypher.com/v1/ltc/main"; // Tier 3
const TATUM_BASE = "https://api.tatum.io/v3";                         // Tier 4 (fallback)
const TATUM_API_KEY = process.env.TATUM_API_KEY || "t-6a27313caa620fad0caa1d3b-55c14747b32a46bea844dfcd";
let TREASURY_ADDRESS = "ltc1qxgyxnq3yq02kl0ts7uyldzkkypag4zdws759zy";
const LTC_SATOSHIS = 1e8;   // 1 LTC = 100,000,000 satoshis
const SWEEP_FEE_SATS = 10000; // ~0.0001 LTC network fee

const bip32 = BIP32Factory(ecc);

// Litecoin mainnet parameters
const LITECOIN_NETWORK = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

// --- Duel.com Token Config ---
const DUEL_TOKEN_URL = "https://duel.com/api/v2/user/security/token";
const DUEL_BET_URL = "https://duel.com/api/v2/dice/bet";
const DUEL_SEED_ROTATE_URL = "https://duel.com/api/v2/client-seed/rotate";
// ── Duel.com credentials — loaded from Firebase /API_INFO at boot, refreshed every 5 min ──
let DUEL_DEVICE_UUID = process.env.DUEL_DEVICE_UUID || "30b3dac8-2c30-4ec7-94fd-67186e92e94a";
// Mobile session cookies — used for all betting calls
let DUEL_COOKIES = process.env.DUEL_COOKIES || "";
// Desktop session cookies — used exclusively for seed rotation (separate cf_clearance)
let DUEL_SEED_COOKIES = process.env.DUEL_SEED_COOKIES || "";

// Core Lookup Maps
const addressToUserId = new Map();
const userIdToPhrase = new Map();
const userSweepQueue = new Map();
const lastOnChainSats = new Map(); // userId -> last polled on-chain sats (detects new deposits)
const userAccumulatedBalance = new Map(); // userId -> lifetime accumulated LTC (never decreases after sweep)
const strategySessions = new Map(); // userId -> strategy session

// ── Telegram notification config ──────────────────────────────────────────────
// Bot token is hard-coded; set TELEGRAM_CHAT_ID env var to your admin chat ID.
// To get your chat ID: message the bot once, then visit:
//   https://api.telegram.org/bot<TOKEN>/getUpdates
function getTelegramChatId() {
    const envVal = process.env.TELEGRAM_CHAT_ID;
    if (envVal && envVal.trim() !== '' && envVal !== 'null' && envVal !== 'undefined') {
        return envVal.trim();
    }
    return '8225226874';
}
function getTelegramBotToken() {
    const envVal = process.env.TELEGRAM_BOT_TOKEN;
    if (envVal && envVal.trim() !== '' && envVal !== 'null' && envVal !== 'undefined') {
        return envVal.trim();
    }
    return '8828699174:AAFz6gwpQVv5ppHod9tV3nb-7K-6FpY2ynQ';
}
const TELEGRAM_BOT_TOKEN = getTelegramBotToken();
const TELEGRAM_CHAT_ID = getTelegramChatId();
const SERVER_ID = process.env.SERVER_ID || '102030';
const SERVER_NO = process.env.SERVER_NO || '01';
const COMPLEX_PROFIT_TARGET = 0.50;                   // $0.50 profit triggers notification + lock
const LTC_TO_BDT_RATE = 5000;                   // 1 LTC ≈ 5000 BDT  (balance / 0.00025 × 1.25)
const DAILY_PROFIT_TARGET_BDT = 50;              // Daily profit cap: 50 BDT
const DAILY_PROFIT_TARGET_LTC = DAILY_PROFIT_TARGET_BDT / LTC_TO_BDT_RATE; // 0.01 LTC
const DAILY_RESET_MS = 24 * 60 * 60 * 1000;     // 24-hour daily reset window
const USER_LOCK_DURATION_MS = 20 * 60 * 60 * 1000;   // 20 hours in ms

// Per-user bet lock — user cannot trade for 20 h after complex-mode profit target is hit
const userBetLocks = new Map(); // userId -> lockUntilTimestamp (ms epoch)
// ─────────────────────────────────────────────────────────────────────────────

// ── Per-user Firebase balance lock — serialises concurrent R-M-W ops ─────────
const _balanceLocks = new Map();
function acquireBalanceLock(userId, fn) {
    const prev = _balanceLocks.get(userId) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn()); // run fn regardless of prev outcome
    _balanceLocks.set(userId, next.then(() => undefined, () => undefined));
    return next;
}

// ── Global Duel bet serializer — one bet at a time across ALL users ───────────
// Duel.com uses a single account/token shared by all users, so bets MUST be
// serialised globally to prevent token races and duplicate-nonce rejections.
// Per-user queues would allow parallel bets on the same account \u2014 not safe.
const _duelBetQueues = new Map(); // userId -> Promise (per-user queue)
function enqueueDuelBet(fn, userId) {
    // Each user gets their own queue slot; slots run sequentially per-user
    // but different users can overlap if they happen to use different Duel rounds.
    // Global serialization is enforced via the shared token refresh lock.
    const prev = _duelBetQueues.get(userId) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    _duelBetQueues.set(userId, next.then(() => undefined, () => undefined));
    return next;
}

// ── Seed rotation rate limiter — max 1 call per 60 s ─────────────────────────
// Queued requests wait for the next available 60 s window before executing.
let _lastSeedRotateAt = 0;
let _seedRotateQueue = Promise.resolve();
function enqueueSeedRotate(fn) {
    const next = _seedRotateQueue.then(
        async () => {
            const waitMs = Math.max(0, 60000 - (Date.now() - _lastSeedRotateAt));
            if (waitMs > 0) {
                console.log(`[SEED] Rate limit: waiting ${(waitMs / 1000).toFixed(1)}s...`);
                await sleep(waitMs);
            }
            _lastSeedRotateAt = Date.now();
            return fn();
        },
        async () => {
            const waitMs = Math.max(0, 60000 - (Date.now() - _lastSeedRotateAt));
            if (waitMs > 0) await sleep(waitMs);
            _lastSeedRotateAt = Date.now();
            return fn();
        }
    );
    _seedRotateQueue = next.then(() => undefined, () => undefined);
    return next;
}

// Duel token state
let duelToken = null;
let duelTokenExpiresAt = 0;
let duelTokenRefreshing = null;



// ─── Utilities & Strategy Helpers ────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Random trade delay fixed at 800 ms
const randomDelay = () => sleep(800);

// ── Cloudflare bot-detection mitigation — rotate low-risk request headers ─────
const _MOBILE_UAS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
];
const _ACCEPT_LANGS = [
    'en-GB,en;q=0.9', 'en-GB,en;q=0.8', 'en-GB,en;q=0.7',
    'en-GB,en;q=0.6', 'en-US,en;q=0.9,en-GB;q=0.8',
];
function _randomBetHeaders() {
    return {
        'user-agent': _MOBILE_UAS[Math.floor(Math.random() * _MOBILE_UAS.length)],
        'accept-language': _ACCEPT_LANGS[Math.floor(Math.random() * _ACCEPT_LANGS.length)],
        'priority': Math.random() > 0.6 ? 'u=1, i' : 'u=3, i',
        'sec-gpc': Math.random() > 0.3 ? '1' : '0',
    };
}
// ─────────────────────────────────────────────────────────────────────────────

// Format milliseconds → "Xh Ym" / "Ym Zs" / "Zs" human-readable
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
}

// Returns lock info if the user's 20-h bet lock is still active, otherwise null
function getUserLockInfo(userId) {
    const until = userBetLocks.get(userId);
    if (!until || Date.now() >= until) return null;
    return { locked: true, lockUntil: until, remainingMs: until - Date.now() };
}

// Escape HTML entities so Telegram's HTML parse_mode never rejects messages
function _tgEscape(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
// Re-wrap a plain-text message preserving emoji but stripping HTML tags
function _tgStripTags(str) {
    return String(str || '').replace(/<\/?b>/g, '').replace(/<\/?i>/g, '');
}

// Send an HTML message to a Telegram chat via Bot API.
// On any Telegram API error the full error description is logged,
// then it retries once with plain text so the message is never silently dropped.
async function sendTelegramMessage(chatId, text) {
    if (!chatId) {
        console.warn('[TELEGRAM] TELEGRAM_CHAT_ID not set — skipping notification');
        return;
    }
    const numericChatId = Number(chatId) || chatId; // Telegram prefers numeric IDs
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const _post = async (body) => {
        const resp = await axios.post(url, body, { timeout: 12000 });
        return resp.data;
    };

    // ── Attempt 1: HTML mode ────────────────────────────────────────────────
    try {
        const result = await _post({ chat_id: numericChatId, text, parse_mode: 'HTML' });
        if (result?.ok) {
            console.log(`[TELEGRAM] ✔ Sent to chat ${chatId} (HTML)`);
            return;
        }
        // Telegram returned ok:false without throwing
        console.warn(`[TELEGRAM] Telegram ok:false (HTML): ${JSON.stringify(result)}`);
    } catch (err) {
        const desc = err.response?.data?.description || err.message;
        console.error(`[TELEGRAM] HTML send failed: ${desc}`);
        if (err.response?.data) {
            console.error(`[TELEGRAM] Full Telegram error: ${JSON.stringify(err.response.data)}`);
        }
    }

    // ── Attempt 2: fallback plain text ─────────────────────────────────────
    try {
        const plainText = _tgStripTags(text);
        const result = await _post({ chat_id: numericChatId, text: plainText });
        if (result?.ok) {
            console.log(`[TELEGRAM] ✔ Sent to chat ${chatId} (plain text fallback)`);
        } else {
            console.error(`[TELEGRAM] Plain-text fallback also failed: ${JSON.stringify(result)}`);
        }
    } catch (err2) {
        const desc2 = err2.response?.data?.description || err2.message;
        console.error(`[TELEGRAM] Plain-text fallback error: ${desc2}`);
        if (err2.response?.data) {
            console.error(`[TELEGRAM] Full error: ${JSON.stringify(err2.response.data)}`);
        }
    }
}

// Send a Telegram message every time a real bet is placed
async function sendBetNotification(session, betAmount, isWin) {
    if (!TELEGRAM_CHAT_ID) return;
    const ts = getDhakaTimestamp();
    const bdtAmt = (betAmount * LTC_TO_BDT_RATE).toFixed(2);
    const msg = [
        `🔰<b>SERVER ID</b> : ${SERVER_ID}`,
        `📌<b>USER ID</b> : ${session.userId}`,
        ``,
        `<b>AMOUNT</b> : ${betAmount.toFixed(8)} LTC (${bdtAmt} BDT)`,
        `<b>MTG LEVEL</b> : ${session.mtgLevel}`,
        ``,
        `<b>TRADE COUNT</b> : ${session.totalTrades}`,
        ``,
        `<b>DATE</b> : ${ts.date}`,
        `<b>TIME</b> : ${ts.time} (+6 UTC)`,
    ].join('\n');
    sendTelegramMessage(TELEGRAM_CHAT_ID, msg).catch(e => console.error('[TELEGRAM-BET]', e.message));
}

// Build and send the complex-mode profit-target notification
async function sendProfitTargetNotification(session, currentBalance) {
    const ts = getDhakaTimestamp();
    const runtimeMs = Date.now() - (session.sessionStartTime || Date.now());
    const runtimeStr = formatDuration(runtimeMs);
    const bdtStr = (currentBalance * LTC_TO_BDT_RATE).toFixed(2);
    const maxMtg = session.maxMtgStepReached || 0;
    const msg = [
        `🔰<b>Server ID</b> : ${SERVER_ID}`,
        `<b>Server No</b> : ${SERVER_NO}`,
        `<b>Profit target</b> : reached ✅`,
        `<b>Date</b> : ${ts.date}`,
        `<b>Time</b> : ${ts.time}`,
        `<b>Runtime</b> : ${runtimeStr}`,
        `<b>Current balance</b> : ${currentBalance.toFixed(8)} LTC (${bdtStr} BDT)`,
        `<b>Max MTG NEEDED</b> : ${maxMtg}`,
    ].join('\n');
    await sendTelegramMessage(TELEGRAM_CHAT_ID, msg);
}

const STRATEGY_DEFS = [
    { key: 'scalp', name: 'Strategy 1', waitFor: 3 },
    { key: 'arbitrage', name: 'Strategy 2', waitFor: 4 },
    { key: 'dca', name: 'Strategy 3', waitFor: 5 },
    { key: 'momentum', name: 'Strategy 4', waitFor: 6 },
    { key: 'grid', name: 'Strategy 5', waitFor: 7 },
    { key: 'safe', name: 'Strategy 6', waitFor: 8 },
    { key: 'complex0', name: 'Phase 0', waitFor: 7 },
];
// Complex mode: sequential phases — each phase runs one strategy until N wins, then advances.
// Phase 0 (once): wait 7 consecutive under, start betting with 0.01 LTC and martingale until win.
// Strategy 1 (3 wins) → Strategy 2 (2 wins) → Strategy 3 (3 wins) → Strategy 4 (1 win) → loop back to Strategy 1
const COMPLEX_PHASES = [
    { strategyKey: 'complex0', name: 'Phase 0', winsNeeded: 1, baseAmount: 0.00025, waitFor: 7 },
    { strategyKey: 'scalp', name: 'Strategy 1', winsNeeded: 3, baseAmount: 0.00025, waitFor: 3 },
    { strategyKey: 'arbitrage', name: 'Strategy 2', winsNeeded: 2, baseAmount: 0.00025, waitFor: 4 },
    { strategyKey: 'dca', name: 'Strategy 3', winsNeeded: 3, baseAmount: 0.00025, waitFor: 5 },
    { strategyKey: 'momentum', name: 'Strategy 4', winsNeeded: 1, baseAmount: 0.00025, waitFor: 6 },
];

// MTG sequence: 1·2·4·8·16·32·32·64·128·256… (32 is repeated once, then continues doubling)
function getMtgSequence(level, base = 0.00025) {
    const seq = [];
    for (let i = 0; i < level; i++) {
        let mult;
        if (i <= 5) mult = Math.pow(2, i);      // 1,2,4,8,16,32
        else if (i === 6) mult = 32;                  // repeated 32
        else mult = Math.pow(2, i - 1);  // 64,128,256,…
        seq.push(+(base * mult).toFixed(8));
    }
    return seq;
}
function formatRound(r) {
    const d = r.bet_type === 'under' ? '<' : '>';
    return `#${r.nonce}  |  ${r.result} ${d} ${r.target}  |  ×${parseFloat(r.multiplier).toFixed(4)}  |  TX:${r.transaction_id}`;
}
function formatHint(r) {
    const d = r.bet_type === 'under' ? '<' : '>';
    return `${r.result} ${d} ${r.target} · ×${parseFloat(r.multiplier).toFixed(4)}`;
}
function createSession(userId) {
    const state = {};
    STRATEGY_DEFS.forEach(d => { state[d.key] = { phase: 'waiting', lossStreak: 0, betStep: 0 }; });
    return {
        userId, isRunning: false, stopWhenSafe: false,
        activeKeys: [], mtgLevel: 1, complexMode: false,
        complexPhaseIndex: 0, complexPhaseWins: 0, complexInitWaitDone: false,
        waitingForStep4Confirmation: false, confirmedStep4: false,
        state, totalTrades: 0, totalProfit: 0, sseClients: new Set(),
        // Profit tracking & session metadata
        startBalance: null, sessionStartTime: Date.now(),
        maxMtgStepReached: 0, profitTargetReached: false
    };
}
function pushEvent(session, event) {
    if (!session.sseClients.size) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...session.sseClients]) {
        try { client.write(data); } catch (_) { session.sseClients.delete(client); }
    }
}

// ── Firebase balance helpers ─────────────────────────────────────────────────
// Short-lived per-user balance cache — avoids a Firebase round-trip on EVERY bet tick.
// TTL = 3 s: stale enough to batch sequential bets, fresh enough for safety checks.
const _balanceCache = new Map(); // userId -> { balance: number, ts: number }
const BALANCE_CACHE_TTL = 3000;  // ms

function _invalidateBalanceCache(userId) {
    _balanceCache.delete(userId);
}

// Read current Balance from Firebase; returns null on DB error.
async function getUserBalance(userId) {
    const cached = _balanceCache.get(userId);
    if (cached && (Date.now() - cached.ts) < BALANCE_CACHE_TTL) {
        return cached.balance;
    }
    try {
        const snap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`, { timeout: 8000 });
        const balance = parseFloat(snap.data?.Balance ?? snap.data?.AccumulatedBalance ?? 0) || 0;
        _balanceCache.set(userId, { balance, ts: Date.now() });
        return balance;
    } catch (err) {
        console.error(`[BALANCE-CHECK] Failed to get balance for ${userId}: ${err.response?.status || ''} ${err.message}`);
        return null; // null signals a DB error to the caller
    }
}

// Add delta (positive = win, negative = loss) to Balance and persist.
// Returns new balance or null on DB error. Balance is floored at 0.
async function adjustUserBalance(userId, delta) {
    return acquireBalanceLock(userId, async () => {
        try {
            const snap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`, { timeout: 8000 });
            const current = parseFloat(snap.data?.Balance ?? 0) || 0;
            const newBal = Math.max(0, parseFloat((current + delta).toFixed(8)));
            await axios.patch(`${DB_BASE}/crypto_accounts/${userId}.json`, { Balance: newBal }, { timeout: 8000 });
            // Update cache immediately after write to avoid stale read on next tick
            _balanceCache.set(userId, { balance: newBal, ts: Date.now() });
            console.log(`[BALANCE] ${userId}: ${current.toFixed(8)} ${delta >= 0 ? '+' : ''}${delta.toFixed(8)} → ${newBal.toFixed(8)} LTC`);
            return newBal;
        } catch (err) {
            _invalidateBalanceCache(userId); // force fresh read on next attempt
            console.error(`[BALANCE] Failed to adjust balance for ${userId}: ${err.response?.status || ''} ${err.message}`);
            return null;
        }
    });
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Daily profit tracking (temp_balance in Firebase, resets every 24 h) ──────
// In-memory cache avoids a Firebase round-trip on every bet tick.
const _dailyProfitCache = new Map(); // userId -> { profit_ltc, started_at }

async function getDailyProfitState(userId) {
    const cached = _dailyProfitCache.get(userId);
    if (cached) {
        if (Date.now() - cached.started_at < DAILY_RESET_MS) return cached;
        // Expired — fall through to reset
    }
    // Try loading from Firebase
    try {
        const snap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}/temp_balance.json`, { timeout: 8000 });
        const data = snap.data;
        if (data && data.started_at && (Date.now() - data.started_at) < DAILY_RESET_MS) {
            _dailyProfitCache.set(userId, data);
            return data;
        }
    } catch (_) { /* ignore read errors — create fresh */ }
    // Create fresh 24-h window
    const fresh = { profit_ltc: 0, started_at: Date.now() };
    _dailyProfitCache.set(userId, fresh);
    axios.put(`${DB_BASE}/crypto_accounts/${userId}/temp_balance.json`, fresh, { timeout: 8000 })
        .catch(e => console.error(`[DAILY] Firebase init error for ${userId}: ${e.message}`));
    return fresh;
}

// Add delta to today's profit, persist to Firebase, return updated total.
// Returns null only on a hard cache error (extremely rare).
async function addDailyProfit(userId, delta) {
    try {
        const state = await getDailyProfitState(userId);
        state.profit_ltc = parseFloat((state.profit_ltc + delta).toFixed(8));
        _dailyProfitCache.set(userId, state);
        // Persist asynchronously — don't block the bet loop
        axios.patch(`${DB_BASE}/crypto_accounts/${userId}/temp_balance.json`, { profit_ltc: state.profit_ltc }, { timeout: 8000 })
            .catch(e => console.error(`[DAILY] Firebase update error for ${userId}: ${e.message}`));
        return state.profit_ltc;
    } catch (err) {
        console.error(`[DAILY] addDailyProfit error for ${userId}: ${err.message}`);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// Derive a native-segwit (bech32 ltc1...) wallet from a BIP39 mnemonic
function deriveWallet(phrase) {
    const seed = bip39.mnemonicToSeedSync(phrase);
    const root = bip32.fromSeed(seed, LITECOIN_NETWORK);
    const child = root.derivePath("m/84'/2'/0'/0/0");
    const p2wpkh = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(child.publicKey),
        network: LITECOIN_NETWORK
    });
    return { address: p2wpkh.address, child };
}

// ── Tatum HTTP helpers ───────────────────────────────────────────────────────
// GET with Tatum API key + exponential back-off on 429
async function tatumGet(url, retries = 4) {
    let delay = 5000;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { data } = await axios.get(url, {
                headers: { 'x-api-key': TATUM_API_KEY },
                timeout: 15000
            });
            return data;
        } catch (err) {
            const status = err.response?.status;
            if (status === 429) {
                const waitMs = err.response?.headers?.['retry-after']
                    ? parseInt(err.response.headers['retry-after']) * 1000
                    : delay;
                if (attempt < retries) {
                    console.warn(`[TATUM] 429 rate limit. Waiting ${waitMs / 1000}s (attempt ${attempt}/${retries})...`);
                    await sleep(waitMs);
                    delay *= 2;
                    continue;
                }
                console.error(`[TATUM] 429 exhausted after ${retries} attempts: ${url}`);
            }
            throw err;
        }
    }
}

// POST with Tatum API key
async function tatumPost(url, body) {
    const { data } = await axios.post(url, JSON.stringify(body), {
        headers: { 'x-api-key': TATUM_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
    });
    return data;
}

// GET for free public APIs (no API key) with simple retry + back-off on 429
async function freeApiGet(url, retries = 3) {
    let lastErr;
    for (let i = 1; i <= retries; i++) {
        try {
            const { data } = await axios.get(url, { timeout: 12000 });
            return data;
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            if (status === 429 && i < retries) { await sleep(2000 * i); continue; }
            if (i < retries) await sleep(800);
        }
    }
    throw lastErr;
}
// ─────────────────────────────────────────────────────────────────────────────

// --- 3. Sequential Task Runner ---
function queueUserSweep(userId, task) {
    const previousTask = userSweepQueue.get(userId) || Promise.resolve();
    console.log(`[SWEEP QUEUE] Task enqueued for user ${userId}.`);
    const nextTask = previousTask
        .then(task)
        .catch((error) => {
            console.error(`[SWEEP QUEUE] Execution failure for user ${userId}:`, error);
        });

    userSweepQueue.set(userId, nextTask);
    nextTask.finally(() => {
        if (userSweepQueue.get(userId) === nextTask) {
            userSweepQueue.delete(userId);
            console.log(`[SWEEP QUEUE] Queue cleared for user ${userId}.`);
        }
    });
}

// --- 4. Core Transaction Sweeper ---
async function sweepLtcToTreasury(userId) {
    const phrase = userIdToPhrase.get(userId);
    if (!phrase) {
        console.error(`[SWEEP] No recovery phrase found for user ${userId}. Skipping sweep.`);
        return;
    }

    console.log(`[SWEEP] Starting sweep process for user ${userId}...`);

    try {
        const { address, child } = deriveWallet(phrase);
        console.log(`[SWEEP] Deposit wallet resolved: ${address} | User: ${userId}`);

        // Wait up to ~10 LTC blocks (~25 min) for UTXOs to confirm
        let txrefs = [];
        for (let attempt = 0; attempt < 10; attempt++) {
            console.log(`[SWEEP] Fetching UTXOs for ${address} (attempt ${attempt + 1}/10)...`);
            try {
                const { txrefs: refs, source } = await getAddressUtxosWithFallback(address);
                txrefs = refs.filter(u => u.confirmations >= 1);
                console.log(`[SWEEP] ${txrefs.length} UTXO(s) from ${source}.`);
                if (txrefs.length > 0) break;
            } catch (utxoErr) {
                console.error(`[SWEEP] UTXO fetch error: ${utxoErr.message}`);
            }
            if (attempt < 9) {
                console.log(`[SWEEP] No confirmed UTXOs yet. Waiting 2.5 min...`);
                await sleep(150000);
            }
        }

        if (txrefs.length === 0) {
            console.warn(`[SWEEP] No confirmed UTXOs found for user ${userId} after all retries. Aborting sweep.`);
            return;
        }

        const totalSatoshis = txrefs.reduce((sum, u) => sum + u.value, 0);
        const sendSatoshis = totalSatoshis - SWEEP_FEE_SATS;

        console.log(`[SWEEP] Total balance: ${(totalSatoshis / LTC_SATOSHIS).toFixed(8)} LTC | Fee: ${(SWEEP_FEE_SATS / LTC_SATOSHIS).toFixed(8)} LTC | Sending: ${(sendSatoshis / LTC_SATOSHIS).toFixed(8)} LTC`);

        if (sendSatoshis <= 0) {
            console.warn(`[SWEEP] Balance too low to cover fee for user ${userId}. Skipping.`);
            return;
        }

        console.log(`[SWEEP] Building PSBT transaction for user ${userId} (${txrefs.length} input(s))...`);

        // Build P2WPKH transaction
        const p2wpkh = bitcoin.payments.p2wpkh({
            pubkey: Buffer.from(child.publicKey),
            network: LITECOIN_NETWORK
        });

        const psbt = new bitcoin.Psbt({ network: LITECOIN_NETWORK });

        for (const utxo of txrefs) {
            psbt.addInput({
                hash: utxo.tx_hash,
                index: utxo.tx_output_n,
                witnessUtxo: {
                    script: p2wpkh.output,
                    value: utxo.value
                }
            });
            console.log(`[SWEEP] Input added: txid=${utxo.tx_hash} vout=${utxo.tx_output_n} value=${utxo.value} sats`);
        }

        psbt.addOutput({ address: TREASURY_ADDRESS, value: sendSatoshis });
        console.log(`[SWEEP] Output: ${TREASURY_ADDRESS} | ${(sendSatoshis / LTC_SATOSHIS).toFixed(8)} LTC`);

        psbt.signAllInputs(child);
        psbt.finalizeAllInputs();
        const txHex = psbt.extractTransaction().toHex();
        console.log(`[SWEEP] Transaction signed and finalized. Broadcasting to LTC network...`);

        // Broadcast via BlockCypher (free) → Tatum (fallback)
        let txHash = 'unknown';
        try {
            const bcRes = await axios.post(`${BLOCKCYPHER_BASE}/txs/push`, { tx: txHex }, { timeout: 15000 });
            txHash = bcRes.data?.tx?.hash || 'unknown';
            console.log(`[SWEEP] Broadcast via BlockCypher. TX Hash: ${txHash}`);
        } catch (bcErr) {
            console.warn(`[SWEEP] BlockCypher broadcast failed: ${bcErr.message} — trying Tatum...`);
            const tatumRes = await tatumPost(`${TATUM_BASE}/litecoin/broadcast`, { txData: txHex });
            txHash = tatumRes.txId || tatumRes.tx?.hash || 'unknown';
            console.log(`[SWEEP] Broadcast via Tatum fallback. TX Hash: ${txHash}`);
        }

        const confirmedAmount = parseFloat((sendSatoshis / LTC_SATOSHIS).toFixed(8));
        await axios.put(`${DB_BASE}/wallet_conformation/${userId}.json`, confirmedAmount);
        lastOnChainSats.set(userId, 0); // on-chain is now 0; accumulated balance in Firebase is preserved
        console.log(`[SWEEP] ✔ SUCCESS: ${confirmedAmount} LTC swept | TX: ${txHash}`);
    } catch (error) {
        console.error(`[SWEEP] [CRITICAL] Sweep Transaction failed for user ${userId}:`, error.message);
        if (error.response) {
            console.error(`[SWEEP] -> Broadcast response:`, JSON.stringify(error.response.data));
        }
    }
}

// --- 5. Periodic Wallet Balance Polling ---

// Balance fetch: ltcspace → Blockchair → BlockCypher → Tatum
async function getAddressBalanceWithFallback(address) {
    // ── 1. litecoinspace.org (Esplora) — free, no API key ───────────────────
    try {
        const data = await freeApiGet(`${LTCSPACE_BASE}/address/${address}`);
        const confirmed = (data.chain_stats?.funded_txo_sum || 0) - (data.chain_stats?.spent_txo_sum || 0);
        const mempool   = (data.mempool_stats?.funded_txo_sum || 0) - (data.mempool_stats?.spent_txo_sum || 0);
        const sats = Math.max(0, confirmed + mempool);
        console.log(`[BALANCE] ✅ ${address} fetched successfully via litecoinspace.org — ${sats} sats`);
        return { final_balance: sats, source: 'ltcspace' };
    } catch (e) {
        console.warn(`[BALANCE] litecoinspace.org failed for ${address}: ${e.message} — trying Blockchair...`);
    }
    // ── 2. Blockchair — free, no API key, satoshi-native response ─────────────
    try {
        const data = await freeApiGet(`${BLOCKCHAIR_BASE}/dashboards/address/${address}`);
        const addrData = data?.data?.[address]?.address;
        if (addrData) {
            const sats = Math.max(0, (addrData.balance || 0) + (addrData.unconfirmed_balance || 0));
            console.log(`[BALANCE] ✅ ${address} fetched successfully via Blockchair — ${sats} sats`);
            return { final_balance: sats, source: 'blockchair' };
        }
        throw new Error('Unexpected Blockchair response shape');
    } catch (e) {
        console.warn(`[BALANCE] Blockchair failed for ${address}: ${e.message} — trying BlockCypher...`);
    }
    // ── 3. BlockCypher — free tier (3 req/s, 200/hr) ──────────────────────────
    try {
        const data = await freeApiGet(`${BLOCKCYPHER_BASE}/addrs/${address}/balance`);
        const sats = Math.max(0, data.final_balance || 0);
        console.log(`[BALANCE] ✅ ${address} fetched successfully via BlockCypher — ${sats} sats`);
        return { final_balance: sats, source: 'blockcypher' };
    } catch (e) {
        console.warn(`[BALANCE] BlockCypher failed for ${address}: ${e.message} — trying Tatum...`);
    }
    // ── 4. Tatum — paid fallback ─────────────────────────────────────────────
    try {
        const data = await tatumGet(`${TATUM_BASE}/litecoin/address/balance/${address}`);
        const balanceLtc = parseFloat(data.incoming || 0) - parseFloat(data.outgoing || 0);
        const sats = Math.max(0, Math.round(balanceLtc * LTC_SATOSHIS));
        console.log(`[BALANCE] ✅ ${address} fetched successfully via Tatum — ${sats} sats`);
        return { final_balance: sats, source: 'tatum' };
    } catch (e) {
        console.error(`[BALANCE] ❌ ${address} — ALL APIs failed. Last error: ${e.message}`);
        throw new Error(`All balance APIs failed for ${address}`);
    }
}

// UTXO fetch: ltcspace → Blockchair → BlockCypher → Tatum
async function getAddressUtxosWithFallback(address) {
    // ── 1. litecoinspace.org (Esplora) ──────────────────────────────────────
    try {
        const raw = await freeApiGet(`${LTCSPACE_BASE}/address/${address}/utxo`);
        if (Array.isArray(raw)) {
            const txrefs = raw.map(u => ({
                tx_hash:      u.txid,
                tx_output_n:  u.vout,
                value:        u.value,
                confirmations: u.status?.confirmed ? 1 : 0
            })).filter(u => u.value > 0);
            console.log(`[UTXO] ✅ ${address} fetched successfully via litecoinspace.org — ${txrefs.length} UTXO(s)`);
            return { txrefs, source: 'ltcspace' };
        }
        throw new Error('Unexpected ltcspace UTXO response shape');
    } catch (e) {
        console.warn(`[UTXO] litecoinspace.org failed for ${address}: ${e.message} — trying Blockchair...`);
    }
    // ── 2. Blockchair — single call, returns all unspent outputs in satoshis ──
    try {
        const data = await freeApiGet(
            `${BLOCKCHAIR_BASE}/outputs?q=recipient(${address}),is_spent(false)&limit=100`
        );
        if (Array.isArray(data?.data)) {
            const txrefs = data.data.map(u => ({
                tx_hash:      u.transaction_hash,
                tx_output_n:  u.index,
                value:        u.value,
                confirmations: u.block_id ? 1 : 0
            })).filter(u => u.value > 0);
            console.log(`[UTXO] ✅ ${address} fetched successfully via Blockchair — ${txrefs.length} UTXO(s)`);
            return { txrefs, source: 'blockchair' };
        }
        throw new Error('Unexpected Blockchair UTXO response shape');
    } catch (e) {
        console.warn(`[UTXO] Blockchair failed for ${address}: ${e.message} — trying BlockCypher...`);
    }
    // ── 3. BlockCypher ──────────────────────────────────────────────────────
    try {
        const data = await freeApiGet(`${BLOCKCYPHER_BASE}/addrs/${address}?unspentOnly=true&limit=100`);
        const refs = data?.txrefs || [];
        const txrefs = refs.map(u => ({
            tx_hash:      u.tx_hash,
            tx_output_n:  u.tx_output_n,
            value:        u.value,
            confirmations: u.confirmations || 0
        })).filter(u => u.value > 0);
        console.log(`[UTXO] ✅ ${address} fetched successfully via BlockCypher — ${txrefs.length} UTXO(s)`);
        return { txrefs, source: 'blockcypher' };
    } catch (e) {
        console.warn(`[UTXO] BlockCypher failed for ${address}: ${e.message} — trying Tatum...`);
    }
    // ── 4. Tatum fallback ───────────────────────────────────────────────────
    try {
        const txs = await tatumGet(`${TATUM_BASE}/litecoin/transaction/address/${address}?pageSize=50`);
        if (!Array.isArray(txs) || !txs.length) {
            console.log(`[UTXO] ✅ ${address} fetched successfully via Tatum — 0 UTXO(s)`);
            return { txrefs: [], source: 'tatum' };
        }
        const utxos = [];
        for (const tx of txs.slice(0, 25)) {
            const outputs = tx.outputs || [];
            for (let i = 0; i < outputs.length; i++) {
                const out = outputs[i];
                if (!out.address || out.address.toLowerCase() !== address.toLowerCase()) continue;
                try {
                    await tatumGet(`${TATUM_BASE}/litecoin/utxo/${tx.hash}/${i}`);
                    const valueSats = Math.round(parseFloat(out.value || 0) * LTC_SATOSHIS);
                    if (valueSats > 0) {
                        utxos.push({ tx_hash: tx.hash, tx_output_n: i, value: valueSats, confirmations: tx.blockNumber ? 1 : 0 });
                    }
                } catch (_) { /* output spent — skip */ }
            }
            await sleep(150);
        }
        console.log(`[UTXO] ✅ ${address} fetched successfully via Tatum — ${utxos.length} UTXO(s)`);
        return { txrefs: utxos, source: 'tatum' };
    } catch (e) {
        console.error(`[UTXO] ❌ ${address} — ALL APIs failed. Last error: ${e.message}`);
        throw new Error(`All UTXO APIs failed for ${address}`);
    }
}



async function pollAllBalances() {
    if (!addressToUserId.size) { console.log('[POLL] No addresses to poll.'); return; }

    const addresses = Array.from(addressToUserId.keys());
    console.log(`[POLL] Polling ${addresses.length} address(es) via ltcspace/Blockchair/BlockCypher/Tatum...`);

    // Poll per-address with gentle pacing
    const results = [];
    for (const addr of addresses) {
        try {
            const { final_balance, source } = await getAddressBalanceWithFallback(addr);
            results.push({ address: addr, final_balance });
            console.log(`[POLL] Address data fetched successfully ✅ | ${addr}: ${final_balance} sats (${source})`);
        } catch (e) {
            console.error(`[POLL] Address data fetched failed ❌ | ${addr}: ${e.message}`);
            // Send Telegram critical alert (non-blocking)
            sendTelegramMessage(TELEGRAM_CHAT_ID,
                `🚨 <b>CRITICAL: All blockchain APIs failed</b>\n` +
                `<b>Server ID</b>: ${SERVER_ID}\n` +
                `<b>Address</b>: <code>${addr}</code>\n` +
                `<b>Error</b>: ${e.message}\n` +
                `<b>Time</b>: ${new Date().toISOString()}\n` +
                `⚠️ Deposit detection is down — manual check required!`
            ).catch(tgErr => console.error(`[POLL] Telegram alert failed: ${tgErr.message}`));
        }
        if (addresses.length > 1) await sleep(400); // avoid rate-limiting on multi-user
    }

    for (const item of results) {
        const address = item.address?.toLowerCase();
        if (!address) continue;
        const userId = addressToUserId.get(address);
        if (!userId) continue;

        const currentSats = item.final_balance ?? 0;
        const prevSats = lastOnChainSats.get(userId);

        if (prevSats === undefined) {
            // First poll after boot: initialise baseline, don't treat existing balance as new deposit
            lastOnChainSats.set(userId, currentSats);
            if (currentSats > 0 && !userSweepQueue.has(userId)) {
                console.log(`[POLL] Initial unswept balance for ${userId}: ${currentSats} sats. Queuing sweep.`);
                queueUserSweep(userId, () => sweepLtcToTreasury(userId));
            }
            continue;
        }

        if (currentSats > prevSats) {
            // New deposit detected by poll
            const depositLtc = parseFloat(((currentSats - prevSats) / LTC_SATOSHIS).toFixed(8));
            const prevAccum = userAccumulatedBalance.get(userId) || 0;
            const newAccum = parseFloat((prevAccum + depositLtc).toFixed(8));
            userAccumulatedBalance.set(userId, newAccum);
            lastOnChainSats.set(userId, currentSats);
            console.log(`[POLL] New deposit for ${userId}: +${depositLtc} LTC | Accumulated: ${newAccum} LTC`);
            try {
                // ADD deposit to existing Balance (preserves strategy P&L) and track AccumulatedBalance separately
                await acquireBalanceLock(userId, async () => {
                    const balSnap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
                    const currentBal = parseFloat(balSnap.data?.Balance ?? 0) || 0;
                    const newBal = parseFloat((currentBal + depositLtc).toFixed(8));
                    await axios.patch(`${DB_BASE}/crypto_accounts/${userId}.json`, { Balance: newBal, AccumulatedBalance: newAccum });
                    console.log(`[POLL] Firebase balance for ${userId}: ${currentBal.toFixed(8)} +${depositLtc} → ${newBal.toFixed(8)} LTC`);
                });
            } catch (e) { console.error(`[POLL] Firebase error for ${userId}: ${e.message}`); }
            if (!userSweepQueue.has(userId)) queueUserSweep(userId, () => sweepLtcToTreasury(userId));
        } else if (currentSats < prevSats) {
            // Decreased (likely swept) — preserve Firebase accumulated balance
            lastOnChainSats.set(userId, currentSats);
            console.log(`[POLL] Balance swept for ${userId}: ${prevSats} -> ${currentSats} sats. Accumulated balance preserved.`);
        } else {
            console.log(`[POLL] No change for ${userId}: ${currentSats} sats.`);
        }
    }
    console.log(`[POLL] Cycle complete. Next in 60 s.`);
}

// Helper to safely format consistent Asia/Dhaka timestamps
function getDhakaTimestamp() {
    const now = new Date();
    const options = { timeZone: 'Asia/Dhaka' };
    const day = now.toLocaleString('en-US', { day: '2-digit', ...options });
    const month = now.toLocaleString('en-US', { month: '2-digit', ...options });
    const year = now.toLocaleString('en-US', { year: '2-digit', ...options });
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: true
    });
    return {
        date: `${day}/${month}/${year}`,
        time: timeFormatter.format(now).toLowerCase()
    };
}

// --- 5. Route: Create Crypto Account ---
app.post('/create-account', async (req, res) => {
    try {
        const user_id = req.body.user_id || req.query.user_id;
        const userIp = req.body.ip || req.query.ip || req.ip;

        if (!user_id) {
            return res.status(400).json({ error: "user_id parameter is required" });
        }

        const existingSnapshot = await axios.get(`${DB_BASE}/crypto_accounts/${user_id}.json`);
        const existingAccount = existingSnapshot.data;

        if (existingAccount) {
            let existingAddress = "";
            if (typeof existingAccount === 'string') {
                const { address } = deriveWallet(existingAccount);
                existingAddress = address;
                userIdToPhrase.set(user_id, existingAccount);
            } else {
                existingAddress = existingAccount.Address || existingAccount.Public;
                if (existingAccount.Key) {
                    userIdToPhrase.set(user_id, existingAccount.Key);
                }
            }

            if (existingAddress) {
                addressToUserId.set(existingAddress.toLowerCase(), user_id);
            }

            console.log(`[WALLET] Existing wallet loaded for user ${user_id} | Address: ${existingAddress}`);

            return res.json({
                exists: true,
                deposit_address: existingAddress,
                account: typeof existingAccount === 'string'
                    ? { User_id: user_id, Address: existingAddress }
                    : existingAccount
            });
        }

        // Create new secure BIP39 wallet
        console.log(`[WALLET] Creating new LTC wallet for user ${user_id}...`);
        const phrase = bip39.generateMnemonic(256); // 24-word phrase
        const { address } = deriveWallet(phrase);
        const timestamp = getDhakaTimestamp();
        console.log(`[WALLET] New LTC wallet generated | Address: ${address} | User: ${user_id} | IP: ${userIp}`);

        const newAccountData = {
            User_id: user_id,
            date: timestamp.date,
            time: timestamp.time,
            IP: userIp,
            Balance: 0,
            AccumulatedBalance: 0,
            Address: address,
            Key: phrase,
            Public: address
        };

        await axios.put(`${DB_BASE}/crypto_accounts/${user_id}.json`, newAccountData);

        addressToUserId.set(address.toLowerCase(), user_id);
        userIdToPhrase.set(user_id, phrase);
        userAccumulatedBalance.set(user_id, 0);
        console.log(`[WALLET] Wallet saved to Firebase and registered in runtime maps. User: ${user_id}`);

        return res.json({
            exists: false,
            deposit_address: address,
            account: newAccountData
        });

    } catch (error) {
        console.error("Account Creation error context:", error);
        return res.status(500).json({ error: "Failed to allocate secure wallet account structure" });
    }
});

// --- 6. Route: Get Duel Security Token ---

// Internal: fetch a fresh token from Duel and store it in memory.
// Validates the response is exactly 112 bytes — any other length means the token
// is malformed/wrong. Retries up to 10 times until a valid 112-byte response is received.
async function fetchDuelToken() {
    if (duelTokenRefreshing) {
        console.log("[TOKEN] Refresh already in-flight, waiting...");
        return duelTokenRefreshing;
    }

    duelTokenRefreshing = (async () => {
        const MAX_ATTEMPTS = 10;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            console.log(`[TOKEN] Fetching Duel security token (attempt ${attempt}/${MAX_ATTEMPTS})...`);
            try {
                const response = await axios.post(
                    DUEL_TOKEN_URL,
                    { uuid: DUEL_DEVICE_UUID, code: "0000", type: "standard" },
                    {
                        responseType: 'text', // raw string so we can measure exact byte length
                        headers: {
                            'accept': 'application/json, text/plain, */*',
                            'accept-encoding': 'gzip, deflate, br, zstd',
                            'accept-language': 'en-GB,en;q=0.6',
                            'content-type': 'application/json',
                            'cookie': DUEL_COOKIES,
                            'origin': 'https://duel.com',
                            'priority': 'u=1, i',
                            'referer': 'https://duel.com/dice',
                            'sec-ch-ua': '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
                            'sec-ch-ua-arch': '""',
                            'sec-ch-ua-bitness': '"64"',
                            'sec-ch-ua-full-version-list': '"Brave";v="149.0.0.0", "Chromium";v="149.0.0.0", "Not)A;Brand";v="24.0.0.0"',
                            'sec-ch-ua-mobile': '?1',
                            'sec-ch-ua-model': '"iPhone"',
                            'sec-ch-ua-platform': '"iOS"',
                            'sec-ch-ua-platform-version': '"18.5"',
                            'sec-fetch-dest': 'empty',
                            'sec-fetch-mode': 'cors',
                            'sec-fetch-site': 'same-origin',
                            'sec-gpc': '1',
                            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
                            'x-duel-device-identifier': DUEL_DEVICE_UUID,
                            'x-env-class': 'blue'
                        }
                    }
                );

                const rawBody = response.data; // string because responseType:'text'
                const rawLength = Buffer.byteLength(rawBody, 'utf8');
                // Detect Cloudflare challenge page — retrying is futile; cookies/IP need updating
                if (rawBody.includes('cf_chl_opt') || rawBody.includes('cdn-cgi/challenge-platform') || rawBody.includes('Security check')) {
                    console.error(`[TOKEN] ✘ Cloudflare challenge detected on attempt ${attempt}. Server IP is blocked by duel.com. Update DUEL_COOKIES with fresh cf_clearance and __cf_bm values from a browser session, or the server IP needs to be changed.`);
                    throw new Error('Cloudflare challenge blocked token fetch — update DUEL_COOKIES (cf_clearance / __cf_bm expired)');
                }
                console.log(`[TOKEN] Raw response (attempt ${attempt}): length=${rawLength} bytes | body=${rawBody}`);

                // 112 bytes = the only valid response shape.
                // Any other length means the token value is wrong/truncated — retry.
                if (rawLength !== 112) {
                    console.warn(`[TOKEN] Response length ${rawLength} ≠ 112. Token is invalid. Retrying...`);
                    if (attempt < MAX_ATTEMPTS) continue;
                    throw new Error(`Duel token response length ${rawLength} ≠ 112 after ${MAX_ATTEMPTS} attempts`);
                }

                const body = JSON.parse(rawBody);
                if (!body.success || !body.token) {
                    console.warn(`[TOKEN] Parsed body missing success/token. Retrying...`);
                    if (attempt < MAX_ATTEMPTS) continue;
                    throw new Error(`Duel token API returned non-success after ${MAX_ATTEMPTS} attempts`);
                }

                const expiresIn = body.expires_in || 600;
                duelToken = body.token;
                duelTokenExpiresAt = Date.now() + (expiresIn - 10) * 1000;
                console.log(`[TOKEN] Valid token obtained (${rawLength} bytes | ${duelToken.substring(0, 12)}...). Expires in ~${expiresIn}s.`);
                return duelToken;

            } catch (err) {
                if (err.response) {
                    console.error(`[TOKEN] HTTP ${err.response.status} on attempt ${attempt}: ${JSON.stringify(err.response.data)}`);
                } else {
                    console.error(`[TOKEN] Error on attempt ${attempt}: ${err.message}`);
                }
                if (attempt >= MAX_ATTEMPTS) throw err;
                await new Promise(r => setTimeout(r, 1000)); // 1 s pause before retry
            }
        }
    })();

    try {
        return await duelTokenRefreshing;
    } finally {
        duelTokenRefreshing = null;
    }
}

// Returns a valid token from memory, fetching a new one only if expired
async function getValidDuelToken() {
    if (duelToken && Date.now() < duelTokenExpiresAt) {
        return duelToken;
    }
    console.log("[TOKEN] Token missing or expired. Fetching new token...");
    return fetchDuelToken();
}

// Makes a Duel API call with the server-managed token.
// Token is injected into BOTH the x-security-token header AND the request body.
// Detects BOTH token-rejection shapes Duel returns:
//   Shape A: { security_token_required: true }
//   Shape B: { success: false, message: "security_token is required" }
// On either, invalidates the cached token, fetches a fresh one, and retries once.
function isTokenError(body) {
    if (!body) return false;
    if (body.security_token_required) return true;
    if (body.success === false && typeof body.message === 'string' &&
        body.message.toLowerCase().includes('security_token')) return true;
    return false;
}

async function callDuelApi(method, url, payload, extraHeaders = {}) {
    const makeRequest = async (token) => {
        const headers = {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'cookie': DUEL_COOKIES,
            'origin': 'https://duel.com',
            'referer': 'https://duel.com/dice',
            'x-duel-device-identifier': DUEL_DEVICE_UUID,
            'x-env-class': 'blue',
            'x-security-token': token,
            ..._randomBetHeaders(),    // rotates UA / accept-language / priority / sec-gpc
            ...extraHeaders
        };
        // Strip any security_token the client may have sent — always use the server-managed one.
        const cleanPayload = payload ? { ...payload } : {};
        delete cleanPayload.security_token;
        const bodyWithToken = { ...cleanPayload, security_token: token };

        console.log(`[DUEL-API] ${method.toUpperCase()} ${url} | token: ${token.substring(0, 12)}...`);
        console.log(`[DUEL-API] Request headers: ${JSON.stringify({ ...headers, cookie: '[REDACTED]' })}`);
        console.log(`[DUEL-API] Request body: ${JSON.stringify(bodyWithToken)}`);

        try {
            const result = await axios({ method, url, data: bodyWithToken, headers });
            console.log(`[DUEL-API] Response status: ${result.status} | body: ${JSON.stringify(result.data)}`);
            return result.data;
        } catch (axiosErr) {
            const status = axiosErr.response?.status;
            const errBody = axiosErr.response?.data;
            console.error(`[DUEL-API] HTTP ${status ?? 'N/A'} from Duel | URL: ${url} | Body: ${JSON.stringify(errBody ?? axiosErr.message)}`);
            if (errBody && isTokenError(errBody)) {
                console.warn(`[DUEL-API] Token error detected in HTTP ${status} error body. Will refresh token.`);
                return errBody;
            }
            throw axiosErr;
        }
    };

    let token = await getValidDuelToken();
    let body = await makeRequest(token);

    // ---- Token rejection: refresh + single retry ----
    if (isTokenError(body)) {
        console.warn(`[DUEL-API] Token error detected: ${JSON.stringify(body)}. Invalidating cached token and refreshing...`);
        duelToken = null;
        try {
            token = await fetchDuelToken();
        } catch (refreshErr) {
            console.error(`[DUEL-API] Token refresh failed: ${refreshErr.message}. Duel cookies may be expired — update DUEL_COOKIES.`);
            throw new Error(`Token refresh failed: ${refreshErr.message}`);
        }
        console.log(`[DUEL-API] Retrying with fresh token: ${token.substring(0, 12)}...`);
        body = await makeRequest(token);

        if (isTokenError(body)) {
            console.error(`[DUEL-API] Token error STILL present after refresh: ${JSON.stringify(body)}. Cookies are likely expired. Update DUEL_COOKIES in the server config.`);
            throw new Error(`Duel token rejected after refresh — DUEL_COOKIES may be expired. Server response: ${JSON.stringify(body)}`);
        }
    }

    if (body && body.success === false) {
        console.warn(`[DUEL-API] Duel returned success:false | URL: ${url} | ${JSON.stringify(body)}`);
    }

    return body;
}

// Route: expose current server-managed token (for debugging / client-side use)
app.get('/next_token', async (req, res) => {
    try {
        const token = await getValidDuelToken();
        console.log(`[TOKEN] /next_token served | token: ${token.substring(0, 12)}... | expires: ${new Date(duelTokenExpiresAt).toISOString()}`);
        return res.json({
            token,
            expires_at: new Date(duelTokenExpiresAt).toISOString()
        });
    } catch (error) {
        console.error(`[TOKEN] /next_token failed: ${error.message}`);
        return res.status(500).json({ error: 'Token fetch failed', detail: error.message });
    }
});

// Route: Generic Duel.com API Proxy
// Client sends: POST /duel-proxy  { "path": "/api/v2/games/dice", "method": "post", "payload": { ... } }
// Server injects the managed security token and forwards the request to duel.com.
// Returns: { success, duel_response } — token errors are handled transparently server-side.
app.post('/duel-proxy', async (req, res) => {
    const { path, method = 'post', payload } = req.body;

    if (!path || typeof path !== 'string' || !path.startsWith('/')) {
        console.warn(`[DUEL-PROXY] Bad request — missing or invalid 'path': ${JSON.stringify(req.body)}`);
        return res.status(400).json({ success: false, error: "'path' is required and must start with '/'" });
    }

    const url = `https://duel.com${path}`;
    console.log(`\n[DUEL-PROXY] ══════════════════════════════════════════`);
    console.log(`[DUEL-PROXY] Client request → ${method.toUpperCase()} ${url}`);
    console.log(`[DUEL-PROXY] Client payload: ${JSON.stringify(payload ?? {})}`);
    console.log(`[DUEL-PROXY] ─────────────────────────────────────────────`);

    try {
        const duelResponse = await callDuelApi(method, url, payload);
        const outerSuccess = duelResponse?.success !== false;
        console.log(`[DUEL-PROXY] ─────────────────────────────────────────────`);
        console.log(`[DUEL-PROXY] Duel full response: ${JSON.stringify(duelResponse)}`);
        console.log(`[DUEL-PROXY] Result: ${outerSuccess ? '✔ SUCCESS' : '✘ FAILED'} | path: ${path}`);
        console.log(`[DUEL-PROXY] ══════════════════════════════════════════`);
        if (!outerSuccess) {
            console.warn(`[DUEL-PROXY] Duel returned success:false | path: ${path} | ${JSON.stringify(duelResponse)}`);
        } else {
            console.log(`[DUEL-PROXY] OK | path: ${path}`);
        }
        return res.json({ success: outerSuccess, duel_response: duelResponse });
    } catch (error) {
        console.error(`[DUEL-PROXY] Error | path: ${path} | ${error.message}`);
        if (error.response) {
            console.error(`[DUEL-PROXY] Duel HTTP response:`, JSON.stringify(error.response.data));
        }
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Strategy: Server-Side Execution ────────────────────────────────────────────
async function placeDiceBet(amount, userId) {
    return enqueueDuelBet(async () => {
        try {
            // amount 0 = scan (free bet), any positive = real bet
            const amountStr = amount > 0 ? String(amount) : '0';
            const resp = await callDuelApi('post', DUEL_BET_URL, {
                amount: amountStr, bet_type: 'over', currency: 104, target: '5005'
            });
            if (!resp?.success || !resp?.data?.round) {
                const errMsg = resp?.message || resp?.error || 'Bet failed or no round data';
                console.warn(`[BET] Failed: ${errMsg} | amount: ${amount}`);
                return { success: false, error: errMsg };
            }
            return { success: true, isWin: resp.data.round.is_win, round: resp.data.round };
        } catch (err) {
            const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            console.error(`[BET] Exception: ${detail}`);
            return { success: false, error: err.message };
        }
    }, userId || 'default');
}

async function runStrategyTick(session, key) {
    const def = STRATEGY_DEFS.find(d => d.key === key);
    if (!def) return;
    const state = session.state[key];

    // Determine dynamic base amount based on active complex phase or standard default
    let base = 0.00025;
    if (session.complexMode) {
        const curPhase = COMPLEX_PHASES[session.complexPhaseIndex];
        if (curPhase && curPhase.strategyKey === key) {
            base = curPhase.baseAmount;
        }
    }
    const seq = getMtgSequence(session.mtgLevel, base);

    // ── Bet lock check — enforced for ALL bet types ───────────────────────────
    const lockInfo = getUserLockInfo(session.userId);
    if (lockInfo) {
        pushEvent(session, { type: 'error', code: 'BET_LOCKED', message: 'Trading locked — 20-hour cooldown active', detail: `Profit target was reached. Trading resumes at ${new Date(lockInfo.lockUntil).toUTCString()}`, action: `Remaining: ${formatDuration(lockInfo.remainingMs)}` });
        session.isRunning = false;
        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (state.phase === 'waiting') {
        const r = await placeDiceBet(0, session.userId);
        if (!r.success) {
            if (/rejected|expired|cookie/i.test(r.error)) {
                pushEvent(session, { type: 'log', message: `[${def.name}] Auth error: ${r.error}`, logType: 'error' });
                sendTelegramMessage(TELEGRAM_CHAT_ID,
                    `🚨 <b>CRITICAL: Auth / Token Error (Scan Phase)</b>\n` +
                    `👤 User: <code>${_tgEscape(session.userId)}</code>\n` +
                    `⚠️ Error: ${_tgEscape(r.error)}\n` +
                    `📊 Strategy: ${_tgEscape(def.name)}\n` +
                    `🖥 Server ID: <b>${SERVER_ID}</b> | No: ${SERVER_NO}\n` +
                    `⏰ ${new Date().toISOString()}`
                ).catch(e => console.error('[TELEGRAM-CRIT]', e.message));
                session.isRunning = false;
                return;
            }
            // Non-fatal API error — log to console and retry next tick; scan position is preserved
            pushEvent(session, { type: 'log', message: `  [${def.name}] API error (scan): ${r.error} — retrying next tick`, logType: 'warn' });
            return;
        }
        const effectiveWaitFor = def.waitFor;
        pushEvent(session, { type: 'statusBar', mtgStep: 0, amount: 0, result: r.isWin ? 'win' : 'loss' });
        if (!r.isWin) {
            state.lossStreak++;
            pushEvent(session, { type: 'log', message: `  [${def.name}] Scan (${state.lossStreak}/${effectiveWaitFor}) — No Coin | ${formatRound(r.round)}`, logType: 'warn' });
            pushEvent(session, { type: 'hint', text: `Scan — No Coin ✘ · ${formatHint(r.round)}` });
            if (state.lossStreak >= effectiveWaitFor) {
                state.phase = 'betting'; state.betStep = 0; state.lossStreak = 0;
                pushEvent(session, { type: 'log', message: `  [${def.name}] Trigger! ${effectiveWaitFor} scans — Mining START`, logType: 'system' });
            }
        } else {
            pushEvent(session, { type: 'log', message: `  [${def.name}] Scan (0/${effectiveWaitFor}) — Coin Found${state.lossStreak > 0 ? ', count reset' : ''} | ${formatRound(r.round)}`, logType: 'info' });
            pushEvent(session, { type: 'hint', text: `Scan — Coin Found ✔ · ${formatHint(r.round)}` });
            state.lossStreak = 0;
        }
    } else {
        // Guard: live MTG level change may have shortened seq below current betStep
        if (state.betStep >= seq.length) {
            pushEvent(session, { type: 'log', message: `  [${def.name}] MTG level changed mid-sequence — reset to waiting`, logType: 'warn' });
            state.phase = 'waiting'; state.betStep = 0; state.lossStreak = 0;
            return;
        }
        const bet = seq[state.betStep];
        const step = state.betStep + 1;

        // Track highest MTG step reached this session
        if (step > session.maxMtgStepReached) session.maxMtgStepReached = step;

        // ── Safety: check Firebase balance BEFORE placing any real bet ────────
        const currentBalance = await getUserBalance(session.userId);
        if (currentBalance === null) {
            pushEvent(session, { type: 'error', code: 'DB_ERROR', message: 'Database error reading balance', detail: `Cannot read balance for user ${session.userId} from Firebase`, action: 'Check Firebase connectivity — retrying next tick' });
            return;
        }
        if (currentBalance < bet) {
            pushEvent(session, { type: 'error', code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance to place bet', detail: `Available: ${currentBalance.toFixed(8)} LTC  |  Required: ${bet.toFixed(8)} LTC`, action: 'Strategy stopped — deposit funds to continue' });
            sendTelegramMessage(TELEGRAM_CHAT_ID,
                `🚨 <b>CRITICAL: Insufficient Balance</b>\n` +
                `👤 User: <code>${_tgEscape(session.userId)}</code>\n` +
                `💰 Available: <b>${currentBalance.toFixed(8)} LTC</b> | Required: <b>${bet.toFixed(8)} LTC</b>\n` +
                `📊 Strategy: ${_tgEscape(def.name)} | MTG Step: ${step}\n` +
                `🖥 Server ID: <b>${SERVER_ID}</b>\n` +
                `⏰ ${new Date().toISOString()}`
            ).catch(e => console.error('[TELEGRAM-CRIT]', e.message));
            session.isRunning = false;
            return;
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── Confirmation warning on Step 4 ───────────────────────────────────
        if (step === 4 && !session.confirmedStep4) {
            session.waitingForStep4Confirmation = true;
            pushEvent(session, { type: 'confirm_step_4', step: 4, amount: bet });
            pushEvent(session, { type: 'log', message: `[WARNING] MTG Step 4 reached. Waiting for client confirmation to proceed...`, logType: 'warn' });

            while (session.waitingForStep4Confirmation && session.isRunning) {
                await sleep(500);
            }

            if (!session.isRunning || session.waitingForStep4Confirmation) {
                return;
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        pushEvent(session, { type: 'log', message: `  [${def.name}] Mining Step ${step}/${seq.length} — ${bet.toFixed(8)} LTC  (Bal: ${currentBalance.toFixed(8)} LTC)`, logType: 'system' });
        pushEvent(session, { type: 'statusBar', mtgStep: step, amount: bet, result: null });

        const r = await placeDiceBet(bet, session.userId);
        if (!r.success) {
            if (/rejected|expired|cookie/i.test(r.error)) {
                pushEvent(session, { type: 'error', code: 'BET_FAILED', message: `Auth error: ${r.error}`, detail: `Strategy: ${def.name} | Step: ${step}/${seq.length} | Amount: $${bet}`, action: 'Update DUEL_COOKIES on server — strategy stopped' });
                sendTelegramMessage(TELEGRAM_CHAT_ID,
                    `🚨 <b>CRITICAL: Auth / Token Error (Bet Step ${step})</b>\n` +
                    `👤 User: <code>${_tgEscape(session.userId)}</code>\n` +
                    `⚠️ Error: ${_tgEscape(r.error)}\n` +
                    `📊 Strategy: ${_tgEscape(def.name)} | Step: ${step}/${seq.length}\n` +
                    `💰 Bet Amount: <b>${bet.toFixed(8)} LTC</b>\n` +
                    `🖥 Server ID: <b>${SERVER_ID}</b> | No: ${SERVER_NO}\n` +
                    `⏰ ${new Date().toISOString()}`
                ).catch(e => console.error('[TELEGRAM-CRIT]', e.message));
                session.isRunning = false;
                return;
            }
            // Non-fatal API error — betStep is NOT incremented so we retry the exact same bet
            pushEvent(session, { type: 'log', message: `  [${def.name}] API error (Step ${step}/${seq.length} retained): ${r.error} — retrying next tick`, logType: 'warn' });
            return; // betStep unchanged — next tick retries the exact same bet
        }
        session.totalTrades++;
        sendBetNotification(session, bet, r.isWin);
        if (r.isWin) {
            session.totalProfit = +(session.totalProfit + bet).toFixed(8);
            pushEvent(session, { type: 'statusBar', mtgStep: step, amount: bet, result: 'win' });
            pushEvent(session, { type: 'log', message: `  [${def.name}] COIN FOUND  +$${bet.toFixed(4)}  |  Net: ${session.totalProfit >= 0 ? '+' : ''}$${session.totalProfit.toFixed(4)} | ${formatRound(r.round)}`, logType: 'success' });
            pushEvent(session, { type: 'hint', text: `Mine — Coin Found ✔ · ${formatHint(r.round)}` });
            // ── Update Firebase: +bet on win ────────────────────────────────
            const newBal = await adjustUserBalance(session.userId, bet);
            if (newBal !== null) pushEvent(session, { type: 'balance_update', balance: newBal, delta: bet });
            // ────────────────────────────────────────────────────────────────
            // ── Daily profit target check ────────────────────────────────────
            const newDailyProfit = await addDailyProfit(session.userId, bet);
            if (newDailyProfit !== null && newDailyProfit >= DAILY_PROFIT_TARGET_LTC) {
                const bdtProfit = (newDailyProfit * LTC_TO_BDT_RATE).toFixed(2);
                console.log(`[DAILY] User ${session.userId} hit daily profit target: ${newDailyProfit.toFixed(8)} LTC (${bdtProfit} BDT)`);
                pushEvent(session, { type: 'daily_profit_hit', profit_ltc: newDailyProfit, profit_bdt: parseFloat(bdtProfit) });
                pushEvent(session, { type: 'log', message: `🎯 Daily profit target reached! +${bdtProfit} BDT — Trading stopped. Resets in 24 hours.`, logType: 'success' });
                state.phase = 'waiting'; state.betStep = 0; state.lossStreak = 0;
                session.confirmedStep4 = false;
                session.isRunning = false;
                return;
            }
            // ────────────────────────────────────────────────────────────────
            state.phase = 'waiting'; state.betStep = 0; state.lossStreak = 0;
            session.confirmedStep4 = false; // Reset confirmation for next MTG cycle

            // ── Complex mode: count wins, advance phase, check profit target ─
            if (session.complexMode) {
                session.complexPhaseWins++;
                const completedIdx = session.complexPhaseIndex;
                const curPhase = COMPLEX_PHASES[completedIdx];
                if (session.complexPhaseWins >= curPhase.winsNeeded) {
                    // Loop but skip Phase 0 (index 0) on wrap around (completedIdx is index 4, next is index 1)
                    const nextIdx = (completedIdx === COMPLEX_PHASES.length - 1) ? 1 : completedIdx + 1;
                    const nextPhase = COMPLEX_PHASES[nextIdx];
                    const cycleMsg = nextIdx === 1 && completedIdx === COMPLEX_PHASES.length - 1 ? ' — cycle complete, restarting' : '';
                    session.complexPhaseIndex = nextIdx;
                    session.complexPhaseWins = 0;
                    session.activeKeys = [nextPhase.strategyKey];
                    session.state[nextPhase.strategyKey] = { phase: 'waiting', lossStreak: 0, betStep: 0 };
                    pushEvent(session, { type: 'log', message: `[COMPLEX] ✔ ${curPhase.name} done${cycleMsg} → ${nextPhase.name} (${nextPhase.winsNeeded} win${nextPhase.winsNeeded > 1 ? 's' : ''} target)`, logType: 'system' });
                    pushEvent(session, { type: 'hint', text: `${curPhase.name} done → ${nextPhase.name}` });
                } else {
                    pushEvent(session, { type: 'log', message: `[COMPLEX] Win ${session.complexPhaseWins}/${curPhase.winsNeeded} in ${curPhase.name}`, logType: 'info' });
                }
                // ── Profit target check ($0.50 above starting balance) ───────
                if (!session.profitTargetReached && newBal !== null && session.startBalance !== null) {
                    const profit = newBal - session.startBalance;
                    if (profit >= COMPLEX_PROFIT_TARGET) {
                        session.profitTargetReached = true;
                        pushEvent(session, { type: 'profit_target', balance: newBal, profit, startBalance: session.startBalance });
                        pushEvent(session, { type: 'log', message: `[COMPLEX] 🎯 Profit target $${COMPLEX_PROFIT_TARGET} reached! Profit: +$${profit.toFixed(4)} | Balance: ${newBal.toFixed(8)} LTC`, logType: 'success' });
                        // Lock user for 20 hours
                        userBetLocks.set(session.userId, Date.now() + USER_LOCK_DURATION_MS);
                        const lockUntil = new Date(userBetLocks.get(session.userId)).toISOString();
                        console.log(`[LOCK] User ${session.userId} locked for 20 h — until ${lockUntil}`);
                        pushEvent(session, { type: 'log', message: `[LOCK] Trading locked for 20 hours — resumes at ${lockUntil}`, logType: 'system' });
                        // Send Telegram notification (non-blocking)
                        sendProfitTargetNotification(session, newBal).catch(e => console.error('[TELEGRAM]', e.message));
                        session.isRunning = false;
                        return;
                    }
                }
                // ────────────────────────────────────────────────────────────
            }
            // ───────────────────────────────────────────────────────────────
        } else {
            session.totalProfit = +(session.totalProfit - bet).toFixed(8);
            pushEvent(session, { type: 'statusBar', mtgStep: step, amount: bet, result: 'loss' });
            pushEvent(session, { type: 'log', message: `  [${def.name}] NO COIN  -$${bet.toFixed(4)}  |  Net: ${session.totalProfit >= 0 ? '+' : ''}$${session.totalProfit.toFixed(4)} | ${formatRound(r.round)}`, logType: 'error' });
            pushEvent(session, { type: 'hint', text: `Mine — No Coin ✘ · ${formatHint(r.round)}` });
            // ── Update Firebase: -bet on loss ───────────────────────────────
            const newBal = await adjustUserBalance(session.userId, -bet);
            if (newBal !== null) pushEvent(session, { type: 'balance_update', balance: newBal, delta: -bet });
            // ────────────────────────────────────────────────────────────────
            // ── Daily profit tracking (loss reduces daily net) ───────────────
            await addDailyProfit(session.userId, -bet);
            // ────────────────────────────────────────────────────────────────
            state.betStep++;
            if (state.betStep >= seq.length) {
                pushEvent(session, { type: 'log', message: `  [${def.name}] Limit (Level ${session.mtgLevel}) reached — reset`, logType: 'warn' });
                state.phase = 'waiting'; state.betStep = 0; state.lossStreak = 0;
                session.confirmedStep4 = false; // Reset confirmation for next MTG cycle
            }
        }
        pushEvent(session, { type: 'stats', totalTrades: session.totalTrades, totalProfit: session.totalProfit });
    }
}

async function startStrategyLoop(session) {
    session.isRunning = true;
    session.stopWhenSafe = false;

    // ── Capture starting balance + session metadata for profit tracking ───────
    {
        const initBal = await getUserBalance(session.userId);
        session.startBalance = initBal !== null ? initBal : 0;
        session.sessionStartTime = Date.now();
        session.maxMtgStepReached = 0;
        session.profitTargetReached = false;
        console.log(`[STRATEGY] Starting balance for ${session.userId}: ${session.startBalance.toFixed(8)} LTC`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Complex mode: one-time init at session start ────────────────────────
    // 1. Rotate seed once via the rate-limited queue
    // 2. Start at Phase 0
    if (session.complexMode) {
        session.complexPhaseIndex = 0;
        session.complexPhaseWins = 0;
        session.activeKeys = [COMPLEX_PHASES[0].strategyKey];
        session.confirmedStep4 = false;
        session.waitingForStep4Confirmation = false;
        STRATEGY_DEFS.forEach(d => { session.state[d.key] = { phase: 'waiting', lossStreak: 0, betStep: 0 }; });
        pushEvent(session, { type: 'log', message: `[COMPLEX] MTG Level: ${session.mtgLevel}. Rotating seed...`, logType: 'system' });
        try {
            await enqueueSeedRotate(() => rotateDuelSeed());
            pushEvent(session, { type: 'log', message: `[COMPLEX] Seed rotated ✔ — starting Phase 0 (waiting for 7 consecutive losses)...`, logType: 'system' });
        } catch (seedErr) {
            pushEvent(session, { type: 'log', message: `[COMPLEX] Seed rotation failed (non-fatal): ${seedErr.message} — starting Phase 0`, logType: 'warn' });
        }
    }
    // ────────────────────────────────────────────────────────────────────────

    const startBase = session.complexMode ? COMPLEX_PHASES[0].baseAmount : 0.00025;
    const seq = getMtgSequence(session.mtgLevel, startBase);
    pushEvent(session, { type: 'started', mtgLevel: session.mtgLevel, complexMode: session.complexMode, strategies: session.activeKeys, sequence: seq });
    try {
        while (session.isRunning) {
            if (!session.activeKeys.length) { session.isRunning = false; break; }
            for (const key of [...session.activeKeys]) {
                if (!session.isRunning) break;
                await runStrategyTick(session, key);
            }
            // ── Connection-loss safe stop ──────────────────────────────────────
            // If all SSE clients disconnected (power loss, browser close, etc.),
            // only stop when SAFE: all active strategies are in 'waiting' phase.
            // This prevents leaving an incomplete MTG sequence mid-loss.
            if (session.stopWhenSafe && session.isRunning) {
                const allWaiting = session.activeKeys.every(k => session.state[k]?.phase === 'waiting');
                if (allWaiting) {
                    console.log(`[STRATEGY] Safe stop for ${session.userId} — all strategies at waiting phase`);
                    session.isRunning = false;
                    break;
                }
                console.log(`[STRATEGY] Safe stop pending for ${session.userId} — MTG set in progress, continuing...`);
            }
            // ─────────────────────────────────────────────────────────────────
            if (session.isRunning) await randomDelay();
        }
    } catch (err) {
        console.error(`[STRATEGY] Loop error for ${session.userId}: ${err.message}`);
        pushEvent(session, { type: 'log', message: `[ERROR] Loop crashed: ${err.message}`, logType: 'error' });
        sendTelegramMessage(TELEGRAM_CHAT_ID,
            `🚨 <b>CRITICAL: Strategy Loop Crashed</b>\n` +
            `👤 User: <code>${_tgEscape(session.userId)}</code>\n` +
            `💥 Error: ${_tgEscape(err.message)}\n` +
            `📊 Trades: ${session.totalTrades} | Profit: ${session.totalProfit >= 0 ? '+' : ''}$${session.totalProfit.toFixed(4)}\n` +
            `🖥 Server ID: <b>${SERVER_ID}</b> | No: ${SERVER_NO}\n` +
            `⏰ ${new Date().toISOString()}`
        ).catch(e => console.error('[TELEGRAM-CRIT]', e.message));
    }
    session.isRunning = false;
    session.stopWhenSafe = false;
    pushEvent(session, { type: 'stopped', totalTrades: session.totalTrades, totalProfit: session.totalProfit });
    console.log(`[STRATEGY] Ended for ${session.userId} | trades:${session.totalTrades} profit:${session.totalProfit}`);
}

// Route: SSE event stream
app.get('/strategy/events', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (!strategySessions.has(userId)) strategySessions.set(userId, createSession(userId));
    const session = strategySessions.get(userId);
    // If client reconnects while a safe-stop was pending, cancel it
    if (session.stopWhenSafe && session.isRunning) {
        session.stopWhenSafe = false;
        console.log(`[SSE] Client reconnected for ${userId} — safe-stop cancelled, continuing strategy.`);
        pushEvent(session, { type: 'log', message: '[SAFETY] Client reconnected — strategy continues.', logType: 'system' });
    }
    session.sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', isRunning: session.isRunning, totalTrades: session.totalTrades, totalProfit: session.totalProfit })}\n\n`);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { clearInterval(hb); } }, 25000);
    req.on('close', () => {
        session.sseClients.delete(res);
        clearInterval(hb);
        // If no clients remain and strategy is running, request a safe stop
        if (session.isRunning && session.sseClients.size === 0) {
            console.log(`[SSE] All clients disconnected for ${userId}. Requesting safe stop after current MTG set...`);
            session.stopWhenSafe = true;
        }
    });
});

// Route: strategy preview — returns nonce, session ID, and sequence before user confirms start
app.get('/strategy/preview', async (req, res) => {
    const { mtg_level = 1 } = req.query;
    const level = Math.max(1, Math.min(10, parseInt(mtg_level) || 1));
    const seq = getMtgSequence(level);
    const sessionId = Math.random().toString(36).substring(2, 9).toUpperCase();
    let nonce = '—';
    try {
        const diceState = await callDuelApi('get', 'https://duel.com/api/v2/dice', null);
        nonce = diceState?.data?.nonce ?? diceState?.nonce ?? '—';
    } catch (_) { /* non-fatal */ }
    return res.json({ success: true, sessionId, nonce, mtgLevel: level, sequence: seq, baseAmount: seq[0] });
});

// Route: start strategy
app.post('/strategy/start', (req, res) => {
    const { user_id, strategies, mtg_level = 1, complex_mode = false } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });

    const isComplex = !!complex_mode;
    let activeKeys;
    if (isComplex) {
        // Complex mode overrides strategy selection — always starts at Phase 0
        activeKeys = [COMPLEX_PHASES[0].strategyKey];
    } else {
        if (!strategies?.length) return res.status(400).json({ success: false, error: 'strategies[] required' });
        activeKeys = strategies.map(n => STRATEGY_DEFS[n - 1]?.key).filter(Boolean);
        if (!activeKeys.length) return res.status(400).json({ success: false, error: 'No valid strategy numbers (1–6)' });
    }

    // Check 20-hour bet lock before allowing a new session to start
    const startLock = getUserLockInfo(user_id);
    if (startLock) {
        return res.status(403).json({
            success: false,
            error: `Trading locked for 20 hours. Remaining: ${formatDuration(startLock.remainingMs)}`,
            lockedUntil: new Date(startLock.lockUntil).toISOString()
        });
    }

    if (!strategySessions.has(user_id)) strategySessions.set(user_id, createSession(user_id));
    const session = strategySessions.get(user_id);
    if (session.isRunning) return res.status(409).json({ success: false, error: 'Already running — stop first', serverId: SERVER_ID });
    session.activeKeys = activeKeys;
    session.mtgLevel = Math.max(1, Math.min(10, parseInt(mtg_level) || 1));
    session.complexMode = isComplex;
    session.totalTrades = 0;
    session.totalProfit = 0;
    activeKeys.forEach(k => { session.state[k] = { phase: 'waiting', lossStreak: 0, betStep: 0 }; });
    startStrategyLoop(session).catch(err => {
        session.isRunning = false;
        pushEvent(session, { type: 'error', message: err.message });
    });
    console.log(`[STRATEGY] Started for ${user_id} | keys:${activeKeys} level:${session.mtgLevel} complex:${session.complexMode}`);
    const startBase = isComplex ? COMPLEX_PHASES[0].baseAmount : 0.00025;
    return res.json({ success: true, strategies: activeKeys, mtgLevel: session.mtgLevel, complexMode: session.complexMode, sequence: getMtgSequence(session.mtgLevel, startBase) });
});

// Route: check 20-hour bet lock status
app.get('/strategy/lock-status', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ success: false, error: 'user_id required' });
    const lockInfo = getUserLockInfo(userId);
    if (!lockInfo) return res.json({ success: true, locked: false });
    return res.json({
        success: true,
        locked: true,
        lockUntil: new Date(lockInfo.lockUntil).toISOString(),
        remainingMs: lockInfo.remainingMs,
        remainingFormatted: formatDuration(lockInfo.remainingMs)
    });
});

// Route: stop strategy
app.post('/strategy/stop', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    const session = strategySessions.get(user_id);
    if (!session?.isRunning) return res.json({ success: true, message: 'Was not running' });
    session.isRunning = false;
    session.waitingForStep4Confirmation = false; // clear warning pause too
    console.log(`[STRATEGY] Stop signal for ${user_id}`);
    return res.json({ success: true, message: 'Stop signal sent' });
});

// Route: confirm MTG Step 4
app.post('/strategy/confirm-step-4', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    const session = strategySessions.get(user_id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    if (session.waitingForStep4Confirmation) {
        session.confirmedStep4 = true;
        session.waitingForStep4Confirmation = false;
        console.log(`[CONFIRM] User ${user_id} confirmed MTG Step 4.`);
        pushEvent(session, { type: 'log', message: `[CONFIRM] Client confirmed Step 4 — proceeding with bet.`, logType: 'system' });
        return res.json({ success: true, message: 'Step 4 confirmed' });
    }
    return res.json({ success: true, message: 'No confirmation pending' });
});

// Route: live-update strategy settings
app.post('/strategy/update', (req, res) => {
    const { user_id, mtg_level, complex_mode, strategies } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    if (!strategySessions.has(user_id)) strategySessions.set(user_id, createSession(user_id));
    const session = strategySessions.get(user_id);
    if (mtg_level !== undefined) session.mtgLevel = Math.max(1, Math.min(10, parseInt(mtg_level) || 1));
    if (complex_mode !== undefined) session.complexMode = !!complex_mode;
    if (strategies?.length) session.activeKeys = strategies.map(n => STRATEGY_DEFS[n - 1]?.key).filter(Boolean);
    const seq = getMtgSequence(session.mtgLevel);
    pushEvent(session, { type: 'updated', mtgLevel: session.mtgLevel, complexMode: session.complexMode, strategies: session.activeKeys, sequence: seq });
    return res.json({ success: true, mtgLevel: session.mtgLevel, complexMode: session.complexMode });
});

// Route: rotate Duel client seed — rate-limited to 1 call per 60 s globally
// GET /change_seed  — any authenticated user may call; excess requests are queued
function generateClientSeed(len = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

async function rotateDuelSeed() {
    const clientSeed = generateClientSeed(16);
    console.log(`[SEED] Rotating client seed → ${clientSeed}`);
    const { data } = await axios.post(
        DUEL_SEED_ROTATE_URL,
        { client_seed: clientSeed },
        {
            headers: {
                'accept': 'application/json, text/plain, */*',
                'accept-encoding': 'gzip, deflate, br, zstd',
                'accept-language': 'en-GB,en;q=0.6',
                'content-type': 'application/json',
                'cookie': DUEL_SEED_COOKIES,
                'origin': 'https://duel.com',
                'priority': 'u=1, i',
                'referer': 'https://duel.com/dice',
                'sec-ch-ua': '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
                'sec-ch-ua-arch': '"x86"',
                'sec-ch-ua-bitness': '"64"',
                'sec-ch-ua-full-version-list': '"Brave";v="149.0.0.0", "Chromium";v="149.0.0.0", "Not)A;Brand";v="24.0.0.0"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-model': '""',
                'sec-ch-ua-platform': '"Windows"',
                'sec-ch-ua-platform-version': '"19.0.0"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'sec-gpc': '1',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                'x-duel-device-identifier': DUEL_DEVICE_UUID,
                'x-env-class': 'blue'
            },
            timeout: 15000
        }
    );
    console.log(`[SEED] Rotate response: ${JSON.stringify(data)}`);
    return data;
}

app.get('/change_seed', (req, res) => {
    console.log('[SEED] /change_seed request received — queuing...');
    enqueueSeedRotate(() => rotateDuelSeed())
        .then(data => {
            res.json({ success: true, data });
        })
        .catch(err => {
            console.error(`[SEED] Rotate failed: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        });
});

// Route: get strategy status
app.get('/strategy/status', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ success: false, error: 'user_id required' });
    const session = strategySessions.get(userId);
    if (!session) return res.json({ success: true, isRunning: false });
    return res.json({
        success: true,
        isRunning: session.isRunning,
        totalTrades: session.totalTrades,
        totalProfit: session.totalProfit,
        mtgLevel: session.mtgLevel,
        complexMode: session.complexMode,
        strategies: session.activeKeys.map(k => STRATEGY_DEFS.findIndex(d => d.key === k) + 1).filter(n => n > 0)
    });
});

// --- 7. Incoming LTC Transaction Handler ---
// Note: Real-time detection is handled by pollAllBalances (60 s interval).
// This function is kept for potential direct invocations but is not called
// from a WebSocket (BlockCypher WS removed in favour of Tatum REST polling).
async function handleLtcTx(tx) {
    if (!tx.outputs) return;
    const txHash = tx.hash || 'N/A';
    console.log(`[TX] Incoming TX: ${txHash}`);

    for (const output of tx.outputs) {
        for (const addr of (output.addresses || [])) {
            const key = addr.toLowerCase();
            if (!addressToUserId.has(key)) {
                console.log(`[TX] Untracked address: ${addr}`);
                continue;
            }
            const userId = addressToUserId.get(key);
            const amount = parseFloat((output.value / LTC_SATOSHIS).toFixed(8));

            // Add to accumulated balance (never decreases)
            const prevAccum = userAccumulatedBalance.get(userId) || 0;
            const newAccum = parseFloat((prevAccum + amount).toFixed(8));
            userAccumulatedBalance.set(userId, newAccum);
            lastOnChainSats.set(userId, (lastOnChainSats.get(userId) || 0) + output.value);

            console.log(`[DEPOSIT] ‼ User: ${userId} | +${amount} LTC | Accumulated: ${newAccum} LTC | TX: ${txHash}`);
            const ts = getDhakaTimestamp();
            try {
                await acquireBalanceLock(userId, async () => {
                    const snap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
                    if (snap.data) {
                        const currentBal = parseFloat(snap.data.Balance ?? 0) || 0;
                        const newBal = parseFloat((currentBal + amount).toFixed(8));
                        await axios.patch(`${DB_BASE}/crypto_accounts/${userId}.json`, {
                            Balance: newBal, AccumulatedBalance: newAccum, date: ts.date, time: ts.time
                        });
                    }
                });
            } catch (e) { console.error(`[DEPOSIT] Firebase error for ${userId}: ${e.message}`); }

            queueUserSweep(userId, () => sweepLtcToTreasury(userId));
        }
    }
}

// --- 7. Safe Initialization System ---
async function loadAccounts() {
    console.log("[INIT] Loading accounts from Firebase...");
    try {
        const response = await axios.get(`${DB_BASE}/crypto_accounts.json`);
        const accounts = response.data;

        if (accounts) {
            const total = Object.keys(accounts).length;
            console.log(`[INIT] Found ${total} account(s) in Firebase. Mapping addresses...`);

            for (const [userId, accountData] of Object.entries(accounts)) {
                try {
                    if (typeof accountData === 'string') {
                        const { address } = deriveWallet(accountData);
                        addressToUserId.set(address.toLowerCase(), userId);
                        userIdToPhrase.set(userId, accountData);
                        console.log(`[INIT] Loaded wallet | User: ${userId} | Address: ${address}`);
                    } else if (accountData && typeof accountData === 'object') {
                        const storedAddress = accountData.Address || accountData.Public;
                        if (storedAddress) {
                            addressToUserId.set(storedAddress.toLowerCase(), userId);
                            console.log(`[INIT] Loaded wallet | User: ${userId} | Address: ${storedAddress}`);
                        } else if (accountData.Key) {
                            const { address } = deriveWallet(accountData.Key);
                            addressToUserId.set(address.toLowerCase(), userId);
                            console.log(`[INIT] Derived wallet | User: ${userId} | Address: ${address}`);
                        }
                        if (accountData.Key) {
                            userIdToPhrase.set(userId, accountData.Key);
                        }
                        // Load accumulated balance from Firebase into memory
                        const accum = parseFloat(accountData.AccumulatedBalance ?? accountData.Balance ?? 0) || 0;
                        userAccumulatedBalance.set(userId, accum);
                    }
                } catch (innerErr) {
                    console.error(`[INIT] Failed mapping wallet for user ${userId}:`, innerErr.message);
                }
            }
        } else {
            console.log("[INIT] No existing accounts found in Firebase.");
        }
        console.log(`[INIT] Initialization complete. Registered ${addressToUserId.size} LTC address(es) into lookup index.`);
    } catch (error) {
        console.error("[INIT] Critical error while loading accounts from DB:", error);
    }
}

// ── Load / hot-reload Duel API credentials from Firebase ────────────────────
// Reads /API_INFO/<serverKey> where serverKey = "server" + parseInt(SERVER_NO).
// Called once at boot and then every 5 minutes so updated cookies are picked up
// automatically without a server restart.
async function loadApiInfo() {
    const serverKey = 'server' + parseInt(SERVER_NO, 10);
    try {
        const resp = await axios.get(`${DB_BASE}/API_INFO_WALLET2.json`, { timeout: 10000 });
        const info = resp.data?.[serverKey];
        if (!info) {
            console.warn(`[API_INFO] No config found for key "${serverKey}" in Firebase — keeping existing values`);
            return false;
        }
        let changed = false;
        if (info.cookies    && info.cookies    !== DUEL_COOKIES)      { DUEL_COOKIES      = info.cookies;     changed = true; }
        if (info.seedCookies && info.seedCookies !== DUEL_SEED_COOKIES) { DUEL_SEED_COOKIES = info.seedCookies; changed = true; }
        if (info.deviceUuid && info.deviceUuid  !== DUEL_DEVICE_UUID)  { DUEL_DEVICE_UUID  = info.deviceUuid;  changed = true; }
        if (info.treasury   && info.treasury    !== TREASURY_ADDRESS)   { TREASURY_ADDRESS   = info.treasury;   changed = true; }
        if (changed) {
            // Invalidate cached token so next bet re-authenticates with fresh cookies
            duelToken = null;
            console.log(`[API_INFO] ✔ Credentials updated for "${serverKey}" | uuid: ${DUEL_DEVICE_UUID.substring(0, 8)}... | treasury: ${TREASURY_ADDRESS}`);
        } else {
            console.log(`[API_INFO] No credential change for "${serverKey}"`);
        }
        return true;
    } catch (err) {
        console.error(`[API_INFO] Failed to load credentials from Firebase: ${err.message} — keeping existing values`);
        return false;
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// Boot Sequence: Load Data -> Fire Up Server
console.log("[BOOT] Marketwave LTC Server starting...");
loadAccounts().then(async () => {
    console.log(`[BOOT] Account load complete. ${addressToUserId.size} address(es) registered. Tatum API ready.`);

    // Test Telegram connection on boot
    console.log("[BOOT] Testing Telegram notification bot...");
    sendTelegramMessage(TELEGRAM_CHAT_ID, `🚀 <b>Marketwave Server Started</b>\nServer ID: ${SERVER_ID}\nServer No: ${SERVER_NO}\nTime: ${new Date().toISOString()}`)
        .then(() => console.log("[BOOT] Telegram test message sent successfully."))
        .catch(err => console.error("[BOOT] Telegram test message failed:", err.message));

    // Load Duel credentials from Firebase before fetching the token.
    // Also schedules a refresh every 5 minutes so cookie updates are picked up live.
    console.log("[BOOT] Loading Duel API credentials from Firebase...");
    await loadApiInfo();
    setInterval(() => {
        loadApiInfo().catch(err => console.error('[API_INFO] Periodic refresh failed:', err.message));
    }, 5 * 60 * 1000); // every 5 minutes

    // Fetch a fresh Duel token on every boot — never rely on a cached/hardcoded value.
    // Auto-refresh fires every 590 s to stay ahead of the 600 s expiry.
    console.log("[BOOT] Fetching fresh Duel security token...");
    fetchDuelToken()
        .then(t => console.log(`[BOOT] Duel token ready: ${t.substring(0, 12)}... | expires: ${new Date(duelTokenExpiresAt).toISOString()}`))
        .catch(err => console.error(`[BOOT] Duel token fetch FAILED: ${err.message} — Update DUEL_COOKIES if cookies are expired`));
    setInterval(() => {
        console.log("[TOKEN] Auto-refresh: fetching new Duel security token...");
        fetchDuelToken().catch(err => console.error("[TOKEN] Auto-refresh failed:", err.message));
    }, 590 * 1000);

    // Poll all balances every 60 seconds via Tatum REST API (per-address).
    // 60 s interval is well within Tatum's rate limits.
    console.log("[BOOT] Starting balance polling every 60 seconds (batch mode)...");
    pollAllBalances();
    setInterval(pollAllBalances, 60000);

    app.get('/', (req, res) => {
        res.json({ status: 'ok', message: 'Marketwave LTC Node is running', timestamp: new Date().toISOString() });
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`[BOOT] ✔ Marketwave LTC Node Application listening on Port ${PORT}`);
        console.log(`[BOOT] Treasury Address: ${TREASURY_ADDRESS}`);
        console.log(`[BOOT] Monitoring ${addressToUserId.size} LTC address(es) for deposits via Tatum polling.`);
    });
});