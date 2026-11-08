// 登录和验证码的失败锁定：按「IP + 邮箱」计数，连续失败 5 次锁定 15 分钟
// 计数存在 KV 里（KV 是最终一致的，计数是近似值，足够挡住暴力尝试）；没有 KV 时不锁定。
// 本文件不引入其他模块，便于在 Node 里直接做单元测试（e2e/unit/tests/auth-guard.test.mjs）。

export const AUTH_GUARD_MAX_FAILURES = 5;
export const AUTH_GUARD_LOCK_SECONDS = 15 * 60;

export type AuthGuardScope = 'login' | 'verify_code';

type GuardKV = Pick<KVNamespace, 'get' | 'put' | 'delete'>;

type GuardState = {
    count: number,
    // 毫秒时间戳；0 表示没有锁定
    lockedUntil: number,
};

export const authGuardKey = (scope: AuthGuardScope, ip: string | null | undefined, email: string): string => (
    `auth-guard:${scope}:${ip || 'unknown'}:${email.trim().toLowerCase()}`
);

const readState = async (kv: GuardKV, key: string): Promise<GuardState> => {
    const value = await kv.get(key);
    if (!value) return { count: 0, lockedUntil: 0 };
    try {
        const parsed = JSON.parse(value) as Partial<GuardState>;
        return {
            count: Number(parsed.count) || 0,
            lockedUntil: Number(parsed.lockedUntil) || 0,
        };
    } catch {
        return { count: 0, lockedUntil: 0 };
    }
};

/** 是否处于锁定中 */
export const isAuthLocked = async (
    kv: GuardKV | undefined | null,
    key: string,
    now: number = Date.now(),
): Promise<boolean> => {
    if (!kv) return false;
    const state = await readState(kv, key);
    return state.lockedUntil > now;
};

/** 记一次失败，返回记完之后是否被锁定 */
export const recordAuthFailure = async (
    kv: GuardKV | undefined | null,
    key: string,
    now: number = Date.now(),
): Promise<boolean> => {
    if (!kv) return false;
    const state = await readState(kv, key);
    // 锁定期已过就重新计数
    const count = state.lockedUntil && state.lockedUntil <= now ? 1 : state.count + 1;
    const locked = count >= AUTH_GUARD_MAX_FAILURES;
    const next: GuardState = {
        count,
        lockedUntil: locked ? now + AUTH_GUARD_LOCK_SECONDS * 1000 : 0,
    };
    // 失败计数在最后一次失败后 15 分钟自动过期
    await kv.put(key, JSON.stringify(next), { expirationTtl: AUTH_GUARD_LOCK_SECONDS });
    return locked;
};

/** 成功后清掉计数 */
export const clearAuthFailures = async (
    kv: GuardKV | undefined | null,
    key: string,
): Promise<void> => {
    if (!kv) return;
    await kv.delete(key);
};
