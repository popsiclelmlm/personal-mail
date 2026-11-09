/**
 * 解析密码列表类的配置（ADMIN_PASSWORDS、PASSWORDS）：
 * - JSON 数组：`["a", "b"]`；
 * - 不是 JSON 数组时，把整个字符串当成一个密码（`wrangler secret put` 时直接输入密码也能用）。
 * 解析失败时只记录配置名，不输出原值，避免密码出现在日志里。
 */
export const parseSecretList = (
    value: string | string[] | undefined | null,
    name: string,
): string[] => {
    if (!value) return [];
    const clean = (items: unknown[]): string[] => items
        .filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (Array.isArray(value)) return clean(value);
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(text);
            if (Array.isArray(parsed)) return clean(parsed);
        } catch {
            console.error(`${name} is not a valid JSON array; using the whole value as one password`);
        }
    }
    return [text];
};
