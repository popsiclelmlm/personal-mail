import { Hono } from 'hono'
import { verifyAddressToken } from '../address_auth';

import utils, {
    adminAuthGuardKey, checkCfTurnstile, getAdminTokenVersion, getPasswords, getAdminPasswords, hashPassword,
} from '../utils';
import { findMatchingSecret, resolveAdminTokenTtl, signAdminToken } from '../admin_token';
import { clearAuthFailures, isAuthLocked, recordAuthFailure } from '../user_api/auth_guard';
import i18n from '../i18n';
import { ErrorCode } from '../error_codes';

const api = new Hono<HonoCustomType>()

api.post('/open_api/site_login', async (c) => {
    const { password, cf_token } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    const passwords = getPasswords(c);
    const hashedPasswords = await Promise.all(passwords.map(p => hashPassword(p)));
    if (!hashedPasswords.length || !password || !hashedPasswords.includes(password)) {
        return c.json({ code: ErrorCode.AUTH_SITE_PASSWORD_INVALID, message: msgs.CustomAuthPasswordMsg }, 401)
    }
    return c.json({ success: true })
})

// 管理员登录：前端发来密码的 SHA-256 摘要，校验通过后签发短期会话令牌。
// 前端只保存令牌，不再保存密码本身（页面被 XSS 时最多泄露一个会过期、可吊销的令牌）。
api.post('/open_api/admin_login', async (c) => {
    const { password, cf_token } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    // 按 IP 计数，连续失败 5 次锁定 15 分钟（和 x-admin-auth 明文密码共用计数）
    const guardKey = adminAuthGuardKey(c);
    if (await isAuthLocked(c.env.KV, guardKey)) {
        return c.text(msgs.TooManyAttemptsMsg, 429);
    }
    const adminPasswords = getAdminPasswords(c);
    const hashedPasswords = await Promise.all(adminPasswords.map(p => hashPassword(p)));
    const matchedHash = findMatchingSecret(hashedPasswords, typeof password === 'string' ? password.toLowerCase() : password);
    const matchedPassword = matchedHash === null ? null : adminPasswords[hashedPasswords.indexOf(matchedHash)];
    if (!matchedPassword) {
        // 没配置管理员密码时不计失败次数，免得误锁
        if (adminPasswords.length && await recordAuthFailure(c.env.KV, guardKey)) {
            return c.text(msgs.TooManyAttemptsMsg, 429);
        }
        return c.json({ code: ErrorCode.AUTH_ADMIN_CREDENTIAL_INVALID, message: msgs.NeedAdminPasswordMsg }, 401)
    }
    await clearAuthFailures(c.env.KV, guardKey);
    const { token, expiresAt } = await signAdminToken({
        jwtSecret: c.env.JWT_SECRET,
        password: matchedPassword,
        version: await getAdminTokenVersion(c),
        ttlSeconds: resolveAdminTokenTtl(c.env.ADMIN_TOKEN_TTL_SECONDS),
    });
    return c.json({ success: true, token, expires_at: expiresAt })
})

api.post('/open_api/credential_login', async (c) => {
    const { credential, cf_token } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    if (!credential) {
        return c.text(msgs.InvalidAddressCredentialMsg, 401)
    }
    try {
        await verifyAddressToken(c, credential);
    } catch (error) {
        return c.text(msgs.InvalidAddressCredentialMsg, 401)
    }
    return c.json({ success: true })
})

export { api }
