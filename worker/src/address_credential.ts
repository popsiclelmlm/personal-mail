import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt';

import { isVersionCurrent } from './auth_version';
import { getUserTokenVersion } from './user_api/user_token';

export type AddressCredentialState = {
    id: number,
    credential_version: number,
    credential_login_disabled: number,
};

const isMissingColumnError = (e: unknown): boolean => (
    /credential_version|credential_login_disabled/.test((e as Error)?.message || '')
);

/** 地址的凭证状态；地址不存在（或名字对不上）时返回 null */
export const getAddressCredentialState = async (
    c: Context<HonoCustomType>,
    addressId: number,
    name: string,
): Promise<AddressCredentialState | null> => {
    try {
        const row = await c.env.DB.prepare(
            `SELECT id, credential_version, credential_login_disabled FROM address WHERE id = ? AND name = ?`
        ).bind(addressId, name).first<AddressCredentialState>();
        if (!row) return null;
        return {
            id: row.id,
            credential_version: row.credential_version ?? 0,
            credential_login_disabled: row.credential_login_disabled ?? 0,
        };
    } catch (e) {
        // 数据库还没迁移时按版本 0、允许凭证登录处理，保持上游行为
        if (!isMissingColumnError(e)) throw e;
        console.warn('[address_credential] credential columns are missing, run the database migration');
        const id = await c.env.DB.prepare(
            `SELECT id FROM address WHERE id = ? AND name = ?`
        ).bind(addressId, name).first<number>('id');
        return id ? { id, credential_version: 0, credential_login_disabled: 0 } : null;
    }
};

const getCredentialVersion = async (
    c: Context<HonoCustomType>,
    addressId: number,
): Promise<number> => {
    try {
        const version = await c.env.DB.prepare(
            `SELECT credential_version FROM address WHERE id = ?`
        ).bind(addressId).first<number | null>('credential_version');
        return version ?? 0;
    } catch (e) {
        if (!isMissingColumnError(e)) throw e;
        return 0;
    }
};

/**
 * 签发邮箱凭证，带上地址当前的凭证版本 cv。
 * userId：通过账号取得的凭证再带上 uid 和用户令牌版本 utv，地址关闭了邮箱凭证登录时靠它放行。
 * type：特殊用途的凭证（例如 telegram_binding）。
 */
export const signAddressJwt = async (
    c: Context<HonoCustomType>,
    { address, address_id }: { address: string, address_id: number | string },
    options: { userId?: number | string | null, type?: string } = {},
): Promise<string> => {
    const addressId = Number(address_id);
    const payload: Record<string, unknown> = {
        address,
        address_id: addressId,
        cv: await getCredentialVersion(c, addressId),
    };
    if (options.type) payload.type = options.type;
    if (options.userId !== undefined && options.userId !== null) {
        payload.uid = Number(options.userId);
        payload.utv = (await getUserTokenVersion(c, options.userId)) ?? 0;
    }
    return await Jwt.sign(payload, c.env.JWT_SECRET, 'HS256');
};

/** 凭证是通过账号取得的，并且账号仍然绑定这个地址、账号会话没有被吊销 */
export const isAccountIssuedCredentialValid = async (
    c: Context<HonoCustomType>,
    payload: Record<string, unknown>,
    addressId: number,
): Promise<boolean> => {
    const uid = payload.uid;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0) return false;
    const bound = await c.env.DB.prepare(
        `SELECT 1 AS bound FROM users_address WHERE user_id = ? AND address_id = ?`
    ).bind(uid, addressId).first('bound');
    if (!bound) return false;
    const currentUserVersion = await getUserTokenVersion(c, uid);
    if (currentUserVersion === null) return false;
    return isVersionCurrent(payload.utv, currentUserVersion);
};
