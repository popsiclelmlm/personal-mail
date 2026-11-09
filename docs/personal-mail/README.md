# Free Temp Mail：部署与配置说明

本仓库在上游 [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) 之上做了个人邮件系统改造，方案见 `docs/plans/2026-11-08-personal-mail-system.md`。这里只记录和上游不同的部署事项；上游已有的配置照上游文档。

## 新增或改变的环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `IP_DOMAIN_CREATE_LIMIT` | 同一 IP 在同一基础域名（含子域名）下同时存在的地址上限；`0` 关闭。只限制匿名用户和没有角色的登录用户 | `5` |
| `USER_ROLES[].max_permanent_address_count` | 该角色可拥有的永久邮箱（个人邮箱）数量 | `0` |
| `REGISTER_MODE` | 注册策略：`open`（按后台「允许注册」开关）、`invite`（凭邀请码注册）、`closed`（关闭注册）。`invite`、`closed` 时 OAuth2 也只能登录已有账号 | `open` |
| `USER_DEFAULT_ROLE` | 新用户自动获得的角色；邀请码上指定了角色时以邀请码为准。现在不论是否开启邮件验证、是否走邀请码都会授予 | — |
| `PASSWORD_PBKDF2_ITERATIONS` | 用户密码 PBKDF2-SHA256 迭代次数，范围 10000–100000（workerd 上限） | `100000` |
| `USER_ROLES[].personal_send_balance` | 地址升级为个人邮箱时初始化的发信额度（写进 `address_sender`）；不配置则沿用上游的发信额度规则 | — |
| `REGISTER_WITH_PERSONAL_MAILBOX` | `true` 时注册表单改成「名字@个人邮箱域名」：账号就是这个地址，注册时自动建好对应的个人邮箱（永久、关闭邮箱凭证登录、占 1 个永久邮箱额度），用它登录，不再填站外邮箱。这种方式不走邮件验证和站外邮箱白名单；找回密码靠选填的辅助邮箱（见下文），否则只能由管理员重设。需要同时配置 `PERSONAL_MAIL_DOMAINS` | `false` |
| `PERSONAL_MAIL_DOMAINS` | 个人邮箱专用域名（必须同时写在 `DOMAINS` 里）。这些域名不出现在临时邮箱里，匿名用户和登录用户都不能用它们建临时地址，只能在「邮箱」页直接创建为个人邮箱；管理员建地址不受限制 | — |

产品名称默认显示 Magpiess Mail（前端 i18n 的 `title`），不需要再设置 `TITLE`。

## 数据库

- **全新部署**：直接执行 `db/schema.sql`，或在管理后台点「初始化数据库」。
- **从上游升级**：按顺序执行 `db/` 下尚未执行过的迁移文件，或在管理后台点「迁移数据库」。
- **本仓库新增的列**（见 `worker/src/admin_api/custom_migrations.ts`）不占用上游的数据库版本号。管理后台的「迁移数据库」会按实际表结构补齐缺少的列，可以重复执行；缺列时后台会提示需要迁移。
- `db/2026-06-08-retention-and-ip-limit.sql`：已经部署过本仓库旧版本（2026-06 的保留期功能）的数据库已有这三列，**跳过这个文件**，否则 `ALTER TABLE` 会报列已存在。用管理后台迁移则不用区分。

## 账号安全

- **密码**：前端照旧发送密码的 SHA-256 摘要，服务端再做 PBKDF2（每个用户随机 16 字节盐），存成 `pbkdf2$sha256$<迭代次数>$<盐>$<哈希>`。老数据（64 位十六进制）登录成功后当场升级；迭代次数调高后，老哈希也会在下次登录时升级。
- **耗时**：本地 workerd（Apple M4 Pro）上 10 万次迭代约 7ms。Cloudflare 边缘的 CPU 一般更慢，Workers 免费版每次请求只有 10ms CPU，可能超限；用免费版时把 `PASSWORD_PBKDF2_ITERATIONS` 调低（例如 30000），付费版用默认值。上线后用 `wrangler tail` 看登录请求的 CPU 时间再调整。
- **失败锁定**：登录、注册和重设密码时的验证码，按「IP + 邮箱」计数，连续失败 5 次锁定 15 分钟（返回 429）；验证码连续输错 5 次后作废。计数存在 KV 里，没有 KV 绑定时不锁定。
- **按 IP 限流**：`RATE_LIMITER` 绑定现在也作用于 `/user_api/login` 和 `/user_api/reset_password`。
- **令牌**：用户令牌有效期 7 天，剩余不足 4 天时打开页面会自动续期。令牌带版本号 `tv`，重设密码（用户自己或管理员）、「退出所有设备」时版本加 1，旧令牌立即返回 401；升级前签发的没有 `tv` 的令牌按版本 0 处理。角色令牌（`x-user-access-token`，1 小时）不检查版本，最长 1 小时后自然失效。
- **登录提示**：账号不存在和密码错误返回同一条提示，账号不存在时也会算一次哈希，避免探测账号。
- **重设密码**：`POST /user_api/reset_password`（邮箱 + 验证码 + 新密码），需要后台开启邮件验证并设置验证码发件地址；成功后给账号邮箱发通知。注册接口不再覆盖已有账号。
- **退出所有设备**：`POST /user_api/logout_all`，用户设置页有入口。

## 邀请码

`REGISTER_MODE = invite` 时，注册必须带邀请码。管理后台「用户 → 邀请码」可以批量生成（每批最多 50 个）、设置每个邀请码的可用次数、要授予的角色（留空用 `USER_DEFAULT_ROLE`，不能是管理员角色）、过期时间和备注，也能停用和删除；列表里能看到谁用了哪个邀请码。

邀请码存在独立的 `invite_codes`、`invite_code_uses` 表里，没有复用上游的兑换码表：兑换码的管理接口受 `ENABLE_REDEEM_CODE` 控制，打开它会同时开放公开的兑换接口和兑换页。

注册在一个 D1 批次（事务）里完成「消耗邀请码 → 建用户 → 记录使用 → 授予角色」，邮箱已被注册时整批回滚，邀请码次数不会被占用；并发注册抢同一个邀请码的最后一次时只有一个成功。

## 个人邮箱

个人邮箱 = 绑定在账号名下、并且升级为永久（`is_permanent = 1`）的地址。

- **升级**：地址管理「更多 → 设为个人邮箱」，即 `POST /user_api/bind_address/retention`（`permanent`）。只能升级自己名下的地址，占用角色的 `max_permanent_address_count` 额度；升级时默认**关闭邮箱凭证登录**，并按角色的 `personal_send_balance` 初始化发信额度。
- **邮箱凭证版本**：所有签发邮箱凭证的地方（新建地址、地址密码登录、账号取得凭证、Telegram 绑定、Telegram 小程序、管理员查看凭证）都带上 `cv`。`POST /user_api/address/:address_id/reset_credential` 把版本加 1，旧凭证（含 Telegram 绑定）立即失效，并返回一个新的账号凭证。没有 `cv` 的老凭证按版本 0 处理。
- **关闭邮箱凭证登录**（`address.credential_login_disabled = 1`）：直接使用邮箱凭证、地址密码登录、用凭证绑定地址、Telegram 绑定都会被拒绝；只接受通过账号取得的凭证（`/user_api/bind_address_jwt`，带 `uid` 和 `utv`），而且要求账号仍然绑定这个地址、账号没有「退出所有设备」或重设密码。开关接口：`POST /user_api/address/:address_id/credential_login`（`{ "enabled": true|false }`）。管理员「查看凭证」得到的也是普通凭证，关闭凭证登录时同样不能用。
- **统一收件箱**：`GET /user_api/mails` 新增 `address_id`、`unread=1` 筛选；`GET /user_api/mails/unread_counts` 返回每个地址的未读数（个人邮箱排在前面）；`PATCH /user_api/mails/:id/read` 在收件箱里标记已读、未读。
- **发信**：沿用上游的用户发信和发件箱（`/user_api/address/:address_id/send_mail`、`/user_api/sendbox`）。临时地址在 `DEFAULT_SEND_BALANCE = 0` 时没有额度，不能发信；如果配置了 `NO_LIMIT_SEND_ROLE`，该角色名下的临时地址也能发信。
- **转移**：保留期、永久标记和「禁止邮箱凭证登录」原样保留，地址以新 id 重建（旧凭证失效），永久邮箱要占用对方的永久邮箱额度；不能转给自己。
- **注销账号**：用户设置页「注销账号」。`GET /user_api/delete_account/preview` 列出名下的个人邮箱和其他地址；`POST /user_api/delete_account` 需要输入账号邮箱确认、设置过密码的账号还要输密码（失败计入登录锁定），每个个人邮箱必须选择删除或转移；其他已绑定地址连同邮件一起删除；最后删除账号、角色和通行密钥。
- **管理员删除用户**：现在会一并删除该用户的角色和通行密钥（`users.id` 不是 AUTOINCREMENT，新用户可能复用被删用户的 id，原来会继承角色和通行密钥）。被删用户的个人邮箱变成无主的永久邮箱，不会被自动清理，需要时在后台手动删除。

## 个人邮箱专用域名

配置 `PERSONAL_MAIL_DOMAINS` 后：

- **临时邮箱**（导航「临时邮箱」，即首页）的域名列表去掉这些域名，`/api/new_address`、Telegram 和兑换码建地址也不能用它们。
- **「邮箱」页**（`/mailbox`）：登录后列出名下的个人邮箱，可以直接创建（`POST /user_api/personal_mailbox`，`{ "name": "me", "domain": "可选" }`）。新地址绑定到当前账号、设为永久、关闭邮箱凭证登录，占用角色的 `max_permanent_address_count` 额度，下面是账号的统一收件箱。
- 这些域名下的地址不能改回临时或「保留 30 天」，否则会被自动清理。
- 开启 `REGISTER_WITH_PERSONAL_MAILBOX` 后，注册表单要输两次密码，提交前会弹框确认地址（注册后不能改名）；可以选填一个站外的**辅助邮箱**（`users.recovery_email`，不能用本站任何域名），之后在用户设置里修改，修改要输当前密码。找回密码时验证码发到辅助邮箱：需要后台开启邮件验证、设置发件地址并且能正常发信；没有辅助邮箱或不能发信时只能由管理员重设。管理后台的用户列表会显示辅助邮箱。
- 开启 `REGISTER_WITH_PERSONAL_MAILBOX` 后，账号的登录邮箱不能解绑或转给别人（注销账号时照常选择删除或转移）；地址被管理员删掉后，只有账号本人能重新建这个地址。登录时邮箱不区分大小写。

## 发信与找回密码

Workers 免费版不能用 Cloudflare 的 `send_email` 向任意地址发信（需要 Workers Paid），所以用 Resend 免费版（每月 3000 封、每天 100 封，超出只拒发不收费）：

1. 在 Resend 添加个人邮箱域名，按提示加 DNS 记录（都在 `send` 子域名和 DKIM 记录上，不影响根域名的 Email Routing 收信）；建议另加 `_dmarc` TXT `v=DMARC1; p=none;`。
2. 建一个只有 Sending access、只限这个域名的 API Key，用 `wrangler secret put RESEND_TOKEN_<域名大写，点换成下划线>` 保存。用按域名区分的密钥而不是全局 `RESEND_TOKEN`，临时邮箱域名就不会走 Resend。
3. 管理后台「用户设置」开启邮件验证，发件地址填 `noreply@个人邮箱域名`；再把这个地址加进「无限制发送地址列表」（找回密码的发信会检查发件地址的余额，`DEFAULT_SEND_BALANCE = 0` 时不加会报余额不足）。
4. `ADDRESS_CHECK_REGEX` 里要包含 `noreply`，否则用户注册了这个名字就能无限发信。

一次找回密码大约发 3 封：验证码 1 封，重设成功后给账号邮箱和辅助邮箱各发 1 封通知。站内发信额度或 Resend 额度用完、发得太快时，找回密码、注册验证码和用户发信接口返回 429 和「今天的发信额度已用完，请明天再试」这类提示，验证码不会被存下。

## 保留地址名

`ADDRESS_CHECK_REGEX` 对注册、建个人邮箱和匿名建临时邮箱都生效，管理员在后台建地址不受限制。名字校验前会去掉 `a-z0-9` 以外的字符（`no-reply` 会变成 `noreply`），所以正则里只写字母数字。建议分两组：冒充官方风险高的词按「包含」拦截，通用保留名按「完全相同」拦截，避免误伤正常名字：

```
^(?!.*(admin|postmaster|hostmaster|webmaster|abuse|noreply|品牌名))(?!(root|info|support|security|help|service|contact|mailerdaemon|system|official|billing|sales)$).*$
```

## 人机验证（Turnstile）

在 Cloudflare 后台建一个 Turnstile widget（域名填邮箱网页的域名，模式选 Managed），Site Key 写进 `CF_TURNSTILE_SITE_KEY`，Secret 用 `wrangler secret put CF_TURNSTILE_SECRET_KEY` 保存。两者都有时，找回密码验证码、注册、匿名建临时邮箱都要先过人机验证；再设 `ENABLE_GLOBAL_TURNSTILE_CHECK = true` 会加上用户登录、邮箱地址登录和后台登录。前端各个表单有密钥时会自动显示验证组件。

不要用 WAF 的 Managed Challenge 保护接口：前端用 fetch 调接口，接口请求过不了质询，只会让页面报错。

本地验证可以用 Cloudflare 的测试密钥（Site Key `1x00000000000000000000AA`，Secret `1x0000000000000000000000000000000AA`，总是通过），`wrangler dev` 时用 `--var` 传入。

## 自动清理

所有清理任务（按创建时间、不活跃、未绑定、空地址、邮件、发件箱）都跳过：

- 永久邮箱（`is_permanent = 1`）；
- 仍在保留期内的地址（`retention_until` 晚于当前时间）。

保留期条件在每批的 `LIMIT` 之前生效，最旧的一批全是受保护地址时，清理任务也会继续处理后面的地址。

## 搜索引擎

前端 `index.html` 带 `noindex, nofollow`，`frontend/public/robots.txt` 禁止所有抓取。

## 本地验证

本机没有 Docker 时，用 `wrangler dev` 起本地 Worker，再用脚本调接口：

```bash
cp scripts/personal-mail/wrangler.local.toml worker/wrangler.toml
cd worker && pnpm exec wrangler dev --port 8797 --test-scheduled
node scripts/personal-mail/local-verify.mjs all
```

单元测试：`cd e2e && npm run test:unit`（用 Node 内置的 `node:sqlite` 模拟 D1，见 `e2e/unit/d1-sqlite.mjs`）。
