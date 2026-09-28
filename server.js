import express from 'express';
import session from 'express-session';
import path from 'path';
import crypto from 'crypto';
import './db/index.js';
import { SqliteSessionStore } from './db/session-store.js';
import { findUserById } from './db/auth.js';
import { detectLocale, translator, dateLocale, SUPPORTED_LOCALES } from './lib/i18n.js';
import { renderInlineMarkdown, renderBlockMarkdown } from './lib/markdown.js';
import { PROVIDER_NAMES } from './db/recommendations.js';
import { startReminderScheduler } from './lib/reminder-scheduler.js';
import { startTelegramDigestScheduler } from './lib/telegram-digest-scheduler.js';
import { startTelegramPoller } from './lib/telegram-poller.js';
import authRoutes from './routes/auth.js';
import webRoutes from './routes/web.js';
import apiRoutes from './routes/api.js';
import telegramRoutes from './routes/telegram.js';

const app = express();
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Behind Caddy (TLS terminates there) -- needed so express-session sees the
// request as secure via X-Forwarded-Proto and sets the cookie's Secure flag.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(import.meta.dirname, 'views'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

app.use(
    session({
        store: new SqliteSessionStore(),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: 1000 * 60 * 60 * 24 * 365, // "remember me" -- 1 year, single-user app
        },
    })
);

app.use((req, res, next) => {
    let locale = detectLocale(req.get('accept-language'));
    let user = null;
    let textScale = 1;
    if (req.session.userId) {
        const row = findUserById(req.session.userId);
        if (row) {
            user = { id: row.id, username: row.username };
            if (row.locale && SUPPORTED_LOCALES.includes(row.locale)) locale = row.locale;
            textScale = row.text_scale || 1;
        }
    }
    res.locals.user = user;
    res.locals.locale = locale;
    res.locals.t = translator(locale);
    res.locals.dateLocale = dateLocale(locale);
    res.locals.SUPPORTED_LOCALES = SUPPORTED_LOCALES;
    res.locals.textScale = textScale;
    res.locals.md = renderInlineMarkdown;
    res.locals.mdBlock = renderBlockMarkdown;
    res.locals.AI_PROVIDER_NAMES = PROVIDER_NAMES;
    next();
});

app.use('/api', apiRoutes);
app.use('/telegram', telegramRoutes);
app.use('/', authRoutes);
app.use('/', webRoutes);

app.use((req, res) => res.status(404).render('404'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`readrepeat listening on :${PORT}`));
startReminderScheduler();
startTelegramDigestScheduler();
startTelegramPoller();
