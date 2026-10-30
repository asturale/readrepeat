// Run with: npm test (node's built-in test runner, no extra dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyIdToken, safeEqual, pkceChallenge } from '../lib/oidc.js';

const ISS = 'https://auth.example.com';
const CLIENT = 'readrepeat';
const NOW = 1_800_000_000_000;

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (pub, kid) => ({ ...pub.export({ format: 'jwk' }), kid, use: 'sig' });
const KEYS = [jwk(rsa.publicKey, 'rsa1'), jwk(ec.publicKey, 'ec1')];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { alg = 'RS256', kid = 'rsa1', key = rsa.privateKey } = {}) {
    const head = b64({ alg, kid, typ: 'JWT' });
    const body = b64(claims);
    const data = Buffer.from(`${head}.${body}`);
    const sig = alg === 'none' ? Buffer.alloc(0)
        : alg.startsWith('ES') ? crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
        : crypto.sign('sha256', data, key);
    return `${head}.${body}.${sig.toString('base64url')}`;
}
const good = (extra = {}) => ({ iss: ISS, aud: CLIENT, sub: 'abc', nonce: 'n1', exp: NOW / 1000 + 300, iat: NOW / 1000, preferred_username: 'koen', ...extra });
const verify = (tok, opts = {}) => verifyIdToken(tok, { nonce: 'n1', now: NOW, keys: KEYS, issuer: ISS, clientId: CLIENT, ...opts });

test('accepts a valid RS256 token', async () => {
    const c = await verify(sign(good()));
    assert.equal(c.sub, 'abc');
});

test('accepts a valid ES256 token', async () => {
    const c = await verify(sign(good(), { alg: 'ES256', kid: 'ec1', key: ec.privateKey }));
    assert.equal(c.preferred_username, 'koen');
});

test('rejects a token signed by an unknown key', async () => {
    await assert.rejects(verify(sign(good(), { key: other.privateKey })), /signature/);
});

test('rejects alg none and HS256', async () => {
    await assert.rejects(verify(sign(good(), { alg: 'none' })), /alg not allowed/);
    const head = b64({ alg: 'HS256', kid: 'rsa1' });
    const body = b64(good());
    const mac = crypto.createHmac('sha256', JSON.stringify(KEYS[0])).update(`${head}.${body}`).digest('base64url');
    await assert.rejects(verify(`${head}.${body}.${mac}`), /alg not allowed/);
});

test('rejects an RS-labelled token checked against an EC key (key confusion)', async () => {
    await assert.rejects(verify(sign(good(), { alg: 'RS256', kid: 'ec1', key: rsa.privateKey })), /signature/);
});

test('rejects a tampered payload', async () => {
    const [h, , s] = sign(good()).split('.');
    await assert.rejects(verify(`${h}.${b64(good({ sub: 'evil' }))}.${s}`), /signature/);
});

test('checks issuer, audience, azp, expiry, iat and nonce', async () => {
    await assert.rejects(verify(sign(good({ iss: 'https://evil.example.com' }))), /issuer/);
    await assert.rejects(verify(sign(good({ aud: 'someone-else' }))), /audience/);
    await assert.rejects(verify(sign(good({ aud: [CLIENT, 'x'] }))), /azp/);
    await verify(sign(good({ aud: [CLIENT, 'x'], azp: CLIENT })));
    await assert.rejects(verify(sign(good({ exp: NOW / 1000 - 120 }))), /expired/);
    await assert.rejects(verify(sign(good({ iat: NOW / 1000 + 600 }))), /future/);
    await assert.rejects(verify(sign(good({ nonce: 'other' }))), /nonce/);
    await assert.rejects(verify(sign(good()), { nonce: '' }), /nonce/);
    await assert.rejects(verify(sign(good({ sub: '' }))), /subject/);
});

test('rejects malformed tokens', async () => {
    await assert.rejects(verify('not-a-jwt'), /JWS/);
    await assert.rejects(verify('a.b.c'), /malformed/);
});

test('safeEqual and PKCE', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual(undefined, ''), false);
    assert.equal(safeEqual('', ''), false);
    // RFC 7636 appendix B test vector
    assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
