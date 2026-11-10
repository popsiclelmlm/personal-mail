<!-- markdownlint-disable-file MD033 -->
# Personal Mail

<p align="center">
  <a href="README.md">中文</a> | <a href="README_EN.md">English</a>
</p>

运行在 Cloudflare 免费额度上的个人邮件系统：受邀用户注册后，直接得到「名字@你的域名」的长期个人邮箱；访客可以匿名创建临时邮箱。一个 Worker 同时托管网页和接口，收信用 Cloudflare Email Routing，发信用 Resend 免费版，不需要服务器。

> 本项目由 [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) 改造而来（MIT 许可），感谢原作者和所有贡献者。上游的大部分功能（附件、Telegram 机器人、Webhook、OAuth2、Passkey 等）都保留着。

> 仅供学习和个人用途，请勿用于任何违法行为。

## 功能

**个人邮箱**

- 注册即开通：账号就是「名字@个人邮箱域名」，注册时自动建好对应邮箱，凭邀请码注册
- 个人邮箱永久保留、不会被自动清理；「邮箱」页汇总名下所有邮箱的统一收件箱
- 可选填一个站外辅助邮箱，忘记密码时把验证码发到那里
- 注销账号时可以逐个选择删除或转移名下的邮箱

**临时邮箱**

- 匿名即可创建，可选保留期，到期自动清理
- 同一 IP 在同一域名下的地址数量有上限，个人邮箱域名不会出现在临时邮箱里

**安全与防滥用**

- 用户密码使用 PBKDF2，连续输错锁定；「退出所有设备」可以让旧登录全部失效
- 管理后台使用短期会话令牌，浏览器里不保存管理员密码
- 邮件 HTML 一律净化后显示，页面带内容安全策略（CSP），能在浏览器里执行的附件只允许下载
- Turnstile 人机验证（托管模式）、按 IP 限流、保留地址名（admin、noreply 等不能注册）
- 隐私政策与使用条款页面

## 相比上游的改进

在 [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) 的基础上，本项目改动了 130 多个文件、新增约 7800 行代码和文档，主要包括：

### 新功能

- **注册即个人邮箱**：开启 `REGISTER_WITH_PERSONAL_MAILBOX` 后，注册表单改为「名字@个人邮箱域名」，这个地址同时是登录账号和个人邮箱；注册时二次输入密码，提交前弹窗确认地址
- **个人邮箱专用域名**（`PERSONAL_MAIL_DOMAINS`）：这些域名只用于个人邮箱，不出现在临时邮箱、Telegram 和兑换码建地址里
- **「邮箱」页和统一收件箱**：汇总账号名下所有邮箱的来信，可按地址筛选，显示每个地址的未读数，可标记已读或未读
- **个人邮箱管理**：地址可升级为永久的个人邮箱（不会被清理）；邮箱凭证带版本号，可一键重置让旧凭证失效；可关闭邮箱凭证登录，只允许通过账号访问；可转移给其他账号
- **注销账号**：逐个选择删除或转移名下的个人邮箱，其余地址和邮件一并删除
- **邀请码注册**（`REGISTER_MODE = invite`）：后台批量生成，可设可用次数、授予的角色、过期时间和备注，能看到使用记录；注册在事务里完成，邀请码不会超用
- **辅助邮箱找回密码**：注册时可选填站外邮箱，忘记密码时验证码发到那里，重设成功后发通知；发信额度用完时提示「今天的发信额度已用完，请明天再试」
- **临时邮箱保留期**：地址可设保留期，到期自动清理；永久邮箱和保留期内的地址不会被任何清理任务删除；同一 IP 在同一基础域名下的地址数有上限（`IP_DOMAIN_CREATE_LIMIT`）
- **隐私政策与使用条款**页面，页脚和注册表单都有入口
- **退出所有设备**：用户和管理员各自都能让已签发的登录全部失效

### 安全加固

- 用户密码改为 PBKDF2-SHA256 加随机盐存储，旧哈希在下次登录时自动升级
- 登录、注册、重设密码连续失败会锁定，按 IP 限流也覆盖了登录和重设密码；登录提示不区分「账号不存在」和「密码错误」
- 用户令牌带版本号，重设密码或退出所有设备后旧令牌立即失效；令牌与签发时的账号严格绑定，删除账号后编号被复用也不会串号
- 角色令牌每次使用都回库核对当前角色，撤销或降级立即生效
- 管理后台改用 8 小时有效、可一键吊销的会话令牌，浏览器不再保存管理员密码；管理员密码连续输错同样会锁定
- 邮件 HTML 在所有显示模式下都先净化再显示，iframe 显示模式放进沙箱，页面带内容安全策略（CSP）
- HTML、SVG 等能在浏览器里运行的附件只允许下载，不在站内打开
- 全站可开启 Turnstile 人机验证（找回密码、注册、匿名建邮箱和各类登录）；保留地址名（admin、noreply 等）不能注册；页面禁止搜索引擎收录

### 同样影响上游的安全问题

改造过程中，我们发现并修复了几处同样存在于上游的前端安全问题，主要和邮件内容的渲染方式有关。我们已通过 GitHub 私密漏洞报告提交给上游维护者（经 [#1203](https://github.com/dreamhunter2333/cloudflare_temp_email/issues/1203) 请对方开通了私下渠道）。为了不让还在使用上游版本的站点暴露风险，具体细节会在上游发布修复后再补充到这里。发现本项目的安全问题，请按 [SECURITY.md](SECURITY.md) 私下报告。

### 体验

- 默认界面品牌 Magpiess Mail（喜鹊 Logo、蓝色主题），导航改为「邮箱 / 临时邮箱 / 用户中心」
- 登录成功后显示加载骨架屏，不再误弹「登录已过期」
- 帮助页按实际界面重写，讲清邮箱凭证和个人邮箱

### 部署与工程

- 完全运行在 Cloudflare 免费额度上，针对 Workers 免费版的 CPU 限制调整了密码哈希参数
- [从零部署指南](docs/personal-mail/DEPLOY.md)，附 AI 编程助手部署的分工和提示词，以及[生产配置模板](scripts/personal-mail/wrangler.prod.example.toml)
- Worker 侧单元测试 273 项（用 Node 内置 SQLite 模拟 D1）、前端测试 186 项，另有不需要 Docker 的本地接口验证脚本

## 部署

- **从零部署**：[docs/personal-mail/DEPLOY.md](docs/personal-mail/DEPLOY.md)，按上线顺序写成，包括让 AI 编程助手代为部署的做法
- **配置说明**：[docs/personal-mail/README.md](docs/personal-mail/README.md)，记录新增的环境变量和与上游不同的地方
- **上游通用文档**：Telegram、Webhook、SMTP 代理等上游功能的配置见[上游文档](https://temp-mail-docs.awsl.uk)

全部使用 Cloudflare Workers 免费版、D1、KV、Email Routing、Turnstile 和 Resend 免费版即可运行。

## 本地开发

```bash
cd worker && pnpm install
cp ../scripts/personal-mail/wrangler.local.toml wrangler.dev.toml
pnpm exec wrangler dev -c wrangler.dev.toml --port 8797
```

前端：`cd frontend && pnpm install && VITE_API_BASE=http://127.0.0.1:8797 pnpm exec vite`。测试：`cd frontend && pnpm test`，`cd e2e && npm run test:unit`。接口级的本地验证脚本见配置说明的「本地验证」。

## 换成自己的品牌

界面默认名称是 Magpiess Mail，换品牌时改这几处：

- 网站名称：`frontend/src/i18n/message-registry.ts` 的 `views.Header.title`，以及 `frontend/src/i18n/locales/source/` 下各语言文件
- Logo 和图标：`frontend/public/`
- 隐私政策正文：`frontend/src/views/legal/privacy-policy-content.js`
- 找回密码等系统邮件的标题和正文：`worker/src/i18n/zh.ts`、`worker/src/i18n/en.ts`
- 页脚署名：生产配置里的 `COPYRIGHT`

## 技术栈

- 前端：Vue 3、Vite、Naive UI；邮件解析使用 Rust 编译的 WebAssembly
- 后端：Cloudflare Workers（Hono），D1（SQLite）存数据，KV 存短期数据
- 收信：Cloudflare Email Routing；发信：Resend

## 许可证

[MIT](LICENSE)，保留原项目的版权声明。
