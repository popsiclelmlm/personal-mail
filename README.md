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
