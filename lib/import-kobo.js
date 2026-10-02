import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { upsertHighlight } from '../db/highlights.js';

// Kobo's own KoboReader.sqlite (native firmware reading app, independent of
// KOReader) -- highlights live in Bookmark joined to content for title/
// author. Hidden is stored as the STRING 'false'/'true' (not an integer, despite
// the BOOL-looking column type), confirmed against a real device export --
// a naive `Hidden = 0` comparison silently matches nothing.
export function importKoboDb(buffer) {
    if (!buffer || buffer.length === 0) {
        return { error: 'empty', result: null };
    }
    const tmpPath = path.join(os.tmpdir(), `readrepeat-kobo-${crypto.randomUUID()}.sqlite`);
    fs.writeFileSync(tmpPath, buffer);
    try {
        const kobo = new Database(tmpPath, { readonly: true, fileMustExist: true });
        let rows;
        try {
            rows = kobo
                .prepare(
                    `SELECT b.BookmarkID AS id, b.Text AS text, b.Annotation AS note, b.DateCreated AS createdAt,
                            c.Title AS title, c.Attribution AS author
                     FROM Bookmark b
                     JOIN content c ON b.VolumeID = c.ContentID
                     WHERE b.Type = 'highlight' AND (b.Hidden IS NULL OR b.Hidden != 'true')
                           AND b.Text IS NOT NULL AND b.Text != ''`
                )
                .all();
        } finally {
            kobo.close();
        }

        if (rows.length === 0) {
            return { error: 'no_highlights', result: null };
        }

        let created = 0;
        let updated = 0;
        for (const r of rows) {
            const createdAt = r.createdAt ? Date.parse(r.createdAt) : NaN;
            const { created: wasCreated } = upsertHighlight({
                book: { title: r.title || 'Unknown book', author: r.author || undefined },
                text: r.text,
                note: r.note || undefined,
                source: 'kobo-db',
                source_id: r.id,
                created_at: Number.isFinite(createdAt) ? createdAt : undefined,
            });
            if (wasCreated) created++;
            else updated++;
        }
        return { error: null, result: { total: rows.length, created, updated } };
    } catch (e) {
        return { error: 'invalid_file', result: null };
    } finally {
        fs.unlink(tmpPath, () => {});
    }
}
