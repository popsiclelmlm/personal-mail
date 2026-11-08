// 注册策略与邀请码
// 本文件不引入其他模块，便于在 Node 里直接做单元测试（e2e/unit/tests/invite.test.mjs）。
//
// 没有复用上游的兑换码表 redeem_codes，原因：
// 1. 兑换码的管理接口受 ENABLE_REDEEM_CODE 控制，打开它会同时开放公开的 /redeem_api 和兑换页；
// 2. 公开的兑换、查询接口要在多处排除邀请码类型，改动分散在上游的热点文件里；
// 3. 邀请码需要「可用次数」和使用记录，和兑换码一次性兑换的语义不同。

export type RegisterMode = 'open' | 'invite' | 'closed';

/** 解析 REGISTER_MODE；没配置或不认识时为 open（保持上游行为，仍受后台「允许注册」开关控制） */
export const resolveRegisterMode = (value: unknown): RegisterMode => {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (mode === 'invite' || mode === 'closed') return mode;
    return 'open';
};

// 去掉容易看错的 0/O、1/I/L
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 12;

/** 生成邀请码：12 位大写字母和数字，用 crypto 随机数 */
export const generateInviteCode = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
    let code = '';
    for (const byte of bytes) {
        // 31 个字符，取模的偏差可以忽略
        code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
    }
    return code;
};

/** 规范化用户输入的邀请码：去掉空格和连字符，转大写；格式不对返回 null */
export const normalizeInviteCode = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const code = value.toUpperCase().replace(/[\s-]/g, '');
    if (code.length < 6 || code.length > 64) return null;
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code;
};

/** 显示用：每 4 位加一个连字符 */
export const formatInviteCode = (code: string): string => code.replace(/(.{4})(?=.)/g, '$1-');

// 注册时消耗邀请码：只有启用、未过期、还有剩余次数时才加 1；配合 changes() 判断是否成功
export const CONSUME_INVITE_CODE_SQL = `UPDATE invite_codes
    SET used_count = used_count + 1, updated_at = datetime('now')
    WHERE code = ? AND enabled = 1 AND used_count < max_uses
    AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`;

// 查邀请码是否可用（注册前先查一次，拿到要授予的角色）
export const SELECT_USABLE_INVITE_CODE_SQL = `SELECT id, code, role FROM invite_codes
    WHERE code = ? AND enabled = 1 AND used_count < max_uses
    AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`;

// 注册批次里的其余语句（顺序：消耗邀请码 → 建用户 → 记录使用 → 授予角色），
// 每条都用 changes() 判断上一条是否成功，任何一条失败整个批次回滚
export const INSERT_USER_AFTER_INVITE_SQL = `INSERT INTO users (user_email, password, user_info)
    SELECT ?, ?, ? WHERE changes() = 1`;
export const INSERT_USER_SQL = `INSERT INTO users (user_email, password, user_info) VALUES (?, ?, ?)`;
export const RECORD_INVITE_USE_SQL = `INSERT INTO invite_code_uses (invite_code_id, user_id)
    SELECT ?, id FROM users WHERE user_email = ? AND changes() = 1`;
export const GRANT_ROLE_AFTER_INSERT_SQL = `INSERT INTO user_roles (user_id, role_text)
    SELECT id, ? FROM users WHERE user_email = ? AND changes() = 1
    ON CONFLICT(user_id) DO NOTHING`;
