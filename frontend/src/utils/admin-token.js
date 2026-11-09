// 管理员会话令牌：管理员密码只在登录时发一次（SHA-256 摘要），之后前端只保存服务端签发的短期令牌。
// 令牌过期、被吊销（退出所有设备）或管理员密码被修改后，后台回到登录框。

/** 令牌在 localStorage 里的键 */
export const ADMIN_TOKEN_STORAGE_KEY = 'adminToken';
/** 旧版前端把管理员密码明文存在这个键里，启动时清掉 */
export const LEGACY_ADMIN_PASSWORD_STORAGE_KEY = 'adminAuth';

// setTimeout 的最大延迟（约 24.8 天），超过会被当成 0 立即触发
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** 形如服务端签发的 JWT（第一段是 base64url 编码的 JSON） */
export const looksLikeAdminToken = (value) => (
    typeof value === 'string' && /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
);

const decodeBase64Url = (segment) => {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
};

/** 令牌的过期时间（毫秒时间戳）；不是令牌或解析失败时返回 null。只读不验签，验签在服务端 */
export const getAdminTokenExpiry = (token) => {
    if (!looksLikeAdminToken(token)) return null;
    try {
        const payload = JSON.parse(decodeBase64Url(token.split('.')[1]));
        const exp = payload?.exp;
        return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
    } catch {
        return null;
    }
};

/** 令牌格式正确且还没过期 */
export const isAdminTokenUsable = (token, now = Date.now()) => {
    const expiry = getAdminTokenExpiry(token);
    return expiry !== null && expiry > now;
};

// 隐私模式或禁用了站点数据时，连读取 localStorage 属性都可能抛错
const browserStorages = () => ['localStorage', 'sessionStorage'].map((name) => {
    try {
        return globalThis[name];
    } catch {
        return null;
    }
});

/** 清掉旧版前端留在浏览器里的明文管理员密码 */
export const purgeLegacyAdminPassword = (storages = browserStorages()) => {
    for (const storage of storages) {
        try {
            storage?.removeItem(LEGACY_ADMIN_PASSWORD_STORAGE_KEY);
        } catch {
            // 隐私模式等情况下访问存储可能抛错，忽略
        }
    }
};

/**
 * 在令牌到期时调用 onExpire（令牌无效或已过期时立即调用），返回取消函数。
 * 超过 setTimeout 上限时分段等待。
 */
export const scheduleAdminTokenExpiry = (token, onExpire, {
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
} = {}) => {
    let timer = null;
    let cancelled = false;
    const expiry = getAdminTokenExpiry(token);
    const check = () => {
        if (cancelled) return;
        const remaining = expiry === null ? 0 : expiry - now();
        if (remaining <= 0) {
            timer = null;
            onExpire();
            return;
        }
        timer = setTimer(check, Math.min(remaining, MAX_TIMER_DELAY));
    };
    check();
    return () => {
        cancelled = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
    };
};
