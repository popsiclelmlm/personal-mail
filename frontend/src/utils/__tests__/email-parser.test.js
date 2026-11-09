import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processItem, safeAttachmentMimeType } from '../email-parser';

vi.mock('mail-parser-wasm', () => ({
    parse_message: () => { throw new Error('Exercise the PostalMime fallback'); },
}));

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment');
});

afterEach(() => vi.restoreAllMocks());

describe('PostalMime fallback', () => {
    it.each([
        ['From: Sender <first@example.com>', 'Sender <first@example.com>'],
        ['From: first@example.com', 'first@example.com'],
        ['fRoM: "Sender, Display"\r\n <first@example.com>', 'Sender, Display <first@example.com>'],
        ['From: =?UTF-8?B?5Y+R5Lu25Lq6?= <first@example.com>', '发件人 <first@example.com>'],
        ['From: First <first@example.com>\r\nFrom: Last <last@example.com>', 'First <first@example.com>'],
        ['From: First <first@example.com>\r\nFrom:', 'First <first@example.com>'],
        ['From:\r\nFrom: Last <last@example.com>', 'bounce@transport.example'],
        ['From: invalid\r\nFrom: Last <last@example.com>', 'bounce@transport.example'],
        ['', 'bounce@transport.example'],
    ])('parses sender: %s', async (header, sender) => {
        const raw = [...(header ? [header] : []), 'Subject: =?UTF-8?B?5rWL6K+V?=',
            'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
            Buffer.from('正文 "quoted" \\path $& ${from}').toString('base64')].join('\r\n');
        const item = await processItem({ raw, source: 'bounce@transport.example' });
        expect(item.originalSource).toBe('bounce@transport.example');
        expect(item.source).toBe(sender);
        expect(item.subject).toBe('测试');
        expect(item.text.trim()).toBe('正文 "quoted" \\path $& ${from}');
        expect(item.message).toBe(item.text);
        expect(item.attachments).toEqual([]);
    });

    it('preserves inline binary bytes, Unicode filenames and attached email content', async () => {
        const binary = Buffer.from([0, 127, 128, 255]);
        const attachedMail = 'From: nested@example.com\r\nSubject: Nested\r\n\r\nNested body';
        const raw = [
            'From: Sender <first@example.com>', 'Subject: Attachments',
            'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=test', '',
            '--test', 'Content-Type: text/html; charset=utf-8', '', '<p>正文</p><img src="cid:picture">',
            '--test', 'Content-Type: image/png', 'Content-ID: <picture>',
            "Content-Disposition: inline; filename*=utf-8''%E5%9B%BE.png", 'Content-Transfer-Encoding: base64', '',
            binary.toString('base64'), '--test', 'Content-Type: message/rfc822',
            'Content-Disposition: attachment; filename="forward.eml"', 'Content-Transfer-Encoding: base64', '',
            Buffer.from(attachedMail).toString('base64'), '--test--',
        ].join('\r\n');
        const item = await processItem({ raw, source: 'bounce@transport.example' });
        expect(item.message).toContain('<p>正文</p>');
        expect(item.attachments[0].id).toBe('<picture>');
        expect(item.attachments.map(file => file.filename)).toEqual(['图.png', 'forward.eml']);
        expect(new Uint8Array(await item.attachments[0].blob.arrayBuffer())).toEqual(new Uint8Array(binary));
        expect(await item.attachments[1].blob.text()).toBe(attachedMail);
        expect(item.attachments[0].blob.type).toBe('image/png');
    });
});

// 附件 blob: 链接和网站同源，可执行的类型不能原样生成 blob（否则点开附件就以本站身份跑脚本）
describe('attachment blob types', () => {
    it.each([
        ['text/html', 'application/octet-stream'],
        ['TEXT/HTML; charset=utf-8', 'application/octet-stream'],
        ['application/xhtml+xml', 'application/octet-stream'],
        ['image/svg+xml', 'application/octet-stream'],
        ['text/xml', 'application/octet-stream'],
        ['application/xml', 'application/octet-stream'],
        ['application/javascript', 'application/octet-stream'],
        ['text/javascript', 'application/octet-stream'],
        ['multipart/related', 'application/octet-stream'],
        ['message/rfc822', 'application/octet-stream'],
        ['application/vnd.ms-excel', 'application/octet-stream'],
        ['', 'application/octet-stream'],
        [undefined, 'application/octet-stream'],
        ['image/png', 'image/png'],
        ['IMAGE/JPEG', 'image/jpeg'],
        ['image/gif; name="a.gif"', 'image/gif'],
        ['application/pdf', 'application/pdf'],
        ['audio/mpeg', 'audio/mpeg'],
        ['video/mp4', 'video/mp4'],
        ['text/plain', 'text/plain'],
        ['text/plain; charset="GB2312"', 'text/plain;charset=gb2312'],
        ['text/plain; charset=<script>', 'text/plain'],
    ])('%s -> %s', (declared, expected) => {
        expect(safeAttachmentMimeType(declared)).toBe(expected);
    });

    it('turns an HTML attachment linked from the body into a download, keeping inline images', async () => {
        const html = '<script>alert(document.domain)</script>';
        const raw = [
            'From: Sender <first@example.com>', 'Subject: Invoice',
            'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=test', '',
            '--test', 'Content-Type: text/html; charset=utf-8', '', '<a href="cid:preview">Preview</a>',
            '--test', 'Content-Type: text/html', 'Content-ID: preview',
            'Content-Disposition: attachment; filename="preview.html"', '', html,
            '--test', 'Content-Type: image/svg+xml', 'Content-Disposition: attachment; filename="logo.svg"', '',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
            '--test', 'Content-Type: image/png', 'Content-Disposition: inline; filename="a.png"',
            'Content-Transfer-Encoding: base64', '', Buffer.from([1, 2, 3]).toString('base64'),
            '--test--',
        ].join('\r\n');
        const item = await processItem({ raw, source: 'bounce@transport.example' });
        expect(item.attachments.map(file => [file.filename, file.blob.type])).toEqual([
            ['preview.html', 'application/octet-stream'],
            ['logo.svg', 'application/octet-stream'],
            ['a.png', 'image/png'],
        ]);
        // 内容不变，只是不会在浏览器里当网页打开
        expect(await item.attachments[0].blob.text()).toBe(html);
        expect(item.message).toContain('href="blob:attachment"');
    });
});
