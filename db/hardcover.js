// Cover + canonical-metadata enrichment via Hardcover's API -- same
// search-then-validate-by-author approach as the existing
// automation/scripts/hardcover-lib.mjs, kept as its own copy here since this
// is a separate, independently-deployed app (not sharing code across
// unrelated docker projects).
const HARDCOVER_TOKEN = process.env.HARDCOVER_API_TOKEN;
const API = 'https://api.hardcover.app/v1/graphql';

let lastCallAt = 0;
async function hcFetch(query, variables) {
    if (!HARDCOVER_TOKEN) return null;
    const wait = Math.max(0, lastCallAt + 1050 - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${HARDCOVER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => null);
    if (!json || json.errors || !json.data) return null;
    return json.data;
}

export async function enrichBook(title, author) {
    const q = `${title} ${author || ''}`.trim();
    const data = await hcFetch(
        `query($q: String!) { search(query: $q, query_type: "Book", per_page: 5) { results } }`,
        { q }
    );
    const hits = data?.search?.results?.hits || [];
    if (hits.length === 0) return null;

    const authorWords = (author || '')
        .toLowerCase()
        .split(/[,&]/)[0]
        .split(/\s+/)
        .filter((w) => w.length > 2);

    for (const h of hits) {
        const doc = h.document;
        const docAuthors = (doc.author_names || []).join(', ');
        const authorMatch =
            authorWords.length === 0 || authorWords.some((w) => docAuthors.toLowerCase().includes(w));
        if (!authorMatch) continue;

        const bookId = parseInt(doc.id, 10);
        const detail = await hcFetch(
            `query($id: Int!) { books(where: {id: {_eq: $id}}) { image { url } } }`,
            { id: bookId }
        );
        const cover_url = detail?.books?.[0]?.image?.url || null;
        return { hardcover_id: bookId, author: docAuthors || null, cover_url };
    }
    return null;
}
