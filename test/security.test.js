import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    loginBlocked, recordLoginFailure, clearLoginFailures,
    issueSetupCode, checkSetupCode, clearSetupCode,
} from '../lib/security.js';

test('login limiter blocks after 10 failures and resets after the window', () => {
    const ip = '203.0.113.7';
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) recordLoginFailure(ip, t0);
    assert.equal(loginBlocked(ip, t0), false);
    recordLoginFailure(ip, t0);
    assert.equal(loginBlocked(ip, t0), true);
    assert.equal(loginBlocked('198.51.100.1', t0), false, 'other IPs unaffected');
    assert.equal(loginBlocked(ip, t0 + 15 * 60 * 1000 + 1), false, 'window expired');
    clearLoginFailures(ip);
});

test('setup code: only the issued code works, and only until cleared', () => {
    const code = issueSetupCode(() => {});
    assert.equal(checkSetupCode('wrong'), false);
    assert.equal(checkSetupCode(undefined), false);
    assert.equal(checkSetupCode(` ${code} `), true, 'surrounding whitespace is ignored');
    clearSetupCode();
    assert.equal(checkSetupCode(code), false);
});
