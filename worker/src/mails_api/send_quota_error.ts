/**
 * 发信额度或频率受限（站内发信额度，或 Resend 等服务商的额度）。
 * message 是直接给用户看的提示，调用方据此返回 429，不再拼成笼统的「发送失败」。
 */
export type SendQuotaKind = 'daily' | 'monthly' | 'rate';

export class SendQuotaError extends Error {
    kind: SendQuotaKind;

    constructor(kind: SendQuotaKind, message: string) {
        super(message);
        this.name = 'SendQuotaError';
        this.kind = kind;
    }
}

/** Resend 返回的错误名对应的限制类型；不是额度或频率问题时返回 null */
export const resendQuotaKind = (errorName: unknown): SendQuotaKind | null => {
    switch (errorName) {
        case 'daily_quota_exceeded': return 'daily';
        case 'monthly_quota_exceeded': return 'monthly';
        case 'rate_limit_exceeded': return 'rate';
        default: return null;
    }
};

type SendQuotaMessages = {
    ServerSendMailDailyLimitMsg: string,
    ServerSendMailMonthlyLimitMsg: string,
    SendMailRateLimitedMsg: string,
};

/** 按限制类型取给用户看的提示 */
export const sendQuotaMessage = (kind: SendQuotaKind, msgs: SendQuotaMessages): string => {
    if (kind === 'daily') return msgs.ServerSendMailDailyLimitMsg;
    if (kind === 'monthly') return msgs.ServerSendMailMonthlyLimitMsg;
    return msgs.SendMailRateLimitedMsg;
};
