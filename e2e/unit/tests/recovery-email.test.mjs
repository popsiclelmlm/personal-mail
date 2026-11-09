import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeRecoveryEmail } from '../../../worker/src/recovery_email.ts';

const own = ['magpiess.com', 'temp-a.test'];

test('the recovery email is optional', () => {
    assert.deepEqual(normalizeRecoveryEmail(undefined, own), { ok: true, email: null });
    assert.deepEqual(normalizeRecoveryEmail('   ', own), { ok: true, email: null });
});

test('recovery emails are trimmed and lowercased', () => {
    assert.deepEqual(normalizeRecoveryEmail('  Me@Gmail.COM ', own), { ok: true, email: 'me@gmail.com' });
});

test('invalid recovery emails are refused', () => {
    for (const value of ['plain', 'a@b', 'a b@c.com', 123, `${'a'.repeat(250)}@x.com`]) {
        assert.deepEqual(normalizeRecoveryEmail(value, own), { ok: false, reason: 'invalid' }, String(value));
    }
});

test('addresses on this site cannot be recovery emails', () => {
    assert.deepEqual(normalizeRecoveryEmail('me@magpiess.com', own), { ok: false, reason: 'own_domain' });
    assert.deepEqual(normalizeRecoveryEmail('me@sub.temp-a.test', own), { ok: false, reason: 'own_domain' });
    assert.deepEqual(normalizeRecoveryEmail('me@notmagpiess.com', own), { ok: true, email: 'me@notmagpiess.com' });
});
