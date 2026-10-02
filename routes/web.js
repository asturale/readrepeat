import express from 'express';
import fs from 'fs';
import path from 'path';
import { requireLogin } from './middleware.js';
import { importClippingsText } from '../lib/import-clippings.js';
import { listBooksWithCounts, getBook, setReviewWeight, deleteBook, updateBookMetadata, mergeSelectedBooks } from '../db/books.js';
import {
    listHighlightsForBook,
    countHighlights,
    getHighlight,
    createManualHighlight,
    updateHighlightText,
    deleteHighlight,
    mergeHighlights,
    listRecentHighlights,
    listRandomHighlights,
    listLeastRecentlySeen,
} from '../db/highlights.js';
import { createApiToken, listApiTokens, revokeApiToken, setUserLocale, findUserById, markSessionCompleted, completedSessionToday, setFeedMode, verifyPassword, setPassword } from '../db/auth.js';
import { checkPasswordStrength, MIN_LENGTH } from '../lib/password-policy.js';
import { logSessionDay, getStreak, getMonthCalendar } from '../db/streak.js';
import { SUPPORTED_LOCALES } from '../lib/i18n.js';
import { saveSubscription, removeSubscription, hasSubscription, listSubscriptions, setReviewBatchSize, setReminderFrequency, setReminderHour, setTextScale } from '../db/push.js';
import { setApiKey, getApiKey, setProvider, getProvider, configuredProviders, PROVIDERS, listRecommendations, generateRecommendations, generateRecommendationsForBook, generateRecommendationsForTopic } from '../db/recommendations.js';
import { setTelegramChatId, setTelegramDigest } from '../db/telegram.js';
import { telegramDigestConfigured, sendTelegramTest } from '../lib/telegram-digest.js';
import { sendToSubscription } from '../lib/push.js';
import { VAPID_PUBLIC } from '../lib/push.js';
import { addToReview, removeFromReview, isInReview, getReviewBatch, recordReview, reviewQueueSize, reviewEnrolledCount, previewFromBatch, getHighlightsByIds, getDiscoverBatch } from '../db/reviews.js';
import { renderShareImage } from '../lib/share-image.js';
import { stripMarkdown, renderInlineMarkdown } from '../lib/markdown.js';
import { search } from '../db/search.js';
import { buildGdprExport } from '../db/export.js';
import { setCrosspointSettings, markCrosspointSynced } from '../db/crosspoint.js';
import { syncCrosspointClippings } from '../lib/crosspoint-sync.js';
import { importKoboDb } from '../lib/import-kobo.js';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));

const router = express.Router();
router.use(requireLogin);

router.get('/about', (req, res) => {
    res.render('about', { version: pkg.version, highlightCount: countHighlights(), bookCount: listBooksWithCounts().length });
});

router.get('/', (req, res) => {
    const bookCount = listBooksWithCounts().length;
    const reviewEnrolled = reviewEnrolledCount();
    const user = findUserById(req.session.userId);
    // An explicit ?feed= click both applies for this view AND becomes the
    // remembered default for next time; otherwise fall back to whatever
    // was last saved.
    const feedMode = ['recent', 'random', 'oldest'].includes(req.query.feed) ? req.query.feed : user.feed_mode;
    if (req.query.feed && req.query.feed !== user.feed_mode) setFeedMode(user.id, feedMode);
    // Fetch the batch ONCE here and carry its exact highlight ids into the
    // "Review" button's link (see dashboard.ejs) -- previously the preview
    // covers/authors came from a separate, differently-ordered query than
    // getReviewBatch()'s own shuffled diversity pick, so they almost never
    // matched what actually opened in /review.
    const previewBatch = reviewEnrolled > 0 ? getReviewBatch(user.review_batch_size) : [];
    res.render('dashboard', {
        bookCount,
        totalHighlights: countHighlights(),
        reviewSessionCount: previewBatch.length,
        reviewBatchIds: previewBatch.map((h) => h.id).join(','),
        reviewPreview: previewBatch.length > 0 ? previewFromBatch(previewBatch) : null,
        // "Done for today" = completed a review session today, NOT that the
        // (potentially huge, backfilled) due queue has hit zero -- see
        // completedSessionToday()'s own comment.
        reviewDone: completedSessionToday(user),
        streak: getStreak(user.id),
        feedMode,
        recentHighlights:
            feedMode === 'random' ? listRandomHighlights(8) : feedMode === 'oldest' ? listLeastRecentlySeen(8) : listRecentHighlights(8),
    });
});

router.get('/books', (req, res) => {
    const sort = ['recent', 'title', 'author', 'highlights'].includes(req.query.sort) ? req.query.sort : 'recent';
    res.render('books', { books: listBooksWithCounts(sort), totalHighlights: countHighlights(), sort });
});

router.post('/books/merge', (req, res) => {
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(Number).filter(Boolean);
    const survivorId = req.body.survivor_id ? Number(req.body.survivor_id) : null;
    mergeSelectedBooks(ids, survivorId);
    res.redirect('/books');
});

router.get('/books/:id', (req, res) => {
    const book = getBook(req.params.id);
    if (!book) return res.status(404).render('404');
    const highlights = listHighlightsForBook(book.id).map((h) => ({ ...h, in_review: isInReview(h.id) }));
    res.render('book', {
        book,
        highlights,
        editId: req.query.edit ? Number(req.query.edit) : null,
        hasAiKey: configuredProviders(req.session.userId).length > 0,
        recError: req.query.rec_error || null,
    });
});

router.post('/books/:id/recommend', async (req, res) => {
    const book = getBook(req.params.id);
    if (!book) return res.status(404).render('404');
    try {
        await generateRecommendationsForBook(req.session.userId, book.id);
        res.redirect('/recommendations');
    } catch (e) {
        const known = ['no_api_key', 'no_highlights', 'empty_response'].includes(e.message) ? e.message : 'generate_failed';
        res.redirect(`/books/${book.id}?rec_error=${known}`);
    }
});

router.post('/books/:id/delete', (req, res) => {
    const book = getBook(req.params.id);
    if (!book) return res.status(404).render('404');
    deleteBook(book.id);
    res.redirect('/');
});

router.post('/books/:id/metadata', (req, res) => {
    const book = getBook(req.params.id);
    if (!book) return res.status(404).render('404');
    const { title, author, cover_url } = req.body;
    if (title && title.trim()) {
        try {
            updateBookMetadata(book.id, { title: title.trim(), author: author?.trim(), cover_url: cover_url?.trim() });
        } catch (e) {
            // Almost certainly a normalized_key collision with another
            // existing book -- non-fatal, just leave the metadata as-is.
        }
    }
    res.redirect(`/books/${req.params.id}`);
});

router.post('/books/:id/review-weight', (req, res) => {
    setReviewWeight(req.params.id, req.body.weight);
    res.redirect(`/books/${req.params.id}`);
});

router.post('/books/:id/highlights/new', (req, res) => {
    const { text, note, color } = req.body;
    if (text && text.trim()) createManualHighlight(req.params.id, { text: text.trim(), note, color });
    res.redirect(`/books/${req.params.id}`);
});

router.post('/books/:id/highlights/:hid/edit', (req, res) => {
    const h = getHighlight(req.params.hid);
    if (!h || h.book_id != req.params.id) return res.status(404).render('404');
    const { text, note, color } = req.body;
    if (text && text.trim()) updateHighlightText(h.id, { text: text.trim(), note, color });
    res.redirect(`/books/${req.params.id}#highlight-${h.id}`);
});

router.post('/books/:id/highlights/:hid/delete', (req, res) => {
    const h = getHighlight(req.params.hid);
    if (h && h.book_id == req.params.id) deleteHighlight(h.id);
    res.redirect(`/books/${req.params.id}`);
});

router.post('/books/:id/merge', (req, res) => {
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map(Number).filter(Boolean);
    try {
        mergeHighlights(ids);
    } catch (e) {
        // Non-fatal for the user -- just skip the merge and go back.
    }
    res.redirect(`/books/${req.params.id}`);
});

router.post('/books/:id/highlights/:hid/review-toggle', (req, res) => {
    const h = getHighlight(req.params.hid);
    if (!h || h.book_id != req.params.id) return res.status(404).render('404');
    if (isInReview(h.id)) removeFromReview(h.id);
    else addToReview(h.id);
    res.redirect(`/books/${req.params.id}#highlight-${h.id}`);
});

router.get('/review', (req, res) => {
    const count = req.query.count || findUserById(req.session.userId).review_batch_size;
    // ?ids= (set by the dashboard's "Review" link) opens the EXACT batch it
    // already previewed, instead of getReviewBatch() shuffling a fresh
    // (and likely different) one.
    const ids = req.query.ids ? req.query.ids.split(',').map(Number).filter(Boolean) : [];
    const batch = ids.length > 0 ? getHighlightsByIds(ids) : getReviewBatch(count);
    // A feed click opens a single highlight as a card (explicit ?from=feed,
    // set by the feed links) -- that's browsing, not a review session: no
    // "done" screen, and it must NOT count toward the daily streak.
    const fromFeed = req.query.from === 'feed';
    res.render('review', { batch, count, dueCount: reviewQueueSize(), enrolledCount: reviewEnrolledCount(), fromFeed });
});

router.post('/review/:hid', (req, res) => {
    recordReview(req.params.hid, req.body.action);
    res.redirect(`/review?count=${encodeURIComponent(req.body.count || 5)}`);
});

router.post('/review/session/complete', (req, res) => {
    markSessionCompleted(req.session.userId);
    logSessionDay(req.session.userId);
    res.json({ ok: true });
});

function toDiscoverCards(batch) {
    return batch.map((h) => ({
        id: h.id,
        book_id: h.book_id,
        // Raw text/note included too (alongside the already-rendered *Html
        // fields) -- needed to fill the edit textareas, same as review.ejs does.
        text: h.text,
        note: h.note || null,
        textHtml: renderInlineMarkdown(h.text),
        noteHtml: h.note ? renderInlineMarkdown(h.note) : null,
        bookTitleHtml: renderInlineMarkdown(h.book_title),
        bookAuthorHtml: h.book_author ? renderInlineMarkdown(h.book_author) : null,
        coverUrl: h.cover_url || null,
    }));
}

router.get('/discover', (req, res) => {
    const batch = getDiscoverBatch([], 8);
    res.render('discover', { initialCards: toDiscoverCards(batch) });
});

router.get('/api/discover', (req, res) => {
    const exclude = req.query.exclude ? req.query.exclude.split(',').map(Number).filter(Boolean) : [];
    const batch = getDiscoverBatch(exclude, 8);
    res.json({ cards: toDiscoverCards(batch) });
});

// JSON variant of /books/:id/highlights/:hid/edit, for the review card
// (client-rendered, no page redirect like the book-page version -- the
// user needs to be able to stay in the review flow after saving).
router.post('/highlights/:id/edit', (req, res) => {
    const h = getHighlight(req.params.id);
    if (!h) return res.status(404).json({ error: 'not found' });
    const { text, note } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    updateHighlightText(h.id, { text: text.trim(), note: note?.trim() || null, color: h.color });
    res.json({
        ok: true,
        text: text.trim(),
        note: note?.trim() || null,
        textHtml: renderInlineMarkdown(text.trim()),
        noteHtml: note?.trim() ? renderInlineMarkdown(note.trim()) : null,
    });
});

router.get('/highlights/:id/share.png', async (req, res) => {
    const h = getHighlight(req.params.id);
    if (!h) return res.status(404).end();
    const book = getBook(h.book_id);
    try {
        const png = await renderShareImage({ text: stripMarkdown(h.text), title: book.title, author: book.author, coverUrl: book.cover_url });
        res.set('Content-Type', 'image/png');
        res.set('Content-Disposition', `inline; filename="highlight-${h.id}.png"`);
        res.send(png);
    } catch (e) {
        res.status(500).send(res.locals.t('share.image_error', { message: e.message }));
    }
});

router.get('/highlights/:id/share', (req, res) => {
    const h = getHighlight(req.params.id);
    if (!h) return res.status(404).render('404');
    const book = getBook(h.book_id);
    res.render('share', { highlight: h, book });
});

router.get('/search', (req, res) => {
    const q = req.query.q || '';
    const results = q.trim() ? search(q) : { books: [], highlights: [] };
    res.render('search', { q, results });
});

function importLocals(req, extra) {
    const user = findUserById(req.session.userId);
    return {
        result: null,
        error: null,
        crosspointEnabled: !!user.crosspoint_enabled,
        crosspointServerUrl: user.crosspoint_server_url || '',
        crosspointUsername: user.crosspoint_username || '',
        crosspointConfigured: !!user.crosspoint_password,
        crosspointIntervalMinutes: user.crosspoint_interval_minutes,
        crosspointLastSyncedAt: user.crosspoint_last_synced_at,
        crosspointLastSyncError: user.crosspoint_last_sync_error,
        ...extra,
    };
}

router.get('/import', (req, res) => {
    res.render('import', importLocals(req));
});

// Classic Kindle "My Clippings" format (also used by CrossPoint/CrossInk
// devices) -- text is read CLIENT-SIDE from the uploaded file (no multer/
// multipart needed, saves a dependency) and posted as plain text.
// express.text() instead of the global json/urlencoded limit (100kb and
// 2mb respectively) -- a clippings file built up over years can be bigger
// than that.
router.post('/import/clippings', express.text({ type: '*/*', limit: '10mb' }), (req, res) => {
    const { error, result } = importClippingsText(req.body);
    if (error) return res.render('import', importLocals(req, { error: res.locals.t(`import.error_${error}`) }));
    res.render('import', importLocals(req, { result }));
});

// Kobo's own KoboReader.sqlite, uploaded as raw binary (read client-side as
// an ArrayBuffer, NOT text like the clippings upload above -- it's a SQLite
// file, not UTF-8) -- see lib/import-kobo.js for the Bookmark/content join.
router.post('/import/kobo-db', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const { error, result } = importKoboDb(req.body);
    if (error) return res.render('import', importLocals(req, { error: res.locals.t(`import.error_${error}`) }));
    res.render('import', importLocals(req, { result }));
});

router.post('/import/crosspoint-settings', (req, res) => {
    setCrosspointSettings(req.session.userId, {
        enabled: req.body.enabled === 'on',
        serverUrl: req.body.server_url,
        username: req.body.username,
        password: req.body.password,
        intervalMinutes: req.body.interval_minutes,
    });
    res.redirect('/import');
});

// Manual "sync now" button -- same credentials/logic as the background
// scheduler (lib/crosspoint-sync.js), just triggered immediately instead of
// waiting for the next interval tick.
router.post('/import/crosspoint-sync-now', async (req, res) => {
    const user = findUserById(req.session.userId);
    if (!user.crosspoint_server_url || !user.crosspoint_username || !user.crosspoint_password) {
        return res.status(400).json({ ok: false, error: res.locals.t('import.crosspoint_not_configured') });
    }
    try {
        const result = await syncCrosspointClippings({
            serverUrl: user.crosspoint_server_url,
            username: user.crosspoint_username,
            password: user.crosspoint_password,
        });
        markCrosspointSynced(user.id, { error: null });
        res.json({ ok: true, result });
    } catch (e) {
        markCrosspointSynced(user.id, { error: e.message });
        res.status(502).json({ ok: false, error: e.message });
    }
});

function accountLocals(req, res) {
    const now = new Date();
    return {
        streak: getStreak(req.session.userId),
        calendarMonth: getMonthCalendar(req.session.userId, now.getFullYear(), now.getMonth()),
        calendarLabel: now.toLocaleDateString(res.locals.dateLocale, { month: 'long', year: 'numeric' }),
    };
}

// API tokens, language and password all moved here from /account (Koen:
// "move API token management and the language setting to the settings
// page") -- /account is now just the menu + streak + logout.
function settingsLocals(req, extra) {
    const user = findUserById(req.session.userId);
    return {
        reviewBatchSize: user.review_batch_size,
        reminderFrequencyHours: user.reminder_frequency_hours,
        reminderHour: user.reminder_hour,
        textScale: user.text_scale,
        pushSubscribed: hasSubscription(user.id),
        vapidPublicKey: VAPID_PUBLIC,
        tokens: listApiTokens(req.session.userId),
        newToken: null,
        storedLocale: user.locale,
        passwordError: null,
        passwordSuccess: false,
        aiProviders: PROVIDERS,
        aiProvider: getProvider(user.id),
        configuredProviders: configuredProviders(user.id),
        telegramDigestConfigured,
        telegramChatId: user.telegram_chat_id,
        telegramDigestEnabled: !!user.telegram_digest_enabled,
        telegramDigestHour: user.telegram_digest_hour,
        telegramDigestCount: user.telegram_digest_count,
        ...extra,
    };
}

router.get('/account', (req, res) => {
    res.render('account', accountLocals(req, res));
});

router.post('/account/tokens', (req, res) => {
    const token = createApiToken(req.session.userId, req.body.label || null);
    res.render('settings', settingsLocals(req, { newToken: token }));
});

router.post('/account/tokens/:id/revoke', (req, res) => {
    revokeApiToken(req.session.userId, req.params.id);
    res.redirect('/account/settings');
});

router.post('/account/locale', (req, res) => {
    const { locale } = req.body;
    if (!locale || SUPPORTED_LOCALES.includes(locale)) setUserLocale(req.session.userId, locale || null);
    res.redirect('/account/settings');
});

router.post('/account/password', (req, res) => {
    const { current_password, new_password, new_password2 } = req.body;
    const user = findUserById(req.session.userId);
    if (!current_password || !verifyPassword(current_password, user.password_hash)) {
        return res.render('settings', settingsLocals(req, { passwordError: res.locals.t('settings.password_error_current') }));
    }
    const strength = checkPasswordStrength(new_password);
    if (strength === 'too_short') {
        return res.render('settings', settingsLocals(req, { passwordError: res.locals.t('settings.password_error_short', { min: MIN_LENGTH }) }));
    }
    if (strength === 'too_common') {
        return res.render('settings', settingsLocals(req, { passwordError: res.locals.t('settings.password_error_common') }));
    }
    if (new_password !== new_password2) {
        return res.render('settings', settingsLocals(req, { passwordError: res.locals.t('settings.password_error_mismatch') }));
    }
    setPassword(user.id, new_password);
    res.render('settings', settingsLocals(req, { passwordSuccess: true }));
});

router.get('/account/settings', (req, res) => {
    res.render('settings', settingsLocals(req));
});

// GDPR data export (Art. 20) -- everything the app has about this user, as
// a downloadable JSON file. No password hash/API tokens/BYOK keys in it
// (see db/export.js's own explanation).
router.get('/account/export', (req, res) => {
    const data = buildGdprExport(req.session.userId);
    const filename = `readrepeat-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data, null, 2));
});

router.post('/account/settings/review-batch-size', (req, res) => {
    setReviewBatchSize(req.session.userId, req.body.size);
    res.redirect('/account/settings');
});

router.post('/account/settings/reminder-frequency', (req, res) => {
    setReminderFrequency(req.session.userId, req.body.hours);
    res.redirect('/account/settings');
});

router.post('/account/settings/reminder-hour', (req, res) => {
    setReminderHour(req.session.userId, req.body.hour);
    res.redirect('/account/settings');
});

router.post('/account/settings/telegram-chat-id', (req, res) => {
    setTelegramChatId(req.session.userId, req.body.telegram_chat_id || null);
    res.redirect('/account/settings');
});

router.post('/account/settings/telegram-digest', (req, res) => {
    setTelegramDigest(req.session.userId, {
        enabled: req.body.enabled === 'on',
        hour: req.body.hour,
        count: req.body.count,
    });
    res.redirect('/account/settings');
});

router.post('/account/settings/telegram-test', async (req, res) => {
    const user = findUserById(req.session.userId);
    if (!user.telegram_chat_id) return res.status(400).json({ ok: false, error: res.locals.t('settings.telegram_test_no_chat_id') });
    try {
        await sendTelegramTest(user.telegram_chat_id, user.locale);
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ ok: false, error: res.locals.t('settings.telegram_test_failed') });
    }
});

router.post('/account/settings/push-test', async (req, res) => {
    const subs = listSubscriptions(req.session.userId);
    if (subs.length === 0) return res.status(400).json({ ok: false, error: res.locals.t('settings.push_test_no_sub') });
    const payload = { title: 'ReadRepeat', body: res.locals.t('settings.push_test_body'), url: '/' };
    const results = await Promise.all(subs.map((sub) => sendToSubscription(sub, payload)));
    if (results.some(Boolean)) res.json({ ok: true });
    else res.status(502).json({ ok: false, error: res.locals.t('settings.push_test_failed') });
});

router.post('/account/settings/text-scale', (req, res) => {
    setTextScale(req.session.userId, req.body.scale);
    res.redirect('/account/settings');
});

router.post('/account/settings/ai-key', (req, res) => {
    const { provider, api_key } = req.body;
    if (PROVIDERS.includes(provider)) setApiKey(req.session.userId, provider, api_key || null);
    res.redirect('/account/settings');
});

router.post('/account/settings/ai-provider', (req, res) => {
    setProvider(req.session.userId, req.body.provider);
    res.redirect('/account/settings');
});

router.get('/recommendations', (req, res) => {
    res.render('recommendations', {
        history: listRecommendations(req.session.userId),
        hasKey: configuredProviders(req.session.userId).length > 0,
        activeProvider: getProvider(req.session.userId),
        error: null,
        generating: false,
    });
});

router.post('/recommendations/generate', async (req, res) => {
    try {
        await generateRecommendations(req.session.userId);
        res.redirect('/recommendations');
    } catch (e) {
        const known = ['no_api_key', 'no_books', 'empty_response'].includes(e.message) ? e.message : 'generate_failed';
        res.render('recommendations', {
            history: listRecommendations(req.session.userId),
            hasKey: configuredProviders(req.session.userId).length > 0,
            activeProvider: getProvider(req.session.userId),
            error: known,
            generating: false,
        });
    }
});

router.post('/recommendations/generate-topic', async (req, res) => {
    try {
        await generateRecommendationsForTopic(req.session.userId, req.body.topic);
        res.redirect('/recommendations');
    } catch (e) {
        const known = ['no_api_key', 'no_books', 'no_topic', 'empty_response'].includes(e.message) ? e.message : 'generate_failed';
        res.render('recommendations', {
            history: listRecommendations(req.session.userId),
            hasKey: configuredProviders(req.session.userId).length > 0,
            activeProvider: getProvider(req.session.userId),
            error: known,
            generating: false,
        });
    }
});

router.post('/account/push-subscribe', (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'invalid subscription' });
    saveSubscription(req.session.userId, { endpoint, keys });
    res.json({ ok: true });
});

router.post('/account/push-unsubscribe', (req, res) => {
    const { endpoint } = req.body || {};
    if (endpoint) removeSubscription(endpoint);
    res.json({ ok: true });
});

export default router;
