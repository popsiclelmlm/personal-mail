import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FRONTEND_CSP, withFrontendSecurityHeaders } from '../../../worker/src/security_headers.ts';

test('HTML pages get a CSP that forbids inline scripts and event handlers', async () => {
    const res = withFrontendSecurityHeaders(new Response('<html></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"' },
    }));
    const csp = res.headers.get('content-security-policy');
    assert.equal(csp, FRONTEND_CSP);
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), scriptSrc);
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), scriptSrc);
    assert.ok(scriptSrc.includes('https://challenges.cloudflare.com'), 'Turnstile must still load');
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), 'the WebAssembly mail parser must still load');
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // 原有的头、状态和正文保持不变
    assert.equal(res.headers.get('etag'), '"abc"');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<html></html>');
});

test('other static files are passed through untouched', () => {
    const original = new Response('console.log(1)', { headers: { 'content-type': 'application/javascript' } });
    assert.equal(withFrontendSecurityHeaders(original), original);
});
