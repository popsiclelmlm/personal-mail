// 本仓库在上游之外新增的表和列
// 不占用上游的 DB_VERSION 编号：每次迁移都按实际表结构补齐缺少的列，可以重复执行，
// 也兼容已经手动执行过 db/ 下迁移文件、或部署过本仓库旧版本的数据库。

type CustomColumn = {
    table: string,
    column: string,
    ddl: string,
};

export const CUSTOM_COLUMNS: CustomColumn[] = [
    // 地址保留期（db/2026-06-08-retention-and-ip-limit.sql）
    { table: 'address', column: 'retention_type', ddl: `ALTER TABLE address ADD COLUMN retention_type TEXT DEFAULT 'temporary'` },
    { table: 'address', column: 'retention_until', ddl: `ALTER TABLE address ADD COLUMN retention_until DATETIME` },
    { table: 'address', column: 'is_permanent', ddl: `ALTER TABLE address ADD COLUMN is_permanent INTEGER DEFAULT 0` },
    // 账号安全（db/2026-11-09-user-security.sql）
    { table: 'users', column: 'token_version', ddl: `ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0` },
    // 个人邮箱（db/2026-11-09-personal-mailbox.sql）
    { table: 'address', column: 'credential_version', ddl: `ALTER TABLE address ADD COLUMN credential_version INTEGER DEFAULT 0` },
    { table: 'address', column: 'credential_login_disabled', ddl: `ALTER TABLE address ADD COLUMN credential_login_disabled INTEGER DEFAULT 0` },
    // 辅助邮箱（db/2026-11-09-recovery-email.sql）
    { table: 'users', column: 'recovery_email', ddl: `ALTER TABLE users ADD COLUMN recovery_email TEXT` },
];

// 列补齐之后执行，必须可重复执行（IF NOT EXISTS）
export const CUSTOM_STATEMENTS: string[] = [
    `CREATE INDEX IF NOT EXISTS idx_address_is_permanent ON address(is_permanent)`,
    `CREATE TABLE IF NOT EXISTS invite_codes (`
    + ` id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, role TEXT,`
    + ` max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0,`
    + ` enabled INTEGER NOT NULL DEFAULT 1, note TEXT, expires_at DATETIME,`
    + ` created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS invite_code_uses (`
    + ` id INTEGER PRIMARY KEY AUTOINCREMENT, invite_code_id INTEGER NOT NULL, user_id INTEGER NOT NULL,`
    + ` created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS idx_invite_code_uses_invite_code_id ON invite_code_uses(invite_code_id)`,
];

// 本仓库新增的表，用来判断是否需要迁移
export const CUSTOM_TABLES: string[] = ['invite_codes', 'invite_code_uses'];

const getTableColumns = async (db: D1Database, table: string): Promise<Set<string>> => {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return new Set((results || []).map((row) => row.name));
};

/** 缺少的自定义列；表本身不存在时不算（交给初始化建表） */
export const getMissingCustomColumns = async (db: D1Database): Promise<CustomColumn[]> => {
    const columnsByTable = new Map<string, Set<string>>();
    const missing: CustomColumn[] = [];
    for (const item of CUSTOM_COLUMNS) {
        if (!columnsByTable.has(item.table)) {
            columnsByTable.set(item.table, await getTableColumns(db, item.table));
        }
        const columns = columnsByTable.get(item.table)!;
        if (columns.size > 0 && !columns.has(item.column)) {
            missing.push(item);
        }
    }
    return missing;
};

/** 是否还有没执行的自定义迁移（缺列或缺表） */
export const hasPendingCustomMigrations = async (db: D1Database): Promise<boolean> => {
    if ((await getMissingCustomColumns(db)).length > 0) return true;
    for (const table of CUSTOM_TABLES) {
        const exists = await db.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
        ).bind(table).first('name');
        if (!exists) return true;
    }
    return false;
};

/** 补齐自定义列并执行自定义语句；返回补了多少列 */
export const applyCustomMigrations = async (db: D1Database): Promise<number> => {
    const missing = await getMissingCustomColumns(db);
    for (const item of missing) {
        await db.exec(`${item.ddl};`);
    }
    for (const statement of CUSTOM_STATEMENTS) {
        await db.exec(`${statement};`);
    }
    return missing.length;
};
