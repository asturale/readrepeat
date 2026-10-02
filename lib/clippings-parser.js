// Parser for the classic Kindle "My Clippings.txt" format, also used by
// CrossPoint/CrossInk devices for their highlight export (confirmed
// 11-09-2026 on a real file from Koen's Xteink X4 Pro, despite the .bin
// filename -- it's just plain UTF-8 text).
//
// Block format, separated by a line containing only "==========":
//   <Title> (<Author>)
//   - Your Highlight on Page <N> | <Chapter> | Added on <date>
//   <blank line>
//   <highlight text, can span multiple lines>
//
// Also seen: "- Your Note on Page N | ..." (a note, has text) and
// "- Your Bookmark on Page N | ..." (no text after it -- skipped). The
// middle segment between the `|`s is optional (a chapter name); sometimes
// instead of "Page N" there's a "location N-M" (bare Kindle clippings
// without page numbers) -- both are supported, stored in `location`.

function parseMetaLine(line) {
    // "- Your Highlight on Page 43 | Hoofdstuk 10 | Added on <datum>"
    const m = line.match(/^-\s*Your (Highlight|Note|Bookmark)\b(.*)$/i);
    if (!m) return null;
    const type = m[1].toLowerCase();
    const segments = m[2].split('|').map((s) => s.trim());
    // The last segment is always "Added on ..."; everything before it is
    // position info + optionally a chapter name.
    const addedSeg = segments[segments.length - 1] || '';
    const addedMatch = addedSeg.match(/Added on\s+(.+)$/i);
    const addedAt = addedMatch ? new Date(addedMatch[1].trim()) : null;

    const posSegments = segments.slice(0, -1);
    let location = null;
    let chapter = null;
    for (const seg of posSegments) {
        const pageMatch = seg.match(/\b(?:page|pagina)\s+(\S+)/i);
        const locMatch = seg.match(/\blocation\s+(\S+)/i);
        if (pageMatch) location = pageMatch[1];
        else if (locMatch) location = locMatch[1];
        else if (seg && !location) chapter = seg; // first unrecognized segment = chapter
        else if (seg) chapter = seg;
    }
    return { type, location, chapter, addedAt: addedAt && !isNaN(addedAt) ? addedAt : null };
}

function parseTitleLine(line) {
    // "Title (Author)" -- author is optional, and titles can themselves
    // contain parentheses, so take the LAST parenthesized pair at the end
    // of the line.
    const m = line.match(/^(.*)\(([^()]+)\)\s*$/);
    if (m) return { title: m[1].trim(), author: m[2].trim() };
    return { title: line.trim(), author: undefined };
}

export function parseClippings(raw) {
    const blocks = raw
        .replace(/\r\n/g, '\n')
        .replace(/﻿/g, '') // BOM, Kindle files often have it
        .split(/\n=+\n/)
        .map((b) => b.trim())
        .filter(Boolean);

    const parsed = [];
    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 2) continue;
        const titleInfo = parseTitleLine(lines[0]);
        const meta = parseMetaLine(lines[1]);
        if (!titleInfo.title || !meta) continue;
        if (meta.type === 'bookmark') continue; // no text, nothing to import

        const text = lines.slice(2).join('\n').trim();
        if (!text) continue;

        parsed.push({
            title: titleInfo.title,
            author: titleInfo.author,
            type: meta.type,
            location: meta.location,
            chapter: meta.chapter,
            addedAt: meta.addedAt,
            text,
        });
    }

    // Dedup WITHIN the file: the same highlight sometimes appears twice
    // because the device first writes it out as a truncated intermediate
    // state and only later writes the complete version (same book+location+
    // timestamp, different text length) -- the longest (=most complete)
    // version wins.
    const byKey = new Map();
    for (const c of parsed) {
        const key = [c.title, c.author, c.location, c.addedAt?.getTime()].join('::');
        const existing = byKey.get(key);
        if (!existing || c.text.length > existing.text.length) {
            byKey.set(key, c);
        }
    }
    return [...byKey.values()];
}
