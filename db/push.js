import { db } from './index.js';

export function saveSubscription(userId, { endpoint, keys }) {
    const now = Date.now();
    db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
    ).run(userId, endpoint, keys.p256dh, keys.auth, now);
}

export function removeSubscription(endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function listSubscriptions(userId) {
    return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
}

export function hasSubscription(userId) {
    return !!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1').get(userId);
}

export function setReviewBatchSize(userId, size) {
    const n = Math.max(1, Math.min(50, Number(size) || 5));
    db.prepare('UPDATE users SET review_batch_size = ? WHERE id = ?').run(n, userId);
}

export function setTextScale(userId, scale) {
    const allowed = [0.7, 0.85, 1, 1.15, 1.3];
    const s = allowed.includes(Number(scale)) ? Number(scale) : 0.85;
    db.prepare('UPDATE users SET text_scale = ? WHERE id = ?').run(s, userId);
}

export function setReminderFrequency(userId, hours) {
    const allowed = [0, 24, 48, 72, 168];
    const h = allowed.includes(Number(hours)) ? Number(hours) : 0;
    db.prepare('UPDATE users SET reminder_frequency_hours = ? WHERE id = ?').run(h, userId);
}

export function setReminderHour(userId, hour) {
    const h = Math.max(0, Math.min(23, Math.trunc(Number(hour))));
    db.prepare('UPDATE users SET reminder_hour = ? WHERE id = ?').run(Number.isFinite(h) ? h : 9, userId);
}

// Users whose reminder is due: enabled, the current (server-TZ) hour
// matches their chosen reminder_hour, and the configured interval has
// elapsed since the last one -- a 1-hour buffer below the exact interval
// means a reminder due "in 24h" still fires on the next day's matching hour
// even if this tick lands a few minutes early, without ever double-firing
// within the same day (elapsed resets to ~0 right after sending).
export function usersDueForReminder(now = Date.now()) {
    const currentHour = new Date(now).getHours();
    return db
        .prepare(
            `SELECT * FROM users
             WHERE reminder_frequency_hours > 0
             AND reminder_hour = ?
             AND (last_reminded_at IS NULL OR ? - last_reminded_at >= (reminder_frequency_hours - 1) * 3600000)`
        )
        .all(currentHour, now);
}

export function markReminded(userId, now = Date.now()) {
    db.prepare('UPDATE users SET last_reminded_at = ? WHERE id = ?').run(now, userId);
}
