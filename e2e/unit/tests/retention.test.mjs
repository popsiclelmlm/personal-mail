import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createD1 } from '../d1-sqlite.mjs';
import {
    assertIpDomainLimitNotReached,
    buildAddressCleanupCondition,
    buildBatchDeleteAddressStatements,
    countAddressesByIpAndBaseDomain,
    IpDomainLimitError,
    isRetentionType,
    MAILS_CLEANUP_SQL,
    resolveIpDomainCreateLimit,
    SENDBOX_CLEANUP_SQL,
    shouldCheckIpDomainLimit,
} from '../../../worker/src/retention.ts';

// 建四类都已经「过期」的地址：普通临时、永久、保留期内、保留期已过
const seedAddresses = (db) => {
    const insert = db.raw.prepare(
        `INSERT INTO address (name, retention_type, retention_until, is_permanent, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`
    );
    insert.run('plain@temp.test', 'temporary', null, 0, '-10 day', '-10 day');
    insert.run('forever@temp.test', 'permanent', null, 1, '-20 day', '-20 day');
    insert.run('kept@temp.test', 'extended', null, 0, '-10 day', '-10 day');
    db.raw.exec(`UPDATE address SET retention_until = datetime('now', '+5 day') WHERE name = 'kept@temp.test'`);
    insert.run('expired@temp.test', 'extended', null, 0, '-10 day', '-10 day');
    db.raw.exec(`UPDATE address SET retention_until = datetime('now', '-1 day') WHERE name = 'expired@temp.test'`);
    const mail = db.raw.prepare(
        `INSERT INTO raw_mails (address, source, raw, created_at) VALUES (?, 'a@b.test', 'raw', datetime('now', '-10 day'))`
    );
    const sent = db.raw.prepare(
        `INSERT INTO sendbox (address, raw, created_at) VALUES (?, 'raw', datetime('now', '-10 day'))`
    );
    for (const name of ['plain@temp.test', 'forever@temp.test', 'kept@temp.test', 'expired@temp.test']) {
        mail.run(name);
        sent.run(name);
    }
};

const addressNames = (db) => db.raw.prepare(`SELECT name FROM address ORDER BY name`).all().map((row) => row.name);
const mailAddresses = (db, table) => db.raw.prepare(`SELECT address FROM ${table} ORDER BY address`).all().map((row) => row.address);

const runAddressCleanup = async (db, cleanType, cleanDays = 1, batchSize = 100) => {
    for (const sql of buildBatchDeleteAddressStatements(buildAddressCleanupCondition(cleanType, cleanDays, batchSize))) {
        await db.prepare(sql).run();
    }
};

for (const cleanType of ['addressCreated', 'inactiveAddress', 'unboundAddress', 'emptyAddress']) {
    test(`${cleanType} cleanup keeps permanent and in-retention addresses`, async () => {
        const db = createD1();
        seedAddresses(db);
        if (cleanType === 'emptyAddress') {
            db.raw.exec(`DELETE FROM raw_mails`);
        }
        await runAddressCleanup(db, cleanType);
        assert.deepEqual(addressNames(db), ['forever@temp.test', 'kept@temp.test']);
        if (cleanType !== 'emptyAddress') {
            assert.deepEqual(mailAddresses(db, 'raw_mails'), ['forever@temp.test', 'kept@temp.test']);
        }
        assert.deepEqual(mailAddresses(db, 'sendbox'), ['forever@temp.test', 'kept@temp.test']);
    });
}

test('address cleanup still makes progress when the oldest batch is all protected', async () => {
    const db = createD1();
    seedAddresses(db);
    // 批量为 1，最旧的是永久邮箱；保留期条件在 LIMIT 之前，所以仍会删到普通地址
    await runAddressCleanup(db, 'addressCreated', 1, 1);
    await runAddressCleanup(db, 'addressCreated', 1, 1);
    assert.deepEqual(addressNames(db), ['forever@temp.test', 'kept@temp.test']);
});

test('address cleanup keeps bound permanent addresses and their bindings', async () => {
    const db = createD1();
    seedAddresses(db);
    db.raw.exec(`INSERT INTO users (user_email, password) VALUES ('u@example.test', 'x')`);
    db.raw.exec(`INSERT INTO users_address (user_id, address_id) SELECT 1, id FROM address WHERE name = 'forever@temp.test'`);
    await runAddressCleanup(db, 'addressCreated');
    const bound = db.raw.prepare(
        `SELECT a.name FROM users_address ua JOIN address a ON a.id = ua.address_id`
    ).all().map((row) => row.name);
    assert.deepEqual(bound, ['forever@temp.test']);
});

test('mails and sendbox cleanup skip protected addresses', async () => {
    const db = createD1();
    seedAddresses(db);
    // 地址已不存在的邮件也照常清理
    db.raw.exec(`INSERT INTO raw_mails (address, source, raw, created_at) VALUES ('gone@temp.test', 'a@b.test', 'raw', datetime('now', '-10 day'))`);
    await db.prepare(MAILS_CLEANUP_SQL).bind('-1 day', 100).run();
    await db.prepare(SENDBOX_CLEANUP_SQL).bind('-1 day', 100).run();
    assert.deepEqual(mailAddresses(db, 'raw_mails'), ['forever@temp.test', 'kept@temp.test']);
    assert.deepEqual(mailAddresses(db, 'sendbox'), ['forever@temp.test', 'kept@temp.test']);
});

test('mails cleanup keeps recent mails', async () => {
    const db = createD1();
    db.raw.exec(`INSERT INTO raw_mails (address, source, raw) VALUES ('plain@temp.test', 'a@b.test', 'raw')`);
    await db.prepare(MAILS_CLEANUP_SQL).bind('-1 day', 100).run();
    assert.deepEqual(mailAddresses(db, 'raw_mails'), ['plain@temp.test']);
});

test('isRetentionType accepts only known retention types', () => {
    assert.equal(isRetentionType('temporary'), true);
    assert.equal(isRetentionType('extended'), true);
    assert.equal(isRetentionType('permanent'), true);
    assert.equal(isRetentionType('forever'), false);
    assert.equal(isRetentionType(undefined), false);
});

test('resolveIpDomainCreateLimit parses the env value', () => {
    assert.equal(resolveIpDomainCreateLimit(undefined), 5);
    assert.equal(resolveIpDomainCreateLimit(''), 5);
    assert.equal(resolveIpDomainCreateLimit('3'), 3);
    assert.equal(resolveIpDomainCreateLimit(0), 0);
    assert.equal(resolveIpDomainCreateLimit('abc'), 5);
});

test('shouldCheckIpDomainLimit skips users with a role', () => {
    assert.equal(shouldCheckIpDomainLimit({ sourceIp: '1.2.3.4', hasRole: false, limit: 5 }), true);
    assert.equal(shouldCheckIpDomainLimit({ sourceIp: '1.2.3.4', hasRole: true, limit: 5 }), false);
    assert.equal(shouldCheckIpDomainLimit({ sourceIp: '1.2.3.4', hasRole: false, limit: 0 }), false);
    assert.equal(shouldCheckIpDomainLimit({ sourceIp: 'web:unknown', hasRole: false, limit: 5 }), false);
    assert.equal(shouldCheckIpDomainLimit({ sourceIp: '', hasRole: false, limit: 5 }), false);
});

test('IP × base domain count includes subdomains only of that base domain', async () => {
    const db = createD1();
    const insert = db.raw.prepare(`INSERT INTO address (name, source_meta) VALUES (?, ?)`);
    insert.run('a@temp.test', '1.2.3.4');
    insert.run('b@x1.temp.test', '1.2.3.4');
    insert.run('c@nottemp.test', '1.2.3.4');
    insert.run('d@temp.test', '5.6.7.8');
    insert.run('e@other.test', '1.2.3.4');
    assert.equal(await countAddressesByIpAndBaseDomain(db, '1.2.3.4', 'temp.test'), 2);
    assert.equal(await countAddressesByIpAndBaseDomain(db, '1.2.3.4', 'TEMP.TEST'), 2);
    assert.equal(await countAddressesByIpAndBaseDomain(db, '5.6.7.8', 'temp.test'), 1);
    assert.equal(await countAddressesByIpAndBaseDomain(db, '1.2.3.4', 'other.test'), 1);
});

test('creation is rejected once the IP reaches the limit for a base domain', async () => {
    const db = createD1();
    const limit = 2;
    const create = async (name) => {
        await assertIpDomainLimitNotReached(db, {
            sourceIp: '1.2.3.4', baseDomain: 'temp.test', limit, message: 'limit reached',
        });
        db.raw.prepare(`INSERT INTO address (name, source_meta) VALUES (?, '1.2.3.4')`).run(name);
    };
    await create('a@temp.test');
    await create('b@temp.test');
    await assert.rejects(create('c@temp.test'), (error) => {
        assert.ok(error instanceof IpDomainLimitError);
        assert.equal(error.message, 'limit reached');
        return true;
    });
    // 其他基础域名不受影响
    await assertIpDomainLimitNotReached(db, {
        sourceIp: '1.2.3.4', baseDomain: 'other.test', limit, message: 'limit reached',
    });
    // 有角色的用户不做这项检查（由 shouldCheckIpDomainLimit 决定），超过上限仍能创建
    assert.equal(shouldCheckIpDomainLimit({ sourceIp: '1.2.3.4', hasRole: true, limit }), false);
});
