// 用户令牌、角色令牌、账号取得的邮箱凭证：账号编号被复用、角色被撤销后旧凭证必须失效。
// 用项目里真实的校验函数 + node:sqlite 模拟的 D1。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { createD1 } from '../d1-sqlite.mjs';

// worker 源码里的相对导入不带 .ts 后缀（由 wrangler 打包时解析），在 Node 里补上
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (/^\.\.?\//.test(specifier) && context.parentURL?.includes('/worker/src/')
            && !/\.[cm]?[jt]s$/.test(specifier)) {
            return nextResolve(`${specifier}.ts`, context);
        }
        return nextResolve(specifier, context);
    },
});

const {
    isUserRoleTokenCurrent, isUserTokenCurrent, signUserRoleToken, signUserToken,
} = await import('../../../worker/src/user_api/user_token.ts');
const { isAccountIssuedCredentialValid, signAddressJwt } = await import('../../../worker/src/address_credential.ts');
const {
    ACCOUNT_CREATED_AT_SKEW_SECONDS, isIssuedToAccount, parseDbTimestampSeconds,
} = await import('../../../worker/src/auth_version.ts');
const { Jwt } = await import('../../../worker/node_modules/hono/dist/utils/jwt/index.js');

const JWT_SECRET = 'unit-test-jwt-secret';
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

const setup = () => {
    const DB = createD1();
    const c = { env: { DB, JWT_SECRET } };
    const insertUser = async (email, createdAt) => {
        const sql = createdAt
            ? 'INSERT INTO users (user_email, password, created_at) VALUES (?, ?, ?)'
            : 'INSERT INTO users (user_email, password) VALUES (?, ?)';
        const { meta } = await DB.prepare(sql).bind(...[email, 'x', ...(createdAt ? [createdAt] : [])]).run();
        return meta.last_row_id;
    };
    const deleteUser = (id) => DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    const setRole = (id, role) => (role
        ? DB.prepare('INSERT INTO user_roles (user_id, role_text) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET role_text = excluded.role_text').bind(id, role).run()
        : DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(id).run());
    const bump = (id) => DB.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').bind(id).run();
    return { c, DB, insertUser, deleteUser, setRole, bump };
};

const dbTime = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');

test('a deleted account\'s token is rejected after a new account reuses its id', async () => {
    const { c, insertUser, deleteUser } = setup();
    await insertUser('first@example.com');
    const oldId = await insertUser('old@example.com');
    const oldToken = await signUserToken(c, { user_id: oldId, user_email: 'old@example.com' });
    assert.equal(await isUserTokenCurrent(c, decode(oldToken)), true);

    await deleteUser(oldId);
    const newId = await insertUser('new@example.com');
    // users.id 不是 AUTOINCREMENT：编号确实被复用了
    assert.equal(newId, oldId);
    assert.equal(await isUserTokenCurrent(c, decode(oldToken)), false);

    const newToken = await signUserToken(c, { user_id: newId, user_email: 'new@example.com' });
    assert.equal(await isUserTokenCurrent(c, decode(newToken)), true);
});

test('re-registering the same email under a reused id still rejects tokens issued before', async () => {
    const { c, insertUser, deleteUser } = setup();
    const id = await insertUser('same@example.com', dbTime(7200));
    const issuedAt = Math.floor(Date.now() / 1000) - 3600;
    const oldPayload = { user_email: 'same@example.com', user_id: id, tv: 0, iat: issuedAt, exp: issuedAt + 7 * 86400 };
    assert.equal(await isUserTokenCurrent(c, oldPayload), true);

    await deleteUser(id);
    assert.equal(await insertUser('same@example.com'), id);
    assert.equal(await isUserTokenCurrent(c, oldPayload), false);
    // 刚签发的令牌（签发时间不早于账号创建时间）照常可用
    assert.equal(await isUserTokenCurrent(c, { ...oldPayload, iat: Math.floor(Date.now() / 1000) }), true);
});

test('user tokens without a matching email are rejected', async () => {
    const { c, insertUser } = setup();
    const id = await insertUser('Mixed@example.com');
    const now = Math.floor(Date.now() / 1000);
    const base = { user_id: id, tv: 0, iat: now, exp: now + 60 };
    assert.equal(await isUserTokenCurrent(c, { ...base, user_email: 'Mixed@example.com' }), true);
    assert.equal(await isUserTokenCurrent(c, { ...base, user_email: 'mixed@example.com' }), false);
    assert.equal(await isUserTokenCurrent(c, { ...base }), false);
    assert.equal(await isUserTokenCurrent(c, { ...base, user_email: '' }), false);
    assert.equal(await isUserTokenCurrent(c, { ...base, user_email: 'Mixed@example.com', user_id: 999 }), false);
});

test('revoking or changing the admin role invalidates the role token immediately', async () => {
    const { c, insertUser, setRole } = setup();
    const id = await insertUser('admin@example.com');
    await setRole(id, 'admin');
    const token = await signUserRoleToken(c, { user_id: id, user_email: 'admin@example.com', tv: 0 }, 'admin');
    const payload = decode(token);
    assert.equal(payload.user_role, 'admin');
    assert.equal(payload.tv, 0);
    assert.equal(payload.exp - payload.iat, 3600);
    assert.equal(await isUserRoleTokenCurrent(c, payload), true);

    await setRole(id, 'member');
    assert.equal(await isUserRoleTokenCurrent(c, payload), false);
    await setRole(id, null);
    assert.equal(await isUserRoleTokenCurrent(c, payload), false);
    await setRole(id, 'admin');
    assert.equal(await isUserRoleTokenCurrent(c, payload), true);
});

test('role tokens die with the account, a reused id or "log out everywhere"', async () => {
    const { c, insertUser, deleteUser, setRole, bump } = setup();
    await insertUser('first@example.com');
    const id = await insertUser('admin@example.com');
    await setRole(id, 'admin');
    const payload = decode(await signUserRoleToken(c, { user_id: id, user_email: 'admin@example.com', tv: 0 }, 'admin'));

    await bump(id);
    assert.equal(await isUserRoleTokenCurrent(c, payload), false);
    const fresh = decode(await signUserRoleToken(c, { user_id: id, user_email: 'admin@example.com', tv: 1 }, 'admin'));
    assert.equal(await isUserRoleTokenCurrent(c, fresh), true);

    // 删除账号后旧角色令牌失效；即使新账号复用编号、又被设成管理员，旧角色令牌也不能用
    await deleteUser(id);
    assert.equal(await isUserRoleTokenCurrent(c, fresh), false);
    assert.equal(await insertUser('someone@example.com'), id);
    await setRole(id, 'admin');
    assert.equal(await isUserRoleTokenCurrent(c, fresh), false);
});

test('legacy role tokens without tv still work until the version changes', async () => {
    const { c, insertUser, setRole } = setup();
    const id = await insertUser('legacy@example.com');
    await setRole(id, 'admin');
    const now = Math.floor(Date.now() / 1000);
    const legacy = decode(await Jwt.sign({
        user_email: 'legacy@example.com', user_id: id, user_role: 'admin', iat: now, exp: now + 3600,
    }, JWT_SECRET, 'HS256'));
    assert.equal(await isUserRoleTokenCurrent(c, legacy), true);
    assert.equal(await isUserRoleTokenCurrent(c, { ...legacy, user_role: '' }), false);
    assert.equal(await isUserRoleTokenCurrent(c, { ...legacy, user_role: 123 }), false);
});

test('account-issued mailbox credentials do not carry over to a reused id', async () => {
    const { c, DB, insertUser, deleteUser } = setup();
    await insertUser('first@example.com');
    const oldId = await insertUser('old@example.com', dbTime(7200));
    const { meta } = await DB.prepare('INSERT INTO address (name) VALUES (?)').bind('box@example.com').run();
    const addressId = meta.last_row_id;
    await DB.prepare('INSERT INTO users_address (user_id, address_id) VALUES (?, ?)').bind(oldId, addressId).run();

    const credential = decode(await signAddressJwt(c, { address: 'box@example.com', address_id: addressId }, { userId: oldId }));
    assert.equal(credential.uid, oldId);
    assert.equal(typeof credential.uat, 'number');
    assert.equal(await isAccountIssuedCredentialValid(c, credential, addressId), true);

    // 旧账号删除，新账号复用编号并绑定同一个地址
    const oldCredential = { ...credential, uat: credential.uat - 3600 };
    await DB.prepare('DELETE FROM users_address WHERE user_id = ?').bind(oldId).run();
    await deleteUser(oldId);
    assert.equal(await insertUser('new@example.com'), oldId);
    await DB.prepare('INSERT INTO users_address (user_id, address_id) VALUES (?, ?)').bind(oldId, addressId).run();
    assert.equal(await isAccountIssuedCredentialValid(c, oldCredential, addressId), false);
    // 新账号自己取得的凭证可用
    const fresh = decode(await signAddressJwt(c, { address: 'box@example.com', address_id: addressId }, { userId: oldId }));
    assert.equal(await isAccountIssuedCredentialValid(c, fresh, addressId), true);
});

test('account identity helpers', () => {
    assert.equal(parseDbTimestampSeconds('2026-11-09 10:00:00'), Date.UTC(2026, 10, 9, 10) / 1000);
    assert.equal(parseDbTimestampSeconds('2026-11-09T10:00:00Z'), Date.UTC(2026, 10, 9, 10) / 1000);
    assert.equal(parseDbTimestampSeconds(''), null);
    assert.equal(parseDbTimestampSeconds('garbage'), null);
    assert.equal(parseDbTimestampSeconds(null), null);

    const createdAt = '2026-11-09 10:00:00';
    const created = Date.UTC(2026, 10, 9, 10) / 1000;
    const account = { accountEmail: 'a@example.com', accountCreatedAt: createdAt };
    assert.ok(isIssuedToAccount({ ...account, tokenEmail: 'a@example.com', tokenIssuedAt: created }));
    // D1 和 Worker 的时钟误差
    assert.ok(isIssuedToAccount({ ...account, tokenEmail: 'a@example.com', tokenIssuedAt: created - ACCOUNT_CREATED_AT_SKEW_SECONDS }));
    assert.ok(!isIssuedToAccount({ ...account, tokenEmail: 'a@example.com', tokenIssuedAt: created - ACCOUNT_CREATED_AT_SKEW_SECONDS - 1 }));
    assert.ok(!isIssuedToAccount({ ...account, tokenEmail: 'b@example.com', tokenIssuedAt: created }));
    assert.ok(!isIssuedToAccount({ ...account, tokenEmail: null }));
    assert.ok(!isIssuedToAccount({ ...account, tokenEmail: 'a@example.com', tokenIssuedAt: 'soon' }));
    // 邮箱凭证不带邮箱；没有签发时间的老凭证不比较时间
    assert.ok(isIssuedToAccount({ ...account }));
    assert.ok(isIssuedToAccount({ ...account, tokenEmail: 'a@example.com', accountCreatedAt: null, tokenIssuedAt: 0 }));
});
