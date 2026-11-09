<!-- markdownlint-disable-file MD033 -->
# Personal Mail

<p align="center">
  <a href="README.md">中文</a> | <a href="README_EN.md">English</a>
</p>

A personal mail system that runs on Cloudflare's free tier. Invited users sign up and immediately get a long-lived personal mailbox at `name@your-domain`; visitors can create disposable temp mailboxes without an account. One Worker serves both the web app and the API, Cloudflare Email Routing receives mail, and the Resend free plan sends it. No server needed.

> Forked from [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) (MIT). Many thanks to its author and contributors. Most upstream features (attachments, Telegram bot, webhooks, OAuth2, passkeys and more) are still available.

> For learning and personal use only. Do not use it for anything illegal.

## Features

**Personal mailboxes**

- Sign-up creates the mailbox: the account is `name@personal-domain`, created together with its mailbox; sign-up needs an invite code
- Personal mailboxes are permanent and never cleaned up; the Mailbox page shows one inbox for all of an account's mailboxes
- An optional outside recovery email receives password reset codes
- When deleting an account, each mailbox can be deleted or transferred

**Temp mailboxes**

- Anyone can create one, with an optional retention period and automatic cleanup
- Per-IP limits per domain; personal domains never appear in the temp mailbox list

**Security and abuse prevention**

- PBKDF2 password hashing, lockout after repeated failures, and "sign out everywhere"
- The admin console uses short-lived session tokens; the admin password is never stored in the browser
- Mail HTML is always sanitized, pages send a Content-Security-Policy, and attachments a browser could run are download-only
- Turnstile (managed mode), per-IP rate limiting, and reserved address names (admin, noreply, ...)
- Privacy policy and acceptable use page

## Deployment

- **From scratch**: [docs/personal-mail/DEPLOY.md](docs/personal-mail/DEPLOY.md) (Chinese), in launch order, including how to let an AI coding assistant do the deployment
- **Configuration**: [docs/personal-mail/README.md](docs/personal-mail/README.md) (Chinese), new environment variables and differences from upstream
- **Upstream docs**: Telegram, webhooks, the SMTP proxy and other upstream features are documented in the [upstream docs](https://temp-mail-docs.awsl.uk)

Everything fits in the free tiers of Cloudflare Workers, D1, KV, Email Routing, Turnstile and Resend.

## Local development

```bash
cd worker && pnpm install
cp ../scripts/personal-mail/wrangler.local.toml wrangler.dev.toml
pnpm exec wrangler dev -c wrangler.dev.toml --port 8797
```

Frontend: `cd frontend && pnpm install && VITE_API_BASE=http://127.0.0.1:8797 pnpm exec vite`. Tests: `cd frontend && pnpm test` and `cd e2e && npm run test:unit`.

## Using your own brand

The UI is branded "Magpiess Mail" by default. To rebrand, change:

- Site name: `views.Header.title` in `frontend/src/i18n/message-registry.ts` and the files in `frontend/src/i18n/locales/source/`
- Logo and icons: `frontend/public/`
- Privacy policy text: `frontend/src/views/legal/privacy-policy-content.js`
- System mail subjects and bodies (password reset and so on): `worker/src/i18n/zh.ts`, `worker/src/i18n/en.ts`
- Footer credit: `COPYRIGHT` in the production config

## Tech stack

- Frontend: Vue 3, Vite, Naive UI; mail parsing in Rust compiled to WebAssembly
- Backend: Cloudflare Workers (Hono), D1 (SQLite) for data, KV for short-lived data
- Mail: Cloudflare Email Routing for receiving, Resend for sending

## License

[MIT](LICENSE), keeping the original project's copyright notice.
