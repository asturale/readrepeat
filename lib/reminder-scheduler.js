import { usersDueForReminder, markReminded, listSubscriptions } from '../db/push.js';
import { reviewQueueSize } from '../db/reviews.js';
import { sendToSubscription } from './push.js';
import { translator, SUPPORTED_LOCALES } from './i18n.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Single-user app today (highlights/reviews aren't scoped per-user), so
// reviewQueueSize() is already the right "is there anything to nudge about"
// check regardless of which user we're reminding.
export function startReminderScheduler() {
    setInterval(checkAndSend, CHECK_INTERVAL_MS).unref();
}

async function checkAndSend() {
    const due = usersDueForReminder();
    if (due.length === 0) return;
    const queueSize = reviewQueueSize();

    for (const user of due) {
        if (queueSize > 0) {
            const locale = user.locale && SUPPORTED_LOCALES.includes(user.locale) ? user.locale : 'nl';
            const t = translator(locale);
            const payload = { title: 'ReadRepeat', body: t('push.reminder_body', { count: queueSize }), url: '/review' };
            for (const sub of listSubscriptions(user.id)) {
                await sendToSubscription(sub, payload);
            }
        }
        markReminded(user.id);
    }
}
