import { db } from './index.js';

const STOPWORDS = new Set(['the', 'a', 'an', 'de', 'het', 'een']);
const DIACRITIC_RE = new RegExp('[\\u0300-\\u036f]', 'g');

function normWords(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(DIACRITIC_RE, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w && !STOPWORDS.has(w));
}

function norm(s) {
    return normWords(s).join(' ').trim();
}

// Author names arrive in inconsistent order across sources ("Ingram,
// Daniel M." from one import vs "Daniel M. Ingram" from another) --
// sorting the words makes the key order-invariant so both land on the
// same book. Title word order is left alone (it changes meaning there).
function normAuthor(s) {
    return normWords(s).sort().join(' ').trim();
}

export function normalizeKey(title, author) {
    return `${norm(title)}::${normAuthor(author)}`;
}

export function findOrCreateBook({ title, author, cover_url }) {
    const key = normalizeKey(title, author);
    const existing = db.prepare('SELECT * FROM books WHERE normalized_key = ?').get(key);
    if (existing) return existing;
    const now = Date.now();
    const info = db
        .prepare(
            `INSERT INTO books (title, author, cover_url, normalized_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(title, author || null, cover_url || null, key, now, now);
    return db.prepare('SELECT * FROM books WHERE id = ?').get(info.lastInsertRowid);
}

// Manual metadata edit (title/author/cover) -- recomputes normalized_key so
// dedup stays internally consistent with the new values. A future re-import
// still using the OLD title/author from its source could land on a fresh
// duplicate book -- same inherent tradeoff as the original dedup design,
// just now user-triggered instead of source-format-triggered.
export function updateBookMetadata(bookId, { title, author, cover_url }) {
    const key = normalizeKey(title, author);
    db.prepare(
        `UPDATE books SET title = ?, author = ?, cover_url = ?, normalized_key = ?, updated_at = ? WHERE id = ?`
    ).run(title, author || null, cover_url || null, key, Date.now(), bookId);
}

export function setBookCover(bookId, { cover_url, hardcover_id, author }) {
    db.prepare(
        `UPDATE books SET cover_url = COALESCE(?, cover_url), hardcover_id = COALESCE(?, hardcover_id),
         author = COALESCE(author, ?), updated_at = ? WHERE id = ?`
    ).run(cover_url || null, hardcover_id || null, author || null, Date.now(), bookId);
}

// sort is never interpolated directly -- picked from this fixed allowlist
// so there's no path from a query-string value to raw SQL.
const BOOK_SORTS = {
    recent: 'b.updated_at DESC',
    title: 'b.title COLLATE NOCASE ASC',
    author: 'b.author COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC',
    highlights: 'highlight_count DESC',
};

export function listBooksWithCounts(sort = 'recent') {
    const orderBy = BOOK_SORTS[sort] || BOOK_SORTS.recent;
    return db
        .prepare(
            `SELECT b.*, COUNT(h.id) AS highlight_count
             FROM books b LEFT JOIN highlights h ON h.book_id = b.id
             GROUP BY b.id
             ORDER BY ${orderBy}`
        )
        .all();
}

export function getBook(id) {
    return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

const REVIEW_WEIGHTS = [0.25, 0.5, 1, 1.5, 2, 3];

export function setReviewWeight(bookId, weight) {
    const w = REVIEW_WEIGHTS.includes(Number(weight)) ? Number(weight) : 1;
    db.prepare('UPDATE books SET review_weight = ?, updated_at = ? WHERE id = ?').run(w, Date.now(), bookId);
}

// Cascades to highlights (ON DELETE CASCADE) and from there to reviews --
// deleting a book removes everything under it in one go.
export function deleteBook(id) {
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
}

// Moves every highlight from `mergeId` onto `survivorId`, then deletes the
// now-empty `mergeId` book. A highlight is skipped (left to be cleaned up
// by dedupeHighlightsInBook) rather than moved if the survivor already has
// one with the same (source, source_id) -- that would violate the UNIQUE
// constraint. Cover/hardcover_id/author on the survivor are filled in from
// the merged book if the survivor lacks them.
export function mergeBooks(survivorId, mergeId) {
    if (survivorId === mergeId) return;
    const survivor = getBook(survivorId);
    const merged = getBook(mergeId);
    if (!survivor || !merged) return;

    const tx = db.transaction(() => {
        const highlights = db.prepare('SELECT id, source, source_id FROM highlights WHERE book_id = ?').all(mergeId);
        for (const h of highlights) {
            const conflict = db
                .prepare('SELECT 1 FROM highlights WHERE book_id = ? AND source = ? AND source_id = ?')
                .get(survivorId, h.source, h.source_id);
            if (conflict) {
                db.prepare('DELETE FROM highlights WHERE id = ?').run(h.id);
            } else {
                db.prepare('UPDATE highlights SET book_id = ? WHERE id = ?').run(survivorId, h.id);
            }
        }
        db.prepare(
            `UPDATE books SET cover_url = COALESCE(cover_url, ?), hardcover_id = COALESCE(hardcover_id, ?),
             author = COALESCE(author, ?), updated_at = ? WHERE id = ?`
        ).run(merged.cover_url, merged.hardcover_id, merged.author, Date.now(), survivorId);
        db.prepare('DELETE FROM books WHERE id = ?').run(mergeId);
    });
    tx();
}

// Within one book, collapses highlights whose TEXT is byte-identical
// (trimmed) into one row -- catches the case where the same highlight
// arrived via two different sources/source_ids (e.g. the original bulk
// import and an ongoing per-device sync), which the UNIQUE(book_id,
// source, source_id) constraint alone doesn't prevent. Keeps the oldest
// (earliest created_at) row, deletes the rest via straight DELETE (not
// mergeHighlights' text-concatenation -- these are exact duplicates, not
// highlights worth combining).
export function dedupeHighlightsInBook(bookId) {
    const rows = db
        .prepare('SELECT id, text, created_at FROM highlights WHERE book_id = ? AND is_heading = 0 ORDER BY created_at ASC')
        .all(bookId);
    const seen = new Map();
    let removed = 0;
    const tx = db.transaction(() => {
        for (const h of rows) {
            const key = h.text.trim();
            if (seen.has(key)) {
                db.prepare('DELETE FROM highlights WHERE id = ?').run(h.id);
                removed++;
            } else {
                seen.set(key, h.id);
            }
        }
    });
    tx();
    return removed;
}
