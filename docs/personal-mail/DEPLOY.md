# 从零部署到 Cloudflare（Workers 免费版）

这份指南按实际上线的顺序写成，人可以照着一步步做，也可以交给 AI 编程助手（如 Claude Code）执行（见最后一节）。各项配置的含义和与上游的差异见同目录的 [README.md](README.md)。

文中用到的占位符：

| 占位符 | 含义 | 例子 |
|---|---|---|
| `<personal-domain>` | 个人邮箱域名，注册账号就是「名字@这个域名」 | `example.com` |
| `<temp-domain-1>`、`<temp-domain-2>` | 临时邮箱域名，可以没有，也可以有多个 | `temp.example.net` |
| `<worker-name>` | Worker 名称 | `personal-mail` |
| `<d1-name>`、`<kv-name>` | D1 数据库、KV 命名空间的名称 | `personal-mail` |

## 整体结构

- **一个 Worker 同时托管前端和接口**：网页和接口同域名（`mail.<personal-domain>`），前端构建产物通过 Workers Static Assets 发布。
- **存储**：D1 存账号、地址和邮件，KV 存验证码、失败计数等短期数据。
- **收信**：每个域名在 Cloudflare Email Routing 里设置全收规则（catch-all），交给这个 Worker。
- **发信**：Resend 免费版（每月 3000 封、每天 100 封）。Workers 免费版不能用 `send_email` 向任意地址发信。
- **防滥用**：Turnstile 人机验证（托管模式）、按 IP 限流、邀请码注册、保留地址名、页面 CSP。

全部用免费额度即可运行。

## 0. 准备

- 一个 Cloudflare 账号，所有域名都已托管在这个账号下（DNS 由 Cloudflare 解析）。
- Node.js 22 及以上、pnpm。
- 登录 wrangler：`cd worker && pnpm install && npx wrangler login`。
- 发信需要一个 Resend 账号；人机验证需要在 Cloudflare 后台建一个 Turnstile widget（后面会讲）。

## 1. 创建 D1 和 KV

```bash
cd worker
npx wrangler d1 create <d1-name>
npx wrangler kv namespace create <kv-name>
```

记下输出里的 `database_id` 和 KV 的 `id`。

## 2. 写生产配置

```bash
cp ../scripts/personal-mail/wrangler.prod.example.toml wrangler.toml
```

把 `worker/wrangler.toml` 里所有 `<...>` 换成自己的值。这个文件已被 gitignore，只放在本机，**不要提交**。本地开发用另一份配置（`worker/wrangler.dev.toml`，见 README 的「本地验证」），不要和生产配置混用。

## 3. 初始化数据库

```bash
npx wrangler d1 execute <d1-name> --remote --file=../db/schema.sql
```

也可以部署后在管理后台「快速设置 → 数据库」里点「初始化数据库」。以后升级代码时，在同一页点「升级数据库 Schema」补齐新增的列（可以重复执行）。

## 4. 设置密钥

逐个执行，提示输入时直接粘贴值（不会回显，也不会写进任何文件）：

```bash
npx wrangler secret put JWT_SECRET          # 随机长字符串，例如 openssl rand -hex 32 的输出
npx wrangler secret put ADMIN_PASSWORDS     # 管理后台密码，可以直接填明文
```

Turnstile 和 Resend 的密钥在第 8、9 步设置。

## 5. 构建前端并部署

```bash
cd ../frontend && pnpm install && pnpm build
cd ../worker && npx wrangler deploy
```

- 前端构建时**不要**设置 `VITE_API_BASE`：网页和接口同域名，留空就是同源。仓库里如果留有旧的 `frontend/.env.prod`，先确认它没有指向别的地址。
- `wrangler deploy` 打包的是**工作区里的文件**，不是某个提交。多人或多个 AI 会话共用一个目录时，先确认工作区是干净的：

  ```bash
  if [ -z "$(git status --porcelain)" ]; then npx wrangler deploy; else git status --short; fi
  ```

- 部署后 `routes` 里的自定义域名会自动绑定，DNS 记录由 Cloudflare 自动创建。

## 6. 配置收信（Email Routing）

对 `DOMAINS` 里的每个域名：

1. Cloudflare 后台 → 该域名 → Email → Email Routing，按提示启用（会自动添加 MX 和 SPF 记录）。
2. Routing rules → Catch-all address → 动作选 **Send to a Worker**，选择 `<worker-name>`，启用。

只要全收规则指向这个 Worker，所有发到这个域名的信都会进系统。

## 7. 初始化管理后台

打开 `https://mail.<personal-domain>/admin`，用 `ADMIN_PASSWORDS` 里的密码登录（登录后浏览器只保存 8 小时有效的会话令牌，不保存密码）。

1. 「邀请码」：生成邀请码。邀请码只由大写字母和数字组成；直接往数据库里插邀请码时也要用这种格式，否则会提示无效。
2. 预留系统地址：在后台新建 `noreply@<personal-domain>`（找回密码的发件地址）和 `privacy@<personal-domain>`（隐私政策里的联系地址）。管理员建地址不受 `ADDRESS_CHECK_REGEX` 限制，普通用户则注册不了这些名字。
3. 用自己的邀请码注册第一个账号，确认收信正常：从任意外部邮箱给这个地址发一封信，网页里应该能看到。

## 8. 发信和找回密码（Resend）

1. 在 Resend 添加 `<personal-domain>`，按提示添加 DNS 记录（Resend 页面上可以一键自动配置 Cloudflare）。这些记录都在 `send` 之类的子域名和 DKIM 记录上，不影响根域名的收信。等 Resend 显示 Verified。
2. 在 Resend 新建 API Key，权限选 Sending access，只限这个域名。然后：

   ```bash
   npx wrangler secret put RESEND_TOKEN_<PERSONAL_DOMAIN>   # 域名转大写、点换成下划线，如 RESEND_TOKEN_EXAMPLE_COM
   ```

   用按域名区分的密钥，临时邮箱域名就不会走 Resend。
3. 管理后台「快速设置 → 用户设置」：开启邮件验证，发件地址填 `noreply@<personal-domain>`；再到「快速设置 → 全局邮箱设置」，把这个地址加进「无余额限制发送地址列表」（找回密码的发信会检查发件地址的余额，不加会报余额不足）。
4. 建议给 `<personal-domain>` 加 DMARC：在 Cloudflare 后台该域名的 Email → DMARC Management 启用即可（会自动添加 `_dmarc` 记录），或者手动加一条 TXT `_dmarc` = `v=DMARC1; p=none;`。两种方式只选一种。

## 9. 人机验证（Turnstile）

1. Cloudflare 后台 → Turnstile → Add widget：域名填 `mail.<personal-domain>`，模式选 **Managed**。
2. Site Key 写进 `wrangler.toml` 的 `CF_TURNSTILE_SITE_KEY`；Secret：

   ```bash
   npx wrangler secret put CF_TURNSTILE_SECRET_KEY
   ```

3. 重新部署。之后找回密码、注册、匿名建临时邮箱和各类登录都要先过人机验证。

不要用 WAF 的 Managed Challenge 代替：前端用 fetch 调接口，接口请求过不了质询，只会让页面报错。

## 10. 上线检查

```bash
D=https://mail.<personal-domain>
curl -s $D/open_api/settings | head -c 300; echo                     # 返回 JSON，enableSendMail 为 true
curl -s $D/user_api/open_settings; echo                              # enableResetPassword 为 true
curl -s -D - -o /dev/null $D/ | grep -i content-security-policy     # 页面带 CSP
curl -s -X POST $D/user_api/login -H 'content-type: application/json' -H 'x-lang: zh' \
  -d '{"email":"nobody@<personal-domain>","password":"x"}'; echo    # 「人机验证检查失败」
```

再用一个设置了辅助邮箱的测试账号，在网页上走一遍「忘记密码」：验证码应该进外部邮箱的收件箱。测完在后台删掉测试账号和用过的邀请码。

## 常见问题

- **核对 DNS 时查不到刚加的记录**：有些网络会拦截并缓存 DNS 查询，连 `dig @权威服务器` 都会拿到旧结果，还会把「不存在」缓存约 30 分钟。用 DNS over HTTPS 核对：`curl -s -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=_dmarc.<personal-domain>&type=TXT"`。
- **发信额度用完**：Resend 免费版超出额度只拒发不收费，网页上会提示「今天的发信额度已用完，请明天再试」。一次找回密码大约用 3 封。
- **注册时提示名字不合规**：命中了 `ADDRESS_CHECK_REGEX` 的保留名，见 README 的「保留地址名」。
- **CPU 超时**：免费版每次请求只有 10ms CPU，`PASSWORD_PBKDF2_ITERATIONS` 不要调高。
- **回滚**：`npx wrangler deployments list` 查看历史版本，`npx wrangler rollback <版本号>` 回到指定版本。数据库结构的改动不会随回滚撤销。

## 用 AI 编程助手部署

本项目上线时，代码修改、配置生成、本地验证和大部分命令都由 AI 编程助手完成，人只负责账号、密钥和需要拍板的操作。分工如下：

| AI 做 | 人做 |
|---|---|
| 读代码，确定配置项和接口行为 | 注册 Cloudflare、Resend 等账号 |
| 生成 `wrangler.toml`、写代码改动和测试 | 在终端提示符里粘贴密钥（`wrangler secret put`） |
| 用 `wrangler dev` 在本地复现、修复、跑测试和浏览器验证 | 确认 DNS 改动、生产部署、删除 Worker 或数据这类不可逆操作 |
| 部署后用 `curl` 和浏览器核对线上行为 | 完成需要真人的步骤（人机验证、查收自己邮箱里的验证码） |

几条规则：

1. **密钥不进对话**：AI 只运行 `wrangler secret put ...`，由人在终端里直接粘贴值。
2. **不可逆操作先确认**：改 DNS、部署生产、删除 Worker、D1 或 KV 之前，AI 要说清楚影响范围，等人同意；删除数据前先导出备份。
3. **每步都验证**：用接口返回值、数据库查询、浏览器截图确认结果，不凭推测宣布完成；核对 DNS 用 DoH（见上文）。
4. **测试数据用完就删**：测试账号、邀请码、测试发信记录在验证后删除，特别是里面含有真实邮箱地址的记录。
5. **公开内容不带隐私**：提交信息、文档和公开页面里不写个人邮箱、真名和本机路径；推送前检查提交署名。

可以直接交给 AI 的开场提示（按需修改）：

```text
请按 docs/personal-mail/DEPLOY.md 把这个仓库部署到我的 Cloudflare 账号（Workers 免费版）。
个人邮箱域名是 <personal-domain>，临时邮箱域名是 <temp-domain-1>。
要求：密钥由我在终端粘贴，你只运行 wrangler secret put；改 DNS、部署生产、删除任何资源前先问我；
每一步都用命令或浏览器验证结果；测试数据用完删除；最后按「上线检查」逐项核对并告诉我结果。
```
