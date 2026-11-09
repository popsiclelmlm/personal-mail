import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt';

import { isIssuedToAccount, isVersionCurrent, normalizeVersion, USER_TOKEN_TTL_SECONDS } from '../auth_version';

/** 校验凭证要用到的账号信息 */
export type UserAccountState = {
    token_version: number,
    user_email: string | null,
    created_at: string | null,
};

/** 账号当前的令牌版本、邮箱和创建时间；用户不存在时返回 null */
export const getUserAccountState = async (
    c: Context<HonoCustomType>,
    userId: number | string,
): Promise<UserAccountState | null> => {
    type Row = { token_version?: number | null, user_email: string | null, created_at: string | null };
    try {
        const row = await c.env.DB.prepare(
            `SELECT token_version, user_email, created_at FROM users WHERE id = ?`
        ).bind(userId).first<Row>();
        if (!row) return null;
        return {
            token_version: row.token_version ?? 0,
            user_email: row.user_email ?? null,
            created_at: row.created_at ?? null,
        };
    } catch (e) {
        // 数据库还没迁移（缺 token_version 列）时按版本 0 处理，避免所有人都无法登录
        if (!(e as Error).message?.includes('token_version')) throw e;
        console.warn('[user_token] users.token_version is missing, run the database migration');
        const row = await c.env.DB.prepare(
            `SELECT user_email, created_at FROM users WHERE id = ?`
        ).bind(userId).first<Row>();
        return row ? { token_version: 0, user_email: row.user_email ?? null, created_at: row.created_at ?? null } : null;
    }
};

/** 用户当前的令牌版本；用户不存在时返回 null */
export const getUserTokenVersion = async (
    c: Context<HonoCustomType>,
    userId: number | string,
): Promise<number | null> => (await getUserAccountState(c, userId))?.token_version ?? null;

/** 签发用户令牌（x-user-token），带上当前的令牌版本 tv */
export const signUserToken = async (
    c: Context<HonoCustomType>,
    user: { user_id: number, user_email: string },
    tokenVersion?: number | null,
): Promise<string> => {
    const tv = tokenVersion ?? (await getUserTokenVersion(c, user.user_id)) ?? 0;
    const now = Math.floor(Date.now() / 1000);
    return await Jwt.sign({
        user_email: user.user_email,
        user_id: user.user_id,
        tv,
        exp: now + USER_TOKEN_TTL_SECONDS,
        iat: now,
    }, c.env.JWT_SECRET, 'HS256');
};

/** 角色令牌（x-user-access-token）有效期 1 小时 */
export const USER_ROLE_TOKEN_TTL_SECONDS = 60 * 60;

/** 签发角色令牌，带上账号当前的令牌版本 tv（退出所有设备、重设密码后随之失效） */
export const signUserRoleToken = async (
    c: Context<HonoCustomType>,
    user: { user_id: number, user_email: string, tv?: unknown },
    role: string,
): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return await Jwt.sign({
        user_email: user.user_email,
        user_id: user.user_id,
        user_role: role,
        tv: Math.max(normalizeVersion(user.tv), 0),
        iat: now,
        exp: now + USER_ROLE_TOKEN_TTL_SECONDS,
    }, c.env.JWT_SECRET, 'HS256');
};

/** 令牌对应的用户仍然存在、仍是签发时的那个账号（编号可能被新账号复用），且令牌版本等于当前版本 */
export const isUserTokenCurrent = async (
    c: Context<HonoCustomType>,
    payload: Record<string, unknown>,
): Promise<boolean> => {
    const userId = payload.user_id;
    if (typeof userId !== 'number' && typeof userId !== 'string') return false;
    const account = await getUserAccountState(c, userId);
    if (!account) return false;
    if (!isIssuedToAccount({
        tokenEmail: payload.user_email ?? null,
        tokenIssuedAt: payload.iat,
        accountEmail: account.user_email,
        accountCreatedAt: account.created_at,
    })) return false;
    return isVersionCurrent(payload.tv, account.token_version);
};

/**
 * 角色令牌是否仍然有效：账号仍是签发时的那个账号、令牌版本没变，
 * 并且账号「现在」的角色仍是令牌里的角色（撤销或更换角色后立即失效，不用等 1 小时过期）。
 */
export const isUserRoleTokenCurrent = async (
    c: Context<HonoCustomType>,
    payload: Record<string, unknown>,
): Promise<boolean> => {
    if (typeof payload.user_role !== 'string' || !payload.user_role) return false;
    if (!await isUserTokenCurrent(c, payload)) return false;
    const currentRole = await c.env.DB.prepare(
        `SELECT role_text FROM user_roles WHERE user_id = ?`
    ).bind(payload.user_id).first<string | null>('role_text');
    return currentRole === payload.user_role;
};

/** 令牌版本加 1，让这个用户的所有旧令牌失效 */
export const bumpUserTokenVersion = async (
    c: Context<HonoCustomType>,
    userId: number | string,
): Promise<void> => {
    await c.env.DB.prepare(
        `UPDATE users SET token_version = COALESCE(token_version, 0) + 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(userId).run();
};
