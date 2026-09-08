import express from 'express';
import fs from 'fs';
import path from 'path';
import { requireLogin } from './middleware.js';
import { listBooksWithCounts, getBook, setReviewWeight, deleteBook, updateBookMetadata } from '../db/books.js';
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
} from '../db/highlights.js';
import { createApiToken, listApiTokens, revokeApiToken, setUserLocale, findUserById, markSessionCompleted, completedSessionToday } from '../db/auth.js';
import { SUPPORTED_LOCALES } from '../lib/i18n.js';
import { saveSubscription, removeSubscription, hasSubscription, setReviewBatchSize, setReminderFrequency, setReminderHour, setTextScale } from '../db/push.js';
import { VAPID_PUBLIC } from '../lib/push.js';
import { addToReview, removeFromReview, isInReview, getReviewBatch, recordReview, reviewQueueSize, reviewEnrolledCount, previewFromBatch, getHighlightsByIds } from '../db/reviews.js';
import { renderShareImage } from '../lib/share-image.js';
import { stripMarkdown } from '../lib/markdown.js';
import { search } from '../db/search.js';

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
    const feedMode = req.query.feed === 'random' ? 'random' : 'recent';
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
        feedMode,
        recentHighlights: feedMode === 'random' ? listRandomHighlights(8) : listRecentHighlights(8),
    });
});

router.get('/books', (req, res) => {
    res.render('books', { books: listBooksWithCounts(), totalHighlights: countHighlights() });
});

router.get('/books/:id', (req, res) => {
    const book = getBook(req.params.id);
    if (!book) return res.status(404).render('404');
    const highlights = listHighlightsForBook(book.id).map((h) => ({ ...h, in_review: isInReview(h.id) }));
    res.render('book', { book, highlights, editId: req.query.edit ? Number(req.query.edit) : null });
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
    res.render('review', { batch, count, dueCount: reviewQueueSize(), enrolledCount: reviewEnrolledCount() });
});

router.post('/review/:hid', (req, res) => {
    recordReview(req.params.hid, req.body.action);
    res.redirect(`/review?count=${encodeURIComponent(req.body.count || 5)}`);
});

router.post('/review/session/complete', (req, res) => {
    markSessionCompleted(req.session.userId);
    res.json({ ok: true });
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
        res.status(500).send('Kon afbeelding niet genereren: ' + e.message);
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

router.get('/account', (req, res) => {
    res.render('account', { tokens: listApiTokens(req.session.userId), newToken: null, storedLocale: findUserById(req.session.userId).locale });
});

router.post('/account/tokens', (req, res) => {
    const token = createApiToken(req.session.userId, req.body.label || null);
    res.render('account', { tokens: listApiTokens(req.session.userId), newToken: token, storedLocale: findUserById(req.session.userId).locale });
});

router.post('/account/tokens/:id/revoke', (req, res) => {
    revokeApiToken(req.session.userId, req.params.id);
    res.redirect('/account');
});

router.post('/account/locale', (req, res) => {
    const { locale } = req.body;
    if (!locale || SUPPORTED_LOCALES.includes(locale)) setUserLocale(req.session.userId, locale || null);
    res.redirect('/account');
});

router.get('/account/settings', (req, res) => {
    const user = findUserById(req.session.userId);
    res.render('settings', {
        reviewBatchSize: user.review_batch_size,
        reminderFrequencyHours: user.reminder_frequency_hours,
        reminderHour: user.reminder_hour,
        textScale: user.text_scale,
        pushSubscribed: hasSubscription(user.id),
        vapidPublicKey: VAPID_PUBLIC,
    });
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

router.post('/account/settings/text-scale', (req, res) => {
    setTextScale(req.session.userId, req.body.scale);
    res.redirect('/account/settings');
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
