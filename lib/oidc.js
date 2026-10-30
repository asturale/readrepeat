// Optional "Sign in with SSO" via OpenID Connect (authorization code flow +
// PKCE, confidential client). No extra dependency: discovery, token exchange
// and ID-token verification use Node's built-in fetch and crypto.
//
// Enabled when OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and
// OIDC_REDIRECT_URI are all set. SSO never creates accounts: it signs in to
// an EXISTING ReadRepeat user whose username matches the configured claim,
// and pins that user to the provider's subject on first use.
import crypto from 'crypto';

const env = process.env;
const ISSUER = (env.OIDC_ISSUER || '').replace(/\/$/, '');

export const oidcConfig = {
    issuer: ISSUER,
    clientId: env.OIDC_CLIENT_ID || '',
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    redirectUri: env.OIDC_REDIRECT_URI || '',
    providerName: env.OIDC_PROVIDER_NAME || 'SSO',
    usernameClaim: env.OIDC_USERNAME_CLAIM || 'preferred_username',
    scope: env.OIDC_SCOPE || 'openid profile email',
};

export const oidcEnabled = Boolean(
    oidcConfig.issuer && oidcConfig.clientId && oidcConfig.clientSecret && oidcConfig.redirectUri
);

// OIDC_LINK_BY_USERNAME=true: the first SSO sign-in may link to the existing
// account with the same username (claim OIDC_USERNAME_CLAIM). Only safe when
// the provider assigns usernames (users can't choose or change their own).
// Default off: link from Settings while signed in instead.
export const linkByUsername = /^(true|1|yes|on)$/i.test(env.OIDC_LINK_BY_USERNAME || '');

// PASSWORD_LOGIN=false hides and rejects username/password login. Only
// honoured when SSO is configured, so a typo can't lock everyone out.
export const passwordLoginEnabled = !(oidcEnabled && /^(false|0|no|off)$/i.test(env.PASSWORD_LOGIN || ''));

const ALLOWED_ALGS = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384', ES512: 'sha512' };
const CLOCK_SKEW_S = 60;
const CACHE_MS = 60 * 60 * 1000;

let discoveryCache = null;
let jwksCache = null;
let lastForcedJwksRefresh = 0;
const FORCED_REFRESH_MIN_MS = 60 * 1000;

async function fetchJson(url, init) {
    const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`OIDC request to ${new URL(url).pathname} failed: HTTP ${res.status}`);
    return res.json();
}

export async function discovery() {
    if (discoveryCache && Date.now() - discoveryCache.at < CACHE_MS) return discoveryCache.doc;
    const doc = await fetchJson(`${ISSUER}/.well-known/openid-configuration`);
    // The document must describe the issuer we were configured with (OIDC Discovery §4.3).
    if ((doc.issuer || '').replace(/\/$/, '') !== ISSUER) throw new Error('OIDC discovery issuer mismatch');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        if (!/^https:\/\//.test(doc[k] || '')) throw new Error(`OIDC discovery: ${k} missing or not https`);
    }
    discoveryCache = { doc, at: Date.now() };
    return doc;
}

async function jwks(forceRefresh = false) {
    if (!forceRefresh && jwksCache && Date.now() - jwksCache.at < CACHE_MS) return jwksCache.keys;
    const { jwks_uri } = await discovery();
    const { keys } = await fetchJson(jwks_uri);
    jwksCache = { keys: Array.isArray(keys) ? keys : [], at: Date.now() };
    return jwksCache.keys;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = () => b64url(crypto.randomBytes(32));
export const pkceChallenge = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

// Constant-time string comparison (state/nonce are attacker-supplied).
export function safeEqual(a, b) {
    const x = Buffer.from(String(a ?? ''));
    const y = Buffer.from(String(b ?? ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function authorizationUrl({ state, nonce, verifier }) {
    const { authorization_endpoint } = await discovery();
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: oidcConfig.clientId,
        redirect_uri: oidcConfig.redirectUri,
        scope: oidcConfig.scope,
        state,
        nonce,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
    }).toString();
    return url.toString();
}

export async function exchangeCode(code, verifier) {
    const { token_endpoint } = await discovery();
    // client_secret_basic: id and secret are form-urlencoded before base64 (RFC 6749 §2.3.1).
    const form = (s) => encodeURIComponent(s).replace(/%20/g, '+');
    const basic = Buffer.from(`${form(oidcConfig.clientId)}:${form(oidcConfig.clientSecret)}`).toString('base64');
    return fetchJson(token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: oidcConfig.redirectUri,
            code_verifier: verifier,
        }),
    });
}

// Verifies an ID token per OIDC Core §3.1.3.7 and returns its claims.
// `keys` is injectable for tests; normally fetched from the provider's JWKS.
export async function verifyIdToken(idToken, { nonce, now = Date.now(), keys = null, issuer = ISSUER, clientId = oidcConfig.clientId } = {}) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('ID token is not a JWS');
    let header, claims;
    try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
        throw new Error('ID token is malformed');
    }
    const hash = ALLOWED_ALGS[header.alg];
    if (!hash) throw new Error(`ID token alg not allowed: ${header.alg}`);

    const pick = (list) => list.filter((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    const verifies = (list) => pick(list).some((jwk) => {
        try {
            const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
            const expectedType = header.alg.startsWith('RS') ? 'rsa' : 'ec';
            if (key.asymmetricKeyType !== expectedType) return false;
            return crypto.verify(hash, data, header.alg.startsWith('ES') ? { key, dsaEncoding: 'ieee-p1363' } : key, sig);
        } catch {
            return false;
        }
    });
    let ok = verifies(keys || (await jwks()));
    // The provider may have rotated its keys (possibly under the same kid):
    // refetch once, at most once a minute so bad tokens can't hammer the JWKS.
    if (!ok && !keys && Date.now() - lastForcedJwksRefresh > FORCED_REFRESH_MIN_MS) {
        lastForcedJwksRefresh = Date.now();
        ok = verifies(await jwks(true));
    }
    if (!ok) throw new Error('ID token signature invalid');

    const nowS = Math.floor(now / 1000);
    if ((claims.iss || '').replace(/\/$/, '') !== issuer) throw new Error('ID token issuer mismatch');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new Error('ID token audience mismatch');
    if (aud.length > 1 && claims.azp !== clientId) throw new Error('ID token azp mismatch');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw new Error('ID token expired');
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) throw new Error('ID token issued in the future');
    if (!nonce || !safeEqual(claims.nonce, nonce)) throw new Error('ID token nonce mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token has no subject');
    return claims;
}

// Username comes from the ID token, or from the userinfo endpoint when the
// claim isn't in the token (only if userinfo's `sub` matches the token's).
export async function resolveUsername(claims, accessToken) {
    let value = claims[oidcConfig.usernameClaim];
    if (!value && accessToken) {
        const { userinfo_endpoint } = await discovery();
        if (/^https:\/\//.test(userinfo_endpoint || '')) {
            const info = await fetchJson(userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
            if (info.sub !== claims.sub) throw new Error('userinfo subject mismatch');
            value = info[oidcConfig.usernameClaim];
        }
    }
    return typeof value === 'string' ? value.trim() : '';
}
