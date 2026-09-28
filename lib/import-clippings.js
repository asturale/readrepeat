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
        // Stabiele source_id zodat hetzelfde bestand nogmaals uploaden geen
        // duplicaten geeft -- upsertHighlight dedupt daarnaast ook nog op
        // exacte tekst binnen het boek (zie db/highlights.js).
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
