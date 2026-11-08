# Free Temp Mail：部署与配置说明

本仓库在上游 [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) 之上做了个人邮件系统改造，方案见 `docs/plans/2026-11-08-personal-mail-system.md`。这里只记录和上游不同的部署事项；上游已有的配置照上游文档。

## 新增或改变的环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `IP_DOMAIN_CREATE_LIMIT` | 同一 IP 在同一基础域名（含子域名）下同时存在的地址上限；`0` 关闭。只限制匿名用户和没有角色的登录用户 | `5` |
| `USER_ROLES[].max_permanent_address_count` | 该角色可拥有的永久邮箱（个人邮箱）数量 | `0` |

产品名称默认显示 Free Temp Mail（前端 i18n 的 `title`），不需要再设置 `TITLE`。

## 数据库

- **全新部署**：直接执行 `db/schema.sql`，或在管理后台点「初始化数据库」。
- **从上游升级**：按顺序执行 `db/` 下尚未执行过的迁移文件，或在管理后台点「迁移数据库」。
- **本仓库新增的列**（见 `worker/src/admin_api/custom_migrations.ts`）不占用上游的数据库版本号。管理后台的「迁移数据库」会按实际表结构补齐缺少的列，可以重复执行；缺列时后台会提示需要迁移。
- `db/2026-06-08-retention-and-ip-limit.sql`：已经部署过本仓库旧版本（2026-06 的保留期功能）的数据库已有这三列，**跳过这个文件**，否则 `ALTER TABLE` 会报列已存在。用管理后台迁移则不用区分。

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
