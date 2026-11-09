import { computed, ref, watch } from "vue";
import {
    createGlobalState, useStorage, useDark, useToggle,
    useLocalStorage, useSessionStorage
} from '@vueuse/core'
import {
    ADMIN_TOKEN_STORAGE_KEY, isAdminTokenUsable,
    purgeLegacyAdminPassword, scheduleAdminTokenExpiry
} from '../utils/admin-token'

export const useGlobalState = createGlobalState(
    () => {
        const isDark = useDark()
        const toggleDark = useToggle(isDark)
        const loading = ref(false);
        const announcement = useLocalStorage('announcement', '');
        const useSimpleIndex = useLocalStorage('useSimpleIndex', false);
        const openSettings = ref({
            fetched: false,
            title: '',
            announcement: '',
            alwaysShowAnnouncement: false,
            prefix: '',
            addressRegex: '',
            needAuth: false,
            adminContact: '',
            disableUserSystem: false,
            enableUserCreateEmail: false,
            disableAnonymousUserCreateEmail: false,
            disableCustomAddressName: false,
            enableUserDeleteEmail: false,
            enableMailReadStatus: false,
            enableAutoReply: false,
            enableIndexAbout: false,
            /** @type {string[]} */
            defaultDomains: [],
            /** @type {string[]} */
            randomSubdomainDomains: [],
            /** @type {Array<{label: string, value: string}>} */
            domains: [],
            copyright: 'Dream Hunter',
            cfTurnstileSiteKey: '',
            enableWebhook: false,
            isS3Enabled: false,
            enableSendMail: false,
            showGithub: true,
            showGithubForUser: true,
            disableAdminPasswordCheck: false,
            enableAddressPassword: false,
            addressPasswordLoginOnly: false,
            enableAgentEmailInfo: false,
            enableRedeemCode: false,
            redeemCodeUrl: '',
            smtpImapProxyConfig: {
                smtp: {
                    host: '',
                    port: 8025,
                    starttls: false,
                },
                imap: {
                    host: '',
                    port: 11143,
                    starttls: false,
                },
            },
            statusUrl: '',
            enableGlobalTurnstileCheck: false,
        })
        const settings = ref({
            fetched: false,
            send_balance: 0,
            address: '',
            auto_reply: {
                subject: '',
                message: '',
                enabled: false,
                source_prefix: '',
                name: '',
            }
        });
        const sendMailModel = useSessionStorage('sendMailModel', {
            fromName: "",
            toName: "",
            toMail: "",
            subject: "",
            contentType: 'text',
            content: "",
        });
        const showAuth = ref(false);
        const showAddressCredential = ref(false);
        const showAdminAuth = ref(false);
        const auth = useStorage('auth', '');
        // 管理员会话令牌（不再保存管理员密码）；旧版前端存的明文密码启动时清掉
        purgeLegacyAdminPassword();
        const adminToken = useStorage(ADMIN_TOKEN_STORAGE_KEY, '');
        if (adminToken.value && !isAdminTokenUsable(adminToken.value)) {
            adminToken.value = '';
        }
        // 令牌到期时清掉，后台随之回到登录框（其他标签页通过 storage 事件同步）
        let cancelAdminTokenExpiry = null;
        watch(adminToken, (token) => {
            cancelAdminTokenExpiry?.();
            cancelAdminTokenExpiry = token
                ? scheduleAdminTokenExpiry(token, () => {
                    if (adminToken.value === token) adminToken.value = '';
                })
                : null;
        }, { immediate: true });
        const jwt = useStorage('jwt', '');
        const addressPassword = useSessionStorage('addressPassword', '');
        const adminTab = useSessionStorage('adminTab', "account");
        const adminMailTabAddress = ref("");
        const adminSendBoxTabAddress = ref("");
        const mailboxSplitSize = useStorage('mailboxSplitSize', 0.25);
        const mailListView = useStorage('mailListView', false);
        const mailListPreviewLineClamp = useStorage('mailListPreviewLineClamp', 1);
        const useIframeShowMail = useStorage('useIframeShowMail', false);
        const preferShowTextMail = useStorage('preferShowTextMail', false);
        const userJwt = useStorage('userJwt', '');
        const preferredLocale = useStorage('preferredLocale', '');
        const userTab = useSessionStorage('userTab', 'address_management');
        const indexTab = useSessionStorage('indexTab', 'mailbox');
        const globalTabplacement = useStorage('globalTabplacement', 'top');
        const useSideMargin = useStorage('useSideMargin', true);
        const useUTCDate = useStorage('useUTCDate', false);
        const autoLoadRemoteImages = useStorage('autoLoadRemoteImages', true);
        const autoRefresh = useStorage('autoRefresh', false);
        const configAutoRefreshInterval = useStorage("configAutoRefreshInterval", 60);
        const userOpenSettings = ref({
            fetched: false,
            enable: false,
            enableMailVerify: false,
            /** @type {{ clientID: string, name: string, icon?: string }[]} */
            oauth2ClientIDs: [],
            /** 注册策略：open / invite / closed */
            registerMode: 'open',
            /** 是否可以凭邮箱验证码重设密码 */
            enableResetPassword: false,
        });
        const userSettings = ref({
            /** @type {boolean} */
            fetched: false,
            /** 最近一次用登录令牌获取用户信息是否失败（令牌失效、账号不存在或网络异常） @type {boolean} */
            fetch_failed: false,
            /** @type {string} */
            user_email: '',
            /** @type {number} */
            user_id: 0,
            /** @type {boolean} */
            is_admin: false,
            /** @type {string | null} */
            access_token: null,
            /** @type {string | null} */
            new_user_token: null,
            /** @type {null | {domains: string[] | undefined | null, role: string, prefix: string | undefined | null}} */
            user_role: null,
        });
        const showUserSystem = computed(() =>
            openSettings.value.fetched && !openSettings.value.disableUserSystem
        );
        const showUserMailboxes = computed(() =>
            showUserSystem.value && !!userJwt.value
        );
        const showAdminPage = computed(() =>
            !!adminToken.value
            || userSettings.value.is_admin
            || openSettings.value.disableAdminPasswordCheck
        );
        const telegramApp = ref(window.Telegram?.WebApp || {});
        const isTelegram = ref(!!window.Telegram?.WebApp?.initData);
        const _oauth2StateSession = useSessionStorage('userOauth2SessionState', '');
        const _oauth2StateFallback = useStorage('userOauth2SessionState_fb', '');
        const userOauth2SessionState = computed({
            get: () => _oauth2StateSession.value || _oauth2StateFallback.value,
            set: (v) => { _oauth2StateSession.value = v; _oauth2StateFallback.value = v; }
        });
        const _oauth2ClientIDSession = useSessionStorage('userOauth2SessionClientID', '');
        const _oauth2ClientIDFallback = useStorage('userOauth2SessionClientID_fb', '');
        const userOauth2SessionClientID = computed({
            get: () => _oauth2ClientIDSession.value || _oauth2ClientIDFallback.value,
            set: (v) => { _oauth2ClientIDSession.value = v; _oauth2ClientIDFallback.value = v; }
        });
        const browserFingerprint = ref('');
        return {
            isDark,
            toggleDark,
            loading,
            settings,
            sendMailModel,
            announcement,
            openSettings,
            showAuth,
            showAddressCredential,
            auth,
            jwt,
            adminToken,
            showAdminAuth,
            adminTab,
            adminMailTabAddress,
            adminSendBoxTabAddress,
            mailboxSplitSize,
            mailListView,
            mailListPreviewLineClamp,
            useIframeShowMail,
            preferShowTextMail,
            userJwt,
            preferredLocale,
            userTab,
            indexTab,
            userOpenSettings,
            userSettings,
            globalTabplacement,
            useSideMargin,
            useUTCDate,
            autoLoadRemoteImages,
            autoRefresh,
            configAutoRefreshInterval,
            telegramApp,
            isTelegram,
            showAdminPage,
            showUserSystem,
            showUserMailboxes,
            userOauth2SessionState,
            userOauth2SessionClientID,
            useSimpleIndex,
            addressPassword,
            browserFingerprint,
        }
    },
)
