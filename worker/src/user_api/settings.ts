import { Context } from "hono";

import i18n from "../i18n";
import { UserOauth2Settings, UserSettings } from "../models";
import { getJsonSetting, getMaxAddressCount } from "../utils"
import { CONSTANTS } from "../constants";
import { commonGetUserRole, updateUserAddressesUpdatedAt } from "../common";
import { Jwt } from "hono/utils/jwt";
import { USER_TOKEN_REFRESH_WITHIN_SECONDS } from "../auth_version";
import { resolveRegisterMode } from "./invite";
import { signUserToken } from "./user_token";

export default {
    openSettings: async (c: Context<HonoCustomType>) => {
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value);
        const oauth2ClientIDs = [] as { clientID: string, name: string, icon?: string }[];
        try {
            const oauth2Settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
            oauth2ClientIDs.push(
                ...oauth2Settings?.map(s => ({
                    clientID: s.clientID,
                    name: s.name,
                    icon: s.icon,
                })) || []
            );
        } catch (e) {
            console.error("Failed to get oauth2 settings", e);
        }
        const registerMode = resolveRegisterMode(c.env.REGISTER_MODE);
        return c.json({
            enable: settings.enable && registerMode !== 'closed',
            enableMailVerify: settings.enableMailVerify,
            oauth2ClientIDs: oauth2ClientIDs,
            registerMode: registerMode,
            // 重设密码要靠邮箱验证码
            enableResetPassword: !!(settings.enableMailVerify && settings.verifyMailSender && c.env.KV),
        })
    },
    settings: async (c: Context<HonoCustomType>) => {
        const user = c.get("userPayload");
        const msgs = i18n.getMessagesbyContext(c);
        // check if user exists
        const db_user_id = await c.env.DB.prepare(
            `SELECT id FROM users where id = ?`
        ).bind(user.user_id).first<number | undefined | null>("id");
        if (!db_user_id) {
            return c.text(msgs.UserNotFoundMsg, 400);
        }
        const user_role = await commonGetUserRole(c, db_user_id);
        const is_admin = (
            c.env.ADMIN_USER_ROLE
            &&
            c.env.ADMIN_USER_ROLE === user_role?.role
        );
        const access_token = user_role?.role ? await Jwt.sign({
            user_email: user.user_email,
            user_id: user.user_id,
            user_role: user_role.role,
            iat: Math.floor(Date.now() / 1000),
            // 1 hour
            exp: Math.floor(Date.now() / 1000) + 3600,
        }, c.env.JWT_SECRET, "HS256") : null;
        // 剩余有效期不足 4 天时换发新令牌（令牌有效期 7 天，滑动续期）；沿用当前的令牌版本
        const new_user_token = user.exp > (
            Math.floor(Date.now() / 1000) + USER_TOKEN_REFRESH_WITHIN_SECONDS
        ) ? null : await signUserToken(c, {
            user_id: user.user_id, user_email: user.user_email,
        });
        updateUserAddressesUpdatedAt(c, user.user_id);
        // 地址额度：已绑定数、上限、永久邮箱数与上限，只在设置页展示
        const quota = await c.env.DB.prepare(
            `SELECT COUNT(*) AS address_count,`
            + ` COALESCE(SUM(CASE WHEN a.is_permanent = 1 THEN 1 ELSE 0 END), 0) AS permanent_address_count`
            + ` FROM users_address ua JOIN address a ON a.id = ua.address_id WHERE ua.user_id = ?`
        ).bind(db_user_id).first<{ address_count: number, permanent_address_count: number }>();
        const userSettings = new UserSettings(await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY));
        return c.json({
            ...user,
            is_admin: is_admin,
            access_token: access_token,
            new_user_token: new_user_token,
            user_role: user_role,
            address_count: quota?.address_count ?? 0,
            address_limit: await getMaxAddressCount(c, user_role?.role, userSettings),
            permanent_address_count: quota?.permanent_address_count ?? 0,
            max_permanent_address_count: user_role?.max_permanent_address_count ?? 0,
        });
    },
}
