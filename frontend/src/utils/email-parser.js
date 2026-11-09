import PostalMime from 'postal-mime';

function humanFileSize(size) {
    const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
    return parseFloat((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

// 附件的 blob: 链接和网站同源：按邮件里声明的 text/html、image/svg+xml 之类生成 blob，
// 用户点开附件（或正文里指向附件的 cid: 链接）时，里面的脚本会以本站身份执行。
// 只有浏览器不会执行脚本的类型保留原类型（可以直接预览），其余一律按二进制下载。
const PREVIEWABLE_ATTACHMENT_TYPE = new RegExp(
    '^(?:image/(?:png|jpe?g|pjpeg|gif|webp|bmp|x-ms-bmp|avif|apng|x-icon|vnd\\.microsoft\\.icon|tiff)'
    + '|audio/[a-z0-9][a-z0-9.+-]*|video/[a-z0-9][a-z0-9.+-]*|application/pdf|text/plain)$'
);

/** 生成附件 blob 时使用的 MIME 类型；不在可预览名单里的都换成 application/octet-stream */
export function safeAttachmentMimeType(declaredType) {
    if (typeof declaredType !== 'string') return 'application/octet-stream';
    const [base, ...params] = declaredType.split(';');
    const type = base.trim().toLowerCase();
    if (!PREVIEWABLE_ATTACHMENT_TYPE.test(type)) return 'application/octet-stream';
    if (type !== 'text/plain') return type;
    // 纯文本保留字符集，避免中文附件乱码
    const charset = params.map((param) => /^\s*charset\s*=\s*"?([a-z0-9._:-]+)"?\s*$/i.exec(param)?.[1])
        .find(Boolean);
    return charset ? `text/plain;charset=${charset.toLowerCase()}` : 'text/plain';
}

function toAttachment(item, { content, contentType, contentId, filename }) {
    const blob = new Blob([content], { type: safeAttachmentMimeType(contentType) });
    const blob_url = URL.createObjectURL(blob);
    if (contentId && contentId.length > 0) {
        item.message = item.message.replace(`cid:${contentId}`, blob_url);
    }
    return {
        id: contentId || Math.random().toString(36).substring(2, 15),
        filename: filename || contentId || "",
        size: humanFileSize(content?.length || 0),
        url: blob_url,
        blob: blob
    }
}

export async function processItem(item) {
    // Try to parse the email using mail-parser-wasm
    item.originalSource = item.source;
    try {
        const { parse_message } = await import('mail-parser-wasm');
        const parsedEmail = parse_message(item.raw);
        item.source = parsedEmail.sender || item.source;
        item.subject = parsedEmail.subject || '';
        item.message = parsedEmail.body_html || parsedEmail.text || '';
        item.text = parsedEmail.text || '';
        item.attachments = parsedEmail.attachments?.map((a_item) => toAttachment(item, {
            content: a_item.content,
            contentType: a_item.content_type,
            contentId: a_item.content_id,
            filename: a_item.filename,
        })) || [];
    } catch (error) {
        console.log('Error parsing email with mail-parser-wasm');
        console.error(error);
    }
    if (item.subject && item.subject.length > 0 && item.message && item.message.length > 0) {
        return item;
    }
    // Fallback to PostalMime
    try {
        const parsedEmail = await PostalMime.parse(item.raw);
        item.source = parsedEmail.from?.address || item.source;
        if (parsedEmail.from?.address && parsedEmail.from.name) {
            item.source = `${parsedEmail.from.name} <${parsedEmail.from.address}>`;
        }
        item.subject = parsedEmail.subject || 'No Subject';
        item.message = parsedEmail.html || parsedEmail.text || item.raw;
        item.text = parsedEmail.text || '';
        item.attachments = parsedEmail.attachments?.map((a_item) => toAttachment(item, {
            content: a_item.content,
            contentType: a_item.mimeType,
            contentId: a_item.contentId,
            filename: a_item.filename,
        })) || [];
    } catch (error) {
        console.log('Error parsing email with PostalMime');
        console.error(error);
        item.subject = 'No Subject';
        item.message = item.raw;
    }
    return item;
}

export function getDownloadEmlUrl(raw) {
    return URL.createObjectURL(
        new Blob([raw], { type: 'text/plain' }
        ))
}

