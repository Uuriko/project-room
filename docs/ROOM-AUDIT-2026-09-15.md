# Project Room audit prompt and bug-hunt plan (2026-09-15)

Live origin is the product: `https://room.trydemigod.com`. Do not cut over GitHub `main`. Do not set `ship: true`. Skip occupied `.gitignore`, `.wrangler/`, `docs/*RESEARCH*`. Instinct #197 is off this lane.

## Prompt (reuse this)

You are auditing **Project Room** at `~/src/project-room-integration` against the **live Worker**, not against `main`.

Goal: prove Google sign-in still works, then hunt design / code / UI bugs that a real person would hit. Fix only proven bugs with tests on the real helper or HTTP path. Redeploy only from a clean worktree. Keep `/api/open` unpublished.

Never treat email as an account key. Never add Gmail mailbox scopes. Never merge Desk, Dasha, or Tag sandbox. Never first-write a new schema onto staging.

## Live bar (must hold)

| Check | Expect |
|---|---|
| `GET /api/version` | `mode: cloudflare-production` |
| `GET /api/open` | `ship: false`, `persistence: none` |
| `GET /api/auth-config` | `provider: google`, `authorizationPath: /api/auth/google/start` |
| `GET /api/auth/google/start` | 302 to `accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri=https://room.trydemigod.com/api/auth/google/callback`, `scope=openid email profile`, PKCE S256 |
| `GET /privacy` | 200, “Email is not the account key” |
| `GET /api/ready` | 200 |
| Worker secrets | `ROOM_OPERATOR_ACCOUNT_ID`, `ROOM_GOOGLE_CLIENT_ID`, `ROOM_GOOGLE_CLIENT_SECRET` only |

## Bug-hunt system

1. **Live contract script** — `scripts/live-audit.mjs` hits the table above. Fail closed on ship:true, missing Google client, Gmail mailbox scope, or Clerk browser SDK.
2. **Unit tests** — `node --test` on conversation, google-*, production-http, production-gates, provider-onboarding, share-links, channels.
3. **Static UI pass** — live `index.html` + `src/app.js` + `src/styles.css`: skip-link, auth CTA, hidden-until-JS traps, focus, mobile 40rem.
4. **Auth/session pass** — Google PKCE pending map vs SameSite=Strict, callback error `/?google=error`, first Welcome Google member invite grant, key/invite still work when Google is down.
5. **Work/receipts pass** — `conversationReceiptSentence` on result rows, work cards, and linked messages. Title prefix, not long summary.
6. **Do not** — Tree-of-Life UI, Telegram/Gmail/Twilio as launch, staging in-place schema, `accounts.trydemigod.com`.

## Design questions (answer with evidence)

- Can a new Google user reach Welcome without a key?
- After they land, can the first one invite, and can later ones talk without becoming operator?
- Is the primary sign-in Google, with keys as a fallback details, not the other way around?
- Does a work loop close in the conversation (receipt sentence) or only on a work card?

## Stop

One user-visible sentence per fix. Test the real path. Live bar still unpublished. Record findings in this file’s “Findings” section when the hunt runs.

## Findings (this run)

Live `scripts/live-audit.mjs` against `https://room.trydemigod.com`: **ok**, SHA `d57316f` at hunt start. Google start 302s with PKCE, `openid email profile`, callback on the Room origin. `ship: false`.

| Severity | Finding | Action |
|---|---|---|
| High | `/privacy` ran after `checkOrigin`, so a Google consent fetch with `Origin: accounts.google.com` would 403 | Serve `/privacy` before origin check |
| Medium | HTML CTA said “Join”; “Sign in” was also `button primary` | Google is the primary button; keys are ghost fallback |
| Medium | Privacy page was unstyled | Link Room CSS |
| Note | `www.trydemigod.com/room` Join still points at staging | Not this Worker; Demigod HTML door |
| Note | Google may show an unverified-app screen | Expected without Google verification |
| Note | Receipt sentence says “waiting on you” to every viewer | Agreed A1 copy; not changed |

Bug-hunt system: `node scripts/live-audit.mjs` (live) and `node --test tests/live-audit.test.js` (contract, including fail-closed on `ship: true` and Gmail mailbox scope).
