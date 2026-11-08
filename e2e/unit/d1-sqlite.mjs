// 用 Node 内置的 node:sqlite 模拟 Cloudflare D1 的最小接口，供单元测试使用
// 只实现测试用到的 prepare/bind/first/run/all/exec/batch
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_PATH = new URL('../../db/schema.sql', import.meta.url);

const normalizeParam = (value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    return value;
};

export const createD1 = ({ withSchema = true } = {}) => {
    const db = new DatabaseSync(':memory:');
    if (withSchema) {
        db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    }
    const statement = (sql, params = []) => ({
        bind: (...values) => statement(sql, values.map(normalizeParam)),
        first: async (column) => {
            const row = db.prepare(sql).get(...params);
            if (!row) return null;
            return column ? (row[column] ?? null) : { ...row };
        },
        run: async () => {
            const result = db.prepare(sql).run(...params);
            return {
                success: true,
                meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
            };
        },
        all: async () => ({
            success: true,
            results: db.prepare(sql).all(...params).map((row) => ({ ...row })),
        }),
        sql,
    });
    return {
        raw: db,
        prepare: (sql) => statement(sql),
        exec: async (sql) => {
            db.exec(sql);
            return { count: 1, duration: 0 };
        },
        // D1 的 batch 在一个事务里执行，任何一条失败都整体回滚
        batch: async (statements) => {
            db.exec('BEGIN');
            try {
                const results = [];
                for (const item of statements) {
                    results.push(/^\s*select/i.test(item.sql) ? await item.all() : await item.run());
                }
                db.exec('COMMIT');
                return results;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
    };
};

// 内存版 KV，只实现 get/put/delete 和 expirationTtl
export const createKV = () => {
    const store = new Map();
    const now = () => Date.now();
    return {
        store,
        get: async (key, type) => {
            const item = store.get(key);
            if (!item) return null;
            if (item.expiresAt && item.expiresAt <= now()) {
                store.delete(key);
                return null;
            }
            return type === 'json' ? JSON.parse(item.value) : item.value;
        },
        put: async (key, value, options = {}) => {
            const ttl = options.expirationTtl;
            store.set(key, { value: String(value), expiresAt: ttl ? now() + ttl * 1000 : null });
        },
        delete: async (key) => {
            store.delete(key);
        },
    };
};
