import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_PATH || '/data/readrepeat.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS books (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL,
    author         TEXT,
    cover_url      TEXT,
    hardcover_id   INTEGER,
    normalized_key TEXT NOT NULL UNIQUE,
    -- Per-boek review-frequentie-knop: 1.0 = normaal, 2.0 = 2x zo vaak terug
    -- in de review-wachtrij (SM-2-interval wordt erdoor gedeeld), 0.5 = half
    -- zo vaak. Toegepast in reviews.js's recordReview().
    review_weight  REAL NOT NULL DEFAULT 1.0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS highlights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    note        TEXT,
    location    TEXT,
    color       TEXT,
    source      TEXT NOT NULL,
    source_id   TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(book_id, source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);

-- Spaced repetition, opt-in per highlight (NOT auto-created for every
-- highlight -- with 5000+ existing highlights on day one, auto-enrolling
-- everything would dump an unmanageable backlog into the queue). SM-2-lite:
-- ease_factor/interval_days/repetitions follow the classic SuperMemo-2 update
-- rule, due_at is what the /review queue orders on.
CREATE TABLE IF NOT EXISTS reviews (
    highlight_id    INTEGER PRIMARY KEY REFERENCES highlights(id) ON DELETE CASCADE,
    ease_factor     REAL NOT NULL DEFAULT 2.5,
    interval_days   REAL NOT NULL DEFAULT 0,
    repetitions     INTEGER NOT NULL DEFAULT 0,
    due_at          INTEGER NOT NULL,
    last_reviewed_at INTEGER,
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_due ON reviews(due_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- One row per (user, calendar day) a review session was completed on --
-- server-TZ local date as 'YYYY-MM-DD', not a timestamp, so a day either
-- counts or doesn't regardless of how many sessions happened that day.
-- Drives both the streak counter and the Account calendar.
CREATE TABLE IF NOT EXISTS session_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
);
`);

// Idempotent column migration -- `CREATE TABLE IF NOT EXISTS` above is a
// no-op against an already-existing table, so a NEW column on an EXISTING
// table (this app already has real, live data) needs its own ALTER step.
function ensureColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
}
ensureColumn('books', 'review_weight', 'review_weight REAL NOT NULL DEFAULT 1.0');
// Readwise "Action Tags" support (https://docs.readwise.io/readwise/guides/action-tags):
// a note starting with "." is parsed as structure/tags instead of stored as
// a literal note -- see lib/action-tags.js.
ensureColumn('highlights', 'chapter', 'chapter TEXT');
ensureColumn('highlights', 'tags', 'tags TEXT');
ensureColumn('highlights', 'is_heading', 'is_heading INTEGER NOT NULL DEFAULT 0');
ensureColumn('highlights', 'heading_level', 'heading_level INTEGER');
// NULL = no explicit preference, fall back to the browser's Accept-Language
// on every request (see lib/i18n.js's detectLocale).
ensureColumn('users', 'locale', 'locale TEXT');
ensureColumn('users', 'review_batch_size', 'review_batch_size INTEGER NOT NULL DEFAULT 5');
// Hours between reminder pushes; 0 = reminders disabled (default -- opt-in,
// unlike highlight review itself which is opt-out).
ensureColumn('users', 'reminder_frequency_hours', 'reminder_frequency_hours INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'last_reminded_at', 'last_reminded_at INTEGER');
// Local hour (0-23, server TZ -- see compose.yaml's TZ=Europe/Amsterdam) at
// which a due reminder is allowed to fire.
ensureColumn('users', 'reminder_hour', 'reminder_hour INTEGER NOT NULL DEFAULT 9');
// Scale multiplier applied to the review page's highlight text only (not
// book page/search) -- rem-based so it stays relative to the browser's own
// default font size. See review.ejs's --text-scale usage.
ensureColumn('users', 'text_scale', 'text_scale REAL NOT NULL DEFAULT 0.85');
// Set when a /review batch is fully completed (all its cards swiped/
// actioned through) -- "done for today" on the dashboard means this falls
// on today's date, NOT that the whole (potentially huge, backfilled) due
// queue has hit zero.
ensureColumn('users', 'last_session_completed_at', 'last_session_completed_at INTEGER');
// Dashboard "Feed" sort choice, remembered across visits -- 'recent' |
// 'random' | 'oldest'.
ensureColumn('users', 'feed_mode', "feed_mode TEXT NOT NULL DEFAULT 'recent'");

export function userCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
