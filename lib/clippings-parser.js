// Parser voor het klassieke Kindle "My Clippings.txt"-formaat, ook gebruikt
// door CrossPoint/CrossInk-devices voor hun highlight-export (bevestigd
// 11-09-2026 op een echt bestand van Koens Xteink X4 Pro, ondanks de .bin-
// bestandsnaam -- gewoon platte UTF-8-tekst).
//
// Blok-formaat, gescheiden door een regel met alleen "==========":
//   <Titel> (<Auteur>)
//   - Your Highlight on Page <N> | <Hoofdstuk> | Added on <datum>
//   <lege regel>
//   <highlight-tekst, kan meerdere regels beslaan>
//
// Ook gezien: "- Your Note on Page N | ..." (notitie, wel tekst) en
// "- Your Bookmark on Page N | ..." (geen tekst erna -- overgeslagen).
// Middelste segment tussen de `|`'s is optioneel (hoofdstuknaam); soms staat
// er i.p.v. "Page N" een "location N-M" (kale Kindle-clippings zonder
// paginanummers) -- allebei ondersteund, in `location` gezet.

function parseMetaLine(line) {
    // "- Your Highlight on Page 43 | Hoofdstuk 10 | Added on <datum>"
    const m = line.match(/^-\s*Your (Highlight|Note|Bookmark)\b(.*)$/i);
    if (!m) return null;
    const type = m[1].toLowerCase();
    const segments = m[2].split('|').map((s) => s.trim());
    // Laatste segment is altijd "Added on ..."; alles ervoor is positie-info
    // + optioneel een hoofdstuknaam.
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
        else if (seg && !location) chapter = seg; // eerste onherkende segment = hoofdstuk
        else if (seg) chapter = seg;
    }
    return { type, location, chapter, addedAt: addedAt && !isNaN(addedAt) ? addedAt : null };
}

function parseTitleLine(line) {
    // "Titel (Auteur)" -- auteur is optioneel, en titels kunnen zelf haakjes
    // bevatten, dus pak het LAATSTE haakjespaar aan het einde van de regel.
    const m = line.match(/^(.*)\(([^()]+)\)\s*$/);
    if (m) return { title: m[1].trim(), author: m[2].trim() };
    return { title: line.trim(), author: undefined };
}

export function parseClippings(raw) {
    const blocks = raw
        .replace(/\r\n/g, '\n')
        .replace(/﻿/g, '') // BOM, Kindle-bestanden hebben 'm vaak
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
        if (meta.type === 'bookmark') continue; // geen tekst, niks te importeren

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

    // Dedup BINNEN het bestand: dezelfde highlight komt soms 2x voor omdat
    // het device 'm eerst als afgekapte tussenstand wegschrijft en daarna
    // pas compleet (zelfde boek+locatie+tijdstip, verschillende tekstlengte)
    // -- de langste (=meest complete) versie wint.
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
