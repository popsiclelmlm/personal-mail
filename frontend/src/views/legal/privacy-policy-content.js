// 隐私政策与使用规范的正文。
// 法律文本只维护中文和英文两份，其他界面语言显示英文，避免机器翻译带来歧义。
// 修改正文时同步修改两种语言，并更新 PRIVACY_POLICY_UPDATED。
// 每节：title 标题；paragraphs 段落；items 列表；after 列表后的段落。
// 文本里的 {contact} 会被替换成管理员联系方式（ADMIN_CONTACT），没配置时用 fallbackContact。

export const PRIVACY_POLICY_UPDATED = '2026-11-09'

const zh = {
    title: '隐私政策与使用规范',
    updatedLabel: '更新日期：',
    updated: '2026 年 11 月 9 日',
    intro: [
        'Magpiess Mail（下称「本站」）提供个人邮箱和临时邮箱服务。本政策说明本站收集哪些信息、如何使用和保存这些信息，以及使用本站必须遵守的规范。',
        '使用本站即表示你已阅读并同意本政策。如果你不同意，请停止使用本站。',
    ],
    fallbackContact: '本站管理员',
    sections: [
        {
            title: '一、我们收集的信息',
            items: [
                '账号信息：登录地址（名字@个人邮箱域名）、经过加盐哈希处理的密码、你选填的辅助邮箱，以及你设置的 Passkey 公钥。本站不保存密码明文。',
                '邮件内容：发往你的地址的邮件（包括发件人、收件人、主题、正文、附件和邮件头），以及你通过本站发出的邮件记录。',
                '网络信息：创建邮箱、注册、登录和发信时的 IP 地址，以及 Cloudflare 根据 IP 判断的大致地理位置。',
                '人机验证信息：Cloudflare Turnstile 在验证时会处理浏览器和设备的技术信号。',
            ],
            after: ['本站不投放广告，也不使用第三方统计或追踪工具。'],
        },
        {
            title: '二、信息的用途',
            items: [
                '提供收信、发信、登录和找回密码等功能；',
                '防止滥用，例如限制同一 IP 的创建次数、拦截暴力破解和自动化请求；',
                '处理投诉、排查故障和保障安全；',
                '在法律要求时配合有权机关。',
            ],
            after: ['本站不会出售你的个人信息，也不会把邮件内容用于广告。'],
        },
        {
            title: '三、存储位置与保存期限',
            items: [
                '数据保存在 Cloudflare 的数据库和存储服务中，存储位置可能在你所在的国家或地区以外。',
                '个人邮箱及其邮件在你删除之前一直保存。',
                '临时邮箱不保证长期保存，可能按本站的清理规则被删除，请不要用它接收重要邮件。',
                '找回密码的验证码 5 分钟后失效；登录失败次数等安全记录会在短时间后自动过期。',
                '删除邮箱或注销账号后，相关邮件和记录会从数据库中删除；服务商的备份可能在一段时间内仍保留副本。',
            ],
        },
        {
            title: '四、第三方服务',
            paragraphs: ['本站依赖以下服务商，它们按各自的隐私政策处理数据：'],
            items: [
                'Cloudflare：网站托管、数据库、邮件接收（Email Routing）和人机验证（Turnstile）。',
                'Resend：发送找回密码验证码、密码重设通知，以及管理员开通发信权限后的用户发信。Resend 会处理收件人地址和邮件内容。',
            ],
        },
        {
            title: '五、本地存储与 Cookie',
            items: [
                '本站在浏览器的本地存储（localStorage）中保存登录令牌、邮箱凭证和界面偏好（语言、深浅色）。',
                'Cloudflare 可能为安全防护和人机验证设置必要的 Cookie。',
                '本站不使用广告 Cookie 或跨站追踪 Cookie。',
                '退出登录会清除本地保存的登录令牌。',
            ],
        },
        {
            title: '六、谁能看到你的邮件',
            items: [
                '你本人，以及任何拿到该邮箱凭证或登录令牌的人。临时邮箱的凭证一旦泄露，别人就能读取其中的邮件，请妥善保管。',
                '本站管理员在维护服务、处理投诉或依法配合调查时，可以在管理后台查看邮箱和邮件。',
                '邮件以普通形式保存在数据库中，本站不提供端到端加密，请不要通过本站传递高度敏感的信息。',
            ],
        },
        {
            title: '七、你的权利',
            items: [
                '在用户中心查看账号信息，修改或删除辅助邮箱；',
                '删除邮件和邮箱，或注销账号（注销时可以选择删除或转移名下的个人邮箱）；',
                '忘记密码时通过辅助邮箱找回；没有设置辅助邮箱的，请联系管理员重设；',
                '其他与个人信息有关的请求，请通过文末的联系方式提出。',
            ],
        },
        {
            title: '八、安全措施',
            paragraphs: [
                '密码经过 PBKDF2 加盐哈希后保存，连续输错会被暂时锁定；全站使用 HTTPS；注册、登录、找回密码等操作需要通过人机验证。但任何网络服务都无法保证绝对安全，请使用足够强的密码，并妥善保管登录信息。',
            ],
        },
        {
            title: '九、使用规范：不得用于非法用途',
            paragraphs: ['使用本站时，你不得：'],
            items: [
                '从事任何违反法律法规的活动，包括但不限于诈骗、网络钓鱼、洗钱、赌博，或传播色情、暴力等违法信息；',
                '发送垃圾邮件或未经同意的批量营销邮件，或传播病毒、木马等恶意程序；',
                '冒充他人、其他机构或本站官方，或侵犯他人的隐私、名誉、知识产权等合法权益；',
                '利用本站邮箱批量注册、刷单，或以违反第三方服务条款的方式使用本站邮箱；',
                '攻击或干扰本站，或绕过本站的频率限制和人机验证。',
            ],
            after: [
                '违反上述规范的，本站有权不经通知删除相关邮箱和账号、保留相关记录，并在法律要求时提供给有权机关。由此产生的一切法律责任由使用者自行承担。',
            ],
        },
        {
            title: '十、免责声明',
            paragraphs: [
                '本站按现状提供服务，不保证服务不中断、邮件一定送达或数据永不丢失。请自行备份重要邮件。',
            ],
        },
        {
            title: '十一、未成年人',
            paragraphs: ['本站不面向未满 14 周岁的未成年人。如果你未满 14 周岁，请不要注册或使用本站。'],
        },
        {
            title: '十二、政策更新',
            paragraphs: [
                '本站可能会更新本政策，更新后会修改本页顶部的更新日期；重大变化会尽量在网站上提示。更新后继续使用本站，即表示你接受更新后的政策。',
            ],
        },
        {
            title: '十三、联系我们',
            paragraphs: ['关于本政策或个人信息的任何问题，请联系：{contact}。'],
        },
    ],
}

const en = {
    title: 'Privacy Policy and Acceptable Use',
    updatedLabel: 'Last updated: ',
    updated: 'November 9, 2026',
    intro: [
        'Magpiess Mail ("the site") provides personal and temporary mailboxes. This policy explains what information the site collects, how it is used and stored, and the rules you must follow when using the site.',
        'By using the site you confirm that you have read and agree to this policy. If you do not agree, please stop using the site.',
    ],
    fallbackContact: 'the site administrator',
    sections: [
        {
            title: '1. Information we collect',
            items: [
                'Account information: your sign-in address (name@personal-mail-domain), your password stored as a salted hash, the optional recovery email, and the public key of any passkey you register. The site never stores your password in plain text.',
                'Email content: messages sent to your addresses (sender, recipients, subject, body, attachments and headers), and records of messages you send through the site.',
                'Network information: the IP address used when you create a mailbox, sign up, sign in or send mail, and the approximate location Cloudflare derives from it.',
                'Human verification: Cloudflare Turnstile processes technical signals from your browser and device during verification.',
            ],
            after: ['The site shows no ads and uses no third-party analytics or tracking tools.'],
        },
        {
            title: '2. How we use it',
            items: [
                'To receive and send mail, sign you in and reset your password;',
                'To prevent abuse, for example by limiting mailbox creation per IP and blocking brute-force and automated requests;',
                'To handle complaints, troubleshoot problems and keep the service secure;',
                'To cooperate with competent authorities when the law requires it.',
            ],
            after: ['The site does not sell your personal information and does not use email content for advertising.'],
        },
        {
            title: '3. Where and how long data is stored',
            items: [
                'Data is stored in Cloudflare databases and storage services, which may be located outside your country or region.',
                'Personal mailboxes and their messages are kept until you delete them.',
                'Temporary mailboxes are not guaranteed to last and may be removed under the site\'s cleanup rules. Do not use them for important mail.',
                'Password reset codes expire after 5 minutes; security records such as failed sign-in counts expire automatically after a short time.',
                'When you delete a mailbox or your account, the related messages and records are removed from the database; provider backups may keep copies for a limited time.',
            ],
        },
        {
            title: '4. Third-party services',
            paragraphs: ['The site relies on the following providers, which process data under their own privacy policies:'],
            items: [
                'Cloudflare: hosting, database, inbound mail (Email Routing) and human verification (Turnstile).',
                'Resend: delivery of password reset codes, password change notices, and mail sent by users after the administrator grants sending access. Resend processes recipient addresses and message content.',
            ],
        },
        {
            title: '5. Local storage and cookies',
            items: [
                'The site keeps your sign-in token, mailbox credentials and interface preferences (language, theme) in your browser\'s local storage.',
                'Cloudflare may set cookies that are necessary for security and human verification.',
                'The site uses no advertising or cross-site tracking cookies.',
                'Signing out removes the sign-in token stored in your browser.',
            ],
        },
        {
            title: '6. Who can read your mail',
            items: [
                'You, and anyone who obtains the mailbox credential or your sign-in token. If the credential of a temporary mailbox leaks, others can read its messages, so keep it safe.',
                'Site administrators can view mailboxes and messages in the admin console when maintaining the service, handling complaints or cooperating with lawful investigations.',
                'Messages are stored in the database without end-to-end encryption. Do not use the site for highly sensitive information.',
            ],
        },
        {
            title: '7. Your rights',
            items: [
                'View your account information and change or remove your recovery email in the user center;',
                'Delete messages and mailboxes, or delete your account (you can choose to delete or transfer your personal mailboxes);',
                'Reset a forgotten password through your recovery email; without one, ask the administrator to reset it;',
                'For any other request about your personal information, use the contact details at the end of this page.',
            ],
        },
        {
            title: '8. Security',
            paragraphs: [
                'Passwords are stored as salted PBKDF2 hashes and repeated wrong attempts trigger a temporary lockout; the whole site uses HTTPS; sign-up, sign-in and password reset require human verification. No online service can be perfectly secure, so use a strong password and keep your sign-in details safe.',
            ],
        },
        {
            title: '9. Acceptable use: no illegal activity',
            paragraphs: ['When using the site you must not:'],
            items: [
                'Engage in any illegal activity, including but not limited to fraud, phishing, money laundering, gambling, or distributing pornographic, violent or otherwise unlawful content;',
                'Send spam or unsolicited bulk marketing mail, or distribute viruses, trojans or other malware;',
                'Impersonate any person, organization or the site itself, or infringe others\' privacy, reputation, intellectual property or other rights;',
                'Use site mailboxes for mass account registration, fake orders, or in ways that break other services\' terms;',
                'Attack or disrupt the site, or bypass its rate limits or human verification.',
            ],
            after: [
                'If you break these rules, the site may delete the related mailboxes and accounts without notice, keep relevant records, and provide them to competent authorities when the law requires. You bear full legal responsibility for your own conduct.',
            ],
        },
        {
            title: '10. Disclaimer',
            paragraphs: [
                'The site is provided as is, without any guarantee of uninterrupted service, guaranteed delivery or that data will never be lost. Please keep your own copies of important mail.',
            ],
        },
        {
            title: '11. Children',
            paragraphs: ['The site is not intended for children under 14. If you are under 14, please do not sign up for or use the site.'],
        },
        {
            title: '12. Changes to this policy',
            paragraphs: [
                'The site may update this policy and will change the date at the top of this page when it does; significant changes will be announced on the site where possible. Continuing to use the site after an update means you accept the updated policy.',
            ],
        },
        {
            title: '13. Contact',
            paragraphs: ['For any question about this policy or your personal information, contact {contact}.'],
        },
    ],
}

/** 按界面语言取正文：中文界面用中文，其他语言都用英文 */
export const getPrivacyPolicy = (locale) => (locale === 'zh' ? zh : en)

/** 把正文里的 {contact} 换成联系方式 */
export const fillContact = (text, contact) => text.replaceAll('{contact}', contact)
