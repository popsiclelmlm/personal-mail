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

产品名称默认显示 Free Temp Mail（前端 i18n 的 `title`），不需要再设置 `TITLE`。

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
