<script setup>
import { ref } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { startRegistration } from '@simplewebauthn/browser';
import { NButton, NPopconfirm } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { hashPassword } from '../../utils'

const { userJwt, userSettings, } = useGlobalState()
const message = useMessage()

const showLogout = ref(false)
const showLogoutAll = ref(false)
const showDeleteAccount = ref(false)
const deletePreview = ref(null)
const deleteForm = ref({ confirmEmail: '', password: '', actions: {} })
const showCreatePasskey = ref(false)
const passkeyName = ref('')
const showPasskeyList = ref(false)
const showRenamePasskey = ref(false)
const currentPasskeyId = ref(null)
const currentPasskeyName = ref('')
// 辅助邮箱：用来找回密码，修改时要输入当前密码
const showRecoveryEmail = ref(false)
const recoveryForm = ref({ email: '', password: '' })
const savingRecovery = ref(false)

const { t } = useScopedI18n('views.user.UserSettings')


const logout = async () => {
    userJwt.value = '';
    location.reload()
}

// 注销账号：先列出名下的个人邮箱，逐个选择删除或转移
const openDeleteAccount = async () => {
    try {
        const preview = await api.fetch(`/user_api/delete_account/preview`)
        deletePreview.value = preview
        deleteForm.value = {
            confirmEmail: '',
            password: '',
            actions: Object.fromEntries((preview.personal_addresses || []).map(
                (row) => [row.id, { action: 'delete', target: '' }]
            )),
        }
        showDeleteAccount.value = true
    } catch (e) {
        message.error(e.message || 'error')
    }
}

const deleteAccount = async () => {
    const preview = deletePreview.value
    if (!preview) return
    try {
        await api.fetch(`/user_api/delete_account`, {
            method: 'POST',
            body: JSON.stringify({
                confirm_email: deleteForm.value.confirmEmail,
                password: preview.password_required ? await hashPassword(deleteForm.value.password) : undefined,
                personal_addresses: (preview.personal_addresses || []).map((row) => {
                    const item = deleteForm.value.actions[row.id]
                    return item.action === 'transfer'
                        ? { address_id: row.id, action: 'transfer', target_user_email: item.target.trim() }
                        : { address_id: row.id, action: 'delete' }
                }),
            }),
        })
        userJwt.value = ''
        location.reload()
    } catch (e) {
        message.error(e.message || 'error')
    }
}

const openRecoveryEmail = () => {
    recoveryForm.value = { email: userSettings.value.recovery_email || '', password: '' }
    showRecoveryEmail.value = true
}

const saveRecoveryEmail = async () => {
    if (!recoveryForm.value.password) {
        message.error(t('recoveryPasswordRequired'))
        return
    }
    savingRecovery.value = true
    try {
        const res = await api.fetch(`/user_api/recovery_email`, {
            method: 'POST',
            body: JSON.stringify({
                recovery_email: recoveryForm.value.email.trim(),
                password: await hashPassword(recoveryForm.value.password),
            }),
        })
        userSettings.value.recovery_email = res.recovery_email || null
        showRecoveryEmail.value = false
        message.success(t('recoverySaved'))
    } catch (e) {
        message.error(e.message || 'error')
    } finally {
        savingRecovery.value = false
    }
}

// 退出所有设备：服务端令牌版本加 1，包括当前设备在内的所有登录都失效
const logoutAll = async () => {
    try {
        await api.fetch(`/user_api/logout_all`, { method: 'POST' })
        userJwt.value = '';
        location.reload()
    } catch (e) {
        message.error(e.message || 'logout failed')
    }
}

const createPasskey = async () => {
    try {
        const options = await api.fetch(`/user_api/passkey/register_request`, {
            method: 'POST',
            body: JSON.stringify({
                domain: location.hostname,
            })
        })
        const credential = await startRegistration({ optionsJSON: options })

        // Send the result to the server and return the promise.
        await api.fetch(`/user_api/passkey/register_response`, {
            method: 'POST',
            body: JSON.stringify({
                origin: location.origin,
                passkey_name: passkeyName.value || (
                    (window.navigator.userAgentData?.platform || "Unknown")
                    + ": " + Math.random().toString(36).substring(7)
                ),
                credential
            })
        })
        message.success(t('passkeyCreated'));
    } catch (e) {
        console.error(e)
        message.error(e.message)
    } finally {
        passkeyName.value = ''
        showCreatePasskey.value = false
    }
}

const passkeyColumns = [
    {
        title: "Passkey ID",
        key: "passkey_id"
    },
    {
        title: t('passkey_name'),
        key: "passkey_name"
    },
    {
        title: t('created_at'),
        key: "created_at"
    },
    {
        title: t('updated_at'),
        key: "updated_at"
    },
    {
        title: t('actions'),
        key: 'actions',
        render(row) {
            return h('div', [
                [
                    h(NButton,
                        {
                            tertiary: true,
                            type: "primary",
                            onClick: () => {
                                showRenamePasskey.value = true;
                                currentPasskeyId.value = row.passkey_id;
                            }
                        },
                        { default: () => t('renamePasskey') }
                    ),
                    h(NPopconfirm,
                        {
                            onPositiveClick: async () => {
                                try {
                                    await api.fetch(`/user_api/passkey/${row.passkey_id}`, {
                                        method: 'DELETE'
                                    })
                                    await fetchPasskeyList()
                                } catch (e) {
                                    console.error(e)
                                    message.error(e.message)
                                }
                            }
                        },
                        {
                            trigger: () => h(NButton,
                                {
                                    tertiary: true,
                                    type: "error",
                                },
                                { default: () => t('deletePasskey') }
                            ),
                            default: () => `${t('deletePasskey')}?`
                        }
                    ),
                ]
            ])
        }
    }
]

const passkeyData = ref([])

const fetchPasskeyList = async () => {
    try {
        const data = await api.fetch(`/user_api/passkey`)
        passkeyData.value = data
    } catch (e) {
        console.error(e)
        message.error(e.message)
    }
}

const renamePasskey = async () => {
    try {
        await api.fetch(`/user_api/passkey/rename`, {
            method: 'POST',
            body: JSON.stringify({
                passkey_name: currentPasskeyName.value,
                passkey_id: currentPasskeyId.value
            })
        })
        await fetchPasskeyList()
    } catch (e) {
        console.error(e)
        message.error(e.message)
    } finally {
        currentPasskeyName.value = ''
        showRenamePasskey.value = false
    }
}
</script>

<template>
    <div class="center" v-if="userSettings.user_email">
        <n-card :bordered="false" embedded>
            <!-- 额度只在设置页出现 -->
            <n-descriptions :column="1" size="small" label-placement="left" class="quota">
                <n-descriptions-item :label="t('addressQuota')">
                    {{ userSettings.address_count ?? 0 }}<template v-if="userSettings.address_limit > 0"> / {{ userSettings.address_limit }}</template>
                </n-descriptions-item>
                <n-descriptions-item :label="t('personalQuota')">
                    {{ userSettings.permanent_address_count ?? 0 }} / {{ userSettings.max_permanent_address_count ?? 0 }}
                </n-descriptions-item>
                <n-descriptions-item :label="t('recoveryEmail')">
                    <span v-if="userSettings.recovery_email">{{ userSettings.recovery_email }}</span>
                    <n-text v-else depth="3">{{ t('recoveryNotSet') }}</n-text>
                    <n-button text type="primary" size="small" style="margin-left: 8px;" @click="openRecoveryEmail">
                        {{ userSettings.recovery_email ? t('recoveryChange') : t('recoverySet') }}
                    </n-button>
                </n-descriptions-item>
            </n-descriptions>
            <n-button @click="showPasskeyList = true; fetchPasskeyList();" secondary block strong>
                {{ t('showPasskeyList') }}
            </n-button>
            <n-button @click="showCreatePasskey = true" type="primary" secondary block strong>
                {{ t('createPasskey') }}
            </n-button>
            <n-alert :show-icon="false" :bordered="false">
                <span>
                    {{ t('passordTip') }}
                </span>
            </n-alert>
            <n-button @click="showLogout = true" secondary block strong>
                {{ t('logout') }}
            </n-button>
            <n-button @click="showLogoutAll = true" tertiary block>
                {{ t('logoutAll') }}
            </n-button>
            <n-button @click="openDeleteAccount" tertiary block type="error">
                {{ t('deleteAccount') }}
            </n-button>
        </n-card>
        <n-modal v-model:show="showRecoveryEmail" preset="card" :title="t('recoveryEmail')" style="max-width: 480px;">
            <n-form>
                <n-form-item-row :label="t('recoveryEmail')" :feedback="t('recoveryTip')">
                    <n-input v-model:value="recoveryForm.email" :placeholder="t('recoveryPlaceholder')" clearable />
                </n-form-item-row>
                <n-form-item-row :label="t('currentPassword')" required>
                    <n-input v-model:value="recoveryForm.password" type="password" show-password-on="click"
                        @keyup.enter="saveRecoveryEmail" />
                </n-form-item-row>
                <n-button type="primary" block :loading="savingRecovery" @click="saveRecoveryEmail">
                    {{ t('recoverySave') }}
                </n-button>
            </n-form>
        </n-modal>
        <n-modal v-model:show="showDeleteAccount" preset="card" :title="t('deleteAccount')" style="max-width: 560px;">
            <n-space v-if="deletePreview" vertical :size="16">
                <n-text>{{ t('deleteAccountTip') }}</n-text>
                <div v-if="deletePreview.personal_addresses.length">
                    <n-text strong>{{ t('personalMailboxes') }}</n-text>
                    <div v-for="row in deletePreview.personal_addresses" :key="row.id" class="personal-row">
                        <n-text>{{ row.name }}</n-text>
                        <n-radio-group v-model:value="deleteForm.actions[row.id].action" size="small">
                            <n-radio value="delete">{{ t('deleteIt') }}</n-radio>
                            <n-radio value="transfer">{{ t('transferIt') }}</n-radio>
                        </n-radio-group>
                        <n-input v-if="deleteForm.actions[row.id].action === 'transfer'" size="small"
                            v-model:value="deleteForm.actions[row.id].target" :placeholder="t('transferTarget')" />
                    </div>
                </div>
                <n-text v-if="deletePreview.other_addresses.length" depth="3">
                    {{ t('otherAddressesDeleted', { count: deletePreview.other_addresses.length }) }}
                </n-text>
                <n-input v-model:value="deleteForm.confirmEmail" :placeholder="t('typeEmailToConfirm', { email: deletePreview.user_email })" />
                <n-input v-if="deletePreview.password_required" v-model:value="deleteForm.password" type="password"
                    show-password-on="click" :placeholder="t('currentPassword')" />
            </n-space>
            <template #action>
                <n-space justify="end">
                    <n-button size="small" tertiary @click="showDeleteAccount = false">{{ t('cancel') }}</n-button>
                    <n-button size="small" type="error" @click="deleteAccount">{{ t('deleteAccount') }}</n-button>
                </n-space>
            </template>
        </n-modal>
        <n-modal v-model:show="showCreatePasskey" preset="dialog" :title="t('createPasskey')">
            <n-input v-model:value="passkeyName" :placeholder="t('passkeyNamePlaceholder')" />
            <template #action>
                <n-button :loading="loading" @click="createPasskey" size="small" tertiary type="primary">
                    {{ t('createPasskey') }}
                </n-button>
            </template>
        </n-modal>
        <n-modal v-model:show="showRenamePasskey" preset="dialog" :title="t('renamePasskey')">
            <n-input v-model:value="currentPasskeyName" :placeholder="t('renamePasskeyNamePlaceholder')" />
            <template #action>
                <n-button :loading="loading" @click="renamePasskey" size="small" tertiary type="primary">
                    {{ t('renamePasskey') }}
                </n-button>
            </template>
        </n-modal>
        <n-modal v-model:show="showPasskeyList" preset="card" :title="t('showPasskeyList')">
            <n-data-table :columns="passkeyColumns" :data="passkeyData" :bordered="false" embedded />
        </n-modal>
        <n-modal v-model:show="showLogoutAll" preset="dialog" :title="t('logoutAll')">
            <p>{{ t('logoutAllConfirm') }}</p>
            <template #action>
                <n-button @click="logoutAll" size="small" tertiary type="warning">
                    {{ t('logoutAll') }}
                </n-button>
            </template>
        </n-modal>
        <n-modal v-model:show="showLogout" preset="dialog" :title="t('logout')">
            <p>{{ t('logoutConfirm') }}</p>
            <template #action>
                <n-button :loading="loading" @click="logout" size="small" tertiary type="warning">
                    {{ t('logout') }}
                </n-button>
            </template>
        </n-modal>
    </div>
</template>

<style scoped>
.center {
    display: flex;
    justify-content: center;
}

.quota {
    margin-bottom: 8px;
}

.personal-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 0;
}


.n-card {
    max-width: 800px;
    text-align: left;
}

.n-button {
    margin-top: 10px;
    margin-bottom: 10px;
}
</style>
