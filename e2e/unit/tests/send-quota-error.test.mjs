import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SendQuotaError, resendQuotaKind, sendQuotaMessage } from '../../../worker/src/mails_api/send_quota_error.ts';

const msgs = {
    ServerSendMailDailyLimitMsg: '今天的发信额度已用完，请明天再试',
    ServerSendMailMonthlyLimitMsg: '本月的发信额度已用完，请下个月再试，或联系管理员',
    SendMailRateLimitedMsg: '发信太频繁了，请稍等几秒再试',
};

test('Resend quota and rate limit errors are recognised', () => {
    assert.equal(resendQuotaKind('daily_quota_exceeded'), 'daily');
    assert.equal(resendQuotaKind('monthly_quota_exceeded'), 'monthly');
    assert.equal(resendQuotaKind('rate_limit_exceeded'), 'rate');
});

test('other Resend errors are not treated as quota errors', () => {
    for (const name of ['validation_error', 'invalid_from_address', 'restricted_api_key', '', undefined, null]) {
        assert.equal(resendQuotaKind(name), null, String(name));
    }
});

test('each limit kind gets its own friendly message', () => {
    assert.equal(sendQuotaMessage('daily', msgs), msgs.ServerSendMailDailyLimitMsg);
    assert.equal(sendQuotaMessage('monthly', msgs), msgs.ServerSendMailMonthlyLimitMsg);
    assert.equal(sendQuotaMessage('rate', msgs), msgs.SendMailRateLimitedMsg);
});

test('quota errors carry the kind and show only the friendly message', () => {
    const error = new SendQuotaError('daily', msgs.ServerSendMailDailyLimitMsg);
    assert.ok(error instanceof Error);
    assert.equal(error.kind, 'daily');
    assert.equal(error.message, '今天的发信额度已用完，请明天再试');
});

test('subclasses such as the site-wide limit error are still quota errors', () => {
    class SendMailLimitError extends SendQuotaError {}
    const error = new SendMailLimitError('monthly', msgs.ServerSendMailMonthlyLimitMsg);
    assert.ok(error instanceof SendQuotaError);
    assert.equal(error.kind, 'monthly');
});
