import { db } from './index.js';

const STOPWORDS = new Set(['the', 'a', 'an', 'de', 'het', 'een']);
const DIACRITIC_RE = new RegExp('[\\u0300-\\u036f]', 'g');

function norm(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(DIACRITIC_RE, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w && !STOPWORDS.has(w))
        .join(' ')
        .trim();
}

export function normalizeKey(title, author) {
    return `${norm(title)}::${norm(author)}`;
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

export function setBookCover(bookId, { cover_url, hardcover_id, author }) {
    db.prepare(
        `UPDATE books SET cover_url = COALESCE(?, cover_url), hardcover_id = COALESCE(?, hardcover_id),
         author = COALESCE(author, ?), updated_at = ? WHERE id = ?`
    ).run(cover_url || null, hardcover_id || null, author || null, Date.now(), bookId);
}

export function listBooksWithCounts() {
    return db
        .prepare(
            `SELECT b.*, COUNT(h.id) AS highlight_count
             FROM books b LEFT JOIN highlights h ON h.book_id = b.id
             GROUP BY b.id
             ORDER BY b.updated_at DESC`
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
