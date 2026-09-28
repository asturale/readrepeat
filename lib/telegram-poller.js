import { telegramDigestConfigured, getTelegramUpdates } from './telegram-digest.js';
import { handleIncomingMessage } from './telegram-import.js';

// Long-polling instead of a webhook -- ReadRepeat has no public endpoint
// (Tailscale-only by design), so Telegram can't push to us; we pull instead.
// getUpdates' own `timeout` does the waiting (Telegram holds the connection
// open server-side until something arrives or the timeout elapses), so this
// loop makes roughly one outbound request per POLL_TIMEOUT_S, not one per
// second.
const POLL_TIMEOUT_S = 30;
const ERROR_BACKOFF_MS = 5000;

let offset = 0;
let running = false;

export function startTelegramPoller() {
    if (!telegramDigestConfigured || running) return;
    running = true;
    pollLoop();
}

async function pollLoop() {
    while (running) {
        try {
            const updates = await getTelegramUpdates(offset, POLL_TIMEOUT_S);
            for (const update of updates) {
                offset = update.update_id + 1;
                if (update.message) {
                    await handleIncomingMessage(update.message).catch((e) => console.error('telegram message handling failed:', e.message));
                }
            }
        } catch (e) {
            console.error('telegram poll failed:', e.message);
            await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
        }
    }
}
