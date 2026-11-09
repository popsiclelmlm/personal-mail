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

## What's new compared with upstream

Built on [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email), this project touches more than 130 files and adds about 7,800 lines of code and docs. Highlights:

### New features

- **Sign-up creates a personal mailbox**: with `REGISTER_WITH_PERSONAL_MAILBOX`, the sign-up form asks for a name at the personal domain, and that address is both the login and the personal mailbox; the password is entered twice and the address is confirmed before submitting
- **Personal-only domains** (`PERSONAL_MAIL_DOMAINS`): used only for personal mailboxes, never offered for temp mail, Telegram or redeem codes
- **Mailbox page with a unified inbox**: mail from all of an account's mailboxes in one list, filter by address, unread counts per address, mark as read or unread
- **Personal mailbox management**: upgrade an address to a permanent personal mailbox (never cleaned up); versioned mailbox credentials that can be reset to revoke old ones; turn off credential login so the mailbox is reachable only through the account; transfer to another account
- **Account deletion**: choose to delete or transfer each personal mailbox; other addresses and their mail are removed
- **Invite-only sign-up** (`REGISTER_MODE = invite`): generate codes in bulk with a use count, a role to grant, an expiry and a note, and see who used them; sign-up runs in a transaction, so codes are never overused
- **Password reset through a recovery email**: an optional outside address receives the reset code, and a notice is sent after the reset; when the sending quota is used up, users see "try again tomorrow" instead of an error
- **Temp mailbox retention**: addresses can keep a retention period and are cleaned up afterwards; permanent mailboxes and addresses within their retention period are skipped by every cleanup task; per-IP limits per base domain (`IP_DOMAIN_CREATE_LIMIT`)
- **Privacy policy and acceptable use page**, linked from the footer and the sign-up form
- **Sign out everywhere** for both users and admins

### Security hardening

- User passwords are stored with PBKDF2-SHA256 and a random salt; older hashes are upgraded on the next login
- Lockout after repeated failed logins, sign-ups and password resets; per-IP rate limiting also covers login and password reset; the same message for unknown accounts and wrong passwords
- Versioned user tokens are revoked immediately by a password reset or "sign out everywhere", and are bound to the account they were issued for, so a reused account id never inherits a session
- Role tokens are checked against the account's current role on every use, so revoking or downgrading a role takes effect at once
- The admin console uses 8-hour, revocable session tokens instead of storing the admin password in the browser; wrong admin passwords are locked out too
- Mail HTML is sanitized in every display mode, the iframe mode is sandboxed, and pages send a Content-Security-Policy
- Attachments a browser could run (HTML, SVG and the like) are download-only
- Optional Turnstile on password reset, sign-up, anonymous mailbox creation and all logins; reserved address names (admin, noreply, ...); pages are kept out of search engines

### Experience

- Default "Magpiess Mail" branding (magpie logo, blue theme) and a simpler navigation: Mailbox / Temp mail / User center
- A loading skeleton after sign-in instead of a false "session expired" warning
- A rewritten help page that matches the actual UI

### Deployment and engineering

- Runs entirely on Cloudflare's free tier, with password hashing tuned for the Workers free plan's CPU limit
- A [from-scratch deployment guide](docs/personal-mail/DEPLOY.md) (Chinese) with an AI-assisted workflow and prompt, plus a [production config template](scripts/personal-mail/wrangler.prod.example.toml)
- 273 Worker-side unit tests (D1 emulated with Node's built-in SQLite), 186 frontend tests, and a local API verification script that needs no Docker

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
