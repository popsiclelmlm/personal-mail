import { Context, Next } from 'hono';
import { jwt } from 'hono/jwt';
import { Jwt } from 'hono/utils/jwt';

import i18n from './i18n';
import { decideAddressCredential } from './auth_version';
import { getAddressCredentialState, isAccountIssuedCredentialValid } from './address_credential';

export const validateAddressPayload = async (
    c: Context<HonoCustomType>,
    payload: Record<string, unknown>,
): Promise<JwtPayload | null> => {
    const { address, address_id } = payload;
    if (typeof address !== 'string' || !address) return null;
    if (typeof address_id !== 'number'
        && (typeof address_id !== 'string' || !/^\d+$/.test(address_id))
    ) return null;
    const addressId = Number(address_id);
    if (!Number.isSafeInteger(addressId) || addressId <= 0) return null;
    // 地址必须存在；凭证版本 cv 要和数据库一致；关闭了邮箱凭证登录的地址只接受账号会话取得的凭证
    const state = await getAddressCredentialState(c, addressId, address);
    if (!state) return null;
    const accountSessionValid = state.credential_login_disabled
        ? await isAccountIssuedCredentialValid(c, payload, addressId)
        : false;
    const decision = decideAddressCredential({
        tokenVersion: payload.cv,
        currentVersion: state.credential_version,
        credentialLoginDisabled: !!state.credential_login_disabled,
        accountSessionValid,
    });
    return decision === 'ok' ? { address, address_id: addressId } : null;
};

export const verifyAddressToken = async (
    c: Context<HonoCustomType>,
    token: string,
): Promise<JwtPayload> => {
    const payload = await Jwt.verify(token, c.env.JWT_SECRET, 'HS256');
    const addressPayload = payload.type === undefined
        ? await validateAddressPayload(c, payload)
        : null;
    if (!addressPayload) {
        throw new Error(i18n.getMessagesbyContext(c).InvalidAddressCredentialMsg);
    }
    return addressPayload;
};

export const addressJwtAuth = async (c: Context<HonoCustomType>, next: Next) => (
    jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' })(c, async () => {
        const jwtPayload = c.get('jwtPayload');
        const payload = jwtPayload.type === undefined
            ? await validateAddressPayload(c, jwtPayload)
            : null;
        if (!payload) {
            c.res = c.text(i18n.getMessagesbyContext(c).InvalidAddressCredentialMsg, 401);
            return;
        }
        c.set('jwtPayload', payload);
        await next();
    })
);
