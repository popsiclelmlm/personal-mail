import { Context } from "hono";
import { parseSecretList } from './secret_list';
import { ADMIN_TOKEN_VERSION_KEY, AdminHeaderResult, checkAdminAuthHeader, normalizeAdminTokenVersion } from './admin_token';
import { authGuardKey, isAuthLocked, recordAuthFailure } from './user_api/auth_guard';
import { UserSettings, RoleAddressConfig } from "./models";
import { CONSTANTS } from "./constants";

export const getJsonObjectValue = <T = any>(
    value: string | any
): T | null => {
    if (value == undefined || value == null) {
        return null;
    }
    if (typeof value === "object") {
        return value as T;
    }
    if (typeof value !== "string") {
        return null;
    }
    try {
        return JSON.parse(value) as T;
    } catch (e) {
        console.error(`GetJsonValue: Failed to parse ${value}`, e);
    }
    return null;
}

export const getJsonSetting = async <T = any>(
    c: Context<HonoCustomType>, key: string
): Promise<T | null> => {
    const value = await getSetting(c, key);
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value) as T;
    } catch (e) {
        console.error(`GetJsonSetting: Failed to parse ${key}`, e);
    }
    return null;
}

export const getSetting = async (
    c: Context<HonoCustomType>, key: string
): Promise<string | null> => {
    try {
        const value = await c.env.DB.prepare(
            `SELECT value FROM settings where key = ?`
        ).bind(key).first<string>("value");
        return value;
    } catch (error) {
        console.error(`GetSetting: Failed to get ${key}`, error);
    }
    return null;
}

export const saveSetting = async (
    c: Context<HonoCustomType>,
    key: string, value: string
) => {
    await c.env.DB.prepare(
        `INSERT or REPLACE INTO settings (key, value) VALUES (?, ?)`
        + ` ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`
    ).bind(key, value, value).run();
    return true;
}

export const deleteSetting = async (
    c: Context<HonoCustomType>,
    key: string
) => {
    await c.env.DB.prepare(
        `DELETE FROM settings WHERE key = ?`
    ).bind(key).run();
    return true;
}

export const getStringValue = (value: any): string => {
    if (typeof value === "string") {
        return value;
    }
    return "";
}

export const getSplitStringListValue = (
    value: any, demiliter: string = ","
): string[] => {
    const valueToSplit = getStringValue(value);
    return valueToSplit.split(demiliter)
        .map((item: string) => item.trim())
        .filter((item: string) => item.length > 0);
}

export const getBooleanValue = (
    value: boolean | string | any
): boolean => {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return value === "true";
    }
    return false;
}

export const getIntValue = (
    value: number | string | any,
    defaultValue: number = 0
): number => {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        try {
            return parseInt(value);
        } catch (e) {
            console.error(`Failed to parse int value: ${value}`);
        }
    }
    return defaultValue;
}

export const getStringArray = (
    value: string | string[] | undefined | null
): string[] => {
    if (!value) {
        return [];
    }
    // check if value is an array, if not use json.parse
    if (!Array.isArray(value)) {
        try {
            return JSON.parse(value);
        } catch (e) {
            console.error("Failed to parse value", e);
            return [];
        }
    }
    return value;
}

export const trimLower = (
    value: string | undefined | null
): string => {
    return getStringValue(value).trim().toLowerCase();
}

export const normalizeDomain = (
    value: string | undefined | null
): string => {
    return trimLower(value);
}

export const normalizeDomains = (domains: string[]): string[] => {
    return domains
        .map((domain) => normalizeDomain(domain))
        .filter((domain) => domain.length > 0);
}

export const getMailDomain = (
    value: string | undefined | null
): string => {
    const address = getStringValue(value).trim();
    const atIndex = address.lastIndexOf("@");
    if (atIndex < 0) {
        return "";
    }
    return normalizeDomain(address.slice(atIndex + 1));
}

export const normalizeAddressDomain = (
    value: string | undefined | null
): string => {
    const address = getStringValue(value).trim();
    const atIndex = address.lastIndexOf("@");
    if (atIndex < 0) {
        return address;
    }
    const localPart = address.slice(0, atIndex).trim();
    const domain = normalizeDomain(address.slice(atIndex + 1));
    if (!localPart || !domain) {
        return address;
    }
    return `${localPart}@${domain}`;
}

export const includesDomain = (
    domains: string[] | undefined | null,
    domain: string | undefined | null
): boolean => {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain || !domains || domains.length === 0) {
        return false;
    }
    return normalizeDomains(domains).includes(normalizedDomain);
}

export const isDomainOrSubdomain = (
    domain: string | undefined | null,
    allowDomain: string | undefined | null
): boolean => {
    const normalizedDomain = normalizeDomain(domain);
    const normalizedAllowDomain = normalizeDomain(allowDomain);
    if (!normalizedDomain || !normalizedAllowDomain) {
        return false;
    }
    return normalizedDomain === normalizedAllowDomain
        || normalizedDomain.endsWith(`.${normalizedAllowDomain}`);
}

export const getDomainMapValue = <T>(
    valueMap: Record<string, T> | undefined | null,
    domain: string | undefined | null
): T | null => {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain || !valueMap) {
        return null;
    }
    for (const [key, value] of Object.entries(valueMap)) {
        if (normalizeDomain(key) === normalizedDomain) {
            return value;
        }
    }
    return null;
}

export const getDefaultDomains = (c: Context<HonoCustomType>): string[] => {
    if (c.env.DEFAULT_DOMAINS == undefined || c.env.DEFAULT_DOMAINS == null) {
        return getDomains(c);
    }
    const domains = normalizeDomains(getStringArray(c.env.DEFAULT_DOMAINS));
    return domains.length > 0 ? domains : getDomains(c);
}

export const getDomains = (c: Context<HonoCustomType>): string[] => {
    if (!c.env.DOMAINS) {
        return [];
    }
    // check if DOMAINS is an array, if not use json.parse
    if (!Array.isArray(c.env.DOMAINS)) {
        try {
            return normalizeDomains(JSON.parse(c.env.DOMAINS));
        } catch (e) {
            console.error("Failed to parse DOMAINS", e);
            return [];
        }
    }
    return normalizeDomains(c.env.DOMAINS);
}

/** 个人邮箱专用域名（PERSONAL_MAIL_DOMAINS），只取 DOMAINS 里配置过的 */
export const getPersonalMailDomains = (c: Context<HonoCustomType>): string[] => {
    if (!c.env.PERSONAL_MAIL_DOMAINS) {
        return [];
    }
    const domains = getDomains(c);
    return normalizeDomains(getStringArray(c.env.PERSONAL_MAIL_DOMAINS))
        .filter((domain) => domains.includes(domain));
}

export const getRandomSubdomainDomains = (c: Context<HonoCustomType>): string[] => {
    if (!c.env.RANDOM_SUBDOMAIN_DOMAINS) {
        return [];
    }
    return normalizeDomains(getStringArray(c.env.RANDOM_SUBDOMAIN_DOMAINS));
}

export const getUserRoles = (c: Context<HonoCustomType>): UserRole[] => {
    if (!c.env.USER_ROLES) {
        return [];
    }
    const normalizeRoles = (roles: UserRole[]): UserRole[] => {
        return roles.map((role) => ({
            ...role,
            domains: Array.isArray(role.domains)
                ? normalizeDomains(role.domains)
                : typeof role.domains === "string"
                    ? normalizeDomains([role.domains])
                    : role.domains,
        }));
    };
    // check if USER_ROLES is an array, if not use json.parse
    if (!Array.isArray(c.env.USER_ROLES)) {
        try {
            return normalizeRoles(JSON.parse(c.env.USER_ROLES));
        } catch (e) {
            console.error("Failed to parse USER_ROLES", e);
            return [];
        }
    }
    return normalizeRoles(c.env.USER_ROLES);
}

export const getAnotherWorkerList = (c: Context<HonoCustomType>): AnotherWorker[] => {
    if (!c.env.ANOTHER_WORKER_LIST) {
        return [];
    }
    // check if ANOTHER_WORKER_LIST is an array, if not use json.parse
    if (!Array.isArray(c.env.ANOTHER_WORKER_LIST)) {
        try {
            return JSON.parse(c.env.ANOTHER_WORKER_LIST);
        } catch (e) {
            console.error("Failed to parse ANOTHER_WORKER_LIST", e);
            return [];
        }
    }
    return c.env.ANOTHER_WORKER_LIST;
}

// 支持 JSON 数组或单个密码；解析失败时不在日志里输出密码原值
export const getPasswords = (c: Context<HonoCustomType>): string[] => {
    return parseSecretList(c.env.PASSWORDS, "PASSWORDS");
}

export const getAdminPasswords = (c: Context<HonoCustomType>): string[] => {
    return parseSecretList(c.env.ADMIN_PASSWORDS, "ADMIN_PASSWORDS");
}

// 管理员登录接口和 x-admin-auth 明文密码共用同一个失败计数（按 IP），连续失败 5 次锁定 15 分钟
export const adminAuthGuardKey = (c: Context<HonoCustomType>): string => (
    authGuardKey('admin_login', c.req.raw.headers.get("cf-connecting-ip"), 'admin')
)

/** 当前的管理员令牌版本；settings 表里没有（或还没建表）时为 0 */
export const getAdminTokenVersion = async (c: Context<HonoCustomType>): Promise<number> => (
    normalizeAdminTokenVersion(await getSetting(c, ADMIN_TOKEN_VERSION_KEY))
)

/** 管理员令牌版本加 1，让所有已签发的管理员令牌失效，返回新版本 */
export const bumpAdminTokenVersion = async (c: Context<HonoCustomType>): Promise<number> => {
    const next = Math.max(await getAdminTokenVersion(c), 0) + 1;
    await saveSetting(c, ADMIN_TOKEN_VERSION_KEY, String(next));
    return next;
}

/**
 * 校验 x-admin-auth：管理员会话令牌，或（兼容脚本和旧版前端）明文管理员密码。
 * 返回 'ok' 才算管理员；'locked' 表示明文密码失败次数过多；'none' 表示没带这个请求头。
 */
export const checkAdminAuth = async (
    c: Context<HonoCustomType>
): Promise<AdminHeaderResult | 'none'> => {
    const guardKey = adminAuthGuardKey(c);
    return checkAdminAuthHeader(c.req.raw.headers.get("x-admin-auth"), {
        jwtSecret: c.env.JWT_SECRET,
        passwords: getAdminPasswords(c),
        getVersion: () => getAdminTokenVersion(c),
        guard: {
            isLocked: () => isAuthLocked(c.env.KV, guardKey),
            recordFailure: () => recordAuthFailure(c.env.KV, guardKey),
        },
    });
}

export const getEnvStringList = (value: string | string[] | undefined): string[] => {
    if (!value) {
        return [];
    }
    // check if is an array, if not use json.parse
    if (!Array.isArray(value)) {
        try {
            const res = JSON.parse(value) as string[];
            return res.filter((item) => item.length > 0);
        } catch (e) {
            console.error("Failed to parse ADMIN_PASSWORDS", e);
            return [];
        }
    }
    return value.filter((item) => item.length > 0);
}

export const isGlobalTurnstileEnabled = (c: Context<HonoCustomType>): boolean => {
    return getBooleanValue(c.env.ENABLE_GLOBAL_TURNSTILE_CHECK)
        && !!c.env.CF_TURNSTILE_SITE_KEY
        && !!c.env.CF_TURNSTILE_SECRET_KEY;
}

export const checkCfTurnstile = async (
    c: Context<HonoCustomType>, token: string | undefined | null
): Promise<void> => {
    if (!c.env.CF_TURNSTILE_SITE_KEY || !c.env.CF_TURNSTILE_SECRET_KEY) {
        return;
    }
    if (!token) {
        throw new Error("Captcha token is required");
    }
    const reqIp = c.req.raw.headers.get("cf-connecting-ip");
    const formData = new FormData();
    formData.append('secret', c.env.CF_TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    if (reqIp) formData.append('remoteip', reqIp);
    const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    const result = await fetch(url, {
        body: formData,
        method: 'POST',
    });
    const captchaRes: any = await result.json();
    if (!captchaRes.success) {
        console.log("Captcha failed", captchaRes);
        throw new Error("Captcha failed");
    }
}

export const checkUserPassword = (password: string) => {
    if (!password || password.length < 1 || password.length > 100) {
        throw new Error("Invalid password")
    }
    return true;
}

export const hashPassword = async (password: string): Promise<string> => {
    // use crypto to hash password
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const getMaxAddressCount = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined,
    settings: UserSettings
): Promise<number> => {
    if (!userRole) return settings.maxAddressCount;
    const roleConfigs = await getJsonSetting<RoleAddressConfig>(c, CONSTANTS.ROLE_ADDRESS_CONFIG_KEY);
    if (!roleConfigs) return settings.maxAddressCount;
    const roleMaxCount = roleConfigs[userRole]?.maxAddressCount;
    if (typeof roleMaxCount !== 'number') return settings.maxAddressCount;
    if (roleMaxCount < 0) return settings.maxAddressCount;
    return roleMaxCount;
};

/**
 * 检查用户是否已达到地址数量限制
 * @param c - Hono Context
 * @param user_id - 用户 ID
 * @param userRole - 用户角色
 * @returns true 表示已超限，false 表示未超限
 */
export const isAddressCountLimitReached = async (
    c: Context<HonoCustomType>,
    user_id: number | string,
    userRole: string | null | undefined
): Promise<boolean> => {
    const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
    const settings = new UserSettings(value);
    const maxAddressCount = await getMaxAddressCount(c, userRole, settings);

    if (maxAddressCount <= 0) return false;

    const { count } = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM users_address where user_id = ?`
    ).bind(user_id).first<{ count: number }>() || { count: 0 };

    return count >= maxAddressCount;
};

/**
 * Convert HTML string to plain text for notification previews.
 * Strips markup, converts linebreaks, decodes HTML entities and numeric character references.
 *
 * @param html - The HTML string to convert
 * @returns Plain text representation of the HTML content
 */
export function htmlToText(html: string): string {
    if (!html) return "";
    return html
        .replace(/<\s*(script|style|head|svg)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, ' $3 ')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(p|div|tr|td|th|li|table|section|article|header|footer|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => {
            const num = parseInt(code, 10);
            return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
            const num = parseInt(code, 16);
            return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
        })
        .replace(/[ \t\r\f\v]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export default {
    getJsonObjectValue,
    getSetting,
    saveSetting,
    getStringValue,
    getSplitStringListValue,
    getBooleanValue,
    getIntValue,
    getStringArray,
    trimLower,
    normalizeDomain,
    normalizeDomains,
    getMailDomain,
    normalizeAddressDomain,
    includesDomain,
    getDomainMapValue,
    getDefaultDomains,
    getDomains,
    getPersonalMailDomains,
    getRandomSubdomainDomains,
    getUserRoles,
    getAnotherWorkerList,
    getPasswords,
    getAdminPasswords,
    checkAdminAuth,
    getEnvStringList,
    isGlobalTurnstileEnabled,
    checkCfTurnstile,
    checkUserPassword,
    getJsonSetting,
    getJsonValue: getJsonObjectValue,
    getStringList: getStringArray,
    htmlToText
}
