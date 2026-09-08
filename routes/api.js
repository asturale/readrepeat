import express from 'express';
import { requireApiToken } from './middleware.js';
import { upsertHighlight, mergeHighlights } from '../db/highlights.js';
import { parseActionTag } from '../lib/action-tags.js';
import { setBookCover } from '../db/books.js';
import { enrichBook } from '../db/hardcover.js';

const router = express.Router();
router.use(requireApiToken);

const MAX_TEXT = 10000;
const MAX_TITLE = 500;

function validHighlight(h) {
    return h && typeof h.text === 'string' && h.text.trim().length > 0 && h.text.length <= MAX_TEXT;
}

// POST /api/import
// { book: { title, author }, highlights: [{ text, note, chapter, location, color, source, source_id, created_at }] }
// `source`/`source_id` identify the highlight in ITS origin system (e.g.
// readwise-sync.mjs's own .sdr-derived id) -- used for de-duplication on
// repeated imports, never required to be globally unique across sources.
// `note` is parsed for Readwise Action Tags (.h1/.h2/.h3/.word, see
// lib/action-tags.js) inside upsertHighlight -- a genuine free-text note
// passes through unchanged, a tag-like note does not become a literal note.
// `chapter` is separate from `note` -- book-structure context carried from
// the source (e.g. KOReader's own chapter field), not something a human
// typed as a note.
router.post('/import', async (req, res) => {
    const { book, highlights } = req.body || {};
    if (!book || typeof book.title !== 'string' || !book.title.trim() || book.title.length > MAX_TITLE) {
        return res.status(400).json({ error: 'book.title is required' });
    }
    if (!Array.isArray(highlights) || highlights.length === 0) {
        return res.status(400).json({ error: 'highlights must be a non-empty array' });
    }
    if (highlights.length > 500) {
        return res.status(400).json({ error: 'max 500 highlights per request' });
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let bookRecord = null;
    let bookWasNew = false;
    // Readwise Action Tag concatenation (.c1/.c2/.c3/...): a .c1-tagged
    // highlight starts a new group, subsequent .c2/.c3/... in submission
    // order join it, until the next .c1 (or a non-concat highlight) starts/
    // ends a group. Groups are merged (via the same mergeHighlights() used
    // by the manual "select + merge" UI action) after insertion.
    let concatGroups = [];
    let currentGroup = null;

    for (const h of highlights) {
        if (!validHighlight(h)) {
            skipped++;
            continue;
        }
        const result = upsertHighlight({
            book: { title: book.title.trim(), author: book.author || null },
            text: h.text,
            note: h.note || null,
            location: h.location != null ? String(h.location) : null,
            color: h.color || null,
            chapter: h.chapter || null,
            source: h.source || 'api',
            source_id: h.source_id || null,
            created_at: h.created_at ? new Date(h.created_at).getTime() : null,
        });
        bookRecord = result.book;
        bookWasNew = bookWasNew || !bookRecord.cover_url;
        if (result.created) created++;
        else updated++;

        // Readwise's own spec: concatenation is specifically for
        // NON-adjacent highlights ("highlight the first string... then
        // highlight the second string [elsewhere]"), so an unrelated
        // highlight in between must NOT break the group -- only a fresh
        // .c1 starts a new one. Confirmed as a real bug via a live test:
        // an untagged highlight between .c1 and .c2 reset currentGroup and
        // silently skipped the merge entirely.
        const tag = parseActionTag(h.note);
        if (tag.type === 'concat') {
            if (tag.index === 1 || !currentGroup) {
                currentGroup = [];
                concatGroups.push(currentGroup);
            }
            currentGroup.push(result.highlightId);
        }
    }

    for (const group of concatGroups) {
        if (group.length >= 2) {
            try {
                mergeHighlights(group);
            } catch {
                // Group spanned >1 book or otherwise couldn't merge -- leave
                // the individual highlights as-is rather than failing the
                // whole import.
            }
        }
    }

    if (bookRecord && !bookRecord.cover_url) {
        // Fire-and-forget: never make the caller (readwise-sync.mjs) wait on
        // a Hardcover round-trip, and never fail the import if it errors.
        enrichBook(bookRecord.title, bookRecord.author)
            .then((meta) => meta && setBookCover(bookRecord.id, meta))
            .catch(() => {});
    }

    res.json({ book: bookRecord ? { id: bookRecord.id, title: bookRecord.title } : null, created, updated, skipped });
});

export default router;
