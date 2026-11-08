import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createD1, createKV } from '../d1-sqlite.mjs';
import {
    constantTimeEqual,
    hashUserPassword,
    isCurrentPasswordHash,
    isLegacyPasswordHash,
    parsePasswordHash,
    resolvePbkdf2Iterations,
    verifyUserPassword,
} from '../../../worker/src/user_api/password.ts';
import {
    AUTH_GUARD_LOCK_SECONDS,
    AUTH_GUARD_MAX_FAILURES,
    authGuardKey,
    clearAuthFailures,
    isAuthLocked,
    recordAuthFailure,
} from '../../../worker/src/user_api/auth_guard.ts';
import { isVersionCurrent, normalizeVersion } from '../../../worker/src/auth_version.ts';
import {
    CONSUME_INVITE_CODE_SQL,
    formatInviteCode,
    generateInviteCode,
    GRANT_ROLE_AFTER_INSERT_SQL,
    INSERT_USER_AFTER_INVITE_SQL,
    INSERT_USER_SQL,
    normalizeInviteCode,
    RECORD_INVITE_USE_SQL,
    resolveRegisterMode,
    SELECT_USABLE_INVITE_CODE_SQL,
} from '../../../worker/src/user_api/invite.ts';

// 前端发送的是密码的 SHA-256 十六进制摘要
const clientHash = (password) => createHash('sha256').update(password).digest('hex');
// 测试里用最低迭代次数，跑得快
const ITERATIONS = 10_000;

test('password hash uses the pbkdf2 storage format with a random salt', async () => {
    const input = clientHash('correct horse');
    const first = await hashUserPassword(input, ITERATIONS);
    const second = await hashUserPassword(input, ITERATIONS);
    assert.match(first, /^pbkdf2\$sha256\$10000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.notEqual(first, second, 'same password gets different salts');
    const parsed = parsePasswordHash(first);
    assert.equal(parsed.iterations, ITERATIONS);
    assert.equal(parsed.salt.length, 16);
    assert.equal(parsed.hash.length, 32);
    assert.equal(isCurrentPasswordHash(first), true);
    assert.equal(isLegacyPasswordHash(first), false);
    // 新格式不是 64 位十六进制，满足「数据库里不再有新的 64 位十六进制密码」
    assert.doesNotMatch(first, /^[0-9a-f]{64}$/);
});

test('password verification accepts the right password and rejects others', async () => {
    const stored = await hashUserPassword(clientHash('right'), ITERATIONS);
    assert.deepEqual(await verifyUserPassword(clientHash('right'), stored, ITERATIONS), { ok: true, needsUpgrade: false });
    assert.deepEqual(await verifyUserPassword(clientHash('wrong'), stored, ITERATIONS), { ok: false, needsUpgrade: false });
    // 数据库泄露的哈希值本身不能用来登录
    assert.equal((await verifyUserPassword(stored, stored, ITERATIONS)).ok, false);
});

test('legacy hex hashes still log in and are flagged for upgrade', async () => {
    const legacy = clientHash('old password');
    assert.equal(isLegacyPasswordHash(legacy), true);
    assert.deepEqual(await verifyUserPassword(legacy, legacy, ITERATIONS), { ok: true, needsUpgrade: true });
    assert.deepEqual(await verifyUserPassword(clientHash('nope'), legacy, ITERATIONS), { ok: false, needsUpgrade: false });
});

test('hashes with fewer iterations than configured are flagged for upgrade', async () => {
    const stored = await hashUserPassword(clientHash('p'), ITERATIONS);
    assert.deepEqual(await verifyUserPassword(clientHash('p'), stored, 20_000), { ok: true, needsUpgrade: true });
});

test('missing or malformed stored passwords never match', async () => {
    for (const stored of [undefined, null, '', 'pbkdf2$sha256$abc$x$y', 'plain-text', 'pbkdf2$sha256$200000$AAAA$AAAA']) {
        assert.equal((await verifyUserPassword(clientHash('x'), stored, ITERATIONS)).ok, false, String(stored));
    }
});

test('PBKDF2 iterations are clamped to what workerd supports', () => {
    assert.equal(resolvePbkdf2Iterations(undefined), 100_000);
    assert.equal(resolvePbkdf2Iterations('50000'), 50_000);
    assert.equal(resolvePbkdf2Iterations(1_000_000), 100_000);
    assert.equal(resolvePbkdf2Iterations(10), 10_000);
    assert.equal(resolvePbkdf2Iterations('abc'), 100_000);
});

test('constant-time compare checks every byte and the length', () => {
    const a = new Uint8Array([1, 2, 3]);
    assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 3])), true);
    assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 4])), false);
    assert.equal(constantTimeEqual(a, new Uint8Array([1, 2])), false);
    assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 3, 0])), false);
});

const median = (values) => {
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length / 2)];
};

test('wrong password, right password and unknown user take similar time', async () => {
    const iterations = 50_000;
    const stored = await hashUserPassword(clientHash('right'), iterations);
    const time = async (input, value) => {
        const start = process.hrtime.bigint();
        await verifyUserPassword(input, value, iterations);
        return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const samples = { right: [], wrong: [], missing: [] };
    for (let i = 0; i < 15; i++) {
        samples.right.push(await time(clientHash('right'), stored));
        samples.wrong.push(await time(clientHash('wrong'), stored));
        samples.missing.push(await time(clientHash('wrong'), null));
    }
    const right = median(samples.right);
    for (const name of ['wrong', 'missing']) {
        const ratio = median(samples[name]) / right;
        // 都要完整算一次 PBKDF2，耗时应在同一量级；宽松的界限避免机器抖动导致误报
        assert.ok(ratio > 0.5 && ratio < 2, `${name}/right ratio ${ratio.toFixed(2)}`);
    }
});

test('five failures lock the IP + email for 15 minutes, success clears the count', async () => {
    const kv = createKV();
    const key = authGuardKey('login', '1.2.3.4', 'User@Example.test');
    assert.equal(key, 'auth-guard:login:1.2.3.4:user@example.test');
    const now = 1_000_000;
    for (let i = 1; i < AUTH_GUARD_MAX_FAILURES; i++) {
        assert.equal(await recordAuthFailure(kv, key, now), false);
    }
    assert.equal(await isAuthLocked(kv, key, now), false);
    assert.equal(await recordAuthFailure(kv, key, now), true);
    assert.equal(await isAuthLocked(kv, key, now + 1000), true);
    assert.equal(await isAuthLocked(kv, key, now + AUTH_GUARD_LOCK_SECONDS * 1000 + 1), false);
    // 别的 IP、别的邮箱不受影响
    assert.equal(await isAuthLocked(kv, authGuardKey('login', '5.6.7.8', 'user@example.test'), now), false);
    assert.equal(await isAuthLocked(kv, authGuardKey('verify_code', '1.2.3.4', 'user@example.test'), now), false);
    await clearAuthFailures(kv, key);
    assert.equal(await isAuthLocked(kv, key, now), false);
});

test('a failure after the lock expires starts counting again', async () => {
    const kv = createKV();
    const key = authGuardKey('login', '1.2.3.4', 'a@b.test');
    const now = 5_000_000;
    for (let i = 0; i < AUTH_GUARD_MAX_FAILURES; i++) await recordAuthFailure(kv, key, now);
    const later = now + AUTH_GUARD_LOCK_SECONDS * 1000 + 1;
    assert.equal(await recordAuthFailure(kv, key, later), false);
    assert.equal(await isAuthLocked(kv, key, later), false);
});

test('auth guard is a no-op without KV', async () => {
    assert.equal(await isAuthLocked(undefined, 'k'), false);
    assert.equal(await recordAuthFailure(undefined, 'k'), false);
    await clearAuthFailures(undefined, 'k');
});

test('token versions: missing counts as 0, mismatches and junk are rejected', () => {
    assert.equal(isVersionCurrent(undefined, 0), true);
    assert.equal(isVersionCurrent(undefined, null), true);
    assert.equal(isVersionCurrent(0, 0), true);
    assert.equal(isVersionCurrent(2, 2), true);
    assert.equal(isVersionCurrent(undefined, 1), false);
    assert.equal(isVersionCurrent(1, 2), false);
    assert.equal(isVersionCurrent('abc', 0), false);
    assert.equal(isVersionCurrent(-1, 0), false);
    assert.equal(normalizeVersion('3'), 3);
});

test('register mode defaults to open', () => {
    assert.equal(resolveRegisterMode(undefined), 'open');
    assert.equal(resolveRegisterMode('INVITE'), 'invite');
    assert.equal(resolveRegisterMode(' closed '), 'closed');
    assert.equal(resolveRegisterMode('whatever'), 'open');
});

test('invite codes are random, unambiguous and normalized from user input', () => {
    const code = generateInviteCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    assert.notEqual(code, generateInviteCode());
    assert.equal(formatInviteCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
    assert.equal(normalizeInviteCode(' abcd-efgh-jkmn '), 'ABCDEFGHJKMN');
    assert.equal(normalizeInviteCode('abc'), null);
    assert.equal(normalizeInviteCode('abc$defgh'), null);
    assert.equal(normalizeInviteCode(123), null);
});

// 按 user.ts 的顺序执行注册批次
const registerWithInvite = async (db, { code, email, role }) => {
    const invite = await db.prepare(SELECT_USABLE_INVITE_CODE_SQL).bind(code).first();
    if (!invite) return { ok: false, reason: 'invalid' };
    const statements = [
        db.prepare(CONSUME_INVITE_CODE_SQL).bind(code),
        db.prepare(INSERT_USER_AFTER_INVITE_SQL).bind(email, 'hash', '{}'),
        db.prepare(RECORD_INVITE_USE_SQL).bind(invite.id, email),
    ];
    if (role) statements.push(db.prepare(GRANT_ROLE_AFTER_INSERT_SQL).bind(role, email));
    try {
        const results = await db.batch(statements);
        return results[1].meta.changes === 1 ? { ok: true } : { ok: false, reason: 'used up' };
    } catch (error) {
        return { ok: false, reason: error.message.includes('UNIQUE') ? 'exists' : error.message };
    }
};

const seedInvite = (db, { code, maxUses = 1, enabled = 1, expires = null, role = null }) => {
    db.raw.prepare(
        `INSERT INTO invite_codes (code, role, max_uses, enabled, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run(code, role, maxUses, enabled, expires);
};

test('a single-use invite registers one user and grants the role', async () => {
    const db = createD1();
    seedInvite(db, { code: 'AAAABBBBCCCC' });
    assert.deepEqual(await registerWithInvite(db, { code: 'AAAABBBBCCCC', email: 'a@x.test', role: 'member' }), { ok: true });
    assert.deepEqual(await registerWithInvite(db, { code: 'AAAABBBBCCCC', email: 'b@x.test', role: 'member' }), { ok: false, reason: 'invalid' });
    const role = db.raw.prepare(`SELECT ur.role_text FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.user_email = 'a@x.test'`).get();
    assert.equal(role.role_text, 'member');
    const uses = db.raw.prepare(`SELECT COUNT(*) AS n FROM invite_code_uses`).get();
    assert.equal(uses.n, 1);
    assert.equal(db.raw.prepare(`SELECT used_count FROM invite_codes`).get().used_count, 1);
});

test('the last use of an invite cannot be taken twice (consume step fails)', async () => {
    const db = createD1();
    seedInvite(db, { code: 'RACE00000000' });
    const invite = await db.prepare(SELECT_USABLE_INVITE_CODE_SQL).bind('RACE00000000').first();
    // 模拟两个并发请求都查到了可用的邀请码，第一个先消耗掉
    await registerWithInvite(db, { code: 'RACE00000000', email: 'first@x.test' });
    const results = await db.batch([
        db.prepare(CONSUME_INVITE_CODE_SQL).bind('RACE00000000'),
        db.prepare(INSERT_USER_AFTER_INVITE_SQL).bind('second@x.test', 'hash', '{}'),
        db.prepare(RECORD_INVITE_USE_SQL).bind(invite.id, 'second@x.test'),
        db.prepare(GRANT_ROLE_AFTER_INSERT_SQL).bind('member', 'second@x.test'),
    ]);
    assert.equal(results[1].meta.changes, 0);
    assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM users WHERE user_email = 'second@x.test'`).get().n, 0);
    assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM invite_code_uses`).get().n, 1);
    assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM user_roles`).get().n, 0);
});

test('registering an existing email rolls back the invite use and keeps the old account', async () => {
    const db = createD1();
    db.raw.exec(`INSERT INTO users (user_email, password) VALUES ('taken@x.test', 'old-hash')`);
    seedInvite(db, { code: 'TAKEN0000000' });
    assert.deepEqual(await registerWithInvite(db, { code: 'TAKEN0000000', email: 'taken@x.test', role: 'member' }), { ok: false, reason: 'exists' });
    assert.equal(db.raw.prepare(`SELECT used_count FROM invite_codes`).get().used_count, 0);
    assert.equal(db.raw.prepare(`SELECT password FROM users WHERE user_email = 'taken@x.test'`).get().password, 'old-hash');
});

test('disabled, expired and multi-use invites behave as configured', async () => {
    const db = createD1();
    seedInvite(db, { code: 'OFF000000000', enabled: 0 });
    seedInvite(db, { code: 'OLD000000000', expires: '2000-01-01 00:00:00' });
    seedInvite(db, { code: 'TWICE0000000', maxUses: 2, expires: '2999-01-01 00:00:00' });
    assert.equal((await registerWithInvite(db, { code: 'OFF000000000', email: 'a@x.test' })).ok, false);
    assert.equal((await registerWithInvite(db, { code: 'OLD000000000', email: 'b@x.test' })).ok, false);
    assert.equal((await registerWithInvite(db, { code: 'TWICE0000000', email: 'c@x.test' })).ok, true);
    assert.equal((await registerWithInvite(db, { code: 'TWICE0000000', email: 'd@x.test' })).ok, true);
    assert.equal((await registerWithInvite(db, { code: 'TWICE0000000', email: 'e@x.test' })).ok, false);
});

test('open registration inserts the user and grants the default role', async () => {
    const db = createD1();
    await db.batch([
        db.prepare(INSERT_USER_SQL).bind('open@x.test', 'hash', '{}'),
        db.prepare(GRANT_ROLE_AFTER_INSERT_SQL).bind('member', 'open@x.test'),
    ]);
    const row = db.raw.prepare(`SELECT ur.role_text FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.user_email = 'open@x.test'`).get();
    assert.equal(row.role_text, 'member');
    await assert.rejects(db.batch([
        db.prepare(INSERT_USER_SQL).bind('open@x.test', 'other', '{}'),
    ]), /UNIQUE/);
});
