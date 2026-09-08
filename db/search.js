import { db } from './index.js';

// Simple LIKE-based search -- perfectly adequate at this data size (a few
// thousand highlights), and keeps the schema simple (no FTS5 virtual table
// to keep in sync). Parameterized throughout, no injection risk.
export function search(query) {
    const q = `%${query.trim()}%`;
    if (!query.trim()) return { books: [], highlights: [] };

    const books = db
        .prepare(
            `SELECT b.*, COUNT(h.id) AS highlight_count
             FROM books b LEFT JOIN highlights h ON h.book_id = b.id
             WHERE b.title LIKE ? OR b.author LIKE ?
             GROUP BY b.id
             ORDER BY b.title
             LIMIT 50`
        )
        .all(q, q);

    const highlights = db
        .prepare(
            `SELECT h.*, b.title AS book_title, b.author AS book_author, b.cover_url
             FROM highlights h JOIN books b ON b.id = h.book_id
             WHERE h.text LIKE ? OR h.note LIKE ?
             ORDER BY h.created_at DESC
             LIMIT 100`
        )
        .all(q, q);

    return { books, highlights };
}
