import { findUserByApiToken } from '../db/auth.js';

export function requireLogin(req, res, next) {
    if (!req.session.userId) return res.redirect('/login');
    next();
}

export function requireApiToken(req, res, next) {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'Missing Bearer token' });
    const user = findUserByApiToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.apiUser = user;
    next();
}
