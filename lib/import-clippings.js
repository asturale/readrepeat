import crypto from 'crypto';
import { parseClippings } from './clippings-parser.js';
import { upsertHighlight } from '../db/highlights.js';

// Shared by the web /import/clippings route and the Telegram bot's file
// upload handler (routes/telegram.js) -- same parsing, same dedupe key, same
// result shape, so a clippings file imports identically no matter which path
// it came in through.
export function importClippingsText(raw) {
    if (!raw || typeof raw !== 'string' || !raw.trim()) {
        return { error: 'empty', result: null };
    }
    let clippings;
    try {
        clippings = parseClippings(raw);
    } catch (e) {
        return { error: 'parse', result: null };
    }
    if (clippings.length === 0) {
        return { error: 'no_highlights', result: null };
    }

    let created = 0;
    let updated = 0;
    for (const c of clippings) {
        // Stable source_id so uploading the same file again doesn't create
        // duplicates -- upsertHighlight also dedupes on exact text within
        // the book on top of that (see db/highlights.js).
        const sourceId = crypto
            .createHash('sha256')
            .update([c.title, c.author, c.location, c.addedAt?.getTime(), c.text].join('::'))
            .digest('hex');
        const { created: wasCreated } = upsertHighlight({
            book: { title: c.title, author: c.author },
            text: c.text,
            location: c.location,
            chapter: c.chapter,
            source: 'kindle-clippings',
            source_id: sourceId,
            created_at: c.addedAt ? c.addedAt.getTime() : undefined,
        });
        if (wasCreated) created++;
        else updated++;
    }

    return { error: null, result: { total: clippings.length, created, updated } };
}
