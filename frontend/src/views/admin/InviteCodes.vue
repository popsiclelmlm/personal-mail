<script setup>
// 邀请码管理：REGISTER_MODE = invite 时，新用户凭邀请码注册
import { computed, h, onMounted, ref } from 'vue'
import { NButton, NPopconfirm, NSwitch, NText } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'

import { api } from '../../api'
import { useGlobalState } from '../../store'

const { loading, userOpenSettings } = useGlobalState()
const { t } = useScopedI18n('views.admin.InviteCodes')
const message = useMessage()

const data = ref([])
const count = ref(0)
const page = ref(1)
const pageSize = ref(20)
const roleOptions = ref([])
const createdCodes = ref([])
const form = ref({ count: 1, max_uses: 1, role: null, expires_at: null, note: '' })

// 显示用：每 4 位加一个连字符
const formatCode = (code) => (code || '').replace(/(.{4})(?=.)/g, '$1-')

const createdText = computed(() => createdCodes.value.map(formatCode).join('\n'))

const fetchRoles = async () => {
    try {
        const roles = await api.fetch('/admin/user_roles')
        roleOptions.value = (roles || []).map((item) => ({ label: item.role, value: item.role }))
    } catch (error) {
        message.error(error.message || 'error')
    }
}

const fetchData = async () => {
    try {
        const offset = (page.value - 1) * pageSize.value
        const res = await api.fetch(`/admin/invite_codes?limit=${pageSize.value}&offset=${offset}`)
        data.value = res.results || []
        count.value = res.count || 0
    } catch (error) {
        message.error(error.message || 'error')
    }
}

const createCodes = async () => {
    try {
        const res = await api.fetch('/admin/invite_codes', {
            method: 'POST',
            body: JSON.stringify({
                count: form.value.count,
                max_uses: form.value.max_uses,
                role: form.value.role || null,
                expires_at: form.value.expires_at ? new Date(form.value.expires_at).toISOString() : null,
                note: form.value.note,
            }),
        })
        createdCodes.value = res.codes || []
        message.success(t('created', { count: createdCodes.value.length }))
        page.value = 1
        await fetchData()
    } catch (error) {
        message.error(error.message || 'error')
    }
}

const copyCreated = async () => {
    try {
        await navigator.clipboard.writeText(createdText.value)
        message.success(t('copied'))
    } catch (error) {
        message.error(error.message || 'error')
    }
}

const setEnabled = async (row, enabled) => {
    try {
        await api.fetch(`/admin/invite_codes/${row.id}`, {
            method: 'PUT',
            body: JSON.stringify({ enabled }),
        })
        row.enabled = enabled ? 1 : 0
    } catch (error) {
        message.error(error.message || 'error')
    }
}

const removeCode = async (row) => {
    try {
        await api.fetch(`/admin/invite_codes/${row.id}`, { method: 'DELETE' })
        await fetchData()
    } catch (error) {
        message.error(error.message || 'error')
    }
}

const columns = computed(() => [
    { title: t('code'), key: 'code', render: (row) => h('code', formatCode(row.code)) },
    { title: t('role'), key: 'role', render: (row) => row.role || t('defaultRole') },
    { title: t('uses'), key: 'used_count', render: (row) => `${row.used_count} / ${row.max_uses}` },
    {
        title: t('usedBy'), key: 'used_by',
        render: (row) => row.used_by || h(NText, { depth: 3 }, { default: () => '-' }),
    },
    { title: t('expiresAt'), key: 'expires_at', render: (row) => row.expires_at || t('never') },
    { title: t('note'), key: 'note', render: (row) => row.note || '' },
    {
        title: t('enabled'), key: 'enabled',
        render: (row) => h(NSwitch, {
            value: !!row.enabled,
            size: 'small',
            onUpdateValue: (value) => setEnabled(row, value),
        }),
    },
    {
        title: t('actions'), key: 'actions',
        render: (row) => h(NPopconfirm, { onPositiveClick: () => removeCode(row) }, {
            trigger: () => h(NButton, { size: 'small', tertiary: true, type: 'error' }, { default: () => t('delete') }),
            default: () => t('deleteConfirm'),
        }),
    },
])

onMounted(async () => {
    await Promise.all([fetchRoles(), fetchData()])
})
</script>

<template>
    <div class="invite-codes">
        <n-alert v-if="userOpenSettings.fetched && userOpenSettings.registerMode !== 'invite'" type="info"
            :show-icon="false" :bordered="false">
            {{ t('modeTip') }}
        </n-alert>
        <n-form inline class="invite-form" label-placement="top">
            <n-form-item :label="t('count')">
                <n-input-number v-model:value="form.count" :min="1" :max="50" />
            </n-form-item>
            <n-form-item :label="t('maxUses')">
                <n-input-number v-model:value="form.max_uses" :min="1" :max="1000" />
            </n-form-item>
            <n-form-item :label="t('role')">
                <n-select v-model:value="form.role" :options="roleOptions" clearable
                    :placeholder="t('defaultRole')" style="min-width: 160px;" />
            </n-form-item>
            <n-form-item :label="t('expiresAt')">
                <n-date-picker v-model:value="form.expires_at" type="datetime" clearable />
            </n-form-item>
            <n-form-item :label="t('note')">
                <n-input v-model:value="form.note" maxlength="200" />
            </n-form-item>
            <n-form-item>
                <n-button type="primary" :loading="loading" @click="createCodes">{{ t('create') }}</n-button>
            </n-form-item>
        </n-form>
        <n-card v-if="createdCodes.length" size="small" :bordered="false" embedded>
            <n-space vertical>
                <n-text>{{ t('createdTip') }}</n-text>
                <n-input type="textarea" :value="createdText" readonly :autosize="{ minRows: 1, maxRows: 8 }" />
                <n-button size="small" secondary @click="copyCreated">{{ t('copy') }}</n-button>
            </n-space>
        </n-card>
        <n-data-table :columns="columns" :data="data" :bordered="false" :scroll-x="900" />
        <n-pagination v-if="count > pageSize" v-model:page="page" :page-size="pageSize" :item-count="count"
            @update:page="fetchData" />
    </div>
</template>

<style scoped>
.invite-codes {
    display: flex;
    flex-direction: column;
    gap: 12px;
    text-align: left;
}

/* 窄屏时表单项自动换行 */
.invite-form {
    flex-wrap: wrap;
}
</style>
