<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../store'
import { getRouterPathWithLang } from '../utils'
import DOMPurify from 'dompurify'
const { openSettings } = useGlobalState()


const { t, locale } = useScopedI18n('views.Footer')
const privacyPath = computed(() => getRouterPathWithLang('/privacy-policy', locale.value))

</script>

<template>
    <div>
        <n-divider class="footer-divider" />
        <div style="text-align: center; padding: 20px">
            <n-space justify="center">
                <n-text depth="3">
                    {{ t('copyright') }} © 2023-{{ new Date().getFullYear() }}
                </n-text>
                <n-text depth="3">
                    <div v-html="DOMPurify.sanitize(openSettings.copyright)"></div>
                </n-text>
                <RouterLink :to="privacyPath" class="footer-link">{{ t('privacyPolicy') }}</RouterLink>
            </n-space>
        </div>
    </div>
</template>


<style scoped>
.footer-divider {
    margin: 0;
    padding: 0 var(--x-padding);
}

.footer-link {
    color: var(--n-text-color-3, inherit);
    opacity: 0.75;
    text-decoration: none;
}

.footer-link:hover {
    opacity: 1;
    text-decoration: underline;
}
</style>
