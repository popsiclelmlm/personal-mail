#!/usr/bin/env node
// 在本地 wrangler dev 上验证个人邮件改造的接口（替代需要 Docker 的 e2e）。
// 用法：
//   1. cp scripts/personal-mail/wrangler.local.toml worker/wrangler.toml
//   2. cd worker && pnpm exec wrangler dev --port 8797 --test-scheduled
//   3. node scripts/personal-mail/local-verify.mjs [phase1|phase2|phase3|phase4|phase5|all]
// 每次运行都用新的随机名字，可以对同一个本地数据库重复执行。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.VERIFY_BASE_URL || 'http://127.0.0.1:8797';
const ADMIN_PASSWORD = process.env.VERIFY_ADMIN_PASSWORD || 'local-admin-pass';
const JWT_SECRET = process.env.VERIFY_JWT_SECRET || 'local-test-secret-key';
// 本地 SMTP 收信器（scripts/personal-mail/smtp-sink.mjs）的 HTTP 地址
const SMTP_SINK = process.env.VERIFY_SMTP_SINK || 'http://127.0.0.1:1080';
// wrangler dev 的 --persist-to 目录；设置后脚本会直接查本地 D1 核对数据库内容
const D1_PERSIST = process.env.VERIFY_D1_PERSIST || '';
const WORKER_DIR = fileURLToPath(new URL('../../worker/', import.meta.url));
const VERIFY_SENDER = 'noreply@personal.test';
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


// 直接查本地 D1（需要 VERIFY_D1_PERSIST）；没配置时返回 null，相关检查跳过
const sql = (query) => {
    if (!D1_PERSIST) return null;
    // worker/wrangler.toml 是生产配置，本地库用 wrangler.dev.toml 里的 database_id
    const configArgs = existsSync(new URL('../../worker/wrangler.dev.toml', import.meta.url))
        ? ['-c', 'wrangler.dev.toml'] : [];
    const output = execFileSync('pnpm', [
        'exec', 'wrangler', 'd1', 'execute', 'DB', ...configArgs, '--local', '--persist-to', D1_PERSIST, '--json', '--command', query,
    ], { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(output)[0].results;
};

const signJwt = (payload) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
};

const sinkMessages = async () => (await fetch(`${SMTP_SINK}/messages`)).json();

// 发验证码并从本地收信器里取出来
const latestCodeFor = (messages, email) => messages
    .filter((item) => item.to.includes(email))
    .map((item) => item.data.match(/verify code is (\d{6})/)?.[1])
    .filter(Boolean)
    .at(-1);

const requestVerifyCode = async (email, ip = randomIp()) => {
    const before = (await sinkMessages()).length;
    const res = await call('POST', '/user_api/verify_code', { body: { email }, headers: { 'cf-connecting-ip': ip } });
    // 上游规定 5 分钟内不能重发；上一个验证码还有效时直接用它
    if (res.status === 400 && /already sent/i.test(res.text)) {
        const code = latestCodeFor(await sinkMessages(), email);
        if (code) return code;
    }
    if (res.status !== 200) throw new Error(`verify_code failed: ${res.text}`);
    for (let i = 0; i < 20; i++) {
        const code = latestCodeFor((await sinkMessages()).slice(before), email);
        if (code) return code;
        await sleep(250);
    }
    throw new Error(`verify code for ${email} not received`);
};

const setupMailVerify = async () => {
    const userSettings = await call('POST', '/admin/user_settings', {
        body: { enable: true, enableMailVerify: true, verifyMailSender: VERIFY_SENDER, maxAddressCount: 10 },
        headers: admin,
    });
    if (userSettings.status !== 200) throw new Error(`user settings failed: ${userSettings.text}`);
    const account = await call('GET', '/admin/account_settings', { headers: admin });
    const saved = await call('POST', '/admin/account_settings', {
        body: { ...account.data, noLimitSendAddressList: [VERIFY_SENDER] },
        headers: admin,
    });
    if (saved.status !== 200) throw new Error(`account settings failed: ${saved.text}`);
};

const createInvites = async (body) => {
    const res = await call('POST', '/admin/invite_codes', { body, headers: admin });
    if (res.status !== 200) throw new Error(`create invites failed: ${res.text}`);
    return res.data.codes;
};

const registerUser = async ({ email, password, invite, ip = randomIp() }) => {
    const code = await requestVerifyCode(email, ip);
    return call('POST', '/user_api/register', {
        body: { email, password: sha256(password), code, invite_code: invite },
        headers: { 'cf-connecting-ip': ip },
    });
};

const phase2 = async () => {
    console.log('phase 2: account security');
    await setupMailVerify();
    const open = await call('GET', '/user_api/open_settings');
    check('open settings expose invite mode and password reset', open.data.registerMode === 'invite'
        && open.data.enable === true && open.data.enableResetPassword === true, open.data);

    // 邀请制注册
    const email = `invitee${RUN_ID}@outside.test`;
    const noInvite = await call('POST', '/user_api/register', {
        body: { email, password: sha256('pw-1'), code: '000000' },
    });
    check('register without an invite code is rejected', noInvite.status === 400, noInvite);
    const badInvite = await call('POST', '/user_api/register', {
        body: { email, password: sha256('pw-1'), code: '000000', invite_code: 'NOPE-NOPE-NOPE' },
    });
    check('register with an invalid invite code is rejected', badInvite.status === 400, badInvite);
    const [invite, spareInvite] = await createInvites({ count: 2, max_uses: 1 });
    check('admin creates invite codes', /^[A-Z0-9]{12}$/.test(invite), invite);
    const formatted = invite.replace(/(.{4})(?=.)/g, '$1-').toLowerCase();
    const registered = await registerUser({ email, password: 'pw-1', invite: formatted });
    check('register with a valid invite code (any case, with dashes)', registered.status === 200, registered);
    const reused = await registerUser({ email: `second${RUN_ID}@outside.test`, password: 'pw-1', invite });
    check('a single-use invite cannot be used twice', reused.status === 400, reused);
    const duplicate = await registerUser({ email, password: 'pw-2', invite: spareInvite });
    check('registering an existing email does not overwrite it', duplicate.status === 400, duplicate);
    const list = await call('GET', '/admin/invite_codes?limit=20&offset=0', { headers: admin });
    const used = list.data.results.find((row) => row.code === invite);
    const spare = list.data.results.find((row) => row.code === spareInvite);
    check('invite usage is recorded and rolled back on failure', used?.used_count === 1 && used?.used_by === email
        && spare?.used_count === 0, [used, spare]);

    const logged = await login(email, 'pw-1');
    check('invited user logs in', logged.status === 200, logged);
    const token = logged.data.jwt;
    const settings = await call('GET', '/user_api/settings', { headers: userHeaders(token) });
    check('invited user gets the member role', settings.data.user_role?.role === 'member', settings.data);
    const personal = await createAddress(`inv${RUN_ID}`, 'personal.test', { token });
    check('member can create an address on the personal domain', personal.status === 200, personal);
    const tokenPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    check('user token carries tv and lasts 7 days', tokenPayload.tv === 0
        && Math.abs(tokenPayload.exp - tokenPayload.iat - 7 * 86400) < 5, tokenPayload);

    const stored = sql(`SELECT password FROM users WHERE user_email = '${email}'`);
    if (stored) {
        check('password is stored as pbkdf2, not hex', /^pbkdf2\$sha256\$100000\$/.test(stored[0].password), stored[0].password);
    }

    // 老格式密码：登录后自动升级
    if (D1_PERSIST) {
        const legacyEmail = `legacy${RUN_ID}@outside.test`;
        sql(`INSERT INTO users (user_email, password) VALUES ('${legacyEmail}', '${sha256('legacy-pw')}')`);
        const legacyLogin = await login(legacyEmail, 'legacy-pw');
        const upgraded = sql(`SELECT password FROM users WHERE user_email = '${legacyEmail}'`)[0].password;
        check('legacy hex password logs in and is upgraded', legacyLogin.status === 200 && upgraded.startsWith('pbkdf2$'), [legacyLogin.status, upgraded]);
        const hexAsPassword = await call('POST', '/user_api/login', { body: { email: legacyEmail, password: upgraded } });
        check('the stored hash itself cannot be used to log in', hexAsPassword.status === 400, hexAsPassword);
    }

    // 登录失败锁定
    const lockIp = randomIp();
    const wrong = [];
    for (let i = 0; i < 5; i++) wrong.push((await login(email, 'wrong', lockIp)).status);
    const lockedRight = await login(email, 'pw-1', lockIp);
    check('five wrong passwords lock the IP + email', wrong.slice(0, 4).every((s) => s === 400) && wrong[4] === 429
        && lockedRight.status === 429, [...wrong, lockedRight.status]);
    const otherIp = await login(email, 'pw-1');
    check('other IPs are not locked', otherIp.status === 200, otherIp);
    const unknownUser = await login(`nobody${RUN_ID}@outside.test`, 'x');
    const wrongPassword = await login(email, 'wrong');
    check('unknown user gets the same error as a wrong password', unknownUser.status === 400
        && unknownUser.text === wrongPassword.text, [unknownUser.text, wrongPassword.text]);

    // 退出所有设备
    const second = (await login(email, 'pw-1')).data.jwt;
    const legacyToken = signJwt({ user_email: email, user_id: tokenPayload.user_id, exp: Math.floor(Date.now() / 1000) + 3600 });
    const legacyOk = await call('GET', '/user_api/settings', { headers: userHeaders(legacyToken) });
    check('old tokens without tv still work while the version is 0', legacyOk.status === 200, legacyOk.status);
    const logoutAll = await call('POST', '/user_api/logout_all', { headers: userHeaders(token) });
    const afterA = await call('GET', '/user_api/settings', { headers: userHeaders(token) });
    const afterB = await call('GET', '/user_api/settings', { headers: userHeaders(second) });
    const afterLegacy = await call('GET', '/user_api/settings', { headers: userHeaders(legacyToken) });
    check('logout_all revokes every token', logoutAll.status === 200 && afterA.status === 401
        && afterB.status === 401 && afterLegacy.status === 401, [logoutAll.status, afterA.status, afterB.status, afterLegacy.status]);
    const revokedCreate = await createAddress(`rv${RUN_ID}`, 'personal.test', { token });
    check('a revoked token is treated as anonymous when creating addresses', revokedCreate.status === 400, revokedCreate);

    // 重设密码
    const fresh = (await login(email, 'pw-1')).data.jwt;
    const resetIp = randomIp();
    const wrongCodes = [];
    await requestVerifyCode(email, resetIp);
    for (let i = 0; i < 5; i++) {
        wrongCodes.push((await call('POST', '/user_api/reset_password', {
            body: { email, code: '000000', password: sha256('pw-x') }, headers: { 'cf-connecting-ip': resetIp },
        })).status);
    }
    check('five wrong verify codes lock reset_password', wrongCodes.slice(0, 4).every((s) => s === 400) && wrongCodes[4] === 429, wrongCodes);
    const code = await requestVerifyCode(email);
    const sinkBefore = (await sinkMessages()).length;
    const reset = await call('POST', '/user_api/reset_password', { body: { email, code, password: sha256('pw-new') } });
    check('reset_password with the code succeeds', reset.status === 200, reset);
    const oldToken = await call('GET', '/user_api/settings', { headers: userHeaders(fresh) });
    check('reset_password signs out existing sessions', oldToken.status === 401, oldToken.status);
    check('old password no longer works', (await login(email, 'pw-1')).status === 400);
    check('new password works', (await login(email, 'pw-new')).status === 200);
    const reuseCode = await call('POST', '/user_api/reset_password', { body: { email, code, password: sha256('pw-again') } });
    check('a verify code cannot be reused', reuseCode.status === 400, reuseCode);
    await sleep(500);
    const notice = (await sinkMessages()).slice(sinkBefore).find((item) => item.to.includes(email));
    check('a reset notification is mailed to the account', !!notice && /password was reset|密码已重设|=E5=AF=86/.test(notice.data), notice?.data?.slice(0, 200));

    // 管理员建用户、重设密码
    const adminEmail = `byadmin${RUN_ID}@outside.test`;
    await adminCreateUser(adminEmail, 'admin-made', 'member');
    const adminUserToken = (await login(adminEmail, 'admin-made')).data.jwt;
    const adminUser = (await call('GET', `/admin/users?limit=5&offset=0&query=${encodeURIComponent(adminEmail)}`, { headers: admin })).data.results[0];
    const adminReset = await call('POST', `/admin/users/${adminUser.id}/reset_password`, { body: { password: sha256('admin-reset') }, headers: admin });
    const afterAdminReset = await call('GET', '/user_api/settings', { headers: userHeaders(adminUserToken) });
    check('admin password reset revokes the user tokens', adminReset.status === 200 && afterAdminReset.status === 401, [adminReset.status, afterAdminReset.status]);
    const adminStored = sql(`SELECT password FROM users WHERE user_email = '${adminEmail}'`);
    if (adminStored) {
        check('admin-set passwords are stored as pbkdf2', adminStored[0].password.startsWith('pbkdf2$'), adminStored[0].password);
    }
    if (D1_PERSIST) {
        const hex = sql(`SELECT COUNT(*) AS n FROM users WHERE password GLOB '[0-9a-f]*' AND length(password) = 64 AND user_email LIKE '%${RUN_ID}%'`);
        check('no new 64-character hex passwords in the database', hex[0].n === 0, hex);
    }
    return { email, password: 'pw-new' };
};

const decodeJwt = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));

const phase3 = async () => {
    console.log('phase 3: personal mailboxes');
    const email = `owner${RUN_ID}@example.test`;
    await adminCreateUser(email, 'owner-pw', 'member');
    let token = (await login(email, 'owner-pw')).data.jwt;

    // 建一个个人邮箱域名的地址和一个临时地址，都绑定到账号
    const personal = await createAddress(`pm${RUN_ID}`, 'personal.test', { token });
    const temp = await createAddress(`pt${RUN_ID}`, 'temp.test', { token });
    await bindAddress(token, personal.data.jwt);
    await bindAddress(token, temp.data.jwt);
    const plainJwt = personal.data.jwt;
    check('new address credentials carry cv', decodeJwt(plainJwt).cv === 0, decodeJwt(plainJwt));
    check('plain credential works before the upgrade', (await call('GET', '/api/settings', { headers: addressHeaders(plainJwt) })).status === 200);

    // 升级为个人邮箱：默认关闭邮箱凭证登录
    const upgrade = await call('POST', '/user_api/bind_address/retention', {
        body: { address_id: personal.data.address_id, retention_type: 'permanent' }, headers: userHeaders(token),
    });
    check('upgrade to personal mailbox', upgrade.status === 200, upgrade);
    const plainAfter = await call('GET', '/api/settings', { headers: addressHeaders(plainJwt) });
    check('plain credential is refused for a personal mailbox', plainAfter.status === 401, plainAfter.status);
    const pwLogin = await call('POST', '/api/address_login', {
        body: { email: personal.data.address, password: sha256(personal.data.password || 'x') },
    });
    check('address password login is refused for a personal mailbox', pwLogin.status === 403, pwLogin);
    const accountJwtRes = await call('GET', `/user_api/bind_address_jwt/${personal.data.address_id}`, { headers: userHeaders(token) });
    const accountJwt = accountJwtRes.data.jwt;
    const accountPayload = decodeJwt(accountJwt);
    check('account credential carries cv, uid and utv', accountPayload.cv === 0 && typeof accountPayload.uid === 'number'
        && accountPayload.utv === 0, accountPayload);
    check('account credential opens the personal mailbox', (await call('GET', '/api/settings', { headers: addressHeaders(accountJwt) })).status === 200);
    const rebind = await call('POST', '/user_api/bind_address', { headers: { ...userHeaders(token), ...addressHeaders(plainJwt) } });
    check('a plain credential cannot bind a personal mailbox', rebind.status === 401, rebind.status);

    // 打开、关闭邮箱凭证登录
    const enable = await call('POST', `/user_api/address/${personal.data.address_id}/credential_login`, {
        body: { enabled: true }, headers: userHeaders(token),
    });
    const plainEnabled = await call('GET', '/api/settings', { headers: addressHeaders(plainJwt) });
    check('allowing credential login makes the plain credential work again', enable.status === 200 && plainEnabled.status === 200, [enable.status, plainEnabled.status]);
    await call('POST', `/user_api/address/${personal.data.address_id}/credential_login`, { body: { enabled: false }, headers: userHeaders(token) });
    check('turning it off refuses the plain credential again', (await call('GET', '/api/settings', { headers: addressHeaders(plainJwt) })).status === 401);
    const notOwner = await call('POST', `/user_api/address/${personal.data.address_id + 100000}/credential_login`, { body: { enabled: true }, headers: userHeaders(token) });
    check('cannot change credential login of an address that is not bound', notOwner.status === 400, notOwner.status);

    // 重置邮箱凭证
    const reset = await call('POST', `/user_api/address/${personal.data.address_id}/reset_credential`, { headers: userHeaders(token) });
    check('reset credential returns a new credential', reset.status === 200 && decodeJwt(reset.data.jwt).cv === 1, reset.data);
    check('old account credential is revoked after reset', (await call('GET', '/api/settings', { headers: addressHeaders(accountJwt) })).status === 401);
    check('new credential works after reset', (await call('GET', '/api/settings', { headers: addressHeaders(reset.data.jwt) })).status === 200);
    await call('POST', `/user_api/address/${personal.data.address_id}/credential_login`, { body: { enabled: true }, headers: userHeaders(token) });
    check('old plain credential stays revoked even with credential login allowed', (await call('GET', '/api/settings', { headers: addressHeaders(plainJwt) })).status === 401);
    await call('POST', `/user_api/address/${personal.data.address_id}/credential_login`, { body: { enabled: false }, headers: userHeaders(token) });

    // 统一收件箱
    await receiveMail(personal.data.address, `p1 ${RUN_ID}`);
    await receiveMail(personal.data.address, `p2 ${RUN_ID}`);
    await receiveMail(temp.data.address, `t1 ${RUN_ID}`);
    const counts = await call('GET', '/user_api/mails/unread_counts', { headers: userHeaders(token) });
    const countOf = (data, id) => data.results.find((row) => row.address_id === id)?.unread_count;
    check('unread counts per address', counts.status === 200 && countOf(counts.data, personal.data.address_id) === 2
        && countOf(counts.data, temp.data.address_id) === 1 && counts.data.total_unread === 3, counts.data);
    check('personal mailboxes are listed first', counts.data.results[0]?.address_id === personal.data.address_id, counts.data.results);
    const byAddress = await call('GET', `/user_api/mails?limit=20&offset=0&address_id=${personal.data.address_id}`, { headers: userHeaders(token) });
    check('inbox filters by address id', byAddress.data.results.length === 2
        && byAddress.data.results.every((row) => row.address === personal.data.address), byAddress.data);
    const markRead = await call('PATCH', `/user_api/mails/${byAddress.data.results[0].id}/read`, { body: { isUnread: false }, headers: userHeaders(token) });
    const unread = await call('GET', '/user_api/mails?limit=20&offset=0&unread=1', { headers: userHeaders(token) });
    check('mark read from the unified inbox and filter unread', markRead.status === 200 && unread.data.results.length === 2, [markRead.text, unread.data.results.length]);
    const otherEmail = `other${RUN_ID}@example.test`;
    await adminCreateUser(otherEmail, 'other-pw', 'member');
    const otherToken = (await login(otherEmail, 'other-pw')).data.jwt;
    const foreignRead = await call('PATCH', `/user_api/mails/${byAddress.data.results[1].id}/read`, { body: { isUnread: false }, headers: userHeaders(otherToken) });
    const stillUnread = await call('GET', `/user_api/mails?limit=20&offset=0&unread=1&address_id=${personal.data.address_id}`, { headers: userHeaders(token) });
    check('another user cannot change read status', foreignRead.status === 200 && stillUnread.data.results.length === 1, stillUnread.data.results.length);
    const badFilter = await call('GET', '/user_api/mails?limit=20&offset=0&address_id=abc', { headers: userHeaders(token) });
    check('invalid address id filter is rejected', badFilter.status === 400, badFilter.status);

    // 发信：个人邮箱按角色额度可以发，临时地址不能发
    const sendSettings = await call('GET', `/user_api/address/${personal.data.address_id}/settings`, { headers: userHeaders(token) });
    check('personal mailbox gets the role send balance', sendSettings.data.send_balance === 5, sendSettings.data);
    const sinkBefore = (await sinkMessages()).length;
    const sent = await call('POST', `/user_api/address/${personal.data.address_id}/send_mail`, {
        body: { from_name: 'Me', to_mail: `friend${RUN_ID}@outside.test`, to_name: '', subject: `hi ${RUN_ID}`, content: 'hello', is_html: false },
        headers: userHeaders(token),
    });
    check('personal mailbox sends mail', sent.status === 200, sent);
    await sleep(500);
    const delivered = (await sinkMessages()).slice(sinkBefore).find((item) => item.to.includes(`friend${RUN_ID}@outside.test`));
    check('mail reaches the SMTP server', !!delivered && delivered.from === personal.data.address, delivered);
    const sendbox = await call('GET', `/user_api/sendbox?limit=10&offset=0&address=${encodeURIComponent(personal.data.address)}`, { headers: userHeaders(token) });
    check('sent mail is in the user sendbox', sendbox.status === 200 && sendbox.data.results.length === 1, sendbox.data);
    const balanceAfter = await call('GET', `/user_api/address/${personal.data.address_id}/settings`, { headers: userHeaders(token) });
    check('send balance decreases', balanceAfter.data.send_balance === 4, balanceAfter.data);
    const tempSend = await call('POST', `/user_api/address/${temp.data.address_id}/send_mail`, {
        body: { from_name: '', to_mail: `friend${RUN_ID}@outside.test`, to_name: '', subject: 'x', content: 'x', is_html: false },
        headers: userHeaders(token),
    });
    check('temporary address cannot send', tempSend.status === 400, tempSend);

    // 匿名和登录用户的临时邮箱不受影响
    const anon = await createAddress(`pa${RUN_ID}`, 'temp.test');
    await receiveMail(anon.data.address, `anon ${RUN_ID}`);
    const anonMails = await call('GET', '/api/mails?limit=10&offset=0', { headers: addressHeaders(anon.data.jwt) });
    check('anonymous temp mailbox still receives and reads mail', anon.status === 200 && anonMails.data.results.length === 1, anonMails.data);
    const tempMails = await call('GET', '/api/mails?limit=10&offset=0', { headers: addressHeaders(temp.data.jwt) });
    check('bound temp mailbox still works with its plain credential', tempMails.status === 200 && tempMails.data.results.length === 1, tempMails.status);

    // 退出所有设备后，账号取得的个人邮箱凭证也失效
    const currentAccountJwt = (await call('GET', `/user_api/bind_address_jwt/${personal.data.address_id}`, { headers: userHeaders(token) })).data.jwt;
    await call('POST', '/user_api/logout_all', { headers: userHeaders(token) });
    check('logout_all revokes account credentials of personal mailboxes', (await call('GET', '/api/settings', { headers: addressHeaders(currentAccountJwt) })).status === 401);
    token = (await login(email, 'owner-pw')).data.jwt;

    // 转移个人邮箱：保留期和凭证开关保留，占用对方的永久额度
    const noRoleEmail = `norole${RUN_ID}@example.test`;
    await adminCreateUser(noRoleEmail, 'norole-pw', null);
    const toNoRole = await call('POST', '/user_api/transfer_address', {
        body: { address_id: personal.data.address_id, target_user_email: noRoleEmail }, headers: userHeaders(token),
    });
    check('cannot transfer a personal mailbox to a user without permanent quota', toNoRole.status === 400, toNoRole);
    const second = await createAddress(`pm2${RUN_ID}`, 'personal.test', { token });
    await bindAddress(token, second.data.jwt);
    await call('POST', '/user_api/bind_address/retention', { body: { address_id: second.data.address_id, retention_type: 'permanent' }, headers: userHeaders(token) });
    const transferred = await call('POST', '/user_api/transfer_address', {
        body: { address_id: second.data.address_id, target_user_email: otherEmail }, headers: userHeaders(token),
    });
    const otherList = await call('GET', '/user_api/bind_address?limit=20&offset=0', { headers: userHeaders(otherToken) });
    const moved = otherList.data.results.find((row) => row.name === second.data.address);
    check('transferred personal mailbox keeps its retention and credential setting', transferred.status === 200
        && moved?.is_permanent === 1 && moved?.retention_type === 'permanent' && moved?.credential_login_disabled === 1, moved);

    // 注销账号
    const preview = await call('GET', '/user_api/delete_account/preview', { headers: userHeaders(token) });
    check('delete preview lists personal and other addresses', preview.status === 200
        && preview.data.personal_addresses.map((row) => row.id).includes(personal.data.address_id)
        && preview.data.other_addresses.map((row) => row.id).includes(temp.data.address_id)
        && preview.data.password_required === true, preview.data);
    const noAction = await call('POST', '/user_api/delete_account', {
        body: { confirm_email: email, password: sha256('owner-pw') }, headers: userHeaders(token),
    });
    check('delete account requires a choice for each personal mailbox', noAction.status === 400
        && noAction.data.personal_addresses?.[0]?.id === personal.data.address_id, noAction.data);
    const wrongEmail = await call('POST', '/user_api/delete_account', {
        body: { confirm_email: 'x@y.test', password: sha256('owner-pw'), personal_addresses: [{ address_id: personal.data.address_id, action: 'delete' }] },
        headers: userHeaders(token),
    });
    check('delete account requires typing the account email', wrongEmail.status === 400, wrongEmail.text);
    const wrongPw = await call('POST', '/user_api/delete_account', {
        body: { confirm_email: email, password: sha256('nope'), personal_addresses: [{ address_id: personal.data.address_id, action: 'delete' }] },
        headers: userHeaders(token),
    });
    check('delete account requires the password', wrongPw.status === 400, wrongPw.text);
    const removed = await call('POST', '/user_api/delete_account', {
        body: {
            confirm_email: email.toUpperCase(), password: sha256('owner-pw'),
            personal_addresses: [{ address_id: personal.data.address_id, action: 'transfer', target_user_email: otherEmail }],
        },
        headers: userHeaders(token),
    });
    check('delete account with a transfer succeeds', removed.status === 200, removed);
    check('deleted account can no longer log in', (await login(email, 'owner-pw')).status === 400);
    check('deleted account token is revoked', (await call('GET', '/user_api/settings', { headers: userHeaders(token) })).status === 401);
    const otherAfter = await call('GET', '/user_api/bind_address?limit=20&offset=0', { headers: userHeaders(otherToken) });
    check('the personal mailbox now belongs to the receiving user', otherAfter.data.results.some((row) => row.name === personal.data.address && row.is_permanent === 1), otherAfter.data.results.map((row) => row.name));
    check('other addresses of the deleted account are removed', (await call('GET', '/api/settings', { headers: addressHeaders(temp.data.jwt) })).status === 401);
    const otherMails = await call('GET', `/user_api/mails?limit=20&offset=0&address=${encodeURIComponent(personal.data.address)}`, { headers: userHeaders(otherToken) });
    check('mail of the transferred mailbox moves with it', otherMails.data.results.length === 2, otherMails.data.results.length);
};

const phase4 = async () => {
    console.log('phase 4: personal-only domains (PERSONAL_MAIL_DOMAINS = me.test)');
    const settings = await call('GET', '/open_api/settings');
    check('open settings list the personal-only domains', JSON.stringify(settings.data.personalMailDomains) === '["me.test"]',
        settings.data.personalMailDomains);

    // 临时邮箱（匿名和登录用户）都不能用个人邮箱专用域名
    const anon = await createAddress(`pd${RUN_ID}`, 'me.test');
    check('anonymous users cannot create a temp address on the personal-only domain', anon.status === 400, anon);
    const email = `pdu${RUN_ID}@example.test`;
    await adminCreateUser(email, 'pd-pw', 'member');
    const token = (await login(email, 'pd-pw')).data.jwt;
    const userTemp = await createAddress(`pd2${RUN_ID}`, 'me.test', { token });
    check('logged-in users cannot create a temp address on the personal-only domain', userTemp.status === 400, userTemp);
    const tempOk = await createAddress(`pd3${RUN_ID}`, 'temp.test');
    check('temp addresses on other domains still work', tempOk.status === 200, tempOk);

    // 直接创建个人邮箱
    const noLogin = await call('POST', '/user_api/personal_mailbox', { body: { name: `pm4${RUN_ID}` } });
    check('creating a personal mailbox needs an account', noLogin.status === 401, noLogin.status);
    const wrongDomain = await call('POST', '/user_api/personal_mailbox', {
        body: { name: `pm4${RUN_ID}`, domain: 'temp.test' }, headers: userHeaders(token),
    });
    check('personal mailboxes cannot use temp domains', wrongDomain.status === 400, wrongDomain);
    const created = await call('POST', '/user_api/personal_mailbox', {
        body: { name: `pm4${RUN_ID}` }, headers: userHeaders(token),
    });
    check('create a personal mailbox on the personal-only domain', created.status === 200
        && created.data.address === `pm4${RUN_ID}@me.test`, created);
    const row = (await call('GET', '/user_api/mails/unread_counts', { headers: userHeaders(token) }))
        .data.results.find((item) => item.address_id === created.data.address_id);
    check('the new personal mailbox is bound and permanent', row && row.is_permanent === 1, row);
    const flags = sql(`SELECT retention_type, credential_login_disabled FROM address WHERE id = ${Number(created.data.address_id)}`);
    if (flags) {
        check('the new personal mailbox refuses plain credentials', flags[0]?.retention_type === 'permanent'
            && flags[0]?.credential_login_disabled === 1, flags);
    }
    const downgrade = await call('POST', '/user_api/bind_address/retention', {
        body: { address_id: created.data.address_id, retention_type: 'temporary' }, headers: userHeaders(token),
    });
    check('personal-only domain addresses cannot become temporary', downgrade.status === 400, downgrade);
    const duplicate = await call('POST', '/user_api/personal_mailbox', {
        body: { name: `pm4${RUN_ID}` }, headers: userHeaders(token),
    });
    check('duplicate personal mailbox names are refused', duplicate.status === 400, duplicate);

    // 额度：member 角色 max_permanent_address_count = 2
    const second = await call('POST', '/user_api/personal_mailbox', { body: { name: `pm5${RUN_ID}` }, headers: userHeaders(token) });
    const third = await call('POST', '/user_api/personal_mailbox', { body: { name: `pm6${RUN_ID}` }, headers: userHeaders(token) });
    check('the permanent mailbox quota applies', second.status === 200 && third.status === 400, [second.status, third.text]);

    // 收信
    await receiveMail(`pm4${RUN_ID}@me.test`, `hello ${RUN_ID}`);
    const inbox = await call('GET', `/user_api/mails?limit=10&offset=0&address_id=${created.data.address_id}`, { headers: userHeaders(token) });
    check('mail to the personal mailbox shows up in the unified inbox', inbox.data.results?.length === 1, inbox.data);

    // 管理员不受限制
    const adminCreate = await call('POST', '/admin/new_address', {
        body: { name: `pa4${RUN_ID}`, domain: 'me.test', enablePrefix: false }, headers: admin,
    });
    check('admins can still create addresses on the personal-only domain', adminCreate.status === 200, adminCreate);
};

// 第 5 阶段要求 Worker 带 REGISTER_WITH_PERSONAL_MAILBOX=true 运行：
//   pnpm exec wrangler dev -c wrangler.dev.toml --port 8797 --var REGISTER_WITH_PERSONAL_MAILBOX:true
// 这个开关打开后站外邮箱注册（第 2 阶段）会被拒绝，所以 all 不包含第 5 阶段
const phase5 = async () => {
    console.log('phase 5: sign up with a personal mailbox (REGISTER_WITH_PERSONAL_MAILBOX = true)');
    const open = await call('GET', '/user_api/open_settings');
    if (!open.data.registerWithPersonalMailbox) {
        throw new Error('start the worker with --var REGISTER_WITH_PERSONAL_MAILBOX:true first');
    }
    // 后台同时开着邮件验证，用来确认这种注册方式会跳过它
    await setupMailVerify();
    const open2 = await call('GET', '/user_api/open_settings');
    check('open settings switch the form to personal mailbox sign-up', open2.data.registerWithPersonalMailbox === true
        && JSON.stringify(open2.data.personalMailDomains) === '["me.test"]'
        && open2.data.enableMailVerify === false && open2.data.enableResetPassword === false, open2.data);

    const [invite] = await createInvites({ count: 1, max_uses: 3 });
    const name = `rg${RUN_ID}`;
    const address = `${name}@me.test`;
    const ip = randomIp();
    const signup = (body) => call('POST', '/user_api/register', { body, headers: { 'cf-connecting-ip': randomIp() } });

    const external = await signup({ email: `ext${RUN_ID}@example.test`, password: sha256('rg-pw'), invite_code: invite });
    check('external emails are refused in this mode', external.status === 400, external);
    const tempDomain = await signup({ mailbox_name: name, mailbox_domain: 'temp.test', password: sha256('rg-pw'), invite_code: invite });
    check('sign-up cannot use a temp domain', tempDomain.status === 400, tempDomain);
    const noInvite = await signup({ mailbox_name: name, password: sha256('rg-pw') });
    check('sign-up still needs an invite code', noInvite.status === 400, noInvite);

    const ok = await call('POST', '/user_api/register', {
        body: { mailbox_name: name.toUpperCase(), password: sha256('rg-pw'), invite_code: invite },
        headers: { 'cf-connecting-ip': ip },
    });
    check('sign up with name@personal-domain (no verify code needed)', ok.status === 200 && ok.data.email === address, ok);
    const again = await signup({ mailbox_name: name, password: sha256('rg-pw'), invite_code: invite });
    check('the same address cannot sign up twice', again.status === 400, again);

    const loginRes = await login(address.toUpperCase(), 'rg-pw');
    check('log in with the address, case-insensitively', loginRes.status === 200 && !!loginRes.data.jwt, loginRes);
    const token = loginRes.data.jwt;
    const settings = await call('GET', '/user_api/settings', { headers: userHeaders(token) });
    check('the new account gets the default role', settings.data.user_role?.role === 'member', settings.data);
    const row = (await call('GET', '/user_api/mails/unread_counts', { headers: userHeaders(token) }))
        .data.results.find((item) => item.address === address);
    check('the personal mailbox is created, bound and permanent', row && row.is_permanent === 1, row);
    const flags = sql(`SELECT credential_login_disabled FROM address WHERE name = '${address}'`);
    if (flags) check('the sign-up mailbox refuses plain credentials', flags[0]?.credential_login_disabled === 1, flags);
    const uses = sql(`SELECT used_count FROM invite_codes WHERE code = '${invite}'`);
    if (uses) check('failed sign-ups did not use up the invite code', uses[0]?.used_count === 1, uses);

    await receiveMail(address, `welcome ${RUN_ID}`);
    const inbox = await call('GET', `/user_api/mails?limit=10&offset=0&address_id=${row?.address_id}`, { headers: userHeaders(token) });
    check('mail to the sign-up mailbox reaches the account inbox', inbox.data.results?.length === 1, inbox.data);

    const unbind = await call('POST', '/user_api/unbind_address', { body: { address_id: row?.address_id }, headers: userHeaders(token) });
    check('the login mailbox cannot be unbound', unbind.status === 400, unbind);
    const otherEmail = `rgo${RUN_ID}@example.test`;
    await adminCreateUser(otherEmail, 'rgo-pw', 'member');
    const otherToken = (await login(otherEmail, 'rgo-pw')).data.jwt;
    const transfer = await call('POST', '/user_api/transfer_address', {
        body: { address_id: row?.address_id, target_user_email: otherEmail }, headers: userHeaders(token),
    });
    check('the login mailbox cannot be transferred', transfer.status === 400, transfer);

    // 地址被管理员删掉后，别人不能把它建成自己的个人邮箱，账号本人可以重新建
    await call('DELETE', `/admin/delete_address/${row?.address_id}`, { headers: admin });
    const steal = await call('POST', '/user_api/personal_mailbox', { body: { name }, headers: userHeaders(otherToken) });
    check("others cannot take over an account's login address", steal.status === 400, steal);
    const recreate = await call('POST', '/user_api/personal_mailbox', { body: { name }, headers: userHeaders(token) });
    check('the account owner can recreate the login address', recreate.status === 200 && recreate.data.address === address, recreate);
};

const phases = { phase1, phase2, phase3, phase4, phase5 };

const main = async () => {
    const target = process.argv[2] || 'all';
    await ensureDb();
    const selected = target === 'all' ? Object.keys(phases).filter((name) => name !== 'phase5') : [target];
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
