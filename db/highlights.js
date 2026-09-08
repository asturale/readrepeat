import { db } from './index.js';
import { findOrCreateBook } from './books.js';
import { addToReview } from './reviews.js';
import { parseActionTag } from '../lib/action-tags.js';

// Dedup key when no stable source_id is available (manual Readwise export
// rows, or a source that doesn't give one): hash of the highlight text
// itself within the book. When a source_id IS available (our own API
// endpoint from readwise-sync.mjs, which already has one), that's used
// instead -- more robust against a highlight's text being edited later.
function dedupSourceId(text) {
    return 'text:' + Buffer.from(text).toString('base64').slice(0, 40);
}

// Applies Readwise Action Tag parsing to a raw note: a heading tag clears
// the note and returns is_heading/heading_level; an inline/concat tag
// clears the note and returns it as a tag string; a normal note passes
// through unchanged. Returns fields ready to spread into an INSERT/UPDATE.
function processNote(rawNote) {
    const parsed = parseActionTag(rawNote);
    if (parsed.type === 'none') return { note: rawNote || null, tag: null, is_heading: 0, heading_level: null };
    if (parsed.type === 'heading') {
        return { note: null, tag: null, is_heading: 1, heading_level: parsed.level };
    }
    if (parsed.type === 'concat') {
        // Not automated (see lib/action-tags.js) -- recorded as a plain tag
        // so it's at least visible; Koen can merge manually.
        return { note: null, tag: `c${parsed.index}`, is_heading: 0, heading_level: null };
    }
    return { note: null, tag: parsed.tag, is_heading: 0, heading_level: null };
}

function mergeTags(existingTags, newTag) {
    if (!newTag) return existingTags || null;
    const set = new Set((existingTags || '').split(',').filter(Boolean));
    set.add(newTag);
    return [...set].join(',');
}

export function upsertHighlight({ book, text, note, location, color, chapter, source, source_id, created_at }) {
    const b = findOrCreateBook(book);
    const sid = source_id || dedupSourceId(text);
    const now = Date.now();
    const created = created_at || now;
    const processed = processNote(note);
    const existing = db
        .prepare('SELECT id, tags FROM highlights WHERE book_id = ? AND source = ? AND source_id = ?')
        .get(b.id, source, sid);
    if (existing) {
        db.prepare(
            `UPDATE highlights SET text = ?, note = COALESCE(?, note), location = COALESCE(?, location),
             color = COALESCE(?, color), chapter = COALESCE(?, chapter), tags = ?,
             is_heading = ?, heading_level = COALESCE(?, heading_level), updated_at = ? WHERE id = ?`
        ).run(
            text,
            processed.note,
            location || null,
            color || null,
            chapter || null,
            mergeTags(existing.tags, processed.tag),
            processed.is_heading,
            processed.heading_level,
            now,
            existing.id
        );
        return { book: b, highlightId: existing.id, created: false };
    }
    const info = db
        .prepare(
            `INSERT INTO highlights (book_id, text, note, location, color, chapter, tags, is_heading, heading_level, source, source_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            b.id,
            text,
            processed.note,
            location || null,
            color || null,
            chapter || null,
            processed.tag,
            processed.is_heading,
            processed.heading_level,
            source,
            sid,
            created,
            now
        );
    // Opt-OUT spaced repetition: every highlight lands in the review queue by
    // default, Koen removes the ones he doesn't want reviewed (not the
    // reverse) -- see [[project_readrepeat]] memory for why this changed from
    // the original opt-in design.
    addToReview(info.lastInsertRowid);
    return { book: b, highlightId: info.lastInsertRowid, created: true };
}

// Chapter display: use the highlight's own `chapter` (carried from the
// source, e.g. KOReader) if set; otherwise fall back to the text of the
// nearest PRECEDING .h1/.h2/.h3-tagged highlight in the same book (Action
// Tags heading inference) -- computed on read, never stored, so it always
// reflects the current set of heading highlights.
export function listHighlightsForBook(bookId) {
    const rows = db
        .prepare('SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at')
        .all(bookId);
    let currentHeadings = {}; // level -> text, most recent seen so far
    for (const h of rows) {
        if (h.is_heading) {
            currentHeadings[h.heading_level] = h.text;
            // A higher-level heading (e.g. a new h1) resets any deeper
            // headings under a previous section.
            for (let lvl = h.heading_level + 1; lvl <= 3; lvl++) delete currentHeadings[lvl];
            h.display_chapter = h.text;
        } else {
            const deepest = Math.max(0, ...Object.keys(currentHeadings).map(Number));
            h.display_chapter = h.chapter || (deepest > 0 ? currentHeadings[deepest] : null);
        }
    }
    return rows.sort((a, b) => (a.location || '').localeCompare(b.location || '') || a.created_at - b.created_at);
}

export function countHighlights() {
    return db.prepare('SELECT COUNT(*) AS n FROM highlights').get().n;
}

export function getHighlight(id) {
    return db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
}

export function createManualHighlight(bookId, { text, note, color }) {
    const now = Date.now();
    const sourceId = dedupSourceId(text + ':' + now); // manual entries are never dedup targets
    const processed = processNote(note);
    const info = db
        .prepare(
            `INSERT INTO highlights (book_id, text, note, color, tags, is_heading, heading_level, source, source_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
        )
        .run(bookId, text, processed.note, color || null, processed.tag, processed.is_heading, processed.heading_level, sourceId, now, now);
    addToReview(info.lastInsertRowid);
    return info.lastInsertRowid;
}

export function updateHighlightText(id, { text, note, color }) {
    const existing = getHighlight(id);
    const processed = processNote(note);
    db.prepare(
        `UPDATE highlights SET text = ?, note = ?, color = ?, tags = ?, is_heading = ?, heading_level = ?, updated_at = ? WHERE id = ?`
    ).run(
        text,
        processed.note,
        color || null,
        mergeTags(existing?.tags, processed.tag),
        processed.is_heading,
        processed.heading_level,
        Date.now(),
        id
    );
}

export function deleteHighlight(id) {
    db.prepare('DELETE FROM highlights WHERE id = ?').run(id);
}

// Merge: concatenates the text of every highlight (in the given order) into
// the FIRST one, keeps its earliest created_at, deletes the rest. Never
// touches source/source_id of the survivor -- a merge is a local editorial
// action, it shouldn't affect how future imports dedup against it.
export function mergeHighlights(ids) {
    if (ids.length < 2) return null;
    const rows = ids.map((id) => getHighlight(id)).filter(Boolean);
    if (rows.length < 2 || new Set(rows.map((r) => r.book_id)).size > 1) {
        throw new Error('merge vereist 2+ highlights uit hetzelfde boek');
    }
    rows.sort((a, b) => a.created_at - b.created_at);
    const [survivor, ...rest] = rows;
    const mergedText = rows.map((r) => r.text.trim()).join('\n\n');
    const mergedNote = rows.map((r) => r.note).filter(Boolean).join(' / ') || null;
    const tx = db.transaction(() => {
        db.prepare('UPDATE highlights SET text = ?, note = ?, updated_at = ? WHERE id = ?').run(
            mergedText,
            mergedNote,
            Date.now(),
            survivor.id
        );
        for (const r of rest) {
            db.prepare('DELETE FROM highlights WHERE id = ?').run(r.id);
        }
    });
    tx();
    return survivor.id;
}
