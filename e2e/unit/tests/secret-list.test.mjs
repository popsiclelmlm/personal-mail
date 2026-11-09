import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSecretList } from '../../../worker/src/secret_list.ts';

test('password lists accept a JSON array', () => {
    assert.deepEqual(parseSecretList('["a", "", "b"]', 'X'), ['a', 'b']);
    assert.deepEqual(parseSecretList(['a', ''], 'X'), ['a']);
});

test('a plain value is used as a single password', () => {
    assert.deepEqual(parseSecretList('  plain-pass@1  ', 'X'), ['plain-pass@1']);
    assert.deepEqual(parseSecretList('', 'X'), []);
    assert.deepEqual(parseSecretList(undefined, 'X'), []);
});

test('a broken JSON array never leaks the value into the log', () => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
        assert.deepEqual(parseSecretList('[secret-value', 'ADMIN_PASSWORDS'), ['[secret-value']);
    } finally {
        console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes('secret-value'), logged[0]);
});
