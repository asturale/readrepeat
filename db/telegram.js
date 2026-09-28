import { db } from './index.js';

export function setTelegramChatId(userId, chatId) {
    const id = chatId ? String(chatId).trim() : null;
    db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?').run(id || null, userId);
}

export function setTelegramDigest(userId, { enabled, hour, count }) {
    const h = Math.max(0, Math.min(23, Math.trunc(Number(hour))));
    const n = Math.max(1, Math.min(20, Math.trunc(Number(count)) || 5));
    db.prepare(
        'UPDATE users SET telegram_digest_enabled = ?, telegram_digest_hour = ?, telegram_digest_count = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, Number.isFinite(h) ? h : 8, n, userId);
}

// Same due-check shape as db/push.js's usersDueForReminder(): hour match +
// roughly 24h since the last send (1h buffer so a slightly-early tick still
// counts, without ever double-firing the same day).
export function usersDueForTelegramDigest(now = Date.now()) {
    const currentHour = new Date(now).getHours();
    return db
        .prepare(
            `SELECT * FROM users
             WHERE telegram_digest_enabled = 1
             AND telegram_chat_id IS NOT NULL
             AND telegram_digest_hour = ?
             AND (last_telegram_digest_at IS NULL OR ? - last_telegram_digest_at >= 23 * 3600000)`
        )
        .all(currentHour, now);
}

export function markTelegramDigestSent(userId, now = Date.now()) {
    db.prepare('UPDATE users SET last_telegram_digest_at = ? WHERE id = ?').run(now, userId);
}

// Used by the webhook (routes/telegram.js) to match an inbound message's
// chat back to a ReadRepeat account -- only set once a user has pasted
// their chat ID into Settings (see setTelegramChatId above).
export function findUserByTelegramChatId(chatId) {
    return db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(String(chatId));
}
