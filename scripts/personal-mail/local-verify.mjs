#!/usr/bin/env node
// 在本地 wrangler dev 上验证个人邮件改造的接口（替代需要 Docker 的 e2e）。
// 用法：
//   1. cp scripts/personal-mail/wrangler.local.toml worker/wrangler.toml
//   2. cd worker && pnpm exec wrangler dev --port 8797 --test-scheduled
//   3. node scripts/personal-mail/local-verify.mjs [phase1|phase2|phase3|all]
// 每次运行都用新的随机名字，可以对同一个本地数据库重复执行。
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.VERIFY_BASE_URL || 'http://127.0.0.1:8797';
const ADMIN_PASSWORD = process.env.VERIFY_ADMIN_PASSWORD || 'local-admin-pass';
const RUN_ID = randomBytes(3).toString('hex');

let passed = 0;
const failures = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

const call = async (method, path, { body, headers = {}, raw = false } = {}) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    if (!raw) {
        try { data = JSON.parse(text); } catch { /* 保留文本 */ }
    }
    return { status: res.status, data, text };
};

const check = (name, condition, detail) => {
    if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    }
};

const admin = { 'x-admin-auth': ADMIN_PASSWORD };
const userHeaders = (token) => ({ 'x-user-token': token });
const addressHeaders = (jwt) => ({ authorization: `Bearer ${jwt}` });

const ensureDb = async () => {
    await call('POST', '/admin/db_initialize', { headers: admin });
    await call('POST', '/admin/db_migration', { headers: admin });
};

const createAddress = (name, domain, { ip = randomIp(), token } = {}) => call('POST', '/api/new_address', {
    body: { name, domain },
    headers: { 'cf-connecting-ip': ip, ...(token ? userHeaders(token) : {}) },
});

// 管理员直接建用户并设置角色（不经过注册流程）
const adminCreateUser = async (email, password, role) => {
    const created = await call('POST', '/admin/users', { body: { email, password: sha256(password) }, headers: admin });
    if (created.status !== 200) throw new Error(`create user failed: ${created.text}`);
    const users = await call('GET', `/admin/users?limit=10&offset=0&query=${encodeURIComponent(email)}`, { headers: admin });
    const user = users.data.results.find((item) => item.user_email === email);
    if (role) {
        await call('POST', '/admin/user_roles', { body: { user_id: user.id, role_text: role }, headers: admin });
    }
    return user;
};

const login = async (email, password, ip = randomIp()) => call('POST', '/user_api/login', {
    body: { email, password: sha256(password) },
    headers: { 'cf-connecting-ip': ip },
});

const bindAddress = (token, jwt) => call('POST', '/user_api/bind_address', {
    headers: { ...userHeaders(token), ...addressHeaders(jwt) },
});

const receiveMail = (to, subject, from = 'sender@outside.test') => call('POST', '/__test/receive_mail', {
    body: {
        from,
        to,
        raw: [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            `Message-ID: <${randomBytes(6).toString('hex')}@outside.test>`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            `body of ${subject}`,
        ].join('\r\n'),
    },
});

const phase1 = async () => {
    console.log('phase 1: retention, IP × base domain limit, upstream inbox features');
    const ip = randomIp();
    // 匿名用户：同一 IP 在临时域名下最多 2 个（本地配置 IP_DOMAIN_CREATE_LIMIT = 2）
    const a1 = await createAddress(`anon1${RUN_ID}`, 'temp.test', { ip });
    const a2 = await createAddress(`anon2${RUN_ID}`, 'temp.test', { ip });
    const a3 = await createAddress(`anon3${RUN_ID}`, 'temp.test', { ip });
    check('anonymous creates up to the IP × domain limit', a1.status === 200 && a2.status === 200, [a1.text, a2.text]);
    check('anonymous over the limit gets 429', a3.status === 429, a3);
    const random = await createAddress(`anonsub${RUN_ID}`, 'temp.test', { ip });
    check('limit also counts the same base domain', random.status === 429, random);
    const otherIp = await createAddress(`anon4${RUN_ID}`, 'temp.test');
    check('another IP is not affected', otherIp.status === 200, otherIp);
    const personalAnon = await createAddress(`anonp${RUN_ID}`, 'personal.test');
    check('anonymous cannot use the personal domain', personalAnon.status === 400, personalAnon);

    // 有角色的用户不受上限限制
    const email = `role${RUN_ID}@example.test`;
    await adminCreateUser(email, 'pass-1', 'member');
    const logged = await login(email, 'pass-1');
    check('role user logs in', logged.status === 200 && logged.data.jwt, logged);
    const token = logged.data.jwt;
    const created = [];
    for (let i = 0; i < 3; i++) {
        created.push(await createAddress(`role${i}${RUN_ID}`, 'temp.test', { ip, token }));
    }
    check('role user is not limited by IP × domain', created.every((res) => res.status === 200), created.map((res) => res.status));
    const personal = await createAddress(`me${RUN_ID}`, 'personal.test', { ip, token });
    check('role user can use the personal domain', personal.status === 200, personal);

    // 没有角色的登录用户仍按 IP 限制
    const plainEmail = `plain${RUN_ID}@example.test`;
    await adminCreateUser(plainEmail, 'pass-2', null);
    const plainLogin = await login(plainEmail, 'pass-2');
    const plainToken = plainLogin.data.jwt;
    const plainIp = randomIp();
    const p1 = await createAddress(`plain1${RUN_ID}`, 'temp.test', { ip: plainIp, token: plainToken });
    const p2 = await createAddress(`plain2${RUN_ID}`, 'temp.test', { ip: plainIp, token: plainToken });
    const p3 = await createAddress(`plain3${RUN_ID}`, 'temp.test', { ip: plainIp, token: plainToken });
    check('logged-in user without a role is still limited', p1.status === 200 && p2.status === 200 && p3.status === 429, [p1.status, p2.status, p3.status]);

    // 保留期：绑定后升级为永久，额度 2
    for (const res of [...created, personal]) {
        await bindAddress(token, res.data.jwt);
    }
    const bound = await call('GET', '/user_api/bind_address?limit=20&offset=0', { headers: userHeaders(token) });
    check('bound list includes retention columns', bound.status === 200
        && bound.data.results.every((row) => 'retention_type' in row && 'is_permanent' in row), bound.data);
    const ids = bound.data.results.map((row) => row.id);
    const up1 = await call('POST', '/user_api/bind_address/retention', { body: { address_id: ids[0], retention_type: 'permanent' }, headers: userHeaders(token) });
    const up2 = await call('POST', '/user_api/bind_address/retention', { body: { address_id: ids[1], retention_type: 'permanent' }, headers: userHeaders(token) });
    const up3 = await call('POST', '/user_api/bind_address/retention', { body: { address_id: ids[2], retention_type: 'permanent' }, headers: userHeaders(token) });
    check('upgrade to permanent within quota', up1.status === 200 && up2.status === 200, [up1.text, up2.text]);
    check('upgrade beyond permanent quota is rejected', up3.status === 400, up3);
    const ext = await call('POST', '/user_api/bind_address/retention', { body: { address_id: ids[3], retention_type: 'extended' }, headers: userHeaders(token) });
    check('extend retention works', ext.status === 200, ext);
    const bad = await call('POST', '/user_api/bind_address/retention', { body: { address_id: ids[3], retention_type: 'forever' }, headers: userHeaders(token) });
    check('invalid retention type is rejected', bad.status === 400, bad);
    const notMine = await call('POST', '/user_api/bind_address/retention', { body: { address_id: a1.data.address_id, retention_type: 'extended' }, headers: userHeaders(token) });
    check('cannot change retention of an address that is not bound', notMine.status === 400, notMine);
    const settings = await call('GET', '/user_api/settings', { headers: userHeaders(token) });
    check('settings return the address quota', settings.data.address_count === 4
        && settings.data.permanent_address_count === 2 && settings.data.max_permanent_address_count === 2, settings.data);

    // 清理：按创建时间清理 0 天前的地址，永久和保留期内的地址留下
    // created_at 精确到秒，先等一秒多，保证刚建的地址满足「早于现在」
    await sleep(1500);
    const cleanup = await call('POST', '/admin/cleanup', { body: { cleanType: 'addressCreated', cleanDays: 0 }, headers: admin });
    check('admin cleanup runs', cleanup.status === 200, cleanup);
    const afterCleanup = await call('GET', '/user_api/bind_address?limit=20&offset=0', { headers: userHeaders(token) });
    const left = afterCleanup.data.results.map((row) => row.id).sort();
    check('cleanup keeps permanent and extended addresses only', JSON.stringify(left) === JSON.stringify([ids[0], ids[1], ids[3]].sort()), afterCleanup.data.results.map((row) => [row.name, row.retention_type]));
    const anonGone = await call('GET', '/api/settings', { headers: addressHeaders(a1.data.jwt) });
    check('anonymous temp address is cleaned up', anonGone.status === 401, anonGone.status);

    // 上游功能：真实 email() 处理流程收信、已读状态
    const inboxAddress = bound.data.results.find((row) => row.id === ids[0]).name;
    const received = await receiveMail(inboxAddress, `hello ${RUN_ID}`);
    check('mail is delivered through email()', received.status === 200, received);
    const jwtRes = await call('GET', `/user_api/bind_address_jwt/${ids[0]}`, { headers: userHeaders(token) });
    const mails = await call('GET', '/api/mails?limit=10&offset=0', { headers: addressHeaders(jwtRes.data.jwt) });
    check('received mail is listed as unread', mails.status === 200 && mails.data.results[0]?.is_unread === 1, mails.data);
    const markRead = await call('PATCH', `/api/mails/${mails.data.results[0]?.id}/read`, { body: { isUnread: false }, headers: addressHeaders(jwtRes.data.jwt) });
    const mailsAfter = await call('GET', '/api/mails?limit=10&offset=0', { headers: addressHeaders(jwtRes.data.jwt) });
    check('mail can be marked as read', markRead.status === 200 && mailsAfter.data.results[0]?.is_unread === 0, [markRead.text, mailsAfter.data.results[0]?.is_unread]);
    const userMails = await call('GET', `/user_api/mails?limit=10&offset=0&address=${encodeURIComponent(inboxAddress)}`, { headers: userHeaders(token) });
    check('user inbox lists mail of a bound address', userMails.status === 200 && userMails.data.results.length === 1, userMails.data);

    return { token, email, ids, inboxAddress };
};

const phases = { phase1 };

const main = async () => {
    const target = process.argv[2] || 'all';
    await ensureDb();
    const selected = target === 'all' ? Object.keys(phases) : [target];
    for (const name of selected) {
        if (!phases[name]) throw new Error(`unknown phase ${name}`);
        await phases[name]();
    }
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log(failures.map((name) => `  - ${name}`).join('\n'));
        process.exitCode = 1;
    }
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
