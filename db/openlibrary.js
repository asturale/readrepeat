// Fallback cover source when Hardcover has no match -- Open Library is a
// DIFFERENT database (no auth needed, same public API already used by
// automation/scripts/readwise-sync.mjs for Kobo-highlight covers), so it
// can catch books Hardcover doesn't have, especially Dutch/niche titles.
export async function lookupOpenLibraryCover(title, author) {
    try {
        const params = new URLSearchParams({ title, limit: '1' });
        if (author) params.set('author', author);
        const res = await fetch(`https://openlibrary.org/search.json?${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        const coverId = data.docs?.[0]?.cover_i;
        if (!coverId) return null;
        return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
    } catch {
        return null;
    }
}
