// @vitest-environment jsdom
// 邮件正文在允许远程图片时也必须净化：能执行脚本的内容一律去掉，图片和样式保留
import { describe, it, expect } from 'vitest';
import { sanitizeMailHtml, blockRemoteContent } from '../remote-content-policy';

const PAYLOADS = [
    '<img src="x" onerror="window.__pwned=1">',
    '<svg><animate onbegin="window.__pwned=1" attributeName="x" dur="1s"/></svg>',
    '<script>window.__pwned=1</script>',
    '<a href="javascript:window.__pwned=1">click</a>',
    '<iframe src="javascript:window.__pwned=1"></iframe>',
    '<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>',
    '<object data="javascript:window.__pwned=1"></object>',
    '<embed src="javascript:window.__pwned=1">',
    '<body onload="window.__pwned=1">',
    '<details open ontoggle="window.__pwned=1">',
    '<form><button formaction="javascript:window.__pwned=1">x</button></form>',
    '<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned=1"></style></mglyph></table></mtext></math>',
    '<noscript><p title="</noscript><img src=x onerror=window.__pwned=1>"></noscript>',
    '<base href="javascript:/">',
    '<meta http-equiv="refresh" content="0;url=javascript:window.__pwned=1">',
    '<link rel="import" href="https://evil.example/x.html">',
];

// 净化结果里不能再有任何可执行的东西
function executable(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const found = [];
    for (const el of doc.querySelectorAll('*')) {
        if (['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'META', 'LINK'].includes(el.tagName)) {
            found.push(el.tagName);
        }
        for (const a of el.attributes) {
            if (/^on/i.test(a.name)) found.push(`${el.tagName}[${a.name}]`);
            if (/^\s*javascript:/i.test(a.value)) found.push(`${el.tagName}[${a.name}]=javascript:`);
        }
    }
    return found;
}

describe('sanitizeMailHtml', () => {
    it('the checker itself flags unsanitized payloads', () => {
        expect(executable('<img src="x" onerror="1">')).not.toEqual([]);
        expect(executable('<a href="javascript:1">x</a>')).not.toEqual([]);
        expect(executable('<script>1</script>')).not.toEqual([]);
    });

    it.each(PAYLOADS)('removes executable content: %s', (payload) => {
        expect(executable(sanitizeMailHtml(`<p>hi</p>${payload}`))).toEqual([]);
    });

    it('keeps remote images, inline images and links', () => {
        const html = '<img src="https://img.example/a.png"><img src="blob:https://mail.example/1">'
            + '<a href="https://example.com/x">x</a>';
        const out = sanitizeMailHtml(html);
        expect(out).toContain('src="https://img.example/a.png"');
        expect(out).toContain('src="blob:https://mail.example/1"');
        expect(out).toContain('href="https://example.com/x"');
    });

    it('keeps a leading <style> block and inline styles', () => {
        const out = sanitizeMailHtml('<style>p{color:red}</style><p style="font-weight:bold">x</p>');
        expect(out).toContain('<style>p{color:red}</style>');
        expect(out).toContain('style="font-weight:bold"');
    });

    it('returns an empty string for missing content', () => {
        expect(sanitizeMailHtml(undefined)).toBe('');
        expect(sanitizeMailHtml(null)).toBe('');
        expect(sanitizeMailHtml('')).toBe('');
    });

    it('does not run event handlers while sanitizing', async () => {
        window.__pwned = 0;
        sanitizeMailHtml('<img src="x" onerror="window.__pwned=1">');
        await new Promise((r) => setTimeout(r, 50));
        expect(window.__pwned).toBe(0);
    });
});

describe('blockRemoteContent', () => {
    it.each(PAYLOADS)('also removes executable content: %s', (payload) => {
        expect(executable(blockRemoteContent(`<p>hi</p>${payload}`).html)).toEqual([]);
    });
});
