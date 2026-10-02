import { findUserByTelegramChatId } from '../db/telegram.js';
import { importClippingsText } from './import-clippings.js';
import { downloadTelegramFile, sendTelegramMessage } from './telegram-digest.js';
import { translator, SUPPORTED_LOCALES } from './i18n.js';

function userT(user) {
    const locale = user?.locale && SUPPORTED_LOCALES.includes(user.locale) ? user.locale : 'nl';
    return translator(locale);
}

// Handles one inbound Telegram message (from the poller, lib/telegram-
// poller.js) that carries a document -- downloads it, imports it as Kindle
// clippings, replies with a confirmation. Not tied to Express: ReadRepeat
// has no public endpoint (Tailscale-only), so inbound messages are polled,
// not pushed via webhook.
export async function handleIncomingMessage(message) {
    const doc = message.document;
    if (!doc) return;

    const user = findUserByTelegramChatId(message.chat.id);
    if (!user) {
        return sendTelegramMessage(message.chat.id, `⚠️ ${userT(user)('telegram.not_linked')}`).catch((e) =>
            console.error('telegram reply failed:', e.message)
        );
    }
    const t = userT(user);

    try {
        const raw = await downloadTelegramFile(doc.file_id);
        const { error, result } = importClippingsText(raw);
        if (error === 'empty') {
            await sendTelegramMessage(user.telegram_chat_id, `⚠️ ${t('telegram.empty_file')}`);
        } else if (error === 'parse') {
            await sendTelegramMessage(user.telegram_chat_id, `⚠️ ${t('telegram.parse_failed')}`);
        } else if (error === 'no_highlights') {
            await sendTelegramMessage(user.telegram_chat_id, `⚠️ ${t('telegram.no_highlights')}`);
        } else {
            await sendTelegramMessage(
                user.telegram_chat_id,
                `✅ ${t('telegram.import_success', { total: result.total, created: result.created, updated: result.updated })}`
            );
        }
    } catch (e) {
        console.error('telegram import failed:', e.message);
        await sendTelegramMessage(user.telegram_chat_id, `⚠️ ${t('telegram.import_failed')}`).catch(() => {});
    }
}
