import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt';

import { isVersionCurrent, USER_TOKEN_TTL_SECONDS } from '../auth_version';

/** 用户当前的令牌版本；用户不存在时返回 null */
export const getUserTokenVersion = async (
    c: Context<HonoCustomType>,
    userId: number | string,
): Promise<number | null> => {
    try {
        const row = await c.env.DB.prepare(
            `SELECT token_version FROM users WHERE id = ?`
        ).bind(userId).first<{ token_version: number | null }>();
        if (!row) return null;
        return row.token_version ?? 0;
    } catch (e) {
        // 数据库还没迁移（缺 token_version 列）时按版本 0 处理，避免所有人都无法登录
        if (!(e as Error).message?.includes('token_version')) throw e;
        console.warn('[user_token] users.token_version is missing, run the database migration');
        const id = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first('id');
        return id ? 0 : null;
    }
};

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

/** 令牌对应的用户仍然存在，且令牌版本等于当前版本 */
export const isUserTokenCurrent = async (
    c: Context<HonoCustomType>,
    payload: Record<string, unknown>,
): Promise<boolean> => {
    const userId = payload.user_id;
    if (typeof userId !== 'number' && typeof userId !== 'string') return false;
    const current = await getUserTokenVersion(c, userId);
    if (current === null) return false;
    return isVersionCurrent(payload.tv, current);
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
