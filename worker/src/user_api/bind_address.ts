import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt'

import { isAddressCountLimitReached } from "../utils"
import { unbindTelegramByAddress } from '../telegram_api/common';
import i18n from '../i18n';
import { updateAddressUpdatedAt, commonGetUserRole, handleListQuery, hideObjectFields } from '../common';
import { isRetentionType } from '../retention';
import { signAddressJwt } from '../address_credential';

export const getBindedAddressById = async (
    c: Context<HonoCustomType>,
    user_id: number | string,
    address_id: number | string
): Promise<string | null> => {
    if (!user_id || !address_id) {
        return null;
    }
    const address = await c.env.DB.prepare(
        `SELECT a.name FROM users_address ua`
        + ` JOIN address a ON a.id = ua.address_id`
        + ` WHERE ua.user_id = ? AND ua.address_id = ?`
    ).bind(user_id, address_id).first<string>('name');
    return address ?? null;
}

/**
 * 个人邮箱默认可以发信：按角色配置的 personal_send_balance 初始化发信额度。
 * 已有发信记录时只把额度补到不低于角色配置，并重新启用。
 */
const grantPersonalSendBalance = async (
    c: Context<HonoCustomType>,
    user_id: number | string,
    address: string,
): Promise<void> => {
    const userRole = await commonGetUserRole(c, Number(user_id));
    const balance = Number(userRole?.personal_send_balance ?? 0);
    if (!Number.isSafeInteger(balance) || balance <= 0) return;
    await c.env.DB.prepare(
        `INSERT INTO address_sender (address, balance, enabled) VALUES (?, ?, 1)`
        + ` ON CONFLICT(address) DO UPDATE SET`
        + ` balance = MAX(COALESCE(address_sender.balance, 0), excluded.balance), enabled = 1`
    ).bind(address, balance).run();
}

type TransferResult = { ok: true } | { ok: false, status: 400 | 500, message: string };

/**
 * 把绑定在 user_id 名下的地址转给另一个用户。
 * 地址会以新的 id 重建（旧的邮箱凭证随之失效），保留期、永久标记和「禁止邮箱凭证登录」原样保留；
 * 永久邮箱要占用对方的永久邮箱额度。
 */
export const transferAddressToUser = async (
    c: Context<HonoCustomType>,
    user_id: number | string,
    address_id: number | string,
    target_user_email: unknown,
): Promise<TransferResult> => {
    const msgs = i18n.getMessagesbyContext(c);
    const fail = (status: 400 | 500, message: string): TransferResult => ({ ok: false, status, message });
    // check if address exists
    const addressRow = await c.env.DB.prepare(
        `SELECT name, retention_type, retention_until, is_permanent, credential_login_disabled`
        + ` FROM address where id = ?`
    ).bind(address_id).first<{
        name: string, retention_type: string | null, retention_until: string | null,
        is_permanent: number | null, credential_login_disabled: number | null,
    }>();
    if (!addressRow) return fail(400, msgs.AddressNotFoundMsg);
    const address = addressRow.name;
    // check if user exists
    const db_user_id = await c.env.DB.prepare(
        `SELECT id FROM users where id = ?`
    ).bind(user_id).first("id");
    if (!db_user_id) return fail(400, msgs.UserNotFoundMsg);
    // check if target user exists
    if (typeof target_user_email !== 'string' || !target_user_email) return fail(400, msgs.TargetUserNotFoundMsg);
    const target_user_id = await c.env.DB.prepare(
        `SELECT id FROM users where user_email = ?`
    ).bind(target_user_email).first<number>("id");
    if (!target_user_id) return fail(400, msgs.TargetUserNotFoundMsg);
    if (String(target_user_id) === String(user_id)) return fail(400, msgs.TargetUserNotFoundMsg);
    // check target user binded address count
    const userRoleObj = await commonGetUserRole(c, target_user_id);
    if (await isAddressCountLimitReached(c, target_user_id, userRoleObj?.role)) {
        return fail(400, msgs.MaxAddressCountReachedMsg);
    }
    // 永久邮箱要占用对方的永久邮箱额度
    if (addressRow.is_permanent) {
        const { count } = await c.env.DB.prepare(
            `SELECT COUNT(*) AS count FROM address a JOIN users_address ua ON ua.address_id = a.id`
            + ` WHERE ua.user_id = ? AND a.is_permanent = 1`
        ).bind(target_user_id).first<{ count: number }>() || { count: 0 };
        if (count >= (userRoleObj?.max_permanent_address_count ?? 0)) {
            return fail(400, msgs.PermanentQuotaExceededMsg);
        }
    }
    // check if binded
    const db_user_address_id = await c.env.DB.prepare(
        `SELECT user_id FROM users_address where user_id = ? and address_id = ?`
    ).bind(user_id, address_id).first("user_id");
    if (!db_user_address_id) return fail(400, msgs.AddressNotBindedMsg);
    // unbind telegram address
    await unbindTelegramByAddress(c, address);
    // unbind user address
    try {
        const { success } = await c.env.DB.prepare(
            `DELETE FROM users_address where user_id = ? and address_id = ?`
        ).bind(user_id, address_id).run();
        if (!success) return fail(500, msgs.OperationFailedMsg);
    } catch (e) {
        return fail(500, msgs.OperationFailedMsg);
    }
    // delete address
    await c.env.DB.prepare(
        `DELETE FROM address WHERE id = ? `
    ).bind(address_id).run();
    // new address：保留保留期和凭证登录开关，凭证版本从 0 开始（新 id 已让旧凭证失效）
    const { success: newAddressSuccess } = await c.env.DB.prepare(
        `INSERT INTO address(name, retention_type, retention_until, is_permanent, credential_login_disabled)`
        + ` VALUES(?, ?, ?, ?, ?)`
    ).bind(
        address,
        addressRow.retention_type ?? 'temporary',
        addressRow.retention_until,
        addressRow.is_permanent ?? 0,
        addressRow.credential_login_disabled ?? 0,
    ).run();
    if (!newAddressSuccess) {
        throw new Error(msgs.FailedCreateAddressMsg)
    }
    await updateAddressUpdatedAt(c, address);
    // find new address id
    const new_address_id = await c.env.DB.prepare(
        `SELECT id FROM address WHERE name = ?`
    ).bind(address).first<number | null | undefined>("id");
    if (!new_address_id) {
        throw new Error(msgs.OperationFailedMsg)
    }
    // bind
    try {
        const { success } = await c.env.DB.prepare(
            `INSERT INTO users_address (user_id, address_id) VALUES (?, ?)`
        ).bind(target_user_id, new_address_id).run();
        if (!success) return fail(500, msgs.OperationFailedMsg);
    } catch (e) {
        const error = e as Error;
        if (error.message && error.message.includes("UNIQUE")) {
            return fail(400, msgs.AddressAlreadyBindedMsg);
        }
        return fail(500, msgs.OperationFailedMsg);
    }
    return { ok: true };
}

const UserBindAddressModule = {
    bind: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address_id } = c.get("jwtPayload");
        return await UserBindAddressModule.bindByID(c, user_id, address_id)
    },
    bindByID: async (
        c: Context<HonoCustomType>,
        user_id: number | string, address_id: number | string
    ) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!address_id || !user_id) {
            return c.text(msgs.NoAddressOrUserTokenMsg, 400)
        }
        // check if address exists
        const db_address_id = await c.env.DB.prepare(
            `SELECT id FROM address where id = ?`
        ).bind(address_id).first("id");
        if (!db_address_id) {
            return c.text(msgs.AddressNotFoundMsg, 400)
        }
        // check if user exists
        const db_user_id = await c.env.DB.prepare(
            `SELECT id FROM users where id = ?`
        ).bind(user_id).first("id");
        if (!db_user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        // check if binded
        const db_user_address_id = await c.env.DB.prepare(
            `SELECT user_id FROM users_address where user_id = ? and address_id = ?`
        ).bind(user_id, address_id).first("user_id");
        if (db_user_address_id) return c.json({ success: true })
        // check if binded address count
        const userRole = c.get("userRolePayload");
        if (await isAddressCountLimitReached(c, user_id, userRole)) {
            return c.text(msgs.MaxAddressCountReachedMsg, 400)
        }
        // bind
        try {
            const { success } = await c.env.DB.prepare(
                `INSERT INTO users_address (user_id, address_id) VALUES (?, ?)`
            ).bind(user_id, address_id).run();
            if (!success) {
                return c.text(msgs.OperationFailedMsg, 500)
            }
        } catch (e) {
            const error = e as Error;
            if (error.message && error.message.includes("UNIQUE")) {
                return c.text(msgs.AddressAlreadyBindedMsg, 400)
            }
            return c.text(msgs.OperationFailedMsg, 500)
        }
        return c.json({ success: true })
    },
    unbind: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get("userPayload");
        const { address_id } = await c.req.json();
        if (!address_id || !user_id) {
            return c.text(msgs.InvalidAddressOrUserTokenMsg, 400)
        }
        // check if address exists
        const db_address_id = await c.env.DB.prepare(
            `SELECT id FROM address where id = ?`
        ).bind(address_id).first("id");
        if (!db_address_id) {
            return c.text(msgs.AddressNotFoundMsg, 400)
        }
        // check if user exists
        const db_user_id = await c.env.DB.prepare(
            `SELECT id FROM users where id = ?`
        ).bind(user_id).first("id");
        if (!db_user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        // unbind
        try {
            const { success } = await c.env.DB.prepare(
                `DELETE FROM users_address where user_id = ? and address_id = ?`
            ).bind(user_id, address_id).run();
            if (!success) {
                return c.text(msgs.OperationFailedMsg, 500)
            }
        } catch (e) {
            return c.text(msgs.OperationFailedMsg, 500)
        }
        return c.json({ success: true })
    },
    getBindedAddresses: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { limit, offset, query } = c.req.query();
        const params = [String(user_id)];
        const addressQuery = query?.trim();
        if (addressQuery && (addressQuery.length > 100 || /[%_]/.test(addressQuery))) {
            return c.text(i18n.getMessagesbyContext(c).InvalidInputMsg, 400);
        }
        if (addressQuery) {
            params.push(addressQuery);
        }
        const fromQuery = ` FROM address a`
            + ` JOIN users_address ua ON ua.address_id = a.id`
            + ` WHERE ua.user_id = ?`
            + (addressQuery ? ` AND instr(lower(a.name), lower(?)) > 0` : ``);
        return await handleListQuery(
            c,
            `SELECT a.*,`
                + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
                + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
                + fromQuery,
            `SELECT COUNT(*) AS count${fromQuery}`,
            params,
            limit ?? 20,
            offset ?? 0,
            'a.id DESC',
            ['password'],
        );
    },
    getBindedAddressesById: async (
        c: Context<HonoCustomType>, user_id: number | string
    ): Promise<{
        id: number;
        name: string;
        mail_count: number;
        send_count: number;
        created_at: string;
        updated_at: string;
    }[]> => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!user_id) {
            throw new Error(msgs.UserNotFoundMsg);
        }
        // select binded address
        const { results } = await c.env.DB.prepare(
            `SELECT a.*,`
            + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
            + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
            + ` FROM address a `
            + ` JOIN users_address ua `
            + ` ON ua.address_id = a.id `
            + ` WHERE ua.user_id = ?`
            + ` ORDER BY a.id DESC`
        ).bind(user_id).all<{
            id: number;
            name: string;
            mail_count: number;
            send_count: number;
            created_at: string;
            updated_at: string;
        }>();
        return (results || []).map((row) => hideObjectFields(row, ['password']));
    },
    getBindedAddressJwt: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { address_id } = c.req.param();
        // check binded
        const { user_id } = c.get("userPayload");
        if (!address_id || !user_id) {
            return c.text(msgs.InvalidAddressOrUserTokenMsg, 400)
        }
        const name = await getBindedAddressById(c, user_id, address_id);
        if (!name) {
            return c.text(msgs.AddressNotBindedMsg, 400)
        }
        // 通过账号取得的凭证带 uid 和 utv：地址关闭了邮箱凭证登录时也能用，账号退出所有设备后失效
        const jwt = await signAddressJwt(c, { address: name, address_id }, { userId: user_id });
        return c.json({
            jwt: jwt
        })
    },
    transferAddress: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address_id, target_user_email } = await c.req.json();
        const result = await transferAddressToUser(c, user_id, address_id, target_user_email);
        if (!result.ok) return c.text(result.message, result.status);
        return c.json({ success: true })
    },
    // 修改已绑定地址的保留类型：temporary（1 天后可被清理）、extended（保留 30 天）、permanent（永久）
    updateRetention: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get("userPayload");
        const { address_id, retention_type } = await c.req.json();
        if (!address_id || !user_id || !retention_type) {
            return c.text(msgs.RequiredFieldMsg, 400);
        }
        if (!isRetentionType(retention_type)) {
            return c.text(msgs.InvalidRetentionTypeMsg, 400);
        }
        // 只能修改绑定在自己名下的地址
        const address = await getBindedAddressById(c, user_id, address_id);
        if (!address) {
            return c.text(msgs.AddressNotBindedMsg, 400);
        }
        if (retention_type === 'permanent') {
            const isPermanent = await c.env.DB.prepare(
                `SELECT is_permanent FROM address WHERE id = ?`
            ).bind(address_id).first<number>("is_permanent");
            if (!isPermanent) {
                const userRole = await commonGetUserRole(c, user_id);
                const maxPermanent = userRole?.max_permanent_address_count ?? 0;
                const { count } = await c.env.DB.prepare(
                    `SELECT COUNT(*) AS count FROM address a`
                    + ` JOIN users_address ua ON ua.address_id = a.id`
                    + ` WHERE ua.user_id = ? AND a.is_permanent = 1`
                ).bind(user_id).first<{ count: number }>() || { count: 0 };
                if (maxPermanent <= 0 || count >= maxPermanent) {
                    return c.text(msgs.PermanentQuotaExceededMsg, 400);
                }
            }
            // 升级为个人邮箱时默认关闭邮箱凭证登录（之后只能通过账号访问，可在地址管理里打开）；
            // 已经是永久邮箱的再次提交不改动这个开关
            await c.env.DB.prepare(
                `UPDATE address SET retention_type = 'permanent',`
                + ` credential_login_disabled = CASE WHEN COALESCE(is_permanent, 0) = 1`
                + ` THEN COALESCE(credential_login_disabled, 0) ELSE 1 END,`
                + ` is_permanent = 1, retention_until = NULL, updated_at = datetime('now') WHERE id = ?`
            ).bind(address_id).run();
            if (!isPermanent) {
                await grantPersonalSendBalance(c, user_id, address);
            }
        } else if (retention_type === 'extended') {
            await c.env.DB.prepare(
                `UPDATE address SET retention_type = 'extended', is_permanent = 0,`
                + ` retention_until = datetime('now', '+30 day'), updated_at = datetime('now') WHERE id = ?`
            ).bind(address_id).run();
        } else {
            // 改回临时时留 1 天缓冲，避免立刻被清理
            await c.env.DB.prepare(
                `UPDATE address SET retention_type = 'temporary', is_permanent = 0,`
                + ` retention_until = datetime('now', '+1 day'), updated_at = datetime('now') WHERE id = ?`
            ).bind(address_id).run();
        }
        return c.json({ success: true });
    }
}

export default UserBindAddressModule;
