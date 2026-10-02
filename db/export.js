import { db } from './index.js';
import { findUserById, listApiTokens } from './auth.js';
import { getSessionDates } from './streak.js';
import { listRecommendations } from './recommendations.js';

// GDPR export file (Art. 20, right to data portability). Contains everything
// the app has about the user, MINUS secrets -- the password hash, API token
// hashes, and the BYOK provider keys are credentials, not personal data, and
// have no business ending up in a readable export file (that would itself
// become a leak if the file ever ended up somewhere it shouldn't).
//
// books/highlights/reviews are NOT per-user scoped in this schema (1 shared
// library, see db/index.js) -- included anyway, since that's functionally
// exactly "my data" for a user of a single-tenant install like this one.
export function buildGdprExport(userId) {
    const user = findUserById(userId);

    const account = {
        username: user.username,
        created_at: new Date(user.created_at).toISOString(),
        locale: user.locale,
        settings: {
            review_batch_size: user.review_batch_size,
            reminder_frequency_hours: user.reminder_frequency_hours,
            reminder_hour: user.reminder_hour,
            text_scale: user.text_scale,
            feed_mode: user.feed_mode,
            ai_provider: user.ai_provider,
            telegram_digest_enabled: !!user.telegram_digest_enabled,
            telegram_digest_hour: user.telegram_digest_hour,
            telegram_digest_count: user.telegram_digest_count,
        },
    };

    const apiTokens = listApiTokens(userId).map((t) => ({
        label: t.label,
        created_at: new Date(t.created_at).toISOString(),
        last_used_at: t.last_used_at ? new Date(t.last_used_at).toISOString() : null,
    }));

    const books = db
        .prepare('SELECT id, title, author, cover_url, review_weight, created_at, updated_at FROM books ORDER BY id')
        .all()
        .map((b) => ({ ...b, created_at: new Date(b.created_at).toISOString(), updated_at: new Date(b.updated_at).toISOString() }));

    const highlights = db
        .prepare(
            `SELECT h.id, h.book_id, h.text, h.note, h.location, h.color, h.chapter, h.tags, h.is_heading,
                    h.source, h.created_at, h.updated_at,
                    r.ease_factor, r.interval_days, r.repetitions, r.due_at, r.last_reviewed_at
             FROM highlights h
             LEFT JOIN reviews r ON r.highlight_id = h.id
             ORDER BY h.id`
        )
        .all()
        .map((h) => ({
            ...h,
            is_heading: !!h.is_heading,
            in_review: h.ease_factor !== null,
            created_at: new Date(h.created_at).toISOString(),
            updated_at: new Date(h.updated_at).toISOString(),
            due_at: h.due_at ? new Date(h.due_at).toISOString() : null,
            last_reviewed_at: h.last_reviewed_at ? new Date(h.last_reviewed_at).toISOString() : null,
        }));

    const reviewSessionDates = [...getSessionDates(userId)].sort();

    const recommendations = listRecommendations(userId).map((r) => ({
        content: r.content,
        created_at: new Date(r.created_at).toISOString(),
    }));

    return {
        exported_at: new Date().toISOString(),
        account,
        api_tokens: apiTokens,
        books,
        highlights,
        review_session_dates: reviewSessionDates,
        ai_recommendations: recommendations,
    };
}
