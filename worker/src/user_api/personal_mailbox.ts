import { Context } from 'hono';

import i18n from '../i18n';
import { getBooleanValue } from '../utils';
import { signAddressJwt } from '../address_credential';
import { unbindTelegramByAddress } from '../telegram_api/common';
import { getBindedAddressById, transferAddressToUser } from './bind_address';
import { authGuardKey, clearAuthFailures, isAuthLocked, recordAuthFailure } from './auth_guard';
import { resolvePbkdf2Iterations, verifyUserPassword } from './password';

const parseAddressId = (value: string | undefined): number | null => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** 当前用户名下的地址；不是自己的地址返回 null */
const getOwnAddress = async (
    c: Context<HonoCustomType>,
): Promise<{ id: number, name: string } | null> => {
    const addressId = parseAddressId(c.req.param('address_id'));
    if (!addressId) return null;
    const { user_id } = c.get('userPayload');
    const name = await getBindedAddressById(c, user_id, addressId);
    return name ? { id: addressId, name } : null;
};

/** 重置邮箱凭证：凭证版本加 1，所有旧凭证（含 Telegram 绑定）立即失效；返回一个新的账号凭证 */
const resetCredential = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const address = await getOwnAddress(c);
    if (!address) return c.text(msgs.AddressNotBindedMsg, 400);
    await c.env.DB.prepare(
        `UPDATE address SET credential_version = COALESCE(credential_version, 0) + 1,`
        + ` updated_at = datetime('now') WHERE id = ?`
    ).bind(address.id).run();
    await unbindTelegramByAddress(c, address.name);
    const { user_id } = c.get('userPayload');
    const jwt = await signAddressJwt(c, { address: address.name, address_id: address.id }, { userId: user_id });
    return c.json({ success: true, jwt });
};

/** 打开或关闭邮箱凭证登录；关闭后只能通过账号访问这个地址 */
const setCredentialLogin = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const address = await getOwnAddress(c);
    if (!address) return c.text(msgs.AddressNotBindedMsg, 400);
    const { enabled } = await c.req.json<{ enabled?: unknown }>();
    if (typeof enabled !== 'boolean') return c.text(msgs.InvalidInputMsg, 400);
    await c.env.DB.prepare(
        `UPDATE address SET credential_login_disabled = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(enabled ? 0 : 1, address.id).run();
    return c.json({ success: true, credential_login_disabled: enabled ? 0 : 1 });
};

/** 统一收件箱：每个已绑定地址的未读数 */
const unreadCounts = async (c: Context<HonoCustomType>) => {
    const { user_id } = c.get('userPayload');
    const { results } = await c.env.DB.prepare(
        `SELECT a.id AS address_id, a.name AS address, COALESCE(a.is_permanent, 0) AS is_permanent,`
        + ` (SELECT COUNT(*) FROM raw_mails rm WHERE rm.address = a.name AND rm.is_unread = 1) AS unread_count`
        + ` FROM users_address ua JOIN address a ON a.id = ua.address_id`
        + ` WHERE ua.user_id = ? ORDER BY a.is_permanent DESC, a.id DESC LIMIT 500`
    ).bind(user_id).all<{ address_id: number, address: string, is_permanent: number, unread_count: number }>();
    const rows = results || [];
    return c.json({
        results: rows,
        total_unread: rows.reduce((sum, row) => sum + Number(row.unread_count || 0), 0),
    });
};

/** 统一收件箱里标记已读、未读（只能改自己名下地址的邮件） */
const updateMailReadStatus = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.ENABLE_MAIL_READ_STATUS)) {
        return c.json({ error: 'Mail read status is disabled' }, 403);
    }
    const { user_id } = c.get('userPayload');
    const { id } = c.req.param();
    const { isUnread } = await c.req.json<{ isUnread?: boolean }>();
    if (typeof isUnread !== 'boolean') {
        return c.json({ error: 'isUnread must be a boolean' }, 400);
    }
    const value = isUnread ? 1 : 0;
    const { success } = await c.env.DB.prepare(
        `UPDATE raw_mails SET is_unread = ? WHERE id = ? AND COALESCE(is_unread, 0) != ?`
        + ` AND EXISTS (SELECT 1 FROM users_address ua JOIN address a ON a.id = ua.address_id`
        + ` WHERE ua.user_id = ? AND a.name = raw_mails.address)`
    ).bind(value, id, value, user_id).run();
    return c.json({ success });
};

type BoundAddressRow = { id: number, name: string, is_permanent: number, mail_count: number };

const listBoundAddresses = async (
    c: Context<HonoCustomType>,
    user_id: number | string,
): Promise<BoundAddressRow[]> => {
    const { results } = await c.env.DB.prepare(
        `SELECT a.id, a.name, COALESCE(a.is_permanent, 0) AS is_permanent,`
        + ` (SELECT COUNT(*) FROM raw_mails rm WHERE rm.address = a.name) AS mail_count`
        + ` FROM users_address ua JOIN address a ON a.id = ua.address_id WHERE ua.user_id = ?`
        + ` ORDER BY a.id`
    ).bind(user_id).all<BoundAddressRow>();
    return results || [];
};

/** 注销账号前列出名下的地址：个人邮箱要选择删除或转移，其他地址随账号一起删除 */
const deleteAccountPreview = async (c: Context<HonoCustomType>) => {
    const { user_id } = c.get('userPayload');
    const rows = await listBoundAddresses(c, user_id);
    const user = await c.env.DB.prepare(
        `SELECT user_email, password FROM users WHERE id = ?`
    ).bind(user_id).first<{ user_email: string, password: string | null }>();
    return c.json({
        user_email: user?.user_email,
        // 用 OAuth2 注册、没有设置过密码的账号不用输密码
        password_required: !!user?.password,
        personal_addresses: rows.filter((row) => row.is_permanent),
        other_addresses: rows.filter((row) => !row.is_permanent),
    });
};

// 删除地址及其邮件、发件、自动回复、发信额度和绑定关系（注销账号时使用，不受 ENABLE_USER_DELETE_EMAIL 限制）
const deleteAddressCompletely = async (
    c: Context<HonoCustomType>,
    address: { id: number, name: string },
): Promise<void> => {
    await unbindTelegramByAddress(c, address.name);
    await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM raw_mails WHERE address = ?`).bind(address.name),
        c.env.DB.prepare(`DELETE FROM sendbox WHERE address = ?`).bind(address.name),
        c.env.DB.prepare(`DELETE FROM auto_reply_mails WHERE address = ?`).bind(address.name),
        c.env.DB.prepare(`DELETE FROM address_sender WHERE address = ?`).bind(address.name),
        c.env.DB.prepare(`DELETE FROM users_address WHERE address_id = ?`).bind(address.id),
        c.env.DB.prepare(`DELETE FROM address WHERE id = ?`).bind(address.id),
    ]);
};

type PersonalAddressAction = {
    address_id?: unknown,
    action?: unknown,
    target_user_email?: unknown,
};

/**
 * 注销账号：
 * - 必须输入账号邮箱确认；设置过密码的账号还要输入密码（失败计入登录锁定）；
 * - 每个个人邮箱都要指定删除（delete）或转移（transfer + target_user_email）；
 * - 其他已绑定地址连同邮件一起删除；最后删除账号、角色和通行密钥。
 */
const deleteAccount = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { user_id } = c.get('userPayload');
    const body = await c.req.json<{
        confirm_email?: unknown, password?: unknown, personal_addresses?: PersonalAddressAction[],
    }>();
    const user = await c.env.DB.prepare(
        `SELECT id, user_email, password FROM users WHERE id = ?`
    ).bind(user_id).first<{ id: number, user_email: string, password: string | null }>();
    if (!user) return c.text(msgs.UserNotFoundMsg, 400);
    if (typeof body.confirm_email !== 'string'
        || body.confirm_email.trim().toLowerCase() !== user.user_email.toLowerCase()
    ) {
        return c.text(msgs.DeleteAccountConfirmMismatchMsg, 400);
    }
    if (user.password) {
        const guardKey = authGuardKey('login', c.req.raw.headers.get('cf-connecting-ip'), user.user_email);
        if (await isAuthLocked(c.env.KV, guardKey)) return c.text(msgs.TooManyAttemptsMsg, 429);
        const { ok } = await verifyUserPassword(
            typeof body.password === 'string' ? body.password : '',
            user.password,
            resolvePbkdf2Iterations(c.env.PASSWORD_PBKDF2_ITERATIONS),
        );
        if (!ok) {
            const locked = await recordAuthFailure(c.env.KV, guardKey);
            return locked ? c.text(msgs.TooManyAttemptsMsg, 429) : c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        await clearAuthFailures(c.env.KV, guardKey);
    }
    const rows = await listBoundAddresses(c, user_id);
    const personal = rows.filter((row) => row.is_permanent);
    const actions = new Map<number, PersonalAddressAction>();
    for (const item of Array.isArray(body.personal_addresses) ? body.personal_addresses : []) {
        const id = Number(item?.address_id);
        if (Number.isSafeInteger(id)) actions.set(id, item);
    }
    // 每个个人邮箱都必须明确选择，避免误删
    const missing = personal.filter((row) => {
        const action = actions.get(row.id)?.action;
        if (action === 'delete') return false;
        if (action === 'transfer') return typeof actions.get(row.id)?.target_user_email !== 'string';
        return true;
    });
    if (missing.length > 0) {
        return c.json({
            error: msgs.DeleteAccountPersonalAddressActionRequiredMsg,
            personal_addresses: missing.map((row) => ({ id: row.id, name: row.name })),
        }, 400);
    }
    // 先检查转移对象都存在，减少中途失败；额度在转移时检查
    for (const row of personal) {
        const action = actions.get(row.id)!;
        if (action.action !== 'transfer') continue;
        const target = await c.env.DB.prepare(
            `SELECT id FROM users WHERE user_email = ?`
        ).bind(action.target_user_email).first<number>('id');
        if (!target || target === user.id) {
            return c.json({ error: `${row.name}: ${msgs.TargetUserNotFoundMsg}`, address_id: row.id }, 400);
        }
    }
    // 先转移（可能因为对方额度不足失败），全部成功后再删除
    for (const row of personal) {
        const action = actions.get(row.id)!;
        if (action.action !== 'transfer') continue;
        const result = await transferAddressToUser(c, user_id, row.id, action.target_user_email);
        if (!result.ok) {
            return c.json({ error: `${row.name}: ${result.message}`, address_id: row.id }, result.status);
        }
    }
    for (const row of rows) {
        const action = actions.get(row.id);
        if (row.is_permanent && action?.action === 'transfer') continue;
        await deleteAddressCompletely(c, row);
    }
    await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM users_address WHERE user_id = ?`).bind(user_id),
        c.env.DB.prepare(`DELETE FROM user_roles WHERE user_id = ?`).bind(user_id),
        c.env.DB.prepare(`DELETE FROM user_passkeys WHERE user_id = ?`).bind(user_id),
        c.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(user_id),
    ]);
    return c.json({ success: true });
};

export default {
    resetCredential,
    setCredentialLogin,
    unreadCounts,
    updateMailReadStatus,
    deleteAccountPreview,
    deleteAccount,
};
