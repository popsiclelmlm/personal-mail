<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGlobalState } from '../store'
import { getPrivacyPolicy } from './legal/privacy-policy-content'

const { openSettings } = useGlobalState()
const { locale } = useI18n({ useScope: 'global' })

const policy = computed(() => getPrivacyPolicy(locale.value))

// 联系方式取自 ADMIN_CONTACT；像邮箱地址时显示成 mailto 链接
const contact = computed(() => (openSettings.value.adminContact || '').trim())
const contactIsEmail = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.value))

// 把含 {contact} 的段落拆成前后两段，中间插入联系方式
const splitContact = (text) => {
    const [before, after = ''] = text.split('{contact}')
    return { before, after, hasContact: text.includes('{contact}') }
}
</script>

<template>
    <div class="policy">
        <n-card :bordered="false" embedded>
            <n-h1 class="policy-title">{{ policy.title }}</n-h1>
            <n-text depth="3">{{ policy.updatedLabel }}{{ policy.updated }}</n-text>
            <n-p v-for="(text, i) in policy.intro" :key="`intro-${i}`">{{ text }}</n-p>
            <section v-for="section in policy.sections" :key="section.title">
                <n-h2 class="policy-section-title">{{ section.title }}</n-h2>
                <n-p v-for="(text, i) in section.paragraphs || []" :key="`p-${i}`">
                    <template v-if="splitContact(text).hasContact">
                        {{ splitContact(text).before }}<a v-if="contact && contactIsEmail" :href="`mailto:${contact}`">{{
                            contact }}</a><span v-else>{{ contact || policy.fallbackContact }}</span>{{
                            splitContact(text).after }}
                    </template>
                    <template v-else>{{ text }}</template>
                </n-p>
                <n-ul v-if="section.items">
                    <n-li v-for="(item, i) in section.items" :key="`li-${i}`">{{ item }}</n-li>
                </n-ul>
                <n-p v-for="(text, i) in section.after || []" :key="`after-${i}`">{{ text }}</n-p>
            </section>
        </n-card>
    </div>
</template>

<style scoped>
.policy {
    max-width: 820px;
    margin: 0 auto;
    text-align: left;
}

.policy-title {
    margin-bottom: 4px;
}

.policy-section-title {
    margin-top: 28px;
    margin-bottom: 8px;
    font-size: 18px;
}

.policy :deep(.n-p),
.policy :deep(.n-li) {
    line-height: 1.75;
}
</style>
