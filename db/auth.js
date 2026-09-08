import crypto from 'crypto';
import { db } from './index.js';

// scrypt (Node built-in, no extra dependency) -- salted, per-user.
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const check = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

export function createUser(username, password) {
    const now = Date.now();
    const info = db
        .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(username, hashPassword(password), now);
    return info.lastInsertRowid;
}

export function findUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function findUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// locale: null clears the explicit preference, falls back to the browser's
// Accept-Language on every request (see lib/i18n.js).
export function setUserLocale(userId, locale) {
    db.prepare('UPDATE users SET locale = ? WHERE id = ?').run(locale || null, userId);
}

export function markSessionCompleted(userId) {
    db.prepare('UPDATE users SET last_session_completed_at = ? WHERE id = ?').run(Date.now(), userId);
}

// "Done for today" = the last completed /review session falls on the
// caller's current local calendar day (server TZ -- see compose.yaml's
// TZ=Europe/Amsterdam), NOT that the whole due queue is at zero -- with a
// large backfilled backlog that could be thousands of highlights away.
export function completedSessionToday(user, now = Date.now()) {
    if (!user.last_session_completed_at) return false;
    const a = new Date(user.last_session_completed_at);
    const b = new Date(now);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// API tokens: only the SHA-256 hash is stored, the plaintext token is shown
// to the user exactly once (at creation) -- same principle as GitHub PATs.
export function createApiToken(userId, label) {
    const token = 'read_' + crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('INSERT INTO api_tokens (user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)').run(
        userId,
        hash,
        label || null,
        Date.now()
    );
    return token;
}

export function findUserByApiToken(token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db
        .prepare(
            `SELECT u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
        )
        .get(hash);
    if (row) {
        db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), hash);
    }
    return row;
}

export function listApiTokens(userId) {
    return db
        .prepare('SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId);
}

export function revokeApiToken(userId, tokenId) {
    db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(tokenId, userId);
}
