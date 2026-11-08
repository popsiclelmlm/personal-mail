<script setup>
// 统一收件箱：账号名下所有地址的邮件，可按地址筛选、只看未读，显示每个地址的未读数
import { computed, onMounted, ref, watch } from 'vue';
import { useScopedI18n } from '@/i18n/app'

import { api } from '../../api'
import { useGlobalState } from '../../store'
import MailBox from '../../components/MailBox.vue';

const message = useMessage()
const { openSettings } = useGlobalState()

const { t } = useScopedI18n('views.user.UserMailBox')

const mailBoxKey = ref("")
const addressFilter = ref(null);
const unreadOnly = ref(false);
const addressRows = ref([]);
const totalUnread = ref(0);

const addressFilterOptions = computed(() => addressRows.value.map((item) => ({
    // 未读数直接写在选项里，个人邮箱排在前面
    label: item.unread_count > 0 ? `${item.address} · ${item.unread_count}` : item.address,
    value: item.address_id,
})));

const queryMail = () => {
    mailBoxKey.value = Date.now();
}

const fetchMailData = async (limit, offset) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (addressFilter.value) params.set('address_id', String(addressFilter.value));
    if (unreadOnly.value) params.set('unread', '1');
    return await api.fetch(`/user_api/mails?${params.toString()}`);
}

const fetchUnreadCounts = async () => {
    try {
        const res = await api.fetch(`/user_api/mails/unread_counts`);
        addressRows.value = res.results || [];
        totalUnread.value = res.total_unread || 0;
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

const deleteMail = async (curMailId) => {
    await api.fetch(`/user_api/mails/${curMailId}`, { method: 'DELETE' });
    await fetchUnreadCounts();
};

const updateMailReadStatus = async (id, isUnread) => {
    await api.fetch(`/user_api/mails/${id}/read`, {
        method: 'PATCH',
        body: JSON.stringify({ isUnread })
    });
    await fetchUnreadCounts();
};

watch([addressFilter, unreadOnly], () => {
    queryMail();
});

onMounted(() => {
    fetchUnreadCounts();
});
</script>

<template>
    <div style="margin-top: 10px;">
        <n-space align="center" :wrap="true" :size="12">
            <n-select v-model:value="addressFilter" :options="addressFilterOptions" clearable filterable
                :placeholder="t('addressQueryTip')" style="min-width: 240px; max-width: 100%;" />
            <n-checkbox v-if="openSettings.enableMailReadStatus" v-model:checked="unreadOnly">
                {{ t('unreadOnly') }}<template v-if="totalUnread > 0"> ({{ totalUnread }})</template>
            </n-checkbox>
        </n-space>
        <div style="margin-top: 10px;"></div>
        <MailBox :key="mailBoxKey" :enableUserDeleteEmail="openSettings.enableUserDeleteEmail" :fetchMailData="fetchMailData"
            :deleteMail="deleteMail" :showFilterInput="true"
            :enableMailReadStatus="openSettings.enableMailReadStatus" :updateMailReadStatus="updateMailReadStatus" />
    </div>
</template>
