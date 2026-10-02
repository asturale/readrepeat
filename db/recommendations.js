import { db } from './index.js';
import { translator, SUPPORTED_LOCALES } from '../lib/i18n.js';

function userTranslator(userId) {
    const row = db.prepare('SELECT locale FROM users WHERE id = ?').get(userId);
    const locale = row?.locale && SUPPORTED_LOCALES.includes(row.locale) ? row.locale : 'nl';
    return translator(locale);
}

const RECENT_MONTHS = 3;
const MAX_RECENT_HIGHLIGHTS = 200; // keeps the prompt (and the bill) bounded on a big library

export const PROVIDERS = ['deepseek', 'openai', 'anthropic'];
export const PROVIDER_NAMES = { deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic' };
const KEY_COLUMN = { deepseek: 'deepseek_api_key', openai: 'openai_api_key', anthropic: 'anthropic_api_key' };

export function setApiKey(userId, provider, key) {
    const col = KEY_COLUMN[provider];
    if (!col) throw new Error('unknown_provider');
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(key ? key.trim() : null, userId);
}

export function getApiKey(userId, provider) {
    const col = KEY_COLUMN[provider];
    if (!col) return null;
    return db.prepare(`SELECT ${col} AS k FROM users WHERE id = ?`).get(userId)?.k || null;
}

export function setProvider(userId, provider) {
    if (!PROVIDERS.includes(provider)) return;
    db.prepare('UPDATE users SET ai_provider = ? WHERE id = ?').run(provider, userId);
}

export function getProvider(userId) {
    return db.prepare('SELECT ai_provider FROM users WHERE id = ?').get(userId)?.ai_provider || 'deepseek';
}

// Which providers this user has a key stored for, in PROVIDERS order --
// used to gray out/hide provider choices in the UI that can't actually run.
export function configuredProviders(userId) {
    const user = db.prepare('SELECT deepseek_api_key, openai_api_key, anthropic_api_key FROM users WHERE id = ?').get(userId);
    return PROVIDERS.filter((p) => !!user[KEY_COLUMN[p]]);
}

export function listRecommendations(userId) {
    return db
        .prepare(
            `SELECT r.*, b.title AS book_title
             FROM recommendations r LEFT JOIN books b ON b.id = r.book_id
             WHERE r.user_id = ? ORDER BY r.created_at DESC`
        )
        .all(userId);
}

function saveRecommendation(userId, content, { bookId = null, topic = null } = {}) {
    db.prepare('INSERT INTO recommendations (user_id, content, book_id, topic, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, content, bookId, topic, Date.now());
}

// Books/highlights aren't per-user scoped in this schema (see db/index.js)
// -- so like the rest of the app, this works on the whole shared library,
// not per account.
function gatherContext() {
    const books = db
        .prepare(
            `SELECT b.title, b.author, COUNT(h.id) AS highlight_count
             FROM books b LEFT JOIN highlights h ON h.book_id = b.id
             GROUP BY b.id ORDER BY b.updated_at DESC`
        )
        .all();

    const since = Date.now() - RECENT_MONTHS * 30 * 24 * 3600 * 1000;
    const recentHighlights = db
        .prepare(
            `SELECT h.text, b.title AS book_title, b.author AS book_author
             FROM highlights h JOIN books b ON b.id = h.book_id
             WHERE h.created_at >= ? AND h.is_heading = 0
             ORDER BY h.created_at DESC LIMIT ?`
        )
        .all(since, MAX_RECENT_HIGHLIGHTS);

    return { books, recentHighlights };
}

function buildPrompt({ books, recentHighlights }, t) {
    const bookList = books.map((b) => `- ${b.title}${b.author ? ` (${b.author})` : ''} [${b.highlight_count} highlights]`).join('\n');
    const highlightList = recentHighlights
        .map((h) => `- "${h.text.slice(0, 300)}" -- ${t('ai_prompt.highlight_source')} "${h.book_title}"${h.book_author ? ` (${h.book_author})` : ''}`)
        .join('\n');

    return (
        `${t('ai_prompt.book_list_intro')}\n${bookList}\n\n` +
        `${t('ai_prompt.recent_highlights_intro', { months: RECENT_MONTHS })}\n${highlightList || t('ai_prompt.no_recent_highlights')}\n\n` +
        t('ai_prompt.recommend_instruction')
    );
}

function gatherBookContext(bookId) {
    const book = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(bookId);
    if (!book) return null;
    const highlights = db
        .prepare('SELECT text FROM highlights WHERE book_id = ? AND is_heading = 0 ORDER BY created_at')
        .all(bookId);
    return { book, highlights };
}

function buildBookPrompt({ book, highlights }, t) {
    const highlightList = highlights.map((h) => `- "${h.text.slice(0, 300)}"`).join('\n');
    const intro = book.author
        ? t('ai_prompt.book_intro_with_author', { title: book.title, author: book.author })
        : t('ai_prompt.book_intro_no_author', { title: book.title });
    return (
        `${intro}\n${highlightList || t('ai_prompt.no_highlights')}\n\n` +
        t('ai_prompt.book_instruction')
    );
}

const MAX_TOPIC_LENGTH = 200;

function buildTopicPrompt({ books, recentHighlights }, topic, t) {
    const bookList = books.map((b) => `- ${b.title}${b.author ? ` (${b.author})` : ''} [${b.highlight_count} highlights]`).join('\n');
    const highlightList = recentHighlights
        .map((h) => `- "${h.text.slice(0, 300)}" -- ${t('ai_prompt.highlight_source')} "${h.book_title}"${h.book_author ? ` (${h.book_author})` : ''}`)
        .join('\n');

    return (
        `${t('ai_prompt.topic_intro', { topic })}\n\n` +
        `${t('ai_prompt.topic_context_intro')}\n${bookList}\n\n` +
        `${t('ai_prompt.recent_highlights_intro', { months: RECENT_MONTHS })}\n${highlightList || t('ai_prompt.no_recent_highlights')}\n\n` +
        t('ai_prompt.topic_instruction', { topic })
    );
}

async function callDeepseek(apiKey, userPrompt, systemPrompt) {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'deepseek-flash',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        }),
    });
    if (!res.ok) throw new Error(`provider_error:${res.status}:${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
}

async function callOpenAI(apiKey, userPrompt, systemPrompt) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-6-sol',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        }),
    });
    if (!res.ok) throw new Error(`provider_error:${res.status}:${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
}

// Anthropic's Messages API has a different shape from the OpenAI-compatible
// pair above: x-api-key (not Bearer) + a required anthropic-version header,
// system prompt as its own top-level field (not a messages[0]), and the
// reply comes back as a content BLOCK ARRAY, not choices[0].message.content.
async function callAnthropic(apiKey, userPrompt, systemPrompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
        }),
    });
    if (!res.ok) throw new Error(`provider_error:${res.status}:${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    return data.content?.find((b) => b.type === 'text')?.text || null;
}

const CALL_PROVIDER = { deepseek: callDeepseek, openai: callOpenAI, anthropic: callAnthropic };

export async function generateRecommendations(userId) {
    const provider = getProvider(userId);
    const apiKey = getApiKey(userId, provider);
    if (!apiKey) throw new Error('no_api_key');

    const context = gatherContext();
    if (context.books.length === 0) throw new Error('no_books');

    const t = userTranslator(userId);
    const content = await CALL_PROVIDER[provider](apiKey, buildPrompt(context, t), t('ai_prompt.system'));
    if (!content) throw new Error('empty_response');

    saveRecommendation(userId, content);
    return content;
}

export async function generateRecommendationsForBook(userId, bookId) {
    const provider = getProvider(userId);
    const apiKey = getApiKey(userId, provider);
    if (!apiKey) throw new Error('no_api_key');

    const context = gatherBookContext(bookId);
    if (!context) throw new Error('book_not_found');
    if (context.highlights.length === 0) throw new Error('no_highlights');

    const t = userTranslator(userId);
    const content = await CALL_PROVIDER[provider](apiKey, buildBookPrompt(context, t), t('ai_prompt.system'));
    if (!content) throw new Error('empty_response');

    saveRecommendation(userId, content, { bookId });
    return content;
}

export async function generateRecommendationsForTopic(userId, topic) {
    const trimmed = (topic || '').trim().slice(0, MAX_TOPIC_LENGTH);
    if (!trimmed) throw new Error('no_topic');

    const provider = getProvider(userId);
    const apiKey = getApiKey(userId, provider);
    if (!apiKey) throw new Error('no_api_key');

    const context = gatherContext();
    if (context.books.length === 0) throw new Error('no_books');

    const t = userTranslator(userId);
    const content = await CALL_PROVIDER[provider](apiKey, buildTopicPrompt(context, trimmed, t), t('ai_prompt.system'));
    if (!content) throw new Error('empty_response');

    saveRecommendation(userId, content, { topic: trimmed });
    return content;
}
