import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Jwt } from '../../../worker/node_modules/hono/dist/utils/jwt/index.js';
import { createKV } from '../d1-sqlite.mjs';
import {
    ADMIN_TOKEN_DEFAULT_TTL_SECONDS,
    ADMIN_TOKEN_MAX_TTL_SECONDS,
    ADMIN_TOKEN_MIN_TTL_SECONDS,
    checkAdminAuthHeader,
    constantTimeStringEqual,
    deriveAdminTokenSecret,
    findMatchingSecret,
    looksLikeJwt,
    normalizeAdminTokenVersion,
    resolveAdminTokenTtl,
    signAdminToken,
    verifyAdminToken,
} from '../../../worker/src/admin_token.ts';
import {
    AUTH_GUARD_MAX_FAILURES,
    authGuardKey,
    isAuthLocked,
    recordAuthFailure,
} from '../../../worker/src/user_api/auth_guard.ts';

const JWT_SECRET = 'unit-test-jwt-secret';
const PASSWORD = 'admin-pass-1';
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const sign = (overrides = {}) => signAdminToken({
    jwtSecret: JWT_SECRET, password: PASSWORD, version: 0, now: NOW, ...overrides,
});

const verify = (token, overrides = {}) => verifyAdminToken(token, {
    jwtSecret: JWT_SECRET,
    passwords: [PASSWORD],
    getVersion: async () => 0,
    now: NOW + 1000,
    ...overrides,
});

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodePayload = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

test('a freshly signed admin token is accepted and expires after the TTL', async () => {
    const { token, expiresAt } = await sign();
    assert.ok(looksLikeJwt(token));
    assert.equal(expiresAt, Math.floor(NOW / 1000) + ADMIN_TOKEN_DEFAULT_TTL_SECONDS);
    assert.equal(await verify(token), 'ok');
    assert.equal(await verify(token, { now: (expiresAt - 1) * 1000 }), 'ok');
    assert.equal(await verify(token, { now: expiresAt * 1000 }), 'expired');
});

test('the token carries no password, only a keyed binding', async () => {
    const { token } = await sign();
    const payload = decodePayload(token);
    assert.equal(payload.typ, 'admin');
    assert.equal(payload.av, 0);
    assert.match(payload.ph, /^[0-9a-f]{32}$/);
    assert.ok(!token.includes(PASSWORD));
    assert.ok(!JSON.stringify(payload).includes(PASSWORD));
});

test('bumping the version revokes every issued token', async () => {
    const { token } = await sign({ version: 3 });
    assert.equal(await verify(token, { getVersion: async () => '3' }), 'ok');
    assert.equal(await verify(token, { getVersion: async () => 4 }), 'revoked');
    // 设置里的版本号损坏时一律拒绝，而不是放行
    assert.equal(await verify(token, { getVersion: async () => 'garbage' }), 'revoked');
});

test('removing or changing the admin password revokes its tokens', async () => {
    const { token } = await sign();
    assert.equal(await verify(token, { passwords: ['other-pass', PASSWORD] }), 'ok');
    assert.equal(await verify(token, { passwords: ['other-pass'] }), 'revoked');
    assert.equal(await verify(token, { passwords: [] }), 'revoked');
});

test('rotating JWT_SECRET invalidates admin tokens', async () => {
    const { token } = await sign();
    assert.equal(await verify(token, { jwtSecret: 'rotated-secret' }), 'invalid');
    assert.equal(await verify(token, { jwtSecret: '' }), 'invalid');
});

test('the version is only read for tokens with a valid signature', async () => {
    let reads = 0;
    const getVersion = async () => { reads++; return 0; };
    const forged = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ typ: 'admin', av: 0, ph: 'x', exp: 9e9 })}.c2ln`;
    assert.equal(await verify(forged, { getVersion }), 'invalid');
    assert.equal(reads, 0);
    const { token } = await sign();
    assert.equal(await verify(token, { getVersion }), 'ok');
    assert.equal(reads, 1);
});

test('tampered, unsigned and wrong-type tokens are rejected', async () => {
    const { token } = await sign();
    const [header, , signature] = token.split('.');
    const longer = base64url({ ...decodePayload(token), exp: decodePayload(token).exp + 86400 });
    assert.equal(await verify(`${header}.${longer}.${signature}`), 'invalid');
    // alg: none
    const none = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(decodePayload(token))}.`;
    assert.equal(await verify(none), 'invalid');
    assert.equal(await verify('not-a-token'), 'invalid');
    assert.equal(await verify(undefined), 'invalid');

    // 用同一个派生密钥签、但类型不是 admin 的令牌也不行
    const secret = await deriveAdminTokenSecret(JWT_SECRET);
    const wrongType = await Jwt.sign({ ...decodePayload(token), typ: 'user' }, secret, 'HS256');
    assert.equal(await verify(wrongType), 'invalid');
    const noExpiry = await Jwt.sign({ typ: 'admin', av: 0, ph: decodePayload(token).ph }, secret, 'HS256');
    assert.equal(await verify(noExpiry), 'invalid');
});

test('user tokens and admin tokens are not interchangeable', async () => {
    const now = Math.floor(NOW / 1000);
    // 用户令牌直接用 JWT_SECRET 签名，不能当管理员令牌用
    const userToken = await Jwt.sign({
        user_email: 'a@example.com', user_id: 1, tv: 0, typ: 'admin', iat: now, exp: now + 3600,
    }, JWT_SECRET, 'HS256');
    assert.equal(await verify(userToken), 'invalid');
    // 管理员令牌也不能通过用户令牌（JWT_SECRET）的验签
    const { token } = await sign();
    await assert.rejects(() => Jwt.verify(token, JWT_SECRET, 'HS256'));
});

test('the token TTL is configurable within bounds', async () => {
    assert.equal(resolveAdminTokenTtl(undefined), ADMIN_TOKEN_DEFAULT_TTL_SECONDS);
    assert.equal(resolveAdminTokenTtl(''), ADMIN_TOKEN_DEFAULT_TTL_SECONDS);
    assert.equal(resolveAdminTokenTtl('abc'), ADMIN_TOKEN_DEFAULT_TTL_SECONDS);
    assert.equal(resolveAdminTokenTtl('3600'), 3600);
    assert.equal(resolveAdminTokenTtl(5), ADMIN_TOKEN_MIN_TTL_SECONDS);
    assert.equal(resolveAdminTokenTtl(10 ** 9), ADMIN_TOKEN_MAX_TTL_SECONDS);
    const { token, expiresAt } = await sign({ ttlSeconds: 120 });
    assert.equal(expiresAt, Math.floor(NOW / 1000) + 120);
    assert.equal(await verify(token, { now: NOW + 121_000 }), 'expired');
});

test('version and secret helpers', () => {
    assert.equal(normalizeAdminTokenVersion(null), 0);
    assert.equal(normalizeAdminTokenVersion('2'), 2);
    assert.equal(normalizeAdminTokenVersion(-1), -1);
    assert.equal(normalizeAdminTokenVersion('1.5'), -1);
    assert.ok(constantTimeStringEqual('abc', 'abc'));
    assert.ok(!constantTimeStringEqual('abc', 'abd'));
    assert.ok(!constantTimeStringEqual('abc', 'abcd'));
    assert.equal(findMatchingSecret(['a', 'b'], 'b'), 'b');
    assert.equal(findMatchingSecret(['a', 'b'], 'c'), null);
    assert.equal(findMatchingSecret(['a'], ''), null);
    assert.equal(findMatchingSecret(['a'], 42), null);
});

test('only JWT-shaped values are treated as tokens; dotted passwords stay passwords', () => {
    assert.ok(looksLikeJwt('eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJhZG1pbiJ9.c2ln'));
    assert.ok(!looksLikeJwt('my.admin.pass'));
    assert.ok(!looksLikeJwt('local-admin-pass'));
    assert.ok(!looksLikeJwt('eyJ.a.b.c'));
    assert.ok(!looksLikeJwt(''));
    assert.ok(!looksLikeJwt(null));
});

const guardFor = (kv, key) => ({
    isLocked: () => isAuthLocked(kv, key, NOW),
    recordFailure: () => recordAuthFailure(kv, key, NOW),
});

const checkHeader = (header, { kv = createKV(), key = authGuardKey('admin_login', '1.2.3.4', 'admin'), ...overrides } = {}) => (
    checkAdminAuthHeader(header, {
        jwtSecret: JWT_SECRET,
        passwords: [PASSWORD, 'my.admin.pass'],
        getVersion: async () => 0,
        now: NOW + 1000,
        guard: guardFor(kv, key),
        ...overrides,
    })
);

test('x-admin-auth accepts a session token or, for scripts, the plain password', async () => {
    const { token } = await sign();
    assert.equal(await checkHeader(token), 'ok');
    assert.equal(await checkHeader(PASSWORD), 'ok');
    assert.equal(await checkHeader('my.admin.pass'), 'ok');
    assert.equal(await checkHeader(null), 'none');
    assert.equal(await checkHeader(''), 'none');
    assert.equal(await checkHeader('wrong'), 'invalid');
    // 没配置管理员密码时什么都不认
    assert.equal(await checkHeader(PASSWORD, { passwords: [] }), 'invalid');
    assert.equal(await checkHeader(token, { passwords: [] }), 'invalid');
});

test('wrong plain passwords in x-admin-auth count towards the shared lockout', async () => {
    const kv = createKV();
    const key = authGuardKey('admin_login', '1.2.3.4', 'admin');
    for (let i = 1; i < AUTH_GUARD_MAX_FAILURES; i++) {
        assert.equal(await checkHeader(`wrong-${i}`, { kv, key }), 'invalid');
    }
    assert.equal(await checkHeader('wrong-last', { kv, key }), 'locked');
    // 锁定期间连正确的明文密码也不认
    assert.equal(await checkHeader(PASSWORD, { kv, key }), 'locked');
    // 令牌不受锁定影响（它不是靠猜出来的），别的 IP 也不受影响
    const { token } = await sign();
    assert.equal(await checkHeader(token, { kv, key }), 'ok');
    assert.equal(await checkHeader(PASSWORD, { kv, key: authGuardKey('admin_login', '5.6.7.8', 'admin') }), 'ok');
});

test('expired, revoked or forged tokens never count as password failures', async () => {
    const kv = createKV();
    const key = authGuardKey('admin_login', '1.2.3.4', 'admin');
    const { token } = await sign({ ttlSeconds: 60 });
    for (let i = 0; i < AUTH_GUARD_MAX_FAILURES + 1; i++) {
        assert.equal(await checkHeader(token, { kv, key, now: NOW + 3_600_000 }), 'expired');
        assert.equal(await checkHeader(token, { kv, key, getVersion: async () => 1 }), 'revoked');
        assert.equal(await checkHeader(token, { kv, key, jwtSecret: 'other' }), 'invalid');
    }
    assert.equal(await isAuthLocked(kv, key, NOW), false);
    assert.equal(await checkHeader(PASSWORD, { kv, key }), 'ok');
});
