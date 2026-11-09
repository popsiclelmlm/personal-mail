// 辅助邮箱（找回密码用）的校验，纯函数，便于单元测试

export type RecoveryEmailResult =
    | { ok: true, email: string | null }
    | { ok: false, reason: 'invalid' | 'own_domain' };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 规范化辅助邮箱：空值表示不设置；格式要像邮箱，长度不超过 254；
 * 不能用本站的域名（个人邮箱和临时邮箱都在本站，找回密码时可能根本打不开）。
 */
export const normalizeRecoveryEmail = (
    value: unknown,
    systemDomains: string[],
): RecoveryEmailResult => {
    if (value === undefined || value === null) return { ok: true, email: null };
    if (typeof value !== 'string') return { ok: false, reason: 'invalid' };
    const email = value.trim().toLowerCase();
    if (!email) return { ok: true, email: null };
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return { ok: false, reason: 'invalid' };
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const ownDomain = systemDomains.some((item) => {
        const base = item.trim().toLowerCase();
        return !!base && (domain === base || domain.endsWith(`.${base}`));
    });
    if (ownDomain) return { ok: false, reason: 'own_domain' };
    return { ok: true, email };
};
