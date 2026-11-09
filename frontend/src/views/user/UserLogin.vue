<script setup>
import { useMessage } from 'naive-ui'
import { computed, onMounted, ref, watch } from "vue";
import { useScopedI18n } from '@/i18n/app'
import { KeyFilled } from '@vicons/material'

import { api } from '../../api';
import { useGlobalState } from '../../store'
import { hashPassword } from '../../utils';
import { startAuthentication } from '@simplewebauthn/browser';

import Turnstile from '../../components/Turnstile.vue';

const {
    userJwt, userOpenSettings, openSettings,
    userOauth2SessionState, userOauth2SessionClientID
} = useGlobalState()
const message = useMessage();

const { t } = useScopedI18n('views.user.UserLogin')

const tabValue = ref("signin");
const showModal = ref(false);
const user = ref({
    email: "",
    password: "",
    code: "",
    inviteCode: ""
});
// 用个人邮箱注册：账号就是「名字@个人邮箱域名」，注册时自动建好这个个人邮箱
const withMailbox = computed(() => !!userOpenSettings.value.registerWithPersonalMailbox)
const mailboxDomains = computed(() => userOpenSettings.value.personalMailDomains || [])
const mailboxDomainOptions = computed(() => mailboxDomains.value.map((domain) => ({ label: domain, value: domain })))
const mailboxName = ref("")
const mailboxDomain = ref(null)
watch(mailboxDomains, (domains) => {
    if (!mailboxDomain.value && domains.length > 0) mailboxDomain.value = domains[0]
}, { immediate: true })
const loginEmailPlaceholder = computed(() => withMailbox.value && mailboxDomains.value.length > 0
    ? t('loginEmailPlaceholder', { example: `tom@${mailboxDomains.value[0]}` })
    : '')
const signupCfToken = ref("")
const resetCfToken = ref("")
const loginCfToken = ref("")
const signupTurnstileRef = ref(null)
const resetTurnstileRef = ref(null)
const loginTurnstileRef = ref(null)

const emailLogin = async () => {
    if (!user.value.email || !user.value.password) {
        message.error(t('pleaseInput'));
        return;
    }
    try {
        const res = await api.fetch(`/user_api/login`, {
            method: "POST",
            body: JSON.stringify({
                email: user.value.email,
                // hash password
                password: await hashPassword(user.value.password),
                cf_token: loginCfToken.value
            })
        });
        userJwt.value = res.jwt;
        location.reload();
    } catch (error) {
        message.error(error.message || "login failed");
        loginTurnstileRef.value?.refresh?.();
    }
};

const verifyCodeExpire = ref(0);
const verifyCodeTimeout = ref(0);

const getVerifyCodeTimeout = () => {
    if (!verifyCodeExpire.value || verifyCodeExpire.value < new Date().getTime()) return 0;
    return Math.round((verifyCodeExpire.value - new Date().getTime()) / 1000);
};

const sendVerificationCode = async () => {
    if (!user.value.email) {
        message.error(t('pleaseInputEmail'));
        return;
    }
    const currentCfToken = showModal.value ? resetCfToken.value : signupCfToken.value;
    if (openSettings.value.cfTurnstileSiteKey && !currentCfToken && userOpenSettings.value.enableMailVerify) {
        message.error(t('pleaseCompleteTurnstile'));
        return;
    }
    try {
        const res = await api.fetch(`/user_api/verify_code`, {
            method: "POST",
            body: JSON.stringify({
                email: user.value.email,
                cf_token: currentCfToken
            })
        });
        if (res && res.expirationTtl) {
            message.success(t('verifyCodeSent', { timeout: res.expirationTtl }));
            verifyCodeExpire.value = new Date().getTime() + res.expirationTtl * 1000;
            const intervalId = setInterval(() => {
                verifyCodeTimeout.value = getVerifyCodeTimeout();
                if (verifyCodeTimeout.value <= 0) {
                    clearInterval(intervalId);
                    verifyCodeTimeout.value = 0;
                }
            }, 1000);
        }
    } catch (error) {
        message.error(error.message || "send verification code failed");
    }
    if (showModal.value) {
        resetTurnstileRef.value?.refresh?.();
    } else {
        signupTurnstileRef.value?.refresh?.();
    }
};

const mailboxSignup = async () => {
    if (!mailboxName.value.trim() || !user.value.password) {
        message.error(t('pleaseInputMailbox'));
        return;
    }
    try {
        const res = await api.fetch(`/user_api/register`, {
            method: "POST",
            body: JSON.stringify({
                mailbox_name: mailboxName.value.trim(),
                mailbox_domain: mailboxDomain.value || mailboxDomains.value[0],
                password: await hashPassword(user.value.password),
                invite_code: user.value.inviteCode,
                cf_token: signupCfToken.value
            }),
            message: message
        });
        if (res) {
            // 注册成功后把地址填进登录表单
            user.value.email = res.email || '';
            tabValue.value = "signin";
            message.success(t('registeredAs', { address: res.email || '' }));
        }
    } catch (error) {
        message.error(error.message || "register failed");
        signupTurnstileRef.value?.refresh?.();
    }
};

const emailSignup = async () => {
    if (withMailbox.value) {
        await mailboxSignup();
        return;
    }
    if (!user.value.email || !user.value.password) {
        message.error(t('pleaseInput'));
        return;
    }
    if (!user.value.code && userOpenSettings.value.enableMailVerify) {
        message.error(t('pleaseInputCode'));
        return;
    }
    try {
        const res = await api.fetch(`/user_api/register`, {
            method: "POST",
            body: JSON.stringify({
                email: user.value.email,
                // hash password
                password: await hashPassword(user.value.password),
                code: user.value.code,
                invite_code: user.value.inviteCode,
                cf_token: signupCfToken.value
            }),
            message: message
        });
        if (res) {
            tabValue.value = "signin";
            message.success(t('pleaseLogin'));
        }
    } catch (error) {
        message.error(error.message || "register failed");
    }
};

// 凭邮箱验证码重设密码；成功后所有设备都要重新登录
const resetPassword = async () => {
    if (!user.value.email || !user.value.password) {
        message.error(t('pleaseInput'));
        return;
    }
    if (!user.value.code) {
        message.error(t('pleaseInputCode'));
        return;
    }
    try {
        await api.fetch(`/user_api/reset_password`, {
            method: "POST",
            body: JSON.stringify({
                email: user.value.email,
                password: await hashPassword(user.value.password),
                code: user.value.code,
            }),
        });
        showModal.value = false;
        tabValue.value = "signin";
        user.value.code = "";
        message.success(t('passwordResetDone'));
    } catch (error) {
        message.error(error.message || "reset password failed");
    }
};

const passkeyLogin = async () => {
    try {
        const options = await api.fetch(`/user_api/passkey/authenticate_request`, {
            method: 'POST',
            body: JSON.stringify({
                domain: location.hostname,
            })
        })
        const credential = await startAuthentication({ optionsJSON: options })

        // Send the result to the server and return the promise.
        const res = await api.fetch(`/user_api/passkey/authenticate_response`, {
            method: 'POST',
            body: JSON.stringify({
                origin: location.origin,
                domain: location.hostname,
                credential
            })
        })
        userJwt.value = res.jwt;
        location.reload();
    } catch (e) {
        console.error(e)
        message.error(e.message)
    }
};

const oauth2Login = async (clientID) => {
    try {
        userOauth2SessionClientID.value = clientID;
        userOauth2SessionState.value = Math.random().toString(36).substring(2);
        const res = await api.fetch(`/user_api/oauth2/login_url?clientID=${clientID}&state=${userOauth2SessionState.value}`);
        // redirect to oauth2 login page
        location.href = res.url;
    } catch (error) {
        message.error(error.message || "login failed");
    }
};

onMounted(async () => {

});
</script>

<template>
    <div class="center">
        <n-tabs v-model:value="tabValue" size="large" v-if="userOpenSettings.fetched" justify-content="space-evenly">
            <n-tab-pane name="signin" :tab="t('login')">
                <n-form>
                    <n-form-item-row :label="t('email')" required>
                        <n-input v-model:value="user.email" :placeholder="loginEmailPlaceholder || undefined" />
                    </n-form-item-row>
                    <n-form-item-row :label="t('password')" required>
                        <n-input v-model:value="user.password" type="password" show-password-on="click"
                            @keyup.enter="emailLogin" />
                    </n-form-item-row>
                    <Turnstile ref="loginTurnstileRef" v-if="openSettings.enableGlobalTurnstileCheck" v-model:value="loginCfToken" />
                    <n-button @click="emailLogin" type="primary" block secondary strong>
                        {{ t('login') }}
                    </n-button>
                    <n-button @click="showModal = true" type="info" quaternary size="tiny">
                        {{ t('forgotPassword') }}
                    </n-button>
                    <n-divider />
                    <n-button @click="passkeyLogin" type="primary" block secondary strong>
                        <template #icon>
                            <n-icon :component="KeyFilled" />
                        </template>
                        {{ t('loginWithPasskey') }}
                    </n-button>
                    <n-button @click="oauth2Login(item.clientID)" v-for="item in userOpenSettings.oauth2ClientIDs"
                        :key="item.clientID" block secondary strong>
                        <template #icon v-if="item.icon">
                            <span class="oauth2-icon" v-html="item.icon"></span>
                        </template>
                        {{ t('loginWith', { provider: item.name }) }}
                    </n-button>
                </n-form>
            </n-tab-pane>
            <n-tab-pane v-if="userOpenSettings.enable" name="signup" :tab="t('register')">
                <n-form>
                    <n-form-item-row v-if="withMailbox" :label="t('mailboxAccount')" required
                        :feedback="t('mailboxAccountTip')">
                        <div class="mailbox-account">
                            <n-input v-model:value="mailboxName" class="mailbox-account-name"
                                :placeholder="t('mailboxNamePlaceholder')" :maxlength="openSettings.maxAddressLen" />
                            <span class="mailbox-account-at">@</span>
                            <n-select v-if="mailboxDomainOptions.length > 1" v-model:value="mailboxDomain"
                                class="mailbox-account-domain" :options="mailboxDomainOptions"
                                :consistent-menu-width="false" />
                            <span v-else class="mailbox-account-domain-text">{{ mailboxDomains[0] }}</span>
                        </div>
                    </n-form-item-row>
                    <n-form-item-row v-else :label="t('email')" required>
                        <n-input v-model:value="user.email" />
                    </n-form-item-row>
                    <n-form-item-row :label="t('password')" required>
                        <n-input v-model:value="user.password" type="password" show-password-on="click"
                            @keyup.enter="emailSignup" />
                    </n-form-item-row>
                    <n-form-item-row v-if="userOpenSettings.registerMode === 'invite'" :label="t('inviteCode')" required>
                        <n-input v-model:value="user.inviteCode" :placeholder="t('inviteCodePlaceholder')" />
                    </n-form-item-row>
                    <Turnstile ref="signupTurnstileRef" v-if="userOpenSettings.enableMailVerify" v-model:value="signupCfToken" />
                    <n-form-item-row v-if="userOpenSettings.enableMailVerify" :label="t('verifyCode')" required>
                        <n-input-group>
                            <n-input v-model:value="user.code" />
                            <n-button @click="sendVerificationCode" style="margin-bottom: 0" type="primary" ghost
                                :disabled="verifyCodeTimeout > 0">
                                {{ verifyCodeTimeout > 0 ? t('waitforVerifyCode', { timeout: verifyCodeTimeout })
                                    : t('sendVerificationCode') }}
                            </n-button>
                        </n-input-group>
                    </n-form-item-row>
                    <Turnstile ref="signupTurnstileRef" v-if="!userOpenSettings.enableMailVerify" v-model:value="signupCfToken" />
                </n-form>
                <n-button @click="emailSignup" type="primary" block secondary strong>
                    {{ t('register') }}
                </n-button>
            </n-tab-pane>
        </n-tabs>
        <n-modal v-model:show="showModal" style="max-width: 600px;" preset="card" :title="t('forgotPassword')">
            <n-form v-if="userOpenSettings.enableResetPassword">
                <n-form-item-row :label="t('email')" required>
                    <n-input v-model:value="user.email" />
                </n-form-item-row>
                <n-form-item-row :label="t('newPassword')" required>
                    <n-input v-model:value="user.password" type="password" show-password-on="click"
                        @keyup.enter="resetPassword" />
                </n-form-item-row>
                <Turnstile ref="resetTurnstileRef" v-model:value="resetCfToken" />
                <n-form-item-row :label="t('verifyCode')" required>
                    <n-input-group>
                        <n-input v-model:value="user.code" />
                        <n-button @click="sendVerificationCode" style="margin-bottom: 0" type="primary" ghost
                            :disabled="verifyCodeTimeout > 0">
                            {{ verifyCodeTimeout > 0 ? t('waitforVerifyCode', { timeout: verifyCodeTimeout })
                                : t('sendVerificationCode') }}
                        </n-button>
                    </n-input-group>
                </n-form-item-row>
                <n-button @click="resetPassword" type="primary" block secondary strong>
                    {{ t('resetPassword') }}
                </n-button>
            </n-form>
            <n-alert v-else :show-icon="false" :bordered="false">
                <span>
                    {{ t('cannotForgotPassword') }}
                </span>
            </n-alert>
        </n-modal>
    </div>
</template>

<style scoped>
.center {
    display: flex;
    text-align: center;
    place-items: center;
    justify-content: center;
}

.n-button {
    margin-top: 10px;
}

.mailbox-account {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
}

.mailbox-account-name {
    flex: 1 1 auto;
    min-width: 0;
}

.mailbox-account-domain {
    flex: 0 1 180px;
    min-width: 120px;
}

.mailbox-account-at,
.mailbox-account-domain-text {
    white-space: nowrap;
}

.oauth2-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
}

.oauth2-icon :deep(svg) {
    width: 100%;
    height: 100%;
}
</style>
