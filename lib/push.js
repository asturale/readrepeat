import webpush from 'web-push';
import { removeSubscription } from '../db/push.js';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
export const VAPID_PUBLIC = VAPID_PUBLIC_KEY || null;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Sends one push message; on a 404/410 (browser says the subscription is
// gone -- user revoked permission, or uninstalled) the stale row is deleted
// so future reminder runs don't keep retrying it forever.
export async function sendToSubscription(sub, payload) {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
    try {
        await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload)
        );
        return true;
    } catch (e) {
        console.error(`[push] send failed (status ${e.statusCode ?? '?'}) for endpoint ...${sub.endpoint.slice(-24)}: ${e.body || e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) {
            removeSubscription(sub.endpoint);
        }
        return false;
    }
}
