<script setup>
// 「邮箱」页：登录后的个人邮箱。上面列出名下的个人邮箱并可直接创建（只能用个人邮箱专用域名），
// 下面是账号名下所有地址的统一收件箱。没登录时显示账号登录。
import { computed, ref, watch } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { AddOutlined } from '@vicons/material'

import { useGlobalState } from '../store'
import { api } from '../api'
import UserBar from './user/UserBar.vue'
import UserMailBox from './user/UserMailBox.vue'

const message = useMessage()
const { userSettings, openSettings, showUserSystem } = useGlobalState()
const { t } = useScopedI18n('views.Mailbox')

const personalDomains = computed(() => openSettings.value.personalMailDomains || [])
const domainOptions = computed(() => personalDomains.value.map((domain) => ({ label: domain, value: domain })))

const personalRows = ref([])
const showCreate = ref(false)
const newName = ref('')
const newDomain = ref(null)
const creating = ref(false)
const inboxKey = ref(0)

const fetchPersonalMailboxes = async () => {
    try {
        const res = await api.fetch('/user_api/mails/unread_counts')
        personalRows.value = (res.results || []).filter((row) => row.is_permanent)
    } catch (error) {
        message.error(error.message || 'error')
    }
}

const createPersonalMailbox = async () => {
    const name = newName.value.trim()
    if (!name) {
        message.error(t('nameRequired'))
        return
    }
    creating.value = true
    try {
        const res = await api.fetch('/user_api/personal_mailbox', {
            method: 'POST',
            body: JSON.stringify({ name, domain: newDomain.value || personalDomains.value[0] }),
        })
        message.success(t('created', { address: res.address }))
        newName.value = ''
        showCreate.value = false
        await fetchPersonalMailboxes()
        // 刷新统一收件箱里的地址筛选
        inboxKey.value += 1
    } catch (error) {
        message.error(error.message || 'error')
    } finally {
        creating.value = false
    }
}

watch(() => userSettings.value.user_email, (email) => {
    if (email) fetchPersonalMailboxes()
}, { immediate: true })

watch(personalDomains, (domains) => {
    if (!newDomain.value && domains.length > 0) newDomain.value = domains[0]
}, { immediate: true })
</script>

<template>
    <div v-if="showUserSystem">
        <UserBar v-if="!userSettings.user_email" />
        <template v-else>
            <n-card :bordered="false" embedded class="personal-card">
                <div class="personal-head">
                    <div class="personal-head-text">
                        <div class="personal-title">{{ t('personalMailboxes') }}</div>
                        <n-text depth="3" class="personal-tip">{{ t('personalTip') }}</n-text>
                    </div>
                    <n-button v-if="personalDomains.length > 0" type="primary" secondary
                        @click="showCreate = !showCreate">
                        <template #icon>
                            <n-icon :component="AddOutlined" />
                        </template>
                        {{ t('create') }}
                    </n-button>
                </div>
                <div v-if="showCreate" class="create-row">
                    <n-input v-model:value="newName" class="create-name" :placeholder="t('namePlaceholder')"
                        :maxlength="openSettings.maxAddressLen" @keyup.enter="createPersonalMailbox" />
                    <span class="create-at">@</span>
                    <n-select v-if="domainOptions.length > 1" v-model:value="newDomain" class="create-domain"
                        :options="domainOptions" :consistent-menu-width="false" />
                    <span v-else class="create-domain-text">{{ personalDomains[0] }}</span>
                    <n-button type="primary" :loading="creating" @click="createPersonalMailbox">
                        {{ t('confirmCreate') }}
                    </n-button>
                </div>
                <div v-if="personalRows.length > 0" class="personal-list">
                    <n-tag v-for="row in personalRows" :key="row.address_id" round :bordered="false" size="medium">
                        {{ row.address }}
                        <template v-if="row.unread_count > 0"> · {{ row.unread_count }}</template>
                    </n-tag>
                </div>
                <n-text v-else depth="3" class="personal-empty">{{ t('noPersonal') }}</n-text>
            </n-card>
            <UserMailBox :key="inboxKey" />
        </template>
    </div>
</template>

<style scoped>
.personal-card {
    margin-top: 10px;
    text-align: left;
}

.personal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}

.personal-head-text {
    min-width: 0;
}

.personal-title {
    font-size: 16px;
    font-weight: 600;
}

.personal-tip {
    display: block;
    margin-top: 2px;
    font-size: 13px;
}

.create-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 12px;
}

.create-name {
    flex: 1 1 180px;
    min-width: 0;
}

.create-domain {
    flex: 0 1 200px;
    min-width: 140px;
}

.create-at,
.create-domain-text {
    white-space: nowrap;
}

.personal-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.personal-empty {
    display: block;
    margin-top: 12px;
    font-size: 13px;
}
</style>
