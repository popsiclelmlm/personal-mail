// 用户密码的服务端哈希：PBKDF2-SHA256 + 每个用户随机 16 字节盐
// 前端仍然发送密码的 SHA-256 十六进制摘要，服务端把这个摘要当作输入再做 PBKDF2，
// 所以前端、通行密钥和 OAuth2 流程都不用改。
// 本文件不引入其他模块，便于在 Node 里直接做单元测试（e2e/unit/tests/password.test.mjs）。
//
// 存储格式：pbkdf2$sha256$<迭代次数>$<盐 base64>$<哈希 base64>
// 老数据是 64 位十六进制（前端摘要原样入库），登录比对成功后当场升级。

export const PASSWORD_HASH_SCHEME = 'pbkdf2';
export const PASSWORD_HASH_DIGEST = 'sha256';
// workerd 的 PBKDF2 最多支持 100000 次迭代，超过会直接报错
export const MAX_PBKDF2_ITERATIONS = 100_000;
export const MIN_PBKDF2_ITERATIONS = 10_000;
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const LEGACY_HASH_RE = /^[0-9a-f]{64}$/i;

/** 解析 PASSWORD_PBKDF2_ITERATIONS，限制在 workerd 支持的范围内 */
export const resolvePbkdf2Iterations = (value: unknown): number => {
    if (value === undefined || value === null || value === '') return DEFAULT_PBKDF2_ITERATIONS;
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_PBKDF2_ITERATIONS;
    return Math.min(Math.max(Math.trunc(parsed), MIN_PBKDF2_ITERATIONS), MAX_PBKDF2_ITERATIONS);
};

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array | null => {
    try {
        const binary = atob(value);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
        return null;
    }
};

/** 固定耗时比较：长度不同也逐字节比完，结果只在最后判断 */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    const length = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;
    for (let i = 0; i < length; i++) {
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
};

const derive = async (input: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(input), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        key,
        HASH_BYTES * 8,
    );
    return new Uint8Array(bits);
};

export type ParsedPasswordHash = {
    iterations: number,
    salt: Uint8Array,
    hash: Uint8Array,
};

export const parsePasswordHash = (stored: unknown): ParsedPasswordHash | null => {
    if (typeof stored !== 'string') return null;
    const parts = stored.split('$');
    if (parts.length !== 5) return null;
    const [scheme, digest, rawIterations, rawSalt, rawHash] = parts;
    if (scheme !== PASSWORD_HASH_SCHEME || digest !== PASSWORD_HASH_DIGEST) return null;
    if (!/^\d+$/.test(rawIterations)) return null;
    const iterations = Number(rawIterations);
    if (iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) return null;
    const salt = fromBase64(rawSalt);
    const hash = fromBase64(rawHash);
    if (!salt || !hash || salt.length === 0 || hash.length !== HASH_BYTES) return null;
    return { iterations, salt, hash };
};

export const isLegacyPasswordHash = (stored: unknown): boolean => (
    typeof stored === 'string' && LEGACY_HASH_RE.test(stored)
);

export const isCurrentPasswordHash = (stored: unknown): boolean => parsePasswordHash(stored) !== null;

/** 生成新的存储值；input 是前端发来的 SHA-256 摘要 */
export const hashUserPassword = async (
    input: string,
    iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<string> => {
    const rounds = resolvePbkdf2Iterations(iterations);
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const hash = await derive(input, salt, rounds);
    return [PASSWORD_HASH_SCHEME, PASSWORD_HASH_DIGEST, rounds, toBase64(salt), toBase64(hash)].join('$');
};

// 账号不存在或没有密码时也算一次哈希，让响应时间和「密码错误」接近
const DUMMY_SALT = new Uint8Array(SALT_BYTES);

export type PasswordCheckResult = {
    ok: boolean,
    // 比对成功但存储格式过时（老的十六进制，或迭代次数低于当前配置），需要重新哈希
    needsUpgrade: boolean,
};

/**
 * 校验密码。stored 为空、格式不认识时返回失败，但同样会算一次 PBKDF2。
 * iterations 是当前配置的迭代次数，用来判断是否需要升级，以及没有可比对的哈希时计算多少轮。
 */
export const verifyUserPassword = async (
    input: string,
    stored: unknown,
    iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<PasswordCheckResult> => {
    const rounds = resolvePbkdf2Iterations(iterations);
    const encoder = new TextEncoder();
    const parsed = parsePasswordHash(stored);
    if (parsed) {
        const hash = await derive(input, parsed.salt, parsed.iterations);
        const ok = constantTimeEqual(hash, parsed.hash);
        return { ok, needsUpgrade: ok && parsed.iterations < rounds };
    }
    // 老格式：先做一次同样耗时的 PBKDF2，再固定耗时比较十六进制字符串
    await derive(input, DUMMY_SALT, rounds);
    if (typeof input === 'string' && isLegacyPasswordHash(stored)) {
        const ok = constantTimeEqual(
            encoder.encode(input.toLowerCase()),
            encoder.encode((stored as string).toLowerCase()),
        );
        return { ok, needsUpgrade: ok };
    }
    return { ok: false, needsUpgrade: false };
};
