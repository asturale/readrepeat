import { db } from './index.js';

// Password field never round-trips to the browser (see views/import.ejs --
// same pattern as the AI provider keys in Settings), so an UPDATE with a
// blank password must keep the existing one rather than wiping it every
// time the interval or enabled flag is changed.
export function setCrosspointSettings(userId, { enabled, serverUrl, username, password, intervalMinutes }) {
    const minutes = Math.max(5, Math.min(1440, Math.trunc(Number(intervalMinutes)) || 60));
    db.prepare(
        `UPDATE users SET
            crosspoint_enabled = ?,
            crosspoint_server_url = ?,
            crosspoint_username = ?,
            crosspoint_password = COALESCE(NULLIF(?, ''), crosspoint_password),
            crosspoint_interval_minutes = ?
         WHERE id = ?`
    ).run(
        enabled ? 1 : 0,
        serverUrl ? serverUrl.trim().replace(/\/+$/, '') : null,
        username ? username.trim() : null,
        password || '',
        minutes,
        userId
    );
}

// Interval-based due-check (unlike the Telegram digest's fixed hour-of-day):
// due as soon as crosspoint_interval_minutes have elapsed since the last
// sync, or immediately if it has never run.
export function usersDueForCrosspointSync(now = Date.now()) {
    return db
        .prepare(
            `SELECT * FROM users
             WHERE crosspoint_enabled = 1
             AND crosspoint_server_url IS NOT NULL
             AND crosspoint_username IS NOT NULL
             AND crosspoint_password IS NOT NULL
             AND (crosspoint_last_synced_at IS NULL OR ? - crosspoint_last_synced_at >= crosspoint_interval_minutes * 60000)`
        )
        .all(now);
}

export function markCrosspointSynced(userId, { error = null, now = Date.now() } = {}) {
    db.prepare('UPDATE users SET crosspoint_last_synced_at = ?, crosspoint_last_sync_error = ? WHERE id = ?').run(now, error, userId);
}
