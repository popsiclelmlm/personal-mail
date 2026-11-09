<script setup>
import { ref, h, computed, onMounted } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useHead } from '@unhead/vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useIsMobile } from '../utils/composables'
import {
    DarkModeFilled, LightModeFilled, MenuFilled,
    AdminPanelSettingsFilled, MonitorHeartFilled,
    KeyboardArrowDownOutlined, HourglassEmptyOutlined
} from '@vicons/material'
import { Envelope, Language, User } from '@vicons/fa'

import { useGlobalState } from '../store'
import { api } from '../api'
import { getRouterPathWithLang, hashPassword } from '../utils'
import { DEFAULT_LOCALE, isSupportedLocale, replaceLocaleInFullPath } from '../i18n/utils'
import { getLocaleLabel, SUPPORTED_LOCALES } from '../i18n/locale-registry'
import Turnstile from '../components/Turnstile.vue'
import { NButton, NIcon } from 'naive-ui'

const message = useMessage()
const notification = useNotification()

const {
    toggleDark, isDark, isTelegram, showAdminPage, showUserSystem,
    showAuth, auth, loading, openSettings, preferredLocale, userSettings
} = useGlobalState()
const route = useRoute()
const router = useRouter()
const isMobile = useIsMobile()

const showMobileMenu = ref(false)
const menuValue = computed(() => {
    if (route.path.includes("mailbox")) return "mailbox";
    if (route.path.includes("user")) return "user";
    if (route.path.includes("admin")) return "admin";
    return "home";
});

const cfToken = ref('')
const turnstileRef = ref(null)

const authFunc = async () => {
    try {
        await api.fetch('/open_api/site_login', {
            method: 'POST',
            body: JSON.stringify({
                password: await hashPassword(auth.value),
                cf_token: cfToken.value
            })
        });
        location.reload()
    } catch (error) {
        message.error(error.message || "error");
        turnstileRef.value?.refresh?.();
    }
}

const languageOptions = SUPPORTED_LOCALES.map((locale) => ({
    label: getLocaleLabel(locale),
    value: locale,
    key: locale,
}))

const currentLocaleLabel = computed(() => {
    return languageOptions.find(opt => opt.value === locale.value)?.label || locale.value;
});

const { t, locale } = useScopedI18n('views.Header')

const changeLocale = async (lang) => {
    if (!isSupportedLocale(lang)) {
        return;
    }

    const currentFullPath = route.fullPath;
    const targetFullPath = replaceLocaleInFullPath(currentFullPath, lang);

    if (lang === locale.value && targetFullPath === currentFullPath) {
        showMobileMenu.value = false;
        return;
    }

    if (lang === DEFAULT_LOCALE) {
        preferredLocale.value = DEFAULT_LOCALE;
    }

    let localeSwitched = false;
    try {
        await router.push({ path: targetFullPath, force: true });
        localeSwitched = router.currentRoute.value.fullPath === targetFullPath;
        if (!localeSwitched) {
            await router.replace({ path: targetFullPath, force: true });
            localeSwitched = router.currentRoute.value.fullPath === targetFullPath;
        }
    } catch (error) {
        console.error('Failed to switch locale', error);
    } finally {
        showMobileMenu.value = false;
    }

    if (localeSwitched) preferredLocale.value = lang;
}

// 导航顺序：邮箱（账号的个人邮箱）、临时邮箱（首页）、用户中心、管理后台（仅管理员）、深浅色
const menuOptions = computed(() => [
    {
        label: () => h(NButton,
            {
                text: true,
                size: "small",
                type: menuValue.value == "mailbox" ? "primary" : "default",
                style: "width: 100%",
                onClick: async () => {
                    await router.push(getRouterPathWithLang('/mailbox', locale.value));
                    showMobileMenu.value = false;
                }
            },
            {
                default: () => t('mailbox'),
                icon: () => h(NIcon, { component: Envelope })
            }),
        key: "mailbox",
        show: showUserSystem.value && !isTelegram.value
    },
    {
        label: () => h(NButton,
            {
                text: true,
                size: "small",
                type: menuValue.value == "home" ? "primary" : "default",
                style: "width: 100%",
                onClick: async () => {
                    await router.push(getRouterPathWithLang('/', locale.value));
                    showMobileMenu.value = false;
                }
            },
            {
                default: () => t('tempMailbox'),
                icon: () => h(NIcon, { component: HourglassEmptyOutlined })
            }),
        key: "home"
    },
    {
        label: () => h(
            NButton,
            {
                text: true,
                size: "small",
                type: menuValue.value == "user" ? "primary" : "default",
                style: "width: 100%",
                onClick: async () => {
                    await router.push(getRouterPathWithLang("/user", locale.value));
                    showMobileMenu.value = false;
                }
            },
            {
                default: () => t('userCenter'),
                icon: () => h(NIcon, { component: User }),
            }
        ),
        key: "user",
        show: showUserSystem.value && !isTelegram.value
    },
    {
        label: () => h(
            NButton,
            {
                text: true,
                size: "small",
                type: menuValue.value == "admin" ? "primary" : "default",
                style: "width: 100%",
                onClick: async () => {
                    loading.value = true;
                    await router.push(getRouterPathWithLang('/admin', locale.value));
                    loading.value = false;
                    showMobileMenu.value = false;
                }
            },
            {
                default: () => t('admin'),
                icon: () => h(NIcon, { component: AdminPanelSettingsFilled }),
            }
        ),
        show: showAdminPage.value,
        key: "admin"
    },
    {
        label: () => h(
            NButton,
            {
                text: true,
                size: "small",
                style: "width: 100%",
                onClick: () => { toggleDark(); showMobileMenu.value = false; }
            },
            {
                default: () => isDark.value ? t('light') : t('dark'),
                icon: () => h(
                    NIcon, { component: isDark.value ? LightModeFilled : DarkModeFilled }
                )
            }
        ),
        key: "theme"
    },
    {
        label: () => h(
            NButton,
            {
                text: true,
                size: "small",
                style: "width: 100%",
                tag: "a",
                target: "_blank",
                href: openSettings.value?.statusUrl,
            },
            {
                default: () => t('status'),
                icon: () => h(NIcon, { component: MonitorHeartFilled })
            }
        ),
        show: !!openSettings.value?.statusUrl,
        key: "status"
    }
]);

// 标题最后一个词用品牌色，例如 Magpiess + Mail
const titleParts = computed(() => {
    const title = openSettings.value.title || t('title');
    const index = title.lastIndexOf(' ');
    if (index <= 0) return { head: title, tail: '' };
    return { head: title.slice(0, index + 1), tail: title.slice(index + 1) };
});

useHead({
    title: () => openSettings.value.title || t('title'),
    meta: [
        { name: "description", content: openSettings.value.description || t('title') },
    ]
});

onMounted(async () => {
    await api.getOpenSettings(message, notification);
    // make sure user_id is fetched
    if (showUserSystem.value && !userSettings.value.user_id) await api.getUserSettings(message);
});
</script>

<template>
    <div>
        <n-page-header>
            <template #title>
                <h3 class="header-title">
                    {{ titleParts.head }}<span v-if="titleParts.tail" class="header-title-accent">{{ titleParts.tail }}</span>
                </h3>
            </template>
            <template #avatar>
                <img class="header-logo" :class="{ 'header-logo-dark': isDark }" src="/logo-mark.png" width="62" height="36" alt="" />
            </template>
            <template #extra>
                <n-space align="center" class="header-extra">
                    <n-menu v-if="!isMobile" mode="horizontal" :options="menuOptions" responsive />
                    <n-button v-else :text="true" @click="showMobileMenu = !showMobileMenu">
                        <template #icon>
                            <n-icon :component="MenuFilled" />
                        </template>
                        {{ t('menu') }}
                    </n-button>
                    <n-dropdown v-if="!isMobile" :options="languageOptions" @select="changeLocale" trigger="click" class="header-locale-dropdown">
                        <n-button text size="small" class="header-locale-button" style="padding: 0 10px;">
                            <template #icon>
                                <n-icon :component="Language" />
                            </template>
                            {{ currentLocaleLabel }}
                            <n-icon :component="KeyboardArrowDownOutlined" style="margin-left: 4px;" />
                        </n-button>
                    </n-dropdown>
                </n-space>
            </template>
        </n-page-header>
        <n-drawer v-model:show="showMobileMenu" placement="top" style="height: 100vh;">
            <n-drawer-content :title="t('menu')" closable>
                <n-menu :options="menuOptions" />
                <div class="mobile-menu-actions">
                    <n-dropdown :options="languageOptions" @select="changeLocale" trigger="click" class="header-locale-dropdown">
                        <button type="button" class="mobile-menu-utility-button">
                            <n-icon :component="Language" />
                            <span class="mobile-menu-action-label">{{ currentLocaleLabel }}</span>
                            <n-icon :component="KeyboardArrowDownOutlined" class="mobile-menu-action-arrow" />
                        </button>
                    </n-dropdown>
                </div>
            </n-drawer-content>
        </n-drawer>
        <n-modal v-model:show="showAuth" :closable="false" :closeOnEsc="false" :maskClosable="false" preset="dialog"
            :title="t('accessHeader')">
            <p>{{ t('accessTip') }}</p>
            <n-input v-model:value="auth" type="password" show-password-on="click" @keyup.enter="authFunc" />
            <Turnstile ref="turnstileRef" v-if="openSettings.enableGlobalTurnstileCheck" v-model:value="cfToken" />
            <template #action>
                <n-button :loading="loading" @click="authFunc" type="primary">
                    {{ t('ok') }}
                </n-button>
            </template>
        </n-modal>
    </div>
</template>

<style scoped>
.header-logo {
    display: block;
    width: auto;
    height: 36px;
    margin-left: 10px;
}

/* 深色模式下喜鹊的深蓝头部和背景太接近，加一圈淡亮边 */
.header-logo-dark {
    filter: drop-shadow(0 0 0.6px rgba(255, 255, 255, 0.7)) drop-shadow(0 0 2px rgba(255, 255, 255, 0.18));
}

.header-title {
    font-weight: 800;
    letter-spacing: -0.01em;
}

.header-title-accent {
    color: var(--brand-accent-color);
}

:deep(.n-page-header) {
    align-items: center;
    flex-wrap: nowrap;
}

:deep(.n-page-header__main) {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
}

:deep(.n-page-header__title) {
    min-width: 0;
    overflow: hidden;
}

:deep(.n-page-header__title h3) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

:deep(.n-page-header__extra) {
    flex: 0 0 auto;
}

.n-layout-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.header-extra {
    align-items: center;
    flex-wrap: nowrap;
}

.header-extra :deep(.n-space-item) {
    display: flex;
    align-items: center;
}

.header-locale-button {
    display: inline-flex;
    align-items: center;
}

.header-locale-button :deep(.n-button__content) {
    display: inline-flex;
    align-items: center;
}

.header-locale-button :deep(.n-icon) {
    display: inline-flex;
    align-items: center;
}

.mobile-menu-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid rgba(128, 128, 128, 0.16);
}

.mobile-menu-utility-button {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 36px;
    width: 100%;
    min-width: 0;
    padding: 0 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-decoration: none;
    opacity: 0.82;
    cursor: pointer;
}

.mobile-menu-action-label {
    margin: 0 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.mobile-menu-action-arrow {
    flex: 0 0 auto;
    margin-left: 2px;
}

.n-alert {
    margin-top: 10px;
    margin-bottom: 10px;
    text-align: center;
}

.n-card {
    margin-top: 10px;
}

.center {
    display: flex;
    text-align: left;
    place-items: center;
    justify-content: center;
    margin: 20px;
}

.n-form .n-button {
    margin-top: 10px;
}

@media (width < 768px) {
    :deep(.n-page-header) {
        padding-inline: 16px;
    }

    .header-logo {
        margin-left: 0;
    }
}

@media (max-width: 640px) {
    :deep(.n-page-header) {
        padding-block: 10px;
    }

    :deep(.n-page-header__title) {
        min-width: 0;
    }

    :deep(.n-page-header__title h3) {
        max-width: calc(100vw - 104px);
        margin: 0;
        font-size: clamp(16px, 5vw, 20px);
        line-height: 1.2;
    }
}

</style>
