import express from 'express';
import { requireLogin } from './middleware.js';
import { listBooksWithCounts, getBook, setReviewWeight } from '../db/books.js';
import {
    listHighlightsForBook,
    countHighlights,
    getHighlight,
    createManualHighlight,
    updateHighlightText,
    deleteHighlight,
    mergeHighlights,
} from '../db/highlights.js';
import { createApiToken, listApiTokens, revokeApiToken, setUserLocale, findUserById } from '../db/auth.js';
import { SUPPORTED_LOCALES } from '../lib/i18n.js';
import { saveSubscription, removeSubscription, hasSubscription, setReviewBatchSize, setReminderFrequency, setReminderHour, setTextScale } from '../db/push.js';
import { VAPID_PUBLIC } from '../lib/push.js';
import { addToReview, removeFromReview, isInReview, getReviewBatch, recordReview, reviewQueueSize, reviewEnrolledCount } from '../db/reviews.js';
import { renderShareImage } from '../lib/share-image.js';
import { search } from '../db/search.js';

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
    const books = listBooksWithCounts();
    res.render('dashboard', {
        books,
        totalHighlights: countHighlights(),
        reviewDue: reviewQueueSize(),
        reviewEnrolled: reviewEnrolledCount(),
    });
});

router.get('/books/:id', (req, res) => {
    const book = getBook(req.params.id);
    if (!book) return res.status(404).render('404');
    const highlights = listHighlightsForBook(book.id).map((h) => ({ ...h, in_review: isInReview(h.id) }));
    res.render('book', { book, highlights, editId: req.query.edit ? Number(req.query.edit) : null });
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
    res.redirect(`/books/${req.params.id}`);
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
    res.redirect(`/books/${req.params.id}`);
});

router.get('/review', (req, res) => {
    const count = req.query.count || findUserById(req.session.userId).review_batch_size;
    const batch = getReviewBatch(count);
    res.render('review', { batch, count, dueCount: reviewQueueSize(), enrolledCount: reviewEnrolledCount() });
});

router.post('/review/:hid', (req, res) => {
    recordReview(req.params.hid, req.body.action);
    res.redirect(`/review?count=${encodeURIComponent(req.body.count || 5)}`);
});

router.get('/highlights/:id/share.png', async (req, res) => {
    const h = getHighlight(req.params.id);
    if (!h) return res.status(404).end();
    const book = getBook(h.book_id);
    try {
        const png = await renderShareImage({ text: h.text, title: book.title, author: book.author, coverUrl: book.cover_url });
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
