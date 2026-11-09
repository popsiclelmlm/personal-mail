// @vitest-environment jsdom
// 管理员会话令牌：前端只保存令牌，不保存管理员密码；令牌过期后回到登录框
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ADMIN_TOKEN_STORAGE_KEY,
    LEGACY_ADMIN_PASSWORD_STORAGE_KEY,
    getAdminTokenExpiry,
    isAdminTokenUsable,
    looksLikeAdminToken,
    purgeLegacyAdminPassword,
    scheduleAdminTokenExpiry,
} from '../admin-token';

const base64url = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// 前端不验签，签名段随便填
const makeToken = (payload) => `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.c2lnbmF0dXJl`;

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const expSeconds = (offsetMs) => Math.floor((NOW + offsetMs) / 1000);

describe('admin token helpers', () => {
    it('recognises tokens and leaves plain passwords alone', () => {
        expect(looksLikeAdminToken(makeToken({ exp: 1 }))).toBe(true);
        expect(looksLikeAdminToken('local-admin-pass')).toBe(false);
        expect(looksLikeAdminToken('my.admin.pass')).toBe(false);
        expect(looksLikeAdminToken('')).toBe(false);
        expect(looksLikeAdminToken(undefined)).toBe(false);
    });

    it('reads the expiry without verifying the signature', () => {
        const token = makeToken({ typ: 'admin', exp: expSeconds(3600_000), note: '管理员' });
        expect(getAdminTokenExpiry(token)).toBe(expSeconds(3600_000) * 1000);
        expect(getAdminTokenExpiry(makeToken({ typ: 'admin' }))).toBeNull();
        expect(getAdminTokenExpiry(makeToken({ exp: 'soon' }))).toBeNull();
        expect(getAdminTokenExpiry('eyJ.bm90LWpzb24.c2ln')).toBeNull();
        expect(getAdminTokenExpiry('local-admin-pass')).toBeNull();
    });

    it('treats expired or malformed tokens as unusable', () => {
        expect(isAdminTokenUsable(makeToken({ exp: expSeconds(60_000) }), NOW)).toBe(true);
        expect(isAdminTokenUsable(makeToken({ exp: expSeconds(0) }), NOW)).toBe(false);
        expect(isAdminTokenUsable(makeToken({ exp: expSeconds(-1000) }), NOW)).toBe(false);
        expect(isAdminTokenUsable('local-admin-pass', NOW)).toBe(false);
    });

    it('removes the legacy plain-text admin password from every storage', () => {
        localStorage.setItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY, 'local-admin-pass');
        sessionStorage.setItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY, 'local-admin-pass');
        const broken = { removeItem: () => { throw new Error('denied'); } };
        purgeLegacyAdminPassword([localStorage, sessionStorage, broken, null]);
        expect(localStorage.getItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY)).toBeNull();
        expect(sessionStorage.getItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY)).toBeNull();
        // 不传参数时清理浏览器的 localStorage 和 sessionStorage
        localStorage.setItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY, 'local-admin-pass');
        sessionStorage.setItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY, 'local-admin-pass');
        purgeLegacyAdminPassword();
        expect(localStorage.getItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY)).toBeNull();
        expect(sessionStorage.getItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY)).toBeNull();
    });
});

describe('scheduleAdminTokenExpiry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires exactly when the token expires', () => {
        const onExpire = vi.fn();
        scheduleAdminTokenExpiry(makeToken({ exp: expSeconds(90_000) }), onExpire);
        vi.advanceTimersByTime(89_000);
        expect(onExpire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(onExpire).toHaveBeenCalledTimes(1);
    });

    it('fires immediately for expired or unreadable tokens', () => {
        const onExpire = vi.fn();
        scheduleAdminTokenExpiry(makeToken({ exp: expSeconds(-1) }), onExpire);
        scheduleAdminTokenExpiry('local-admin-pass', onExpire);
        expect(onExpire).toHaveBeenCalledTimes(2);
    });

    it('can be cancelled, e.g. after logging out', () => {
        const onExpire = vi.fn();
        const cancel = scheduleAdminTokenExpiry(makeToken({ exp: expSeconds(1_000) }), onExpire);
        cancel();
        vi.advanceTimersByTime(5_000);
        expect(onExpire).not.toHaveBeenCalled();
    });

    it('waits in chunks when the expiry is beyond the setTimeout limit', () => {
        const onExpire = vi.fn();
        const thirtyDays = 30 * 24 * 3600_000;
        scheduleAdminTokenExpiry(makeToken({ exp: expSeconds(thirtyDays) }), onExpire);
        vi.advanceTimersByTime(2 ** 31 - 1);
        expect(onExpire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(thirtyDays - (2 ** 31 - 1));
        expect(onExpire).toHaveBeenCalledTimes(1);
    });
});

describe('global store', () => {
    beforeEach(() => {
        vi.resetModules();
        localStorage.clear();
        sessionStorage.clear();
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const loadStore = async () => (await import('../../store/index.js')).useGlobalState();

    it('never keeps the admin password and drops the legacy key on start', async () => {
        localStorage.setItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY, 'local-admin-pass');
        const state = await loadStore();
        expect(localStorage.getItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY)).toBeNull();
        expect(state.adminAuth).toBeUndefined();
        expect(state.adminToken.value).toBe('');
        expect(state.showAdminPage.value).toBe(false);
    });

    it('keeps a valid token and clears it when it expires', async () => {
        const token = makeToken({ typ: 'admin', exp: expSeconds(120_000) });
        localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
        const state = await loadStore();
        expect(state.adminToken.value).toBe(token);
        expect(state.showAdminPage.value).toBe(true);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.adminToken.value).toBe('');
        expect(state.showAdminPage.value).toBe(false);
        expect(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').toBe('');
    });

    it('drops an already expired token on start', async () => {
        localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, makeToken({ typ: 'admin', exp: expSeconds(-1000) }));
        const state = await loadStore();
        expect(state.adminToken.value).toBe('');
        // 明文密码误存进新键也会被当成无效令牌清掉
        vi.resetModules();
        localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'local-admin-pass');
        expect((await loadStore()).adminToken.value).toBe('');
    });
});
