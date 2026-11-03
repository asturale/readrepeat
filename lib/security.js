import crypto from 'crypto';

// Headers that need no per-page tuning. No script-src yet: several views still use
// inline <script> blocks (accepted risk, see README "Security").
export function securityHeaders(req, res, next) {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
    });
    next();
}

// Failed sign-ins per client IP: at most MAX_FAILS per WINDOW_MS, then 429 until the window ends.
// shortcut: in-memory, so it resets on restart and isn't shared between instances; fine for a single-user app.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const fails = new Map(); // ip -> { count, resetAt }

export function loginBlocked(ip, now = Date.now()) {
    const f = fails.get(ip);
    if (!f || f.resetAt <= now) return false;
    return f.count >= MAX_FAILS;
}

export function recordLoginFailure(ip, now = Date.now()) {
    const f = fails.get(ip);
    if (!f || f.resetAt <= now) fails.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    else f.count += 1;
    if (fails.size > 10000) for (const [k, v] of fails) if (v.resetAt <= now) fails.delete(k);
}

export function clearLoginFailures(ip) {
    fails.delete(ip);
}

// One-time setup code: until the first account exists, /setup needs this code from the
// container log, so whoever reaches a fresh instance first can't claim it.
let setupCode = null;

export function issueSetupCode(log = console.log) {
    setupCode = crypto.randomBytes(9).toString('base64url');
    log(`No account yet. Setup code for /setup (valid until the first account is created): ${setupCode}`);
    return setupCode;
}

export function checkSetupCode(given) {
    if (!setupCode || typeof given !== 'string') return false;
    const a = Buffer.from(given.trim());
    const b = Buffer.from(setupCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clearSetupCode() {
    setupCode = null;
}
