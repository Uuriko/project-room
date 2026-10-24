# Room auth / session friction — 2026-09-18

Audit of the human and agent loops from signup → signin → using → logout /
close browser → login back. Code read on `main` `35526422` (Connect/People
#626 merged) plus this branch. Live probes against
`https://www.getdasha.com/room*` (Worker tip ~`5506d9a2`+; dogfood room
`grok-muse-potter-20260918`). No live secrets in this file.

Hands-off (not this PR): shareable login-link / agent-issued invite-link
(#628), Phase 0 #8/#9. Muse People HTML landed in #626 — this PR sits on
top of it and does not overwrite Connect CTAs.

**#613 merged.** First paint is Google + More. This PR sits on that wrap:
session hint / restore stay outside `#signin-extra`; the key form stays
behind More. Playwright fills use `fillAccessKey`.

## What a visitor actually meets

| Surface | Live (www) | Notes |
|---|---|---|
| HTML door | `/room` | Worker HTML. Apex `/` and `/api/*` stay Webflow. |
| Health | `GET /room/api/health` 200; `GET /api/health` 308 | Webflow owns `/api/*`. |
| Agent mint | `POST /room/api/agent-identities` 201 | Canonical live path. |
| Flow-name mint | `POST /room/api/identity-create` **404** | Alias missing on the deployed Worker. `POST /api/identity-create` is 405 openresty. |
| Session cookies | `room_session` / `account_session` | HttpOnly, SameSite=Strict, Max-Age. Not readable from JS. |
| Account window | `authenticatedUntil` ≤ 8 hours | Store signs the slot in; activity does not extend it. |
| Tab leftovers | `sessionStorage` `pr-auth-kind`, `pr-guide-dismissed` | Die when the tab closes. |
| Browser leftovers (this PR) | `localStorage` `pr-last-room`, `pr-had-account` | Room id + boolean only. Never a secret. |

Cold `GET /api/account-session` still **creates** an anonymous slot
(20/ip/min, 10k cap). That is load and inventory friction for every
first-paint visitor who never signs in.

## Human loop

### Signup / first paint

**Before.** Welcome showed Continue with Google, then the full key form,
then GitHub plus email/password, magic link, passkey, and recovery — all
visible. A new human could reach a key in one click, but the panel looked
like six products.

**#613 (merged).** First paint is Welcome + Google + More. Key form, extra
methods, and invite redeem live in `#signin-extra`. This PR keeps that wrap
and adds session hint / restore above More so a returning browser can
Reopen or Continue without opening More. Muse Connect / People CTAs from
#626 are untouched.

### Signin / reload

**Before.** Boot without `?room=` or `?account=1` tried only the room
cookie. A valid account cookie was ignored after a closed tab because
`pr-auth-kind` lives in `sessionStorage`. Humans who signed in with Google,
then closed the browser, landed on Welcome again even though
`account_session` was still good.

**This PR.**

- Remember last room id and “had an account” in `localStorage`
  (`src/browser-session.js`).
- After a failed room-cookie restore, if those hints exist, try the account
  cookie and reopen the last room or the account workspace.
- Cold visitors (no hints) still skip `GET /api/account-session`, so we do
  not mint a slot just to draw Welcome.
- Auth panel copy states the cookie vs localStorage split
  (`#session-hint`).
- `#session-restore` offers **Reopen #<room>**, **Continue to your rooms**,
  and **Clear saved session on this browser**.

### Using

First room snapshot writes `pr-last-room`. Opening the account workspace
writes `pr-had-account`. No tokens, keys, or CSRF values touch
localStorage.

### Logout / clear

**Before.** Sign out is desktop-visible in the topbar (`display: contents`
on the session menu) and behind ⋮ on small viewports. It cleared cookies
but not last-room / auth-kind leftovers, so the next visit still tried to
reconnect.

**This PR.** Explicit Sign out and account-switch clear
`pr-last-room`, `pr-had-account`, `pr-auth-kind`, and `pr-guide-dismissed`.
The auth-panel **Clear saved session** button does the same and logs out
the account slot. Cookies remain the session; localStorage is only a hint.

### Close browser → come back

| State | After close | After this PR |
|---|---|---|
| Room cookie still valid | Reload restored the room | Unchanged, plus last-room hint for the CTA |
| Account cookie still valid, no `?account=1` | Welcome / empty | Restore workspace or last room when hints exist |
| Cookie expired / Sign out | Welcome, leftover hints | Hints cleared on Sign out; Clear session if they linger |
| Private mode / blocked storage | Silent catch | Same; restore CTAs stay hidden |

## Agent loop

### Mint / signup

Agents follow the flow name `identity-create`. The live Worker only serves
`POST /room/api/agent-identities`. Docs, CLI, and discovery all say
“identity-create” as a **command**, so HTTP clients that POST that path
get 404.

**This PR.** `POST /api/identity-create` is the same handler as
`POST /api/agent-identities` (shared `identity-create:<ip>` bucket).
`rewriteRoomApiPrefix` makes `/room/api/identity-create` the www form.
Declared `security: []` in `docs/openapi.yaml`, listed in
`docs/ROUTE-AUTH-TABLE.md` and `docs/INVITE-ONLY-CHECKLIST.md` §1, probed
in `tests/invite-only-boundary.test.js`.

**Until parent deploys this Worker:** keep minting
`POST /room/api/agent-identities`. Doctor’s signature table says so.

### Using / reconnect

Saved connections use `ROOM_AGENT_CONFIG` (a private directory) and must
not mix with `ROOM_AGENT_*` credential variables.

`check` only reports membership. Agents and TROUBLESHOOTING were told to
run `check` when they meant **doctor**.

Doctor itself GET `${origin}/api/health`. On www that is Webflow (308),
so a healthy Worker looked unreachable.

**This PR.**

- `doctorHealthUrl` uses `edgeDoorApiPath` → `/room/api/health` on
  getdasha hosts.
- Failure signatures cover identity-create 404 and the www health prefix.
- `reconnectCopy` (People → Copy plug-in steps) names
  `ROOM_AGENT_CONFIG=… node scripts/agent-inbox.mjs doctor`.
- `docs/AGENT-CONNECTION.md`, `docs/AGENT-QUICKSTART.md`, and
  `docs/agents/TROUBLESHOOTING.md` distinguish doctor vs check.

## Browser UX report (sibling, 2026-09-18)

Live dogfood on `www.getdasha.com/room#room/{id}` (Open → workers.dev app):

1. **Open dropped the room.** Door script only set `#room/{id}` on
   `a.open`. In-app browsers often drop the fragment on the
   `www.getdasha.com` → `project-room-staging.getdasha.workers.dev` hop.
   The auth gate then showed Welcome with no room id. **This PR:** Open
   and People also set `?room={id}` (survives redirects), click-capture
   as backup. In-app navigation keeps the `?room=` contract so existing
   exact-URL checks still match. The gate title is `Open room {id}`
   with a one-line hint. Owner/title still appear only after sign-in
   (no public room directory).
2. **Auth clutter / key confusion.** Potter live: first paint still
   confusing. **This PR:** Welcome (or Open {room}) + Continue with
   Google + quiet **More options**. Room key, Account key, Have an
   invite, then GitHub/email/magic/passkey/recovery sit inside More.
   Session essay and restore CTAs also stay inside More.
3. **Invite field looked like the default entry.** It is a `<details>`
   inside More. **This PR:** summary is **Have an invite**. People /
   door copy never tells a human to share `#room/{id}` — they
   **Open this invite link** (full `#join/<43-char>`). Minting a
   human invite copies that full URL in one click.
4. **`POST /room/api/identity-create` 404** — alias in this PR; live
   until parent deploys.

P2 from the same report: mobile ⋮ was blank when logged out. **This PR:**
hide `#session-menu` when empty; show **Clear saved session** in the
overflow only when leftovers exist.

## Fixes in this PR (highest ROI, safe)

1. Identity-create HTTP alias (canonical + `/room` prefix).
2. Session restore after reload/close + reconnect CTAs + cookie copy.
3. Sign out / Clear session wipe hints and the account slot.
4. First-paint collapse harder than **#613**: Google + More options
   only; session restore and extra methods stay inside More.
5. Doctor health prefix + documented saved-connection doctor path.
6. Door Open/People `?room=` + `#room/` handoff; gate names `Open {title}`
   when this browser has seen the room, otherwise `Open room {id}`.
7. Room vs Account key hint; quieter invite field; empty mobile ⋮ hidden.

## Remaining P1s (not this PR)

1. **#628 shareable login-link / agent-issued invite-link** — hands-off;
   other agents own minting share links with a bearer.
3. **8-hour `authenticatedUntil`** — account sessions do not slide on
   activity. After eight hours a returning human must sign in again even
   if the cookie Max-Age is longer. Needs a product call (slide vs
   re-auth vs remember-me), not a silent TTL bump.
4. **Phase 0 #8/#9** — hands-off.
5. **Live Worker lag** — `/room/api/identity-create` and the door
   `?room=` handoff stay on the old Worker until the parent deploys.
   No wrangler from this agent.
6. **Anonymous account-slot create** — `GET /api/account-session` still
   mints a slot when extra sign-in methods run. Cold first paint no longer
   calls it; a follow-up could make the GET read-only and POST the slot.
7. **Room owner on the unauthenticated gate** — invite-only; no public
   preview. The id is always shown; the title is shown when this browser
   has already opened that room.

## Coordination

- **#626** merged as `35526422` (“Connect/People UI for agent-owned
  Rooms”). This branch is based on that tip. People / Connect markup,
  roster CTAs, and Muse packet copy were not rewritten.
- **#613** merged. This branch keeps Google + More and does not add a
  second More-options control.
- **#628** untouched.
- **#639** held — another Muse owns Commons.diy research. No collide.

## How to verify (no secrets)

```sh
# Alias + inventory
node --test tests/agent-identities.test.js tests/browser-session.test.js \
  tests/auth-signin-ui.test.js tests/agent-doctor.test.js \
  tests/invite-only-boundary.test.js tests/open-routes.test.js \
  tests/room-roster.test.js tests/room-deep-link.test.js tests/room-entry.test.js
node scripts/open-routes.mjs --check

# After deploy, live www (do not commit the response secret):
# curl -sS -X POST https://www.getdasha.com/room/api/identity-create \
#   -H 'content-type: application/json' \
#   -d '{"displayName":"probe"}'   # expect 201, same shape as agent-identities
```
