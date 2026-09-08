// Minimal express-session store backed by the SAME better-sqlite3 db this
// app already has open -- avoids pulling in `connect-sqlite3`, whose
// dependency chain (sqlite3 -> node-gyp -> tar/cacache/make-fetch-happen)
// carries a critical `node-tar` advisory (arbitrary file write via hardlink
// path traversal) that's otherwise unused build-time-only weight for
// something this simple. Implements just the Store interface express-session
// actually calls: get/set/destroy (+ touch, used to bump expiry on activity).
import session from 'express-session';
import { db } from './index.js';

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// Sweep expired rows occasionally rather than on every request.
setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

export class SqliteSessionStore extends session.Store {
    get(sid, cb) {
        try {
            const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
            if (!row || row.expires_at < Date.now()) return cb(null, null);
            cb(null, JSON.parse(row.data));
        } catch (e) {
            cb(e);
        }
    }

    set(sid, sessionData, cb) {
        try {
            const maxAge = sessionData.cookie?.maxAge ?? 1000 * 60 * 60 * 24;
            const expiresAt = Date.now() + maxAge;
            db.prepare(
                `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
                 ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
            ).run(sid, JSON.stringify(sessionData), expiresAt);
            cb?.(null);
        } catch (e) {
            cb?.(e);
        }
    }

    destroy(sid, cb) {
        try {
            db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
            cb?.(null);
        } catch (e) {
            cb?.(e);
        }
    }

    touch(sid, sessionData, cb) {
        this.set(sid, sessionData, cb);
    }
}
