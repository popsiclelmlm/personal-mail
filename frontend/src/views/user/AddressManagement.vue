<script setup>
import { ref, h, onMounted, watch } from 'vue';
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router';
import { NBadge, NPopconfirm, NButton, NDropdown, NTag, NSpace, NText } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang, isPersonalMailDomain } from '../../utils'
import AddressCredentialModal from '../../components/AddressCredentialModal.vue'

import Login from '../common/Login.vue';

const { jwt, loading, openSettings } = useGlobalState()
const message = useMessage()
const router = useRouter()

const { locale, t } = useScopedI18n('views.user.AddressManagement')
const { t: credentialT } = useScopedI18n('components.AddressCredentialModal')

const data = ref([])
const count = ref(0)
const page = ref(1)
const pageSize = ref(20)
const addressQuery = ref('')
const activeQuery = ref('')
const showTranferAddress = ref(false)
const currentAddress = ref("")
const currentAddressId = ref(0)
const targetUserEmail = ref('')
const showAddressCredential = ref(false)
const currentAddressCredential = ref('')
const credentialAddress = ref('')

const confirmAction = ref(null)

// 保留期剩余天数（向上取整）；没有到期时间时返回 null
const retentionDaysLeft = (row) => {
    if (!row.retention_until) return null
    const until = new Date(`${row.retention_until.replace(' ', 'T')}Z`).getTime()
    if (!Number.isFinite(until)) return null
    return Math.max(Math.ceil((until - Date.now()) / 86400000), 0)
}

// 个人邮箱和临时邮箱只用一个小标识区分
const renderAddressName = (row) => {
    const daysLeft = retentionDaysLeft(row)
    const tags = []
    if (row.is_permanent) {
        tags.push(h(NTag, { size: 'small', type: 'primary', bordered: false }, { default: () => t('personalMailbox') }))
    } else if (daysLeft !== null) {
        tags.push(h(NText, { depth: 3 }, { default: () => t('retentionDaysLeft', { days: daysLeft }) }))
    }
    return h(NSpace, { size: 6, align: 'center', wrap: false }, {
        default: () => [h('span', row.name), ...tags],
    })
}

// 当前打开的邮箱就是这个地址时，换成账号取得的新凭证，避免关闭凭证登录或重置凭证后被踢出
const refreshCurrentMailbox = async (row, newJwt) => {
    if (!jwt.value) return
    try {
        const payload = JSON.parse(atob(jwt.value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
        if (Number(payload.address_id) !== Number(row.id) && payload.address !== row.name) return
        jwt.value = newJwt || (await api.fetch(`/user_api/bind_address_jwt/${row.id}`)).jwt
    } catch (error) {
        console.log(error)
    }
}

const runAddressAction = async (key, row) => {
    try {
        if (key === 'permanent' || key === 'extended' || key === 'temporary') {
            await api.fetch(`/user_api/bind_address/retention`, {
                method: 'POST',
                body: JSON.stringify({ address_id: row.id, retention_type: key })
            })
            if (key === 'permanent') await refreshCurrentMailbox(row)
        } else if (key === 'resetCredential') {
            const res = await api.fetch(`/user_api/address/${row.id}/reset_credential`, { method: 'POST' })
            await refreshCurrentMailbox(row, res.jwt)
        } else if (key === 'disableCredentialLogin' || key === 'enableCredentialLogin') {
            await api.fetch(`/user_api/address/${row.id}/credential_login`, {
                method: 'POST',
                body: JSON.stringify({ enabled: key === 'enableCredentialLogin' })
            })
            if (key === 'disableCredentialLogin') await refreshCurrentMailbox(row)
        }
        message.success(t('success'))
        await fetchData()
    } catch (error) {
        message.error(error.message || "error")
    }
}

// 次要操作收进「更多」菜单；会让旧凭证失效的操作先确认
// 个人邮箱专用域名下的地址只能是永久邮箱，不提供「保留 30 天」「改回临时」
const isPersonalDomainRow = (row) => isPersonalMailDomain(
    String(row.name || '').split('@').pop(), openSettings.value.personalMailDomains || []
);
const addressMenuOptions = (row) => [
    !row.is_permanent && { label: t('makePersonal'), key: 'permanent' },
    !isPersonalDomainRow(row) && { label: t('keep30Days'), key: 'extended' },
    !isPersonalDomainRow(row) && (row.is_permanent || row.retention_type === 'extended') && { label: t('makeTemporary'), key: 'temporary' },
    { type: 'divider', key: 'd1' },
    { label: t('resetCredential'), key: 'resetCredential' },
    row.credential_login_disabled
        ? { label: t('enableCredentialLogin'), key: 'enableCredentialLogin' }
        : { label: t('disableCredentialLogin'), key: 'disableCredentialLogin' },
].filter(Boolean)

const onAddressMenu = (key, row) => {
    const confirmKeys = ['permanent', 'temporary', 'resetCredential', 'disableCredentialLogin']
    if (confirmKeys.includes(key)) {
        confirmAction.value = { key, row }
        return
    }
    runAddressAction(key, row)
}

const confirmText = (action) => action ? t(`${action.key}Confirm`, { address: action.row.name }) : ''

const closeConfirm = () => { confirmAction.value = null }

const acceptConfirm = async () => {
    const action = confirmAction.value
    confirmAction.value = null
    if (action) await runAddressAction(action.key, action.row)
}

const showCredential = async (row) => {
    try {
        const { jwt: addressCredential } = await api.fetch(`/user_api/bind_address_jwt/${row.id}`)
        currentAddressCredential.value = addressCredential
        credentialAddress.value = row.name
        showAddressCredential.value = true
    } catch (error) {
        message.error(error.message || "error")
    }
}

const changeMailAddress = async (address_id) => {
    try {
        const res = await api.fetch(`/user_api/bind_address_jwt/${address_id}`);
        if (!res.jwt) {
            message.error("jwt not found");
            return;
        }
        jwt.value = res.jwt;
        await router.push(getRouterPathWithLang("/", locale.value))
        location.reload();
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const unbindAddress = async (address_id) => {
    try {
        const res = await api.fetch(`/user_api/unbind_address`, {
            method: 'POST',
            body: JSON.stringify({ address_id })
        });
        message.success(t('unbindAddress') + " " + t('success'));
        if (page.value === 1) {
            await fetchData();
        } else {
            page.value = 1;
        }
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const transferAddress = async () => {
    if (!targetUserEmail.value) {
        message.error("targetUserEmail is required");
        return;
    }
    if (!currentAddressId.value) {
        message.error("currentAddressId is required");
        return;
    }
    try {
        const res = await api.fetch(`/user_api/transfer_address`, {
            method: 'POST',
            body: JSON.stringify({
                address_id: currentAddressId.value,
                target_user_email: targetUserEmail.value
            })
        });
        message.success(t('transferAddress') + " " + t('success'));
        if (page.value === 1) {
            await fetchData();
        } else {
            page.value = 1;
        }
        showTranferAddress.value = false;
        currentAddressId.value = 0;
        currentAddress.value = "";
        targetUserEmail.value = "";
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const fetchData = async () => {
    try {
        const params = new URLSearchParams({
            limit: String(pageSize.value),
            offset: String((page.value - 1) * pageSize.value),
        });
        if (activeQuery.value) params.set('query', activeQuery.value);
        const { results, count: addressCount } = await api.fetch(
            `/user_api/bind_address?${params.toString()}`
        );
        data.value = results;
        if (page.value === 1) {
            count.value = addressCount;
        }
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const searchData = () => {
    const query = addressQuery.value.trim();
    if (query.length > 100 || /[%_]/.test(query)) {
        message.error(t('invalidQuery'));
        return;
    }
    addressQuery.value = query;
    activeQuery.value = addressQuery.value;
    if (page.value === 1) {
        fetchData();
    } else {
        page.value = 1;
    }
}

const columns = [
    {
        title: t('emailAddress'),
        key: "name",
        render: renderAddressName
    },
    {
        title: t('mail_count'),
        key: "mail_count",
        render(row) {
            return h(NBadge, {
                value: row.mail_count,
                'show-zero': true,
                max: 99,
                type: "success"
            })
        }
    },
    {
        title: t('send_count'),
        key: "send_count",
        render(row) {
            return h(NBadge, {
                value: row.send_count,
                'show-zero': true,
                max: 99,
                type: "success"
            })
        }
    },
    {
        title: t('actions'),
        key: 'actions',
        render(row) {
            return h('div', [
                // 关闭了邮箱凭证登录的地址不显示凭证，避免误以为可以拿去别处登录
                !row.credential_login_disabled && h(NButton,
                    {
                        tertiary: true,
                        type: "primary",
                        onClick: () => showCredential(row)
                    },
                    { default: () => credentialT('addressCredential') }
                ),
                h(NPopconfirm,
                    {
                        onPositiveClick: () => changeMailAddress(row.id)
                    },
                    {
                        trigger: () => h(NButton,
                            {
                                tertiary: true,
                                type: "primary",
                            },
                            { default: () => t('openMailbox') }
                        ),
                        default: () => `${t('openMailbox')}?`
                    }
                ),
                h(NButton,
                    {
                        tertiary: true,
                        type: "primary",
                        onClick: () => {
                            currentAddressId.value = row.id;
                            currentAddress.value = row.name;
                            showTranferAddress.value = true;
                        }
                    },
                    { default: () => t('transferAddress') }
                ),
                h(NPopconfirm,
                    {
                        onPositiveClick: () => unbindAddress(row.id)
                    },
                    {
                        trigger: () => h(NButton,
                            {
                                tertiary: true,
                                type: "error",
                            },
                            { default: () => t('unbindAddress') }
                        ),
                        default: () => t('unbindAddressTip')
                    }
                ),
                h(NDropdown,
                    {
                        trigger: 'click',
                        options: addressMenuOptions(row),
                        onSelect: (key) => onAddressMenu(key, row)
                    },
                    { default: () => h(NButton, { tertiary: true }, { default: () => t('more') }) }
                ),
            ])
        }
    }
]

onMounted(async () => {
    await fetchData()
})

watch([page, pageSize], async () => {
    await fetchData();
})
</script>

<template>
    <div>
        <AddressCredentialModal v-model:show="showAddressCredential" :address="credentialAddress"
            :jwt="currentAddressCredential" />
        <n-modal v-model:show="showTranferAddress" preset="dialog" :title="t('transferAddress')">
            <span>
                <p>{{ t("transferAddressTip") }}</p>
                <p>{{ t('transferAddress') + ": " + currentAddress }}</p>
                <n-input v-model:value="targetUserEmail" :placeholder="t('targetUserEmail')" />
            </span>
            <template #action>
                <n-button :loading="loading" @click="transferAddress" size="small" tertiary type="error">
                    {{ t('transferAddress') }}
                </n-button>
            </template>
        </n-modal>
        <n-modal :show="!!confirmAction" preset="dialog" :title="t('confirmTitle')"
            @update:show="(value) => { if (!value) closeConfirm() }">
            <p>{{ confirmText(confirmAction) }}</p>
            <template #action>
                <n-button size="small" tertiary @click="closeConfirm">{{ t('cancel') }}</n-button>
                <n-button :loading="loading" size="small" type="primary" @click="acceptConfirm">
                    {{ t('confirm') }}
                </n-button>
            </template>
        </n-modal>
        <n-tabs type="segment">
            <n-tab-pane name="address" :tab="t('address')">
                <n-input-group style="margin-top: 10px;">
                    <n-input v-model:value="addressQuery" data-testid="user-address-search" clearable :placeholder="t('addressQueryTip')"
                        @keydown.enter="searchData" />
                    <n-button @click="searchData" type="primary" tertiary>
                        {{ t('query') }}
                    </n-button>
                </n-input-group>
                <div class="address-table-scroll">
                    <n-pagination v-model:page="page" v-model:page-size="pageSize" :item-count="count"
                        :page-sizes="[20, 50, 100]" show-size-picker>
                        <template #prefix="{ itemCount }">
                            {{ t('itemCount') }}: {{ itemCount }}
                        </template>
                    </n-pagination>
                    <n-data-table :columns="columns" :data="data" :bordered="false" embedded />
                </div>
            </n-tab-pane>
            <n-tab-pane name="create_or_bind" :tab="t('create_or_bind')">
                <Login />
            </n-tab-pane>
        </n-tabs>
    </div>
</template>

<style scoped>
.n-data-table {
    min-width: 760px;
}

.address-table-scroll {
    max-width: 100%;
    overflow-x: auto;
}

.n-pagination {
    margin-top: 10px;
    margin-bottom: 10px;
}
</style>
