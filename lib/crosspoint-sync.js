import { upsertHighlight } from '../db/highlights.js';
import { usersDueForCrosspointSync, markCrosspointSynced } from '../db/crosspoint.js';

const CHECK_INTERVAL_MS = 60 * 1000; // per-user interval is enforced in the DB query, this just controls polling granularity

async function crosspointGet(serverUrl, username, password, path) {
    const res = await fetch(`${serverUrl}${path}`, {
        headers: { 'x-auth-user': username, 'x-auth-key': password },
    });
    if (res.status === 401) throw new Error('Invalid crosspoint-sync username or password.');
    if (!res.ok) throw new Error(`crosspoint-sync request failed: ${res.status}`);
    return res.json();
}

// Pulls every live clipping across all of the user's books in one call (the
// server's own "hub" endpoint, GET /api/v1/clippings -- no per-document
// cursor bookkeeping needed on our side) plus /api/v1/documents for
// title/author, since the clippings themselves only carry a document hash.
// Re-fetches the full set on every run rather than tracking a delta cursor:
// simpler, and upsertHighlight's own dedup on (book, source, source_id)
// already makes re-importing the same clipping a no-op.
export async function syncCrosspointClippings({ serverUrl, username, password }) {
    const [documentsRes, clippingsRes] = await Promise.all([
        crosspointGet(serverUrl, username, password, '/api/v1/documents'),
        crosspointGet(serverUrl, username, password, '/api/v1/clippings'),
    ]);
    const docMeta = new Map();
    for (const d of documentsRes.items || []) {
        docMeta.set(d.document, { title: d.title || 'Unknown book', author: d.author || undefined });
    }

    let created = 0;
    let updated = 0;
    for (const item of clippingsRes.items || []) {
        if (!item.text) continue; // bookmarks with no highlighted text -- nothing to import
        const meta = docMeta.get(item.document) || { title: 'Unknown book', author: undefined };
        const { created: wasCreated } = upsertHighlight({
            book: meta,
            text: item.text,
            note: item.note || undefined,
            chapter: item.chapter || undefined,
            source: 'crosspoint-sync',
            source_id: `${item.document}:${item.id}`,
            created_at: item.created_at ? item.created_at * 1000 : undefined,
        });
        if (wasCreated) created++;
        else updated++;
    }
    return { total: created + updated, created, updated };
}

export function startCrosspointScheduler() {
    setInterval(checkAndSync, CHECK_INTERVAL_MS).unref();
}

async function checkAndSync() {
    const due = usersDueForCrosspointSync();
    for (const user of due) {
        try {
            await syncCrosspointClippings({
                serverUrl: user.crosspoint_server_url,
                username: user.crosspoint_username,
                password: user.crosspoint_password,
            });
            markCrosspointSynced(user.id, { error: null });
        } catch (e) {
            // Best-effort background sync -- log and retry next tick rather than
            // crash the scheduler; the error is also surfaced in Settings.
            console.error(`crosspoint-sync auto-import failed for user ${user.id}:`, e.message);
            markCrosspointSynced(user.id, { error: e.message });
        }
    }
}
