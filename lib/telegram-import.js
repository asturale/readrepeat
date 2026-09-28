import { findUserByTelegramChatId } from '../db/telegram.js';
import { importClippingsText } from './import-clippings.js';
import { downloadTelegramFile, sendTelegramMessage } from './telegram-digest.js';

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
        return sendTelegramMessage(
            message.chat.id,
            '⚠️ Deze Telegram-chat is nog niet gekoppeld aan een ReadRepeat-account. Zet je chat-ID in Instellingen → Telegram dagelijkse highlights.'
        ).catch((e) => console.error('telegram reply failed:', e.message));
    }

    try {
        const raw = await downloadTelegramFile(doc.file_id);
        const { error, result } = importClippingsText(raw);
        if (error === 'empty') {
            await sendTelegramMessage(user.telegram_chat_id, '⚠️ Leeg bestand ontvangen.');
        } else if (error === 'parse') {
            await sendTelegramMessage(user.telegram_chat_id, '⚠️ Kon dit niet als "My Clippings"-bestand lezen.');
        } else if (error === 'no_highlights') {
            await sendTelegramMessage(user.telegram_chat_id, '⚠️ Geen highlights gevonden in dit bestand.');
        } else {
            await sendTelegramMessage(
                user.telegram_chat_id,
                `✅ <b>Import gelukt</b>\n${result.total} highlights gevonden -- ${result.created} nieuw toegevoegd, ${result.updated} al bekend/bijgewerkt.`
            );
        }
    } catch (e) {
        console.error('telegram import failed:', e.message);
        await sendTelegramMessage(user.telegram_chat_id, '⚠️ Importeren mislukt, probeer het later opnieuw.').catch(() => {});
    }
}
