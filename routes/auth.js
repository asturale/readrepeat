import express from 'express';
import { userCount } from '../db/index.js';
import { createUser, findUserByUsername, verifyPassword } from '../db/auth.js';
import { checkPasswordStrength, MIN_LENGTH } from '../lib/password-policy.js';

const router = express.Router();

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
    req.session.userId = userId;
    req.session.username = username;
    res.redirect('/');
});

router.get('/login', (req, res) => {
    if (userCount() === 0) return res.redirect('/setup');
    if (req.session.userId) return res.redirect('/');
    res.render('login', { error: null });
});

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = findUserByUsername(username || '');
    if (!user || !verifyPassword(password || '', user.password_hash)) {
        return res.render('login', { error: res.locals.t('login.error') });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.redirect('/');
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

export default router;
