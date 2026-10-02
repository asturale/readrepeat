import { usersDueForReminder, markReminded, listSubscriptions } from '../db/push.js';
import { getTodaysBatch } from '../db/reviews.js';
import { sendToSubscription } from './push.js';
import { translator, SUPPORTED_LOCALES } from './i18n.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function startReminderScheduler() {
    setInterval(checkAndSend, CHECK_INTERVAL_MS).unref();
}

async function checkAndSend() {
    const due = usersDueForReminder();
    if (due.length === 0) return;

    for (const user of due) {
        // Today's actual review batch (bounded by review_batch_size), not the
        // raw total due-queue size -- a big backlog shouldn't make the
        // notification say "600 highlights to review" when today's session
        // is only ever 5.
        const todaysCount = getTodaysBatch(user.id, user.review_batch_size).length;
        if (todaysCount > 0) {
            const locale = user.locale && SUPPORTED_LOCALES.includes(user.locale) ? user.locale : 'nl';
            const t = translator(locale);
            const payload = { title: 'ReadRepeat', body: t('push.reminder_body', { count: todaysCount }), url: '/review' };
            for (const sub of listSubscriptions(user.id)) {
                await sendToSubscription(sub, payload);
            }
        }
        markReminded(user.id);
    }
}
