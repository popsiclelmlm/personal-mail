import { getPathWithLocale } from '../i18n/utils'

export const hashPassword = async (password: string) => {
    // user crypto to hash password
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const getRouterPathWithLang = (path: string, lang: string) => {
    const normalizedLang = lang === 'en'
        || lang === 'es'
        || lang === 'pt-BR'
        || lang === 'ja'
        || lang === 'de'
        ? lang
        : 'zh';

    return getPathWithLocale(path, normalizedLang);
}

export const utcToLocalDate = (utcDate: string | null | undefined, useUTCDate: boolean) => {
    if (!utcDate) return '';
    const utcDateString = `${utcDate} UTC`;
    if (useUTCDate) {
        return utcDateString;
    }
    try {
        const date = new Date(utcDateString);
        // if invalid date string
        if (isNaN(date.getTime())) return utcDateString;

        return date.toLocaleString();
    } catch (e) {
        console.error(e);
    }
    return utcDateString;
}

/** domain 是否属于个人邮箱专用域名（含子域名），和后端 personal_domains.ts 的判断一致 */
export const isPersonalMailDomain = (domain: string | undefined | null, personalDomains: string[]): boolean => {
    const target = typeof domain === 'string' ? domain.trim().toLowerCase() : ''
    if (!target) return false
    return personalDomains.some((item) => {
        const base = typeof item === 'string' ? item.trim().toLowerCase() : ''
        return !!base && (target === base || target.endsWith(`.${base}`))
    })
}
