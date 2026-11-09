// 管理员会话令牌：用管理员密码登录后签发，前端只保存令牌，不再保存密码本身。
// - 签名密钥从 JWT_SECRET 派生（HMAC），和用户令牌、邮箱凭证互不通用；换 JWT_SECRET 即全部失效。
// - 令牌里的 ph 绑定签发时用的那个管理员密码：从 ADMIN_PASSWORDS 删掉或改掉这个密码，令牌随之失效。
// - 令牌里的 av 是管理员令牌版本（存在 D1 settings 表）：版本加 1 即让所有已签发的令牌失效。
// 本文件只依赖 hono 的 JWT 工具，不引入项目里的其他模块，便于在 Node 里直接做单元测试
// （e2e/unit/tests/admin-token.test.mjs）。
import { Jwt } from 'hono/utils/jwt';

/** 令牌类型标记，防止其他用 JWT_SECRET 派生密钥签的东西被当成管理员令牌 */
export const ADMIN_TOKEN_TYPE = 'admin';
/** 管理员令牌版本在 settings 表里的键 */
export const ADMIN_TOKEN_VERSION_KEY = 'admin_token_version';
/** 默认有效期 8 小时，可用 ADMIN_TOKEN_TTL_SECONDS 调整（1 分钟到 7 天） */
export const ADMIN_TOKEN_DEFAULT_TTL_SECONDS = 8 * 60 * 60;
export const ADMIN_TOKEN_MIN_TTL_SECONDS = 60;
export const ADMIN_TOKEN_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');

const hmacHex = async (key: string, message: string): Promise<string> => {
    const cryptoKey = await crypto.subtle.importKey(
        'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return toHex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
};

/** 固定耗时比较两个字符串 */
export const constantTimeStringEqual = (a: string, b: string): boolean => {
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    const length = Math.max(left.length, right.length);
    let diff = left.length ^ right.length;
    for (let i = 0; i < length; i++) {
        diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
    }
    return diff === 0;
};

/** 在密码列表里找出和输入相同的那个（逐个固定耗时比较），找不到返回 null */
export const findMatchingSecret = (candidates: string[], input: unknown): string | null => {
    if (typeof input !== 'string' || !input) return null;
    let matched: string | null = null;
    for (const candidate of candidates) {
        if (constantTimeStringEqual(candidate, input) && matched === null) matched = candidate;
    }
    return matched;
};

/** 管理员令牌专用的签名密钥（由 JWT_SECRET 派生） */
export const deriveAdminTokenSecret = async (jwtSecret: string): Promise<string> => (
    hmacHex(jwtSecret, 'admin-session-token/v1')
);

/** 密码绑定值：只放密码的 HMAC 摘要片段，令牌泄露也推不出密码 */
export const adminPasswordBinding = async (tokenSecret: string, password: string): Promise<string> => (
    (await hmacHex(tokenSecret, `admin-password:${password}`)).slice(0, 32)
);

/** 解析有效期配置；无效值用默认值，超出范围时取边界 */
export const resolveAdminTokenTtl = (value: unknown): number => {
    if (value === undefined || value === null || value === '') return ADMIN_TOKEN_DEFAULT_TTL_SECONDS;
    const ttl = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(ttl)) return ADMIN_TOKEN_DEFAULT_TTL_SECONDS;
    return Math.min(ADMIN_TOKEN_MAX_TTL_SECONDS, Math.max(ADMIN_TOKEN_MIN_TTL_SECONDS, Math.floor(ttl)));
};

/** 把版本号规范成非负整数；无效值返回 -1（永远不会和当前版本相等） */
export const normalizeAdminTokenVersion = (value: unknown): number => {
    if (value === undefined || value === null || value === '') return 0;
    const version = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(version) && version >= 0 ? version : -1;
};

/**
 * 形如 JWT：三段 base64url，且第一段以 eyJ 开头（即 base64url 编码的 `{"`）。
 * 用来区分「令牌」和「明文密码」两种 x-admin-auth；像 my.admin.pass 这样带点的密码仍按密码处理。
 */
export const looksLikeJwt = (value: unknown): value is string => (
    typeof value === 'string' && /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
);

export type SignAdminTokenOptions = {
    jwtSecret: string,
    password: string,
    version: number,
    ttlSeconds?: number,
    /** 毫秒时间戳，测试用 */
    now?: number,
};

/** 签发管理员令牌，返回令牌和过期时间（秒级时间戳） */
export const signAdminToken = async ({
    jwtSecret, password, version, ttlSeconds, now = Date.now(),
}: SignAdminTokenOptions): Promise<{ token: string, expiresAt: number }> => {
    const secret = await deriveAdminTokenSecret(jwtSecret);
    const iat = Math.floor(now / 1000);
    const expiresAt = iat + resolveAdminTokenTtl(ttlSeconds);
    const token = await Jwt.sign({
        typ: ADMIN_TOKEN_TYPE,
        av: normalizeAdminTokenVersion(version),
        ph: await adminPasswordBinding(secret, password),
        iat,
        exp: expiresAt,
    }, secret, 'HS256');
    return { token, expiresAt };
};

export type AdminTokenResult = 'ok' | 'invalid' | 'expired' | 'revoked';

export type VerifyAdminTokenOptions = {
    jwtSecret: string,
    /** 当前的 ADMIN_PASSWORDS */
    passwords: string[],
    /** 读取当前的令牌版本；只有签名有效时才会调用，避免给伪造的令牌查数据库 */
    getVersion: () => Promise<unknown>,
    now?: number,
};

/**
 * 校验管理员令牌：
 * - invalid：格式不对、签名不对、类型不对；
 * - expired：过期；
 * - revoked：签发它的密码已不在 ADMIN_PASSWORDS 里，或令牌版本已经变了。
 */
export const verifyAdminToken = async (
    token: unknown,
    { jwtSecret, passwords, getVersion, now = Date.now() }: VerifyAdminTokenOptions,
): Promise<AdminTokenResult> => {
    if (!jwtSecret || !looksLikeJwt(token)) return 'invalid';
    const secret = await deriveAdminTokenSecret(jwtSecret);
    let payload: Record<string, unknown>;
    try {
        // 时间相关的检查自己做（可注入 now），hono 只负责验签和算法
        payload = await Jwt.verify(token, secret, {
            alg: 'HS256', exp: false, nbf: false, iat: false,
        }) as Record<string, unknown>;
    } catch {
        return 'invalid';
    }
    if (payload.typ !== ADMIN_TOKEN_TYPE || typeof payload.ph !== 'string') return 'invalid';
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return 'invalid';
    if (payload.exp * 1000 <= now) return 'expired';
    const bindings = await Promise.all(passwords.map(password => adminPasswordBinding(secret, password)));
    if (findMatchingSecret(bindings, payload.ph) === null) return 'revoked';
    const tokenVersion = normalizeAdminTokenVersion(payload.av);
    const currentVersion = normalizeAdminTokenVersion(await getVersion());
    if (tokenVersion < 0 || tokenVersion !== currentVersion) return 'revoked';
    return 'ok';
};

export type AdminHeaderResult = 'ok' | 'invalid' | 'expired' | 'revoked' | 'locked';

export type CheckAdminHeaderOptions = VerifyAdminTokenOptions & {
    /** 失败锁定（和 /open_api/admin_login 共用同一个计数） */
    guard: {
        isLocked: () => Promise<boolean>,
        /** 记一次失败，返回记完之后是否被锁定 */
        recordFailure: () => Promise<boolean>,
    },
};

/**
 * 校验 x-admin-auth 请求头：
 * - 形如 JWT 的按管理员令牌校验；
 * - 其他值按明文管理员密码校验（兼容脚本和旧版前端），并计入失败锁定，
 *   避免绕过登录接口的人机验证和锁定、直接用请求头暴力猜密码。
 */
export const checkAdminAuthHeader = async (
    header: string | null | undefined,
    options: CheckAdminHeaderOptions,
): Promise<AdminHeaderResult | 'none'> => {
    if (!header) return 'none';
    if (!options.passwords.length) return 'invalid';
    if (looksLikeJwt(header)) return verifyAdminToken(header, options);
    if (await options.guard.isLocked()) return 'locked';
    if (findMatchingSecret(options.passwords, header) !== null) return 'ok';
    return await options.guard.recordFailure() ? 'locked' : 'invalid';
};
