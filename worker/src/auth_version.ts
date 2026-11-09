// 凭证版本号：用户令牌里的 tv 对应 users.token_version，邮箱凭证里的 cv 对应 address.credential_version。
// 版本号加 1 即让旧凭证全部失效；老凭证没有版本字段，按 0 处理，升级后已登录的用户不会被立即踢出。
// 本文件不引入其他模块，便于在 Node 里直接做单元测试。

/** 把版本号规范成非负整数；无效值返回 -1（永远不会和数据库里的版本相等） */
export const normalizeVersion = (value: unknown): number => {
    if (value === undefined || value === null) return 0;
    const version = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(version) && version >= 0 ? version : -1;
};

/** 凭证里的版本是否等于当前版本 */
export const isVersionCurrent = (tokenVersion: unknown, currentVersion: unknown): boolean => {
    const token = normalizeVersion(tokenVersion);
    return token >= 0 && token === normalizeVersion(currentVersion);
};

// users.id 不是 AUTOINCREMENT：删掉编号最大的账号后，新账号会复用这个编号。
// 所以只比对编号和版本不够，还要确认凭证是签给「当前这个」账号的。
// D1 的 CURRENT_TIMESTAMP 和 Worker 的时钟可能差一点，比较创建时间时留 2 分钟余量。
export const ACCOUNT_CREATED_AT_SKEW_SECONDS = 120;

/** 把数据库时间（D1 的 'YYYY-MM-DD HH:MM:SS'，UTC）转成秒级时间戳；无效时返回 null */
export const parseDbTimestampSeconds = (value: unknown): number | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const text = value.trim();
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/**
 * 凭证是否签给当前这个账号：
 * - tokenEmail 不是 undefined 时（用户令牌、角色令牌），必须和账号邮箱完全一致；
 * - 带签发时间时，签发时间不能早于账号创建时间（留 ACCOUNT_CREATED_AT_SKEW_SECONDS 余量）。
 */
export const isIssuedToAccount = ({
    tokenEmail, tokenIssuedAt, accountEmail, accountCreatedAt,
}: {
    tokenEmail?: unknown,
    tokenIssuedAt?: unknown,
    accountEmail: unknown,
    accountCreatedAt: unknown,
}): boolean => {
    if (tokenEmail !== undefined) {
        if (typeof tokenEmail !== 'string' || typeof accountEmail !== 'string') return false;
        if (!tokenEmail || tokenEmail !== accountEmail) return false;
    }
    const createdAt = parseDbTimestampSeconds(accountCreatedAt);
    if (createdAt !== null && tokenIssuedAt !== undefined && tokenIssuedAt !== null) {
        const issuedAt = typeof tokenIssuedAt === 'number' ? tokenIssuedAt : Number(tokenIssuedAt);
        if (!Number.isFinite(issuedAt)) return false;
        if (issuedAt < createdAt - ACCOUNT_CREATED_AT_SKEW_SECONDS) return false;
    }
    return true;
};

// 用户令牌有效期 7 天；剩余不足 4 天时，/user_api/settings 换发新令牌（滑动续期）
export const USER_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
export const USER_TOKEN_REFRESH_WITHIN_SECONDS = 4 * 24 * 60 * 60;

export type AddressCredentialDecision = 'ok' | 'revoked' | 'credential_login_disabled';

/**
 * 邮箱凭证是否可用：
 * - 凭证里的 cv 必须等于地址当前的 credential_version，否则已被重置（revoked）；
 * - 地址关闭了邮箱凭证登录时，只接受通过账号取得、且账号会话仍然有效的凭证。
 */
export const decideAddressCredential = ({
    tokenVersion, currentVersion, credentialLoginDisabled, accountSessionValid,
}: {
    tokenVersion: unknown,
    currentVersion: unknown,
    credentialLoginDisabled: boolean,
    accountSessionValid: boolean,
}): AddressCredentialDecision => {
    if (!isVersionCurrent(tokenVersion, currentVersion)) return 'revoked';
    if (credentialLoginDisabled && !accountSessionValid) return 'credential_login_disabled';
    return 'ok';
};
