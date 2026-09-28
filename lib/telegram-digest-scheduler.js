import { usersDueForTelegramDigest, markTelegramDigestSent } from '../db/telegram.js';
import { getDiscoverBatch } from '../db/reviews.js';
import { sendTelegramDigest, telegramDigestConfigured } from './telegram-digest.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function startTelegramDigestScheduler() {
    if (!telegramDigestConfigured) return; // no TELEGRAM_BOT_TOKEN set for this install -- feature stays inert
    setInterval(checkAndSend, CHECK_INTERVAL_MS).unref();
}

async function checkAndSend() {
    const due = usersDueForTelegramDigest();
    for (const user of due) {
        const highlights = getDiscoverBatch([], user.telegram_digest_count);
        if (highlights.length > 0) {
            try {
                await sendTelegramDigest(user.id, user.telegram_chat_id, highlights);
            } catch (e) {
                console.error(`telegram digest failed for user ${user.id}:`, e.message);
            }
        }
        markTelegramDigestSent(user.id);
    }
}
