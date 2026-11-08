import { Context } from 'hono';

import i18n from '../i18n';
import { getUserRoles } from '../utils';
import { generateInviteCode } from '../user_api/invite';

const MAX_BATCH_SIZE = 50;
const MAX_USES_LIMIT = 1000;

const parsePositiveInt = (value: unknown, fallback: number): number | null => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

// 过期时间：空表示不过期；必须是将来的时间
const parseExpiresAt = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') return undefined;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return undefined;
    // 存成 SQLite datetime() 能直接比较的格式
    return new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
};

// 邀请码上的角色必须在 USER_ROLES 里，且不能是管理员角色；空表示用 USER_DEFAULT_ROLE
const validateRole = (c: Context<HonoCustomType>, role: unknown): string | null | undefined => {
    if (role === undefined || role === null || role === '') return null;
    if (typeof role !== 'string') return undefined;
    const trimmed = role.trim();
    if (!trimmed || trimmed === c.env.ADMIN_USER_ROLE) return undefined;
    return getUserRoles(c).some((item) => item.role === trimmed) ? trimmed : undefined;
};

const listInviteCodes = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { limit: rawLimit, offset: rawOffset } = c.req.query();
    const limit = Number.parseInt(rawLimit || '20');
    const offset = Number.parseInt(rawOffset || '0');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.text(msgs.InvalidLimitMsg, 400);
    if (!Number.isInteger(offset) || offset < 0) return c.text(msgs.InvalidOffsetMsg, 400);
    const { results } = await c.env.DB.prepare(
        `SELECT ic.id, ic.code, ic.role, ic.max_uses, ic.used_count, ic.enabled, ic.note,`
        + ` ic.expires_at, ic.created_at, ic.updated_at,`
        + ` (SELECT group_concat(u.user_email, ', ') FROM invite_code_uses icu`
        + `  JOIN users u ON u.id = icu.user_id WHERE icu.invite_code_id = ic.id) AS used_by`
        + ` FROM invite_codes ic ORDER BY ic.id DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    const count = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM invite_codes`).first<number>('count');
    return c.json({ results, count: count ?? 0 });
};

const createInviteCodes = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const body = await c.req.json<{
        count?: unknown, max_uses?: unknown, role?: unknown, expires_at?: unknown, note?: unknown,
    }>();
    const count = parsePositiveInt(body.count, 1);
    const maxUses = parsePositiveInt(body.max_uses, 1);
    const role = validateRole(c, body.role);
    const expiresAt = parseExpiresAt(body.expires_at);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : null;
    if (!count || count > MAX_BATCH_SIZE || !maxUses || maxUses > MAX_USES_LIMIT
        || role === undefined || expiresAt === undefined
    ) {
        return c.text(msgs.InvalidInputMsg, 400);
    }
    const codes = new Set<string>();
    while (codes.size < count) codes.add(generateInviteCode());
    await c.env.DB.batch([...codes].map((code) => c.env.DB.prepare(
        `INSERT INTO invite_codes (code, role, max_uses, expires_at, note) VALUES (?, ?, ?, ?, ?)`
    ).bind(code, role, maxUses, expiresAt, note || null)));
    return c.json({ codes: [...codes] });
};

const updateInviteCode = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const id = parsePositiveInt(c.req.param('id'), 0);
    if (!id) return c.text(msgs.InvalidInputMsg, 400);
    const { enabled } = await c.req.json<{ enabled?: unknown }>();
    if (typeof enabled !== 'boolean') return c.text(msgs.InvalidInputMsg, 400);
    const { meta } = await c.env.DB.prepare(
        `UPDATE invite_codes SET enabled = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(enabled ? 1 : 0, id).run();
    return c.json({ success: (meta.changes ?? 0) > 0 });
};

const deleteInviteCode = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const id = parsePositiveInt(c.req.param('id'), 0);
    if (!id) return c.text(msgs.InvalidInputMsg, 400);
    await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM invite_code_uses WHERE invite_code_id = ?`).bind(id),
        c.env.DB.prepare(`DELETE FROM invite_codes WHERE id = ?`).bind(id),
    ]);
    return c.json({ success: true });
};

export default {
    listInviteCodes,
    createInviteCodes,
    updateInviteCode,
    deleteInviteCode,
};
