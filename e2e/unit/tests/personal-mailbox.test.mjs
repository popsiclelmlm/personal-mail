import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createD1 } from '../d1-sqlite.mjs';
import { decideAddressCredential } from '../../../worker/src/auth_version.ts';
import { buildAddressCleanupCondition, buildBatchDeleteAddressStatements } from '../../../worker/src/retention.ts';

const decide = (overrides) => decideAddressCredential({
    tokenVersion: 0,
    currentVersion: 0,
    credentialLoginDisabled: false,
    accountSessionValid: false,
    ...overrides,
});

test('address credentials without cv keep working while the version is 0', () => {
    assert.equal(decide({ tokenVersion: undefined }), 'ok');
    assert.equal(decide({ tokenVersion: undefined, currentVersion: null }), 'ok');
});

test('resetting the credential version revokes older credentials', () => {
    assert.equal(decide({ tokenVersion: undefined, currentVersion: 1 }), 'revoked');
    assert.equal(decide({ tokenVersion: 0, currentVersion: 1 }), 'revoked');
    assert.equal(decide({ tokenVersion: 1, currentVersion: 1 }), 'ok');
    assert.equal(decide({ tokenVersion: 'x', currentVersion: 0 }), 'revoked');
});

test('personal mailboxes refuse plain credentials and accept valid account sessions', () => {
    assert.equal(decide({ credentialLoginDisabled: true }), 'credential_login_disabled');
    assert.equal(decide({ credentialLoginDisabled: true, accountSessionValid: true }), 'ok');
    // 账号会话有效也不能绕过凭证版本
    assert.equal(decide({ credentialLoginDisabled: true, accountSessionValid: true, currentVersion: 2 }), 'revoked');
});

test('schema has the personal mailbox columns with safe defaults', () => {
    const db = createD1();
    db.raw.exec(`INSERT INTO address (name) VALUES ('a@temp.test')`);
    const row = db.raw.prepare(
        `SELECT retention_type, is_permanent, credential_version, credential_login_disabled FROM address`
    ).get();
    assert.deepEqual({ ...row }, {
        retention_type: 'temporary', is_permanent: 0, credential_version: 0, credential_login_disabled: 0,
    });
    const userColumns = db.raw.prepare(`PRAGMA table_info(users)`).all().map((col) => col.name);
    assert.ok(userColumns.includes('token_version'));
});

test('personal mailboxes are never cleaned up, whatever the cleanup type', async () => {
    const db = createD1();
    db.raw.exec(`INSERT INTO address (name, is_permanent, retention_type, credential_login_disabled, created_at, updated_at)
        VALUES ('me@personal.test', 1, 'permanent', 1, datetime('now', '-400 day'), datetime('now', '-400 day'))`);
    db.raw.exec(`INSERT INTO raw_mails (address, source, raw, created_at) VALUES ('me@personal.test', 'a@b.test', 'raw', datetime('now', '-400 day'))`);
    for (const cleanType of ['addressCreated', 'inactiveAddress', 'unboundAddress', 'emptyAddress']) {
        for (const sql of buildBatchDeleteAddressStatements(buildAddressCleanupCondition(cleanType, 0, 100))) {
            await db.prepare(sql).run();
        }
    }
    assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM address`).get().n, 1);
    assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM raw_mails`).get().n, 1);
});
