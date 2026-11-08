// Fallback cover source when Hardcover has no match -- Open Library is a
// DIFFERENT database (no auth needed, same public API already used by
// Readwise sync script for Kobo-highlight covers), so it
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

// Title/author suggestions while adding a new book by hand.
export async function searchOpenLibrary(q) {
    try {
        const params = new URLSearchParams({ q, limit: '6', fields: 'title,author_name,cover_i,first_publish_year' });
        const res = await fetch(`https://openlibrary.org/search.json?${params}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.docs || []).map((d) => ({
            title: d.title,
            author: (d.author_name || []).slice(0, 2).join(', ') || null,
            year: d.first_publish_year || null,
            cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
        }));
    } catch {
        return [];
    }
}
