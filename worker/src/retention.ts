// 地址保留期与「IP × 基础域名」创建上限
// 本文件不引入其他模块，便于在 Node 里直接做单元测试（e2e/unit/tests/retention.test.mjs）

export const RETENTION_TYPES = ['temporary', 'extended', 'permanent'] as const;
export type RetentionType = typeof RETENTION_TYPES[number];

export const isRetentionType = (value: unknown): value is RetentionType => (
    typeof value === 'string' && (RETENTION_TYPES as readonly string[]).includes(value)
);

const columnPrefix = (alias?: string): string => alias ? `${alias}.` : '';

/** 受保护的地址：永久邮箱，或仍在保留期内 */
export const protectedAddressCondition = (alias?: string): string => {
    const p = columnPrefix(alias);
    return `(COALESCE(${p}is_permanent, 0) = 1`
        + ` OR (${p}retention_until IS NOT NULL AND datetime(${p}retention_until) > datetime('now')))`;
};

/** 可以被自动清理的地址：不是永久邮箱，且不在保留期内 */
export const cleanableAddressCondition = (alias?: string): string => `NOT ${protectedAddressCondition(alias)}`;

/** 邮件或发件记录不属于受保护地址；addressColumn 是外层表里保存地址名的列 */
export const notInProtectedAddressCondition = (addressColumn: string): string => (
    `NOT EXISTS (SELECT 1 FROM address AS pa WHERE pa.name = ${addressColumn} AND ${protectedAddressCondition('pa')})`
);

export type AddressCleanupType = 'inactiveAddress' | 'addressCreated' | 'unboundAddress' | 'emptyAddress';

export const ADDRESS_CLEANUP_TYPES: readonly AddressCleanupType[] = [
    'inactiveAddress', 'addressCreated', 'unboundAddress', 'emptyAddress',
];

export const isAddressCleanupType = (value: unknown): value is AddressCleanupType => (
    typeof value === 'string' && (ADDRESS_CLEANUP_TYPES as readonly string[]).includes(value)
);

/**
 * 清理地址时选出本批要删除的地址。
 * 保留期条件放在 LIMIT 之前，避免最旧的一批全是受保护地址时清理任务原地打转。
 * cleanDays、batchSize 由调用方校验为整数后再传入。
 */
export const buildAddressCleanupCondition = (
    cleanType: AddressCleanupType,
    cleanDays: number,
    batchSize: number,
): string => {
    const cleanable = cleanableAddressCondition('a');
    switch (cleanType) {
        case 'inactiveAddress':
            return `id IN (`
                + `SELECT a.id FROM address AS a WHERE a.updated_at < datetime('now', '-${cleanDays} day') `
                + `AND ${cleanable} `
                + `ORDER BY a.updated_at, a.id LIMIT ${batchSize})`;
        case 'addressCreated':
            return `id IN (`
                + `SELECT a.id FROM address AS a WHERE a.created_at < datetime('now', '-${cleanDays} day') `
                + `AND ${cleanable} `
                + `ORDER BY a.created_at, a.id LIMIT ${batchSize})`;
        case 'unboundAddress':
            return `id IN (`
                + `SELECT a.id FROM address AS a `
                + `WHERE a.created_at < datetime('now', '-${cleanDays} day') `
                + `AND NOT EXISTS (SELECT 1 FROM users_address AS ua WHERE ua.address_id = a.id) `
                + `AND ${cleanable} `
                + `ORDER BY a.created_at, a.id LIMIT ${batchSize})`;
        case 'emptyAddress':
            return `id IN (`
                + `SELECT a.id FROM address AS a `
                + `WHERE a.created_at < datetime('now', '-${cleanDays} day') `
                + `AND NOT EXISTS (SELECT 1 FROM raw_mails AS rm WHERE rm.address = a.name) `
                + `AND ${cleanable} `
                + `ORDER BY a.created_at, a.id LIMIT ${batchSize})`;
    }
};

/** 删除一批地址及其数据的语句；再加一层保留期条件兜底 */
export const buildBatchDeleteAddressStatements = (addressQueryCondition: string): string[] => {
    const condition = `(${addressQueryCondition}) AND ${cleanableAddressCondition()}`;
    return [
        `DELETE FROM raw_mails WHERE address IN (SELECT name FROM address WHERE ${condition})`,
        `DELETE FROM sendbox WHERE address IN (SELECT name FROM address WHERE ${condition})`,
        `DELETE FROM auto_reply_mails WHERE address IN (SELECT name FROM address WHERE ${condition})`,
        `DELETE FROM address_sender WHERE address IN (SELECT name FROM address WHERE ${condition})`,
        `DELETE FROM users_address WHERE address_id IN (SELECT id FROM address WHERE ${condition})`,
        `DELETE FROM address WHERE ${condition}`,
    ];
};

/** 按创建时间清理邮件，跳过受保护地址的邮件；绑定参数：['-N day', batchSize] */
export const MAILS_CLEANUP_SQL = `
    DELETE FROM raw_mails WHERE id IN (
        SELECT rm.id FROM raw_mails AS rm
        WHERE rm.created_at < datetime('now', ?)
        AND ${notInProtectedAddressCondition('rm.address')}
        ORDER BY rm.created_at, rm.id
        LIMIT ?
    )`;

/** 按创建时间清理发件箱，跳过受保护地址的发件记录；绑定参数：['-N day', batchSize] */
export const SENDBOX_CLEANUP_SQL = `
    DELETE FROM sendbox WHERE id IN (
        SELECT sb.id FROM sendbox AS sb
        WHERE sb.created_at < datetime('now', ?)
        AND ${notInProtectedAddressCondition('sb.address')}
        ORDER BY sb.created_at, sb.id
        LIMIT ?
    )`;

export const DEFAULT_IP_DOMAIN_CREATE_LIMIT = 5;

/** 解析 IP_DOMAIN_CREATE_LIMIT；没配置时用默认值，0 或负数表示关闭 */
export const resolveIpDomainCreateLimit = (value: unknown): number => {
    if (value === undefined || value === null || value === '') return DEFAULT_IP_DOMAIN_CREATE_LIMIT;
    const limit = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_IP_DOMAIN_CREATE_LIMIT;
};

/** 只对匿名用户、或没有角色的登录用户检查「IP × 基础域名」上限 */
export const shouldCheckIpDomainLimit = ({ sourceIp, hasRole, limit }: {
    sourceIp: string | null | undefined,
    hasRole: boolean,
    limit: number,
}): boolean => {
    if (hasRole) return false;
    if (limit <= 0) return false;
    if (!sourceIp || sourceIp === 'web:unknown') return false;
    return true;
};

/** 同一来源 IP 在某个基础域名（含其子域名）下现存的地址数 */
export const countAddressesByIpAndBaseDomain = async (
    db: D1Database,
    sourceIp: string,
    baseDomain: string,
): Promise<number> => {
    const domain = baseDomain.trim().toLowerCase();
    const exact = `@${domain}`;
    const subdomain = `.${domain}`;
    const row = await db.prepare(
        `SELECT COUNT(*) AS count FROM address WHERE source_meta = ?`
        + ` AND (substr(lower(name), -?) = ? OR substr(lower(name), -?) = ?)`
    ).bind(sourceIp, exact.length, exact, subdomain.length, subdomain).first<{ count: number }>();
    return Number(row?.count ?? 0);
};

export class IpDomainLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IpDomainLimitError';
    }
}

/** 达到上限时抛出 IpDomainLimitError */
export const assertIpDomainLimitNotReached = async (
    db: D1Database,
    { sourceIp, baseDomain, limit, message }: {
        sourceIp: string, baseDomain: string, limit: number, message: string,
    },
): Promise<void> => {
    const count = await countAddressesByIpAndBaseDomain(db, sourceIp, baseDomain);
    if (count >= limit) {
        throw new IpDomainLimitError(message);
    }
};
