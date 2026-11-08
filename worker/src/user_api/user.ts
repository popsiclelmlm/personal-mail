import { Context } from 'hono';

import i18n from '../i18n';
import utils, { checkCfTurnstile, getJsonSetting, checkUserPassword, getUserRoles, getStringValue, getMailDomain, includesDomain } from "../utils"
import { CONSTANTS } from "../constants";
import { GeoData, UserInfo, UserSettings } from "../models";
import { sendMail } from "../mails_api/send_mail_api";
import { hashUserPassword, resolvePbkdf2Iterations, verifyUserPassword } from "./password";
import { authGuardKey, clearAuthFailures, isAuthLocked, recordAuthFailure } from "./auth_guard";
import {
    CONSUME_INVITE_CODE_SQL, GRANT_ROLE_AFTER_INSERT_SQL, INSERT_USER_AFTER_INVITE_SQL, INSERT_USER_SQL,
    normalizeInviteCode, RECORD_INVITE_USE_SQL, resolveRegisterMode, SELECT_USABLE_INVITE_CODE_SQL,
} from "./invite";
import { bumpUserTokenVersion, signUserToken } from "./user_token";

const getRequestIp = (c: Context<HonoCustomType>): string | null => c.req.raw.headers.get("cf-connecting-ip");

const verifyCodeKey = (email: string): string => `temp-mail:${email}`;

/**
 * 校验邮箱验证码，带失败锁定。返回 null 表示通过，否则返回要直接回给客户端的响应。
 */
const checkVerifyCode = async (
    c: Context<HonoCustomType>,
    email: string,
    code: unknown,
): Promise<Response | null> => {
    const msgs = i18n.getMessagesbyContext(c);
    const guardKey = authGuardKey('verify_code', getRequestIp(c), email);
    if (await isAuthLocked(c.env.KV, guardKey)) {
        return c.text(msgs.TooManyAttemptsMsg, 429);
    }
    const expected = await c.env.KV.get(verifyCodeKey(email));
    if (!expected || typeof code !== 'string' || expected !== code.trim()) {
        const locked = await recordAuthFailure(c.env.KV, guardKey);
        if (locked) {
            // 连续输错后作废这个验证码，锁定期过后只能重新获取
            await c.env.KV.delete(verifyCodeKey(email));
            return c.text(msgs.TooManyAttemptsMsg, 429);
        }
        return c.text(msgs.InvalidVerifyCodeMsg, 400);
    }
    await clearAuthFailures(c.env.KV, guardKey);
    return null;
};

/** 要授予新用户的角色：邀请码上指定的角色优先，其次 USER_DEFAULT_ROLE */
const resolveRoleToGrant = (
    c: Context<HonoCustomType>,
    inviteRole: string | null | undefined,
): { role: string | null, valid: boolean } => {
    const role = (inviteRole || getStringValue(c.env.USER_DEFAULT_ROLE) || '').trim();
    if (!role) return { role: null, valid: true };
    return { role, valid: getUserRoles(c).some((r) => r.role === role) };
};

export default {
    verifyCode: async (c: Context<HonoCustomType>) => {
        const { email, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        // check cf turnstile
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value)
        // check mail domain allow list
        const mailDomain = getMailDomain(email);
        if (settings.enableMailAllowList
            && settings.mailAllowList
            && !includesDomain(settings.mailAllowList, mailDomain)
        ) {
            return c.text(`${msgs.UserMailDomainMustInMsg} ${JSON.stringify(settings.mailAllowList, null, 2)}`, 400)
        }
        // check email regex
        if (settings.enableEmailCheckRegex && settings.emailCheckRegex) {
            try {
                const regex = new RegExp(settings.emailCheckRegex);
                if (!regex.test(email)) {
                    return c.text(`${msgs.UserEmailNotMatchRegexMsg}: /${settings.emailCheckRegex}/`, 400)
                }
            } catch (e) {
                console.error("Failed to check user email regex", e);
            }
        }
        if (!settings.verifyMailSender) {
            return c.text(msgs.VerifyMailSenderNotSetMsg, 400)
        }
        // check if code exists in KV
        const tmpcode = await c.env.KV.get(`temp-mail:${email}`)
        if (tmpcode) {
            return c.text(msgs.CodeAlreadySentMsg, 400)
        }
        // generate code 6 digits and convert to string
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        // send code to email
        try {
            await sendMail(c, settings.verifyMailSender, {
                from_name: "Free Temp Mail",
                to_name: '',
                to_mail: email as string,
                subject: "Free Temp Mail verification code",
                content: `Your verify code is ${code}`,
                is_html: false,
            })
        } catch (e) {
            return c.text(`Failed to send verify code: ${(e as Error).message}`, 500)
        }
        // save to KV
        await c.env.KV.put(`temp-mail:${email}`, code, { expirationTtl: 300 });
        return c.json({
            success: true,
            expirationTtl: 300
        })
    },
    register: async (c: Context<HonoCustomType>) => {
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value)
        const msgs = i18n.getMessagesbyContext(c);
        const registerMode = resolveRegisterMode(c.env.REGISTER_MODE);
        // check enable
        if (!settings.enable || registerMode === 'closed') {
            return c.text(msgs.UserRegistrationDisabledMsg, 403);
        }
        // check request
        const { email, password, code, cf_token, invite_code } = await c.req.json();
        if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400)
        }
        checkUserPassword(password);
        // check cf turnstile only when mail verify is disabled
        // (when enabled, verify_code endpoint already checks turnstile)
        if (!settings.enableMailVerify) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch (error) {
                return c.text(msgs.TurnstileCheckFailedMsg, 400)
            }
        }
        if (settings.enableMailVerify && !code) {
            return c.text(msgs.InvalidVerifyCodeMsg, 400)
        }
        // 邀请制：必须带有效的邀请码
        const inviteCode = registerMode === 'invite' ? normalizeInviteCode(invite_code) : null;
        if (registerMode === 'invite' && !inviteCode) {
            return c.text(msgs.InviteCodeRequiredMsg, 400)
        }
        // check mail domain allow list
        const mailDomain = getMailDomain(email);
        if (settings.enableMailAllowList
            && settings.mailAllowList
            && !includesDomain(settings.mailAllowList, mailDomain)
        ) {
            return c.text(`${msgs.UserMailDomainMustInMsg} ${JSON.stringify(settings.mailAllowList, null, 2)}`, 400)
        }
        // check email regex
        if (settings.enableEmailCheckRegex && settings.emailCheckRegex) {
            try {
                const regex = new RegExp(settings.emailCheckRegex);
                if (!regex.test(email)) {
                    return c.text(`${msgs.UserEmailNotMatchRegexMsg}: /${settings.emailCheckRegex}/`, 400)
                }
            } catch (e) {
                console.error("Failed to check user email regex", e);
            }
        }
        let invite: { id: number, code: string, role: string | null } | null = null;
        if (inviteCode) {
            invite = await c.env.DB.prepare(SELECT_USABLE_INVITE_CODE_SQL)
                .bind(inviteCode).first<{ id: number, code: string, role: string | null }>();
            if (!invite) {
                return c.text(msgs.InviteCodeInvalidMsg, 400)
            }
        }
        // check code
        if (settings.enableMailVerify) {
            const codeResponse = await checkVerifyCode(c, email, code);
            if (codeResponse) return codeResponse;
        }
        const { role: roleToGrant, valid: roleValid } = resolveRoleToGrant(c, invite?.role);
        if (!roleValid) {
            return c.text(msgs.InvalidUserDefaultRoleMsg, 500);
        }
        // geo data
        const reqIp = getRequestIp(c)
        const geoData = new GeoData(reqIp, c.req.raw.cf as any);
        const userInfo = new UserInfo(geoData, email);
        const passwordHash = await hashUserPassword(
            password, resolvePbkdf2Iterations(c.env.PASSWORD_PBKDF2_ITERATIONS)
        );
        // 在一个批次（事务）里完成：消耗邀请码 → 建用户 → 记录邀请码使用 → 授予角色
        // 已有同名账号时插入报 UNIQUE，整个批次回滚，邀请码次数不会被占用；不再覆盖已有账号
        const statements: D1PreparedStatement[] = [];
        if (invite) {
            statements.push(c.env.DB.prepare(CONSUME_INVITE_CODE_SQL).bind(invite.code));
            statements.push(c.env.DB.prepare(INSERT_USER_AFTER_INVITE_SQL)
                .bind(email, passwordHash, JSON.stringify(userInfo)));
            statements.push(c.env.DB.prepare(RECORD_INVITE_USE_SQL).bind(invite.id, email));
        } else {
            statements.push(c.env.DB.prepare(INSERT_USER_SQL)
                .bind(email, passwordHash, JSON.stringify(userInfo)));
        }
        if (roleToGrant) {
            statements.push(c.env.DB.prepare(GRANT_ROLE_AFTER_INSERT_SQL).bind(roleToGrant, email));
        }
        let results: D1Result[];
        try {
            results = await c.env.DB.batch(statements);
        } catch (e) {
            const error = e as Error;
            if (error.message && error.message.includes("UNIQUE")) {
                return c.text(msgs.UserAlreadyExistsMsg, 400)
            }
            return c.text(`${msgs.FailedToRegisterMsg}: ${error.message}`, 500)
        }
        const userInserted = (results[invite ? 1 : 0]?.meta.changes ?? 0) === 1;
        if (!userInserted) {
            // 并发注册把邀请码的最后一次用掉了
            return c.text(msgs.InviteCodeInvalidMsg, 400)
        }
        if (settings.enableMailVerify) {
            await c.env.KV.delete(verifyCodeKey(email));
        }
        return c.json({ success: true })
    },
    login: async (c: Context<HonoCustomType>) => {
        const { email, password, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        // check cf turnstile if global turnstile is enabled
        if (utils.isGlobalTurnstileEnabled(c)) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch (error) {
                return c.text(msgs.TurnstileCheckFailedMsg, 400)
            }
        }
        // 按「IP + 邮箱」计数，连续失败 5 次锁定 15 分钟
        const guardKey = authGuardKey('login', getRequestIp(c), email);
        if (await isAuthLocked(c.env.KV, guardKey)) {
            return c.text(msgs.TooManyAttemptsMsg, 429);
        }
        const user = await c.env.DB.prepare(
            `SELECT id, user_email, password, token_version FROM users where user_email = ?`
        ).bind(email).first<{ id: number, user_email: string, password: string | null, token_version: number | null }>();
        const iterations = resolvePbkdf2Iterations(c.env.PASSWORD_PBKDF2_ITERATIONS);
        // 账号不存在时也算一次哈希，并返回和密码错误相同的提示，避免探测账号
        const { ok, needsUpgrade } = await verifyUserPassword(password, user?.password, iterations);
        if (!user || !ok) {
            const locked = await recordAuthFailure(c.env.KV, guardKey);
            return locked
                ? c.text(msgs.TooManyAttemptsMsg, 429)
                : c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        await clearAuthFailures(c.env.KV, guardKey);
        // 老格式（前端摘要原样入库）或迭代次数过低：当场升级
        if (needsUpgrade) {
            const newHash = await hashUserPassword(password, iterations);
            await c.env.DB.prepare(
                `UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ? AND password = ?`
            ).bind(newHash, user.id, user.password).run();
        }
        const jwt = await signUserToken(c, {
            user_id: user.id, user_email: user.user_email,
        }, user.token_version ?? 0);
        return c.json({
            jwt: jwt
        })
    },
    // 凭邮箱验证码重设密码；成功后所有已登录的设备都要重新登录
    resetPassword: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const settings = new UserSettings(await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY));
        if (!settings.enableMailVerify || !settings.verifyMailSender || !c.env.KV) {
            return c.text(msgs.ResetPasswordNotAvailableMsg, 403);
        }
        const { email, code, password } = await c.req.json();
        if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        checkUserPassword(password);
        if (!code) {
            return c.text(msgs.InvalidVerifyCodeMsg, 400);
        }
        const codeResponse = await checkVerifyCode(c, email, code);
        if (codeResponse) return codeResponse;
        const user = await c.env.DB.prepare(
            `SELECT id, user_email FROM users WHERE user_email = ?`
        ).bind(email).first<{ id: number, user_email: string }>();
        if (!user) {
            return c.text(msgs.UserNotFoundMsg, 400);
        }
        const passwordHash = await hashUserPassword(
            password, resolvePbkdf2Iterations(c.env.PASSWORD_PBKDF2_ITERATIONS)
        );
        await c.env.DB.prepare(
            `UPDATE users SET password = ?, token_version = COALESCE(token_version, 0) + 1,`
            + ` updated_at = datetime('now') WHERE id = ?`
        ).bind(passwordHash, user.id).run();
        await c.env.KV.delete(verifyCodeKey(email));
        // 通知账号邮箱；发送失败不影响重设结果
        c.executionCtx.waitUntil((async () => {
            try {
                await sendMail(c, settings.verifyMailSender as string, {
                    from_name: "Free Temp Mail",
                    to_name: '',
                    to_mail: user.user_email,
                    subject: msgs.PasswordResetMailSubjectMsg,
                    content: msgs.PasswordResetMailContentMsg,
                    is_html: false,
                });
            } catch (e) {
                console.warn("[reset_password] failed to send notification:", (e as Error).message);
            }
        })());
        return c.json({ success: true });
    },
    // 退出所有设备：令牌版本加 1，所有旧令牌立即失效（包括当前这个）
    logoutAll: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        await bumpUserTokenVersion(c, user_id);
        return c.json({ success: true });
    },
}
