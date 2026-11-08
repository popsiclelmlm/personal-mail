import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import { getBooleanValue } from "../utils";

export default {
    getMails: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address, address_id, unread, limit, offset } = c.req.query();
        const filterQuerys = [`ua.user_id = ?`];
        const filterParams = [String(user_id)];
        if (address) {
            filterQuerys.push(`rm.address = ?`);
            filterParams.push(address);
        }
        // 统一收件箱：按地址 id 筛选、只看未读
        if (address_id) {
            if (!/^\d+$/.test(address_id)) {
                return c.text(i18n.getMessagesbyContext(c).InvalidInputMsg, 400);
            }
            filterQuerys.push(`a.id = ?`);
            filterParams.push(address_id);
        }
        if (unread === '1' || unread === 'true') {
            filterQuerys.push(`rm.is_unread = 1`);
        }
        const fromQuery = ` FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` JOIN raw_mails rm ON rm.address = a.name`
            + ` WHERE ${filterQuerys.join(" AND ")}`;
        return await handleMailListQuery(c,
            `SELECT rm.*${fromQuery}`,
            `SELECT count(*) as count${fromQuery}`,
            filterParams, limit, offset, 'rm.id desc'
        );
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
            return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
        }
        const { id } = c.req.param();
        const { user_id } = c.get("userPayload");
        const { success } = await c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ?`
            + ` AND EXISTS (`
            + `SELECT 1 FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
            + `)`
        ).bind(id, user_id).run();
        return c.json({
            success: success
        })
    }
}
