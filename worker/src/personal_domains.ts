// 个人邮箱专用域名（PERSONAL_MAIL_DOMAINS）的纯函数，便于单元测试。
// 这些域名不出现在临时邮箱的可选域名里，只能由登录用户直接创建为个人邮箱。

const normalize = (domain: string | undefined | null): string =>
    typeof domain === 'string' ? domain.trim().toLowerCase() : '';

/** domain 是否属于个人邮箱专用域名（含它们的子域名） */
export const isPersonalMailDomain = (
    domain: string | undefined | null,
    personalDomains: string[],
): boolean => {
    const target = normalize(domain);
    if (!target) return false;
    return personalDomains.some((item) => {
        const base = normalize(item);
        return !!base && (target === base || target.endsWith(`.${base}`));
    });
};

/** 地址（name@domain）是否在个人邮箱专用域名下 */
export const isPersonalMailAddress = (
    address: string | undefined | null,
    personalDomains: string[],
): boolean => {
    const value = normalize(address);
    const at = value.lastIndexOf('@');
    if (at < 0) return false;
    return isPersonalMailDomain(value.slice(at + 1), personalDomains);
};

/**
 * 计算建地址时可选的域名：
 * - 临时邮箱：去掉个人邮箱专用域名；
 * - 个人邮箱：只保留个人邮箱专用域名。
 */
export const selectCreatableDomains = (
    allowDomains: string[],
    personalDomains: string[],
    personalMailbox: boolean,
): string[] => {
    if (personalMailbox) {
        return personalDomains.map(normalize).filter(Boolean);
    }
    if (personalDomains.length === 0) return allowDomains;
    return allowDomains.filter((domain) => !isPersonalMailDomain(domain, personalDomains));
};
