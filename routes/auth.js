import express from 'express';
import { userCount } from '../db/index.js';
import { createUser, findUserByUsername, verifyPassword, findUserByOidc, findUnlinkedUserByUsername, linkUserOidc } from '../db/auth.js';
import { checkPasswordStrength, MIN_LENGTH } from '../lib/password-policy.js';
import {
    oidcEnabled, passwordLoginEnabled, linkByUsername, oidcConfig, randomToken, safeEqual,
    authorizationUrl, exchangeCode, verifyIdToken, resolveUsername,
} from '../lib/oidc.js';

const router = express.Router();
const OIDC_FLOW_MAX_AGE_MS = 10 * 60 * 1000;

function renderLogin(res, error, status = 200) {
    res.status(status).render('login', {
        error,
        oidcEnabled,
        oidcProviderName: oidcConfig.providerName,
        passwordLoginEnabled,
    });
}

// New session id on every sign-in (no session fixation), then log the user in.
function signIn(req, res, user) {
    req.session.regenerate((err) => {
        if (err) return renderLogin(res, res.locals.t('login.error_sso'), 500);
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.save(() => res.redirect('/'));
    });
}

// Single-user app: /setup only works until the first account exists, then
// it's permanently closed off (no open registration ever).
router.get('/setup', (req, res) => {
    if (userCount() > 0) return res.redirect('/login');
    res.render('setup', { error: null });
});

router.post('/setup', (req, res) => {
    if (userCount() > 0) return res.redirect('/login');
    const { username, password, password2 } = req.body;
    if (!username) {
        return res.render('setup', { error: res.locals.t('setup.error_required') });
    }
    const strength = checkPasswordStrength(password);
    if (strength === 'too_short') {
        return res.render('setup', { error: res.locals.t('setup.error_password_short', { min: MIN_LENGTH }) });
    }
    if (strength === 'too_common') {
        return res.render('setup', { error: res.locals.t('setup.error_password_common') });
    }
    if (password !== password2) {
        return res.render('setup', { error: res.locals.t('setup.error_mismatch') });
    }
    const userId = createUser(username, password);
    signIn(req, res, { id: userId, username });
});

router.get('/login', (req, res) => {
    if (userCount() === 0) return res.redirect('/setup');
    if (req.session.userId) return res.redirect('/');
    // SSO-only: skip the page with a single button and go straight to the provider.
    if (!passwordLoginEnabled) return res.redirect('/auth/oidc/login');
    renderLogin(res, null);
});

router.post('/login', (req, res) => {
    if (!passwordLoginEnabled) return renderLogin(res, res.locals.t('login.error_password_disabled'), 403);
    const { username, password } = req.body;
    const user = findUserByUsername(username || '');
    if (!user || !verifyPassword(password || '', user.password_hash)) {
        return renderLogin(res, res.locals.t('login.error'));
    }
    signIn(req, res, user);
});

// --- Sign in with SSO (OpenID Connect), see lib/oidc.js -------------------

async function startFlow(req, res, linkUserId = null) {
    try {
        const flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), at: Date.now(), linkUserId };
        const url = await authorizationUrl(flow);
        req.session.oidc = flow;
        req.session.save(() => res.redirect(url));
    } catch (err) {
        console.error('OIDC login start failed:', err.message);
        renderLogin(res, res.locals.t('login.error_sso'), 502);
    }
}

router.get('/auth/oidc/login', (req, res) => {
    if (!oidcEnabled) return res.status(404).render('404');
    startFlow(req, res);
});

// Rejects cross-site form posts: browsers send Origin on POST. On top of the
// session cookie's SameSite=Lax, which already keeps it off cross-site POSTs.
export function sameOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return true;
    try {
        return new URL(origin).host === req.get('host');
    } catch {
        return false;
    }
}

// Link the signed-in account to an SSO identity (Settings). POST so another
// site can't start it; the callback re-checks it's still the same session user.
router.post('/auth/oidc/link', (req, res) => {
    if (!oidcEnabled) return res.status(404).render('404');
    if (!sameOrigin(req)) return res.status(403).send('Forbidden');
    if (!req.session.userId) return res.redirect('/login');
    startFlow(req, res, req.session.userId);
});

router.get('/auth/oidc/callback', async (req, res) => {
    if (!oidcEnabled) return res.status(404).render('404');
    const flow = req.session.oidc;
    const fail = (msg, status = 400) => {
        console.error('OIDC sign-in rejected:', msg);
        renderLogin(res, res.locals.t('login.error_sso'), status);
    };
    if (!flow || Date.now() - flow.at > OIDC_FLOW_MAX_AGE_MS) return fail('no pending or expired login');
    // A request without the right state must not cancel a pending login, so
    // the flow is only consumed (single use) once the state matches.
    if (!safeEqual(req.query.state, flow.state)) return fail('state mismatch');
    delete req.session.oidc;
    if (req.query.error) return fail(`provider returned ${String(req.query.error).slice(0, 100)}`);
    if (typeof req.query.code !== 'string' || !req.query.code) return fail('no code');
    try {
        const tokens = await exchangeCode(req.query.code, flow.verifier);
        const claims = await verifyIdToken(tokens.id_token, { nonce: flow.nonce });
        const linked = findUserByOidc(oidcConfig.issuer, claims.sub);

        if (flow.linkUserId) {
            if (req.session.userId !== flow.linkUserId) return fail('link flow without the same signed-in user');
            if (linked && linked.id !== flow.linkUserId) return res.redirect('/account/settings?sso=taken');
            linkUserOidc(flow.linkUserId, oidcConfig.issuer, claims.sub);
            return req.session.save(() => res.redirect('/account/settings?sso=linked'));
        }

        let user = linked;
        if (!user && linkByUsername) {
            const username = await resolveUsername(claims, tokens.access_token);
            user = username ? findUnlinkedUserByUsername(username) : null;
            if (user) linkUserOidc(user.id, oidcConfig.issuer, claims.sub);
        }
        if (!user) return renderLogin(res, res.locals.t('login.error_sso_no_account'), 403);
        signIn(req, res, user);
    } catch (err) {
        fail(err.message, 502);
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

export default router;
