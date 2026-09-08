#!/usr/bin/env node
// One-time bulk import: pages through Readwise's own export API and POSTs
// everything into this app's own /api/import endpoint (dogfooding the same
// API readwise-sync.mjs will use going forward). Run once to seed history;
// safe to re-run (the import endpoint dedupes on book+source_id).
const READWISE_TOKEN = process.env.READWISE_TOKEN;
const KNIPSEL_URL = process.env.KNIPSEL_URL || 'http://localhost:3000';
const KNIPSEL_TOKEN = process.env.KNIPSEL_API_TOKEN;

if (!READWISE_TOKEN) throw new Error('READWISE_TOKEN ontbreekt');
if (!KNIPSEL_TOKEN) throw new Error('KNIPSEL_API_TOKEN ontbreekt (maak er een aan via /account)');

async function fetchReadwisePage(cursor) {
    const url = new URL('https://readwise.io/api/v2/export/');
    if (cursor) url.searchParams.set('pageCursor', cursor);
    const res = await fetch(url, { headers: { Authorization: `Token ${READWISE_TOKEN}` } });
    if (!res.ok) throw new Error(`Readwise export failed: HTTP ${res.status}`);
    return res.json();
}

async function importBook(book) {
    const highlights = (book.highlights || []).map((h) => ({
        text: h.text,
        note: h.note || null,
        location: h.location != null ? String(h.location) : null,
        color: h.color || null,
        source: 'readwise-export',
        source_id: String(h.id),
        created_at: h.highlighted_at || h.created_at || null,
    }));
    if (highlights.length === 0) return { created: 0, updated: 0, skipped: 0 };

    const res = await fetch(`${KNIPSEL_URL}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KNIPSEL_TOKEN}` },
        body: JSON.stringify({
            book: { title: book.title, author: book.author },
            highlights,
        }),
    });
    if (!res.ok) {
        console.error(`  fout bij "${book.title}": HTTP ${res.status} ${await res.text()}`);
        return { created: 0, updated: 0, skipped: highlights.length };
    }
    return res.json();
}

async function main() {
    let cursor;
    let totalBooks = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    do {
        const page = await fetchReadwisePage(cursor);
        for (const book of page.results) {
            const result = await importBook(book);
            totalBooks++;
            totalCreated += result.created || 0;
            totalUpdated += result.updated || 0;
            console.log(`"${book.title}": +${result.created || 0} nieuw, ${result.updated || 0} bijgewerkt`);
        }
        cursor = page.nextPageCursor;
    } while (cursor);
    console.log(`\nKlaar: ${totalBooks} boeken, ${totalCreated} nieuwe highlights, ${totalUpdated} bijgewerkt.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
