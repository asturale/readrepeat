import { db } from './index.js';

const DEFAULT_REVIEW_COUNT = 5;
const DEFAULT_INTERVAL_DAYS = 3;

export function isInReview(highlightId) {
    return !!db.prepare('SELECT 1 FROM reviews WHERE highlight_id = ?').get(highlightId);
}

export function addToReview(highlightId) {
    const now = Date.now();
    db.prepare(
        `INSERT OR IGNORE INTO reviews (highlight_id, due_at, created_at) VALUES (?, ?, ?)`
    ).run(highlightId, now, now);
}

export function removeFromReview(highlightId) {
    db.prepare('DELETE FROM reviews WHERE highlight_id = ?').run(highlightId);
}

// Koen wants a BATCH per review session (default 5, adjustable), not a
// one-at-a-time Anki-style single card. Ordering: due items first, then by
// the highlight's ORIGINAL created_at (older highlights get first crack) --
// but explicitly NOT a strict oldest-first queue (Koen: "niet alleen oude,
// zoals Readwise het ook doet") and NOT clustered on one book (he noticed a
// batch of 5 all from the same book). So: build a decent-sized candidate
// pool with that ordering, then round-robin across books in shuffled order
// to spread a batch across different books.
export function getReviewBatch(count = DEFAULT_REVIEW_COUNT) {
    const n = Math.max(1, Math.min(50, Number(count) || DEFAULT_REVIEW_COUNT));
    const now = Date.now();
    // Cap candidates PER BOOK (window function) before pooling -- otherwise
    // one book with many old highlights fills the entire candidate pool by
    // itself and the round-robin below never sees any other book at all
    // (exactly what happened with a flat global ORDER BY + LIMIT).
    const perBookCap = Math.max(3, Math.ceil((n * 3) / 1)); // generous, round-robin trims it down anyway
    const pool = db
        .prepare(
            `SELECT h.*, b.title AS book_title, b.author AS book_author, b.cover_url FROM (
                SELECT h.*, r.due_at,
                       ROW_NUMBER() OVER (
                           PARTITION BY h.book_id
                           ORDER BY (r.due_at <= @now) DESC, h.created_at ASC, r.due_at ASC
                       ) AS rn
                FROM reviews r JOIN highlights h ON h.id = r.highlight_id
             ) h
             JOIN books b ON b.id = h.book_id
             WHERE h.rn <= @cap
             ORDER BY (h.due_at <= @now) DESC, h.created_at ASC, h.due_at ASC`
        )
        .all({ now, cap: perBookCap });

    const byBook = new Map();
    for (const h of pool) {
        if (!byBook.has(h.book_id)) byBook.set(h.book_id, []);
        byBook.get(h.book_id).push(h);
    }
    const bookIds = [...byBook.keys()];
    for (let i = bookIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bookIds[i], bookIds[j]] = [bookIds[j], bookIds[i]];
    }

    const result = [];
    for (let round = 0; result.length < n; round++) {
        let addedThisRound = false;
        for (const bid of bookIds) {
            const list = byBook.get(bid);
            if (round < list.length) {
                result.push(list[round]);
                addedThisRound = true;
                if (result.length >= n) break;
            }
        }
        if (!addedThisRound) break; // pool exhausted
    }
    return result;
}

export function reviewQueueSize() {
    return db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE due_at <= ?').get(Date.now()).n;
}

export function reviewEnrolledCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n;
}

// Dashboard "Daily Review" hero card: a few cover images to fan out + a
// handful of distinct author names for the "X highlights from A, B and
// more" subtitle. Not the actual review batch (that's chosen fresh, with
// its own diversity logic, when /review is opened) -- purely a preview.
export function getDueReviewPreview(sampleSize = 3) {
    const now = Date.now();
    // Due-first, but falls back to the soonest-due highlights when nothing
    // is due yet -- mirrors getReviewBatch()'s own fallback, so the
    // dashboard card can still preview a "review more anyway" session once
    // today's queue is caught up.
    const rows = db
        .prepare(
            `SELECT DISTINCT b.id AS book_id, b.cover_url, b.author
             FROM reviews r JOIN highlights h ON h.id = r.highlight_id JOIN books b ON b.id = h.book_id
             ORDER BY (r.due_at <= @now) DESC, r.due_at ASC
             LIMIT 20`
        )
        .all({ now });
    const covers = rows.filter((r) => r.cover_url).slice(0, sampleSize).map((r) => r.cover_url);
    const authors = [...new Set(rows.map((r) => r.author).filter(Boolean))].slice(0, 2);
    return { covers, authors };
}

// 4-button model (Koen's own design, not classic Anki SM-2):
// - 'next'  : keep the current frequency, just reschedule for its normal next turn
// - 'more'  : show it more often (halves the interval)
// - 'less'  : show it less often (doubles the interval)
// - 'stop'  : never show it again (unenroll from review entirely)
export function recordReview(highlightId, action) {
    if (action === 'stop') {
        removeFromReview(highlightId);
        return;
    }

    const row = db
        .prepare(
            `SELECT r.*, b.review_weight FROM reviews r
             JOIN highlights h ON h.id = r.highlight_id
             JOIN books b ON b.id = h.book_id
             WHERE r.highlight_id = ?`
        )
        .get(highlightId);
    if (!row) return;

    let interval = row.interval_days || DEFAULT_INTERVAL_DAYS;
    if (action === 'more') interval = Math.max(0.25, interval / 2);
    else if (action === 'less') interval = interval * 2;
    // 'next': interval unchanged, just moves due_at forward by it.

    const weight = row.review_weight || 1;
    const effectiveInterval = Math.max(1 / 24, interval / weight); // min. 1 uur
    const now = Date.now();
    const dueAt = now + effectiveInterval * 24 * 60 * 60 * 1000;

    db.prepare(
        `UPDATE reviews SET interval_days = ?, due_at = ?, last_reviewed_at = ?, repetitions = repetitions + 1
         WHERE highlight_id = ?`
    ).run(interval, dueAt, now, highlightId);
}
