// 前端页面的安全响应头。本文件不引入其他模块，便于在 Node 里直接做单元测试。

/**
 * 内容安全策略：脚本只允许来自本站、Turnstile 和 Cloudflare 自动注入的访问统计（Web Analytics），
 * 外加 WebAssembly（前端用它解析邮件）；不允许内联脚本、事件处理器和 eval。
 * 万一邮件内容的净化有遗漏，邮件里的脚本也执行不了。
 * 不限制样式和图片：邮件排版依赖内联样式，远程图片由前端按用户设置控制。
 */
export const FRONTEND_CSP = [
    "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "object-src 'none'",
    "base-uri 'self'",
].join('; ');

/** 给 HTML 页面响应加上安全头；其他静态文件原样返回 */
export const withFrontendSecurityHeaders = (res: Response): Response => {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) {
        return res;
    }
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', FRONTEND_CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};
