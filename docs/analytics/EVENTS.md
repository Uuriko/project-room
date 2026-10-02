# EVENTS.md: the Project Room growth event catalog

Status: catalog for AN-1a. Written 1 October 2026 (America/Phoenix). Code references are `path:line` on `main` at **cbd3f475** (2026-10-02). Line numbers will drift; each reference also names the function or the event constant, so search for that if a line has moved.

This is the growth event catalog. Weekly snapshots land in `docs/analytics/weekly/`. The collector that writes these rows lives in `server/analytics/`.

---

## 1. Principles

1. **Server-side only.** Nothing is emitted from the browser or an agent. Client analytics would miss agents, which are half our users, and would break on MCP.
2. **Derive from the durable record first.** Room already writes an append-only `events` table (`server/store.mjs:1218`, `(room_id, sequence, id UNIQUE, body)`). Twenty-two `INSERT INTO events` sites write it, for example `store.mjs:4039` (`command`), `work-claim-events.mjs:90`, `share-links.mjs:190`, `referrals.mjs:102`, `guest-invites.mjs:329/422/607/794` and `land-queue.mjs:806`. Hooking 22 call sites in hot files would collide with nearly every running batch. Instead, AN-1 **tails the `events` table by `(room_id, sequence)`**, maps room events to growth events with a pure function, and reads a handful of side tables that don't write room events (accounts, invite tables, wake tables and public-work receipts). The same tail started at sequence 0 *is* the backfill. `importEvents` (`server/store.mjs:3604`) replaces a room's log and rewrites sequences; deterministic ids keep that from double-counting.
3. **Request context comes from one ingress hook.** `source` (ui, rest, mcp or webhook) and the attribution token are request facts, not event facts. They're captured once per request in an `AsyncLocalStorage` context (`nodejs_compat` is on; ALS is already used at `cloudflare/room.mjs:6/82`). A 6-line registry in `src/events.js:384 event()` then records `event.id → context` in a bounded LRU, and the tail joins on `event.id`. If a context is missing, the event gets `source:"unknown"` and the miss is counted. It is never guessed.
4. **One table, bounded, append-only.** `analytics_events` holds 90 days or 2M rows, whichever is smaller. Rows are pruned only after they've been exported to R2 as hourly NDJSON. Nothing is sampled below 100k events per UTC day. Above that, only the `public_artifact_viewed` event is sampled, and each kept row carries a `weight` column so the counts stay honest.
5. **Never invent.** Backfilled rows carry `backfilled=1` and `source:"unknown"` unless the stored body proves the source. Events the system can't see, such as page visits before AN-1 or anything to do with billing, are reported as *missing* and never filled in.

## 2. The envelope

Every growth event is one row in `analytics_events` and one line in the R2 export.

| Field | Type | Notes |
|---|---|---|
| `id` | text | Deterministic: `aev_` plus the first 20 hex chars of `sha256(sourceId + "|" + name + "|" + n)`. `sourceId` is the room event id, or a stable side-table key when the row did not come from `events`. Re-running the tail, and a restore that rewrites rowids, cannot duplicate rows. |
| `name` | text | One of the names in §3, e.g. `claim_completed`. |
| `v` | int | Schema version of `props` for this name (starts at 1). |
| `at` | int ms | The time of the underlying record (the room event's `at`, or the table's `created_at`), not the time the tail ran. |
| `room_id` | text or null | Null for account-level and anonymous public events. |
| `account_id` | text or null | The human account behind the actor, when there is one. |
| **`actor_kind`** | enum | `human`, `agent`, `system` or `anonymous`. It comes from the member's `kind` (`member.added` data at `store.mjs:652`), from an agent identity (`agent-identities.mjs:282`), or from the request (no session means `anonymous`). This matches the existing Track C `ACTOR_KINDS` in `src/growth-events.js`, plus `anonymous`. |
| `actor_id` | text or null | Member id, agent identity id or account id. For anonymous viewers it's null; see `viewer_key`. |
| **`source`** | enum | `ui`, `rest`, `mcp`, `webhook`, `cron` or `unknown`. How the source is classified is in §4. |
| `source_detail` | text | The existing Track C channel, kept for continuity: `web`, `api`, `agent-inbox`, `telegram`, `email-inbound` or `system` (from `src/growth-events.js` `EVENT_SOURCES`). |
| `agent_client` | text or null | For `mcp`, the normalised MCP `initialize` `clientInfo.name` (`server/mcp-http.mjs:66`, `server/mcp-room-profile.mjs:671`), e.g. `claude-code`, `codex`, `cursor`, `other`. Otherwise it's the member's `agentType` when one is set. |
| **`referrer_artifact_id`** | text or null | The public artifact that led here, typed by prefix: `rcpt:<wcr_…/wir_…/pwr_…>`, `room:<slug>`, `tmpl:<id>`, `agent:<agentId>`, `inv:<invite id>`, `dir` (the agent directory) or `doc:<path>` (llms.txt, docs). |
| **`ref_member_id`** | text or null | The member who shared it, decoded from a signed `ref` token (§5). It's null for legacy plain-text refs. |
| **`loop`** | enum | `invite`, `agent_invite`, `receipt`, `template`, `public_room`, `agent_card`, `directory`, `referral`, `docs`, `organic` or `unknown`. It's derived from `referrer_artifact_id` and the event. |
| `viewer_key` | text or null | For anonymous public events only: `HMAC(daily_salt, ip_/24 ‖ user-agent)`, truncated to 16 chars. The salt rotates daily and the IP is never stored. It's used only to count unique viewers per day. |
| `room_event_id` / `room_seq` | text / int | Provenance back to `events.id` and `events.sequence`. |
| `props` | JSON ≤ 2 KB | Event-specific fields, listed in §3. No message text, no file contents, no secrets, no emails. |
| `weight` | int | 1, unless sampled. |
| `backfilled` | 0/1 | 1 when the row came from history, before the ingress hook existed. |

## 3. The catalog

Each entry gives:
- **Capture**: where AN-1 gets the event. "tail" means mapped from the `events` table by `server/analytics/map-room-event.mjs`. "table" means read from a side table by `derive-tables.mjs`. "hook" means recorded at request time by the ingress context.
- **Emit point(s)**: the code that produces the underlying record, in its current form.
- **Backfill**: whether history can be rebuilt.

### Acquisition and setup

| Event | Definition | Emit point(s) today (`path:line`) | Capture | actor_kind / source | Attribution | Key props | Backfill |
|---|---|---|---|---|---|---|---|
| `signup` *(added; the funnel needs it)* | An account is created. | `server/store.mjs:2328 createAccount` (INSERT at `:2335`, `accounts.origin`, `created_at`). Callers include GitHub OAuth, Google OAuth, magic link and password signup in `server/http.mjs`. | table `accounts` | human / ui | `ref` from the signup request context (hook), when present | `origin` (the `accounts.origin` string as stored; empty falls back to `local-provisioning`) | yes (time and origin; no source or attribution) |
| `room_created` | A room is created by a person or an agent (the Commons bootstrap room is excluded). | `server/room-lifecycle.mjs:130` (`T.ROOM_CREATED`, from `createAccountRoom` at `:77`); `server/agent-rooms.mjs:162` (agent-created room); `server/http.mjs:2376` (`POST /api/account-rooms`); excluded: `server/bootstrap.mjs:5` | tail `room.created` | human or agent / hook | `ref`, `referrer_artifact_id` (when created from a template or a public CTA) | `kind`, `template_id` (null if none), `created_via` (`account`, `agent`, `template`) | yes |
| `template_forked` | A room is created from a template. | `server/templates.mjs:145 applyRoomTemplate` → `createAccountRoom` at `:155`; route `server/http.mjs:2380` (`POST /api/account-rooms/from-template`). The template `ref` field is already accepted (`templates.mjs` FIELDS). | tail `room.created`, plus `templateId` in data (when absent, AN-1c adds it to the event data, as an additive field) | human / hook | `referrer_artifact_id = tmpl:<id>` | `template_id` | partial (only if the room data names the template) |
| `member_invited` | A person or agent creates an invite of any kind. | `server/share-links.mjs:204` (share link create; event at `:190`); `server/guest-invites.mjs:430` (mint; events `:329/:422`); `server/agent-invites.mjs:152` (create; row at `:205 agent_invite_codes`); `server/referral-invites.mjs:235` (mint; rows at `:274/:290`; route `server/http.mjs:3212`); `server/guest-agent-links.mjs:220` (mint); `server/store.mjs:2733 issueInvitation` (`membership_invitations` at `share-links.mjs:380`); inbound variant: `server/access-requests.mjs:147` (`access.requested` at `:268`) | table `share_links`, `guest_invites`, `agent_invite_codes`, `referral_invites`, `membership_invitations`; tail `access.requested` | human or agent / hook | the invite id becomes `inv:<id>`. AN-1c adds a signed `ref` to the invite URL. | `invite_kind` (`share_link`, `guest`, `agent_code`, `referral`, `guest_agent`, `membership`, `access_request`), `invitee_kind` (human, agent, either) | yes (from table `created_at`) |
| `invite_accepted` | Someone joins a room through an invite. | `server/share-links.mjs:320 join` (route `server/http.mjs:2859`) and `:154 joinAgent` (route `:2827`); `server/guest-invites.mjs:521 redeem` (route `:2772`); `server/guest-agent-links.mjs:304 join` (route `:2744`); `server/agent-invites.mjs:213 redeem` (route `:3194`); `server/referral-invites.mjs:357 redeem` (route `:3229`); `server/store.mjs:2908 acceptInvitation`; `server/access-requests.mjs:552 decide` and `:384 tryAutoApprove`; `server/invitation-evidence.mjs:11` (`member.joined_via_invitation`); `server/http.mjs:2946` (`/join`) | tail `member.joined_via_invitation`, `member.added` with invitation evidence, `referral.completed` | human or agent / hook | `inv:<id>`, `ref_member_id` = inviter | `invite_kind`, `invitee_kind`, `minutes_since_invite` | yes |
| `agent_connected` | An agent becomes a member of a room for the first time. | `member.added` with `kind:"agent"` at: `server/agent-connections.mjs:207`, `server/share-links.mjs:183`, `server/agent-invites.mjs:268`, `server/referral-invites.mjs:418`, `server/guest-agent-links.mjs:270`, `server/guest-invites.mjs:590/:777`, `server/access-requests.mjs:449`, `server/agent-rooms.mjs:162`. Identity mint: `server/agent-identities.mjs:282 create` (route `server/http.mjs:3161`). MCP ingress: `server/http.mjs:817` → `server/mcp-http.mjs:226`. | tail `member.added` (kind agent), deduplicated per (room, member) | agent / hook (`mcp` if it arrived through `/mcp`) | `referredBy` from `member.added` (`store.mjs:652`, checked at `:4145`), `inv:<id>` | `agent_client`, `agentType`, `connect_path` (`mcp`, `rest`, `invite_code`, `share_link`, `referral`, `guest`) | yes |
| `agent_first_post` | An agent member's first `message.posted` in a room. | `server/store.mjs:4204` (command path, `T.MESSAGE_POSTED`) | tail (first occurrence per room and member, kept in `analytics_firsts`) | agent / hook | inherits from that member's `agent_connected` | `minutes_since_connected` | yes |
| `agent_woken` | Room delivers a wake to an agent. | `server/agent-heartbeats.mjs:445 enqueueWake` (ack at `:427`); `server/wake-queue.mjs:164 enqueue` (row at `:200`); `server/work-wakes.mjs:105` ack; webhook delivery `server/agent-plugin-store.mjs:733-748` (constant `server/outbound-webhooks.mjs:212`); claim wake `server/work-claim-events.mjs:58 enqueueClaimWake` | table `agent_wake_signals`, `wake_queue`, `agent_work_wakes` | system / webhook or cron | none | `wake_kind`, `delivered` (bool), `ack_ms` | partial (only what the tables keep) |

### Work and proof

| Event | Definition | Emit point(s) today | Capture | actor_kind / source | Attribution | Key props | Backfill |
|---|---|---|---|---|---|---|---|
| `claim_created` | A Board work item is created. | `server/work-claim-routes.mjs:604` `commit(item,"created")`. The helper `commit()` at `:420-437` calls `emitWorkClaimEvent` (`server/work-claim-events.mjs:70`, insert at `:90`, fan-out at `:94`). Legacy work items use `claim.acquired` at `server/store.mjs:4187`. | tail `work_claim.updated` action `created` | human or agent / hook | none | `claim_kind`, `has_files`, `has_pr` | yes |
| `claim_claimed` *(added; cycle time needs it)* | Someone takes a claim. | `server/work-claim-routes.mjs:627/:644` `commit(…,"claimed")` | tail `work_claim.updated` action `claimed` | human or agent / hook | none | `claimer_kind` | yes |
| `pr_linked` | A claim gets a pull request (at create, at claim, or later). | `server/work-claim-routes.mjs:603` (create with `pullRequest`), `:627/:644` (claim with `pullRequest`) | tail `work_claim.updated` whose `pullRequest` changes from null to set | human or agent / hook | none | `repo` (owner/name only), `pr_number` | yes |
| `pr_merged` | A linked PR merges. | `server/claim-pr-sync.mjs:296` and `:466` (`syncClaimPullRequests` at `:416`, action `pr_merged`); `:324` handles `ci_changed`. `applyPullRequestWebhook` (`:474`) exists but has no ingress route yet; it's polled by the `claim-prs` cron. | tail `work_claim.updated` action `pr_merged` | system / cron (`webhook` once a GitHub App route exists) | none | `minutes_claim_to_merge` | yes |
| `claim_completed` | A claim moves to `done`, or a legacy work item completes. | `server/work-claim-routes.mjs:715` `commit(updated,"state_changed")` to `done`; `:445` (`closeLiveClaims`); `:451` (lease sweep). Legacy: `server/store.mjs:4279` (`T.WORK_COMPLETED`; reducer `completeWork` in `src/events.js:1527`) | tail `work_claim.updated` (state `done`) and `work.completed` | human or agent / hook | none | `minutes_created_to_done`, `closer_kind`, `merged` | yes |
| `receipt_issued` | A proof-of-work receipt exists: `wcr_` (a claim that's done with its PR merged), `wir_` (a completed work item with a receipt) or `pwr_` (a public-work receipt). | `server/receipts-live.mjs:146` (`wcr_`, derived when the claim is done and merged), `:166` (`wir_`), id rule at `:11`; `server/public-work-claims.mjs:197` (`INSERT public_work_receipts`) | derived: emitted together with `claim_completed` or `pr_merged` when the rule at `receipts-live.mjs:146/166` first becomes true; table `public_work_receipts` | inherits the closer's | none | `receipt_kind`, `public` (bool, set if the room opted into public receipts via `room.public_receipts_set`) | yes |

### Public surfaces and loops

| Event | Definition | Emit point(s) today | Capture | actor_kind / source | Attribution | Key props | Backfill |
|---|---|---|---|---|---|---|---|
| `public_artifact_viewed` | A GET on a public artifact by anyone, including crawlers (flagged). | `server/http.mjs:1898-1939` (`/receipts`, `/api/public/receipts`, receipt detail); `:1948` (sitemap, crawler signal only); `:1973-2007` (`/templates`, `/agents`, `/r/<slug>` via `server/public-rooms.mjs:142/223/274`); agent card at `server/agent-plugin-routes.mjs:55`; `llms.txt`, `llms-full.txt` and kits come from `deploy/agent-discovery.mjs` | hook (AN-1c; there's no record of views today) | anonymous, human or agent / ui or rest | `referrer_artifact_id` = the artifact itself; inbound `ref` | `artifact_kind`, `is_bot` (from the UA list), `viewer_key` | **no**. Visits before AN-1c exist only in the owner's Cloudflare Web Analytics dashboard (beacon at `server/http.mjs:775-777`). |
| `public_artifact_cta_clicked` | A click on a "Start a room", "Join" or "Fork" CTA on a public artifact. | none today. CTAs are plain links: `server/receipts-live.mjs:80-84 startHref`, `server/public-rooms.mjs:19 publicRef` / `:26 withRef`. | hook on a new `GET /go?to=<allowlisted path>&ref=<token>` redirect (AN-1c, inside RT's routes module) | anonymous or human / ui | `referrer_artifact_id`, `ref_member_id` | `cta`, `to` | **no** |
| `referral_sent` | A member shares a referral or growth link. | `server/referral-invites.mjs:235 mint`; growth-loop mint path (`server/growth-loop.mjs`; SEC-1 holds this right now) | table `referral_invites`; AN-1c adds signed `ref` mints | human or agent / hook | `ref_member_id` = sender | `channel` (`agent_referral`, `link`, `receipt_footer`) | yes (agent referrals only) |
| `referral_converted` | A referred person or agent joins. | `server/referrals.mjs:59 record` (`T.REFERRAL_COMPLETED`, insert into `referrals`) | tail `referral.completed` | referee kind / hook | `ref_member_id` = referrer member id | `via`, `depth` | yes |
| `referral_activated` | A converted referee later activates. Read only when `referrals.activated_at` exists (G3 owns that column). | `referrals.activated_at` (a lazy ALTER in `server/growth-loop.mjs`) | table `referrals` | referee kind / hook | `ref_member_id` = referrer member id | `via` | yes, when the column exists |

### Money and retention

| Event | Definition | Emit point(s) today | Capture | Notes |
|---|---|---|---|---|
| `upgrade_viewed`, `checkout_started`, `subscription_started` (+ `trial_started` proposed by BILL-3) | Pricing and billing steps. | **None today: there's no billing** (roadmap §8). The parallel `growth/prompts/BILL-*.md` batches plan to emit these through AN-1 if billing is approved. | reserved in `catalog.mjs` (`reserved: true`); BILL flips them to emittable in its own PR | Until then, the `/admin/metrics` revenue panel shows "missing: no billing". Don't create stub events. |
| `churned` | Derived: a room or account with no qualifying activity for 28 days after having been active. | computed by AN-2 from `analytics_events` | derived, not emitted | Kinds: `room_churned`, `agent_churned`, `human_churned`. |

## 4. Classifying `source` (AN-1c ingress hook)

The first matching rule wins:

1. `/mcp` and `/room/mcp` (and anything else `isRoomMcpPath` matches, `server/http.mjs:817`): **`mcp`**.
2. Webhook ingress paths (`/api/inbound/*`, `/api/webhooks/*`, email `room.mjs email()`): **`webhook`**.
3. A scheduled job (`scheduled()` in `cloudflare/room.mjs`, or Node intervals): **`cron`**.
4. A request with a session cookie: **`ui`**.
5. A request with a bearer token (member token, agent identity token or OAuth access token): **`rest`**.
6. Anything else: **`unknown`**. It's counted in `analytics_daily.unknown_source` and must stay under 2% of new events once AN-1c ships.

`actor_kind` comes from the authenticated principal, never from the path. An agent using a cookie session through the UI is still `agent` with source `ui`.

## 5. Attribution tokens

- **Format**: `ref=r1.<b64url(payload)>.<b64url(hmac16)>`. The payload is `{m: memberId?, a: artifactId, l: loop, t: issuedAt(sec)}`. The HMAC uses the `ANALYTICS_REF_KEY` secret (STG/ops add it; until it's set, tokens are minted unsigned as `r0.` and treated as untrusted). Tokens are at most 160 chars. They expire after 90 days for attribution purposes; the link itself still works.
- **Where they go** (AN-1c):
  - invite URLs: share links, guest invites, agent invite codes, referral invites;
  - public receipt footers (`receipts-live.mjs:80 startHref`);
  - public room pages (`public-rooms.mjs:26 withRef`);
  - template pages;
  - agent cards;
  - the llms.txt "start" link.
- **Backward compatibility**: today's plain `ref=<display name>` (≤80 chars), which `src/app.js:139-153` uses to prefill "who referred you", keeps working. The server treats any `ref` that isn't `r0.`/`r1.` as `loop=unknown`, `ref_member_id=null`, and keeps the raw name only in the UI's prefill path. It never goes into analytics, because it's a person's name.
- **Persistence through signup**: the first-touch `ref` is stored server-side, with a 30-day TTL, against the provisional session or redemption id, and copied onto `signup` and `room_created`. The client's existing sessionStorage stash stays as it is.
- **G3 alignment**: G3's planned `?ref=<memberHandle>` and `referral.activated` should mint through `server/analytics/attribution.mjs mintRef()` instead of a second format.

## 6. Derived metrics (computed by AN-2 from `analytics_events`)

- **Weekly Productive Room (WPR)**: a room counts for an ISO week (Monday 00:00 UTC; the dashboard labels the week in America/Phoenix) if, in that week:
  - at least one `human` and at least one `agent` actor each emitted any work or conversation event (`message.posted`, a claim action, `room_created`, `invite_accepted`); and
  - at least one `claim_completed`, `pr_merged` or `receipt_issued` happened.
  
  Commons, QA and canary rooms are excluded using `ANALYTICS_EXCLUDED_ROOMS`, plus any room whose title or slug matches `/^(qa|canary|instinct-canary|smoke)/`. The excluded count is shown separately, never silently dropped.
- **Activation funnel** (per account cohort, by first-touch week): `public_artifact_viewed` (unique `viewer_key`) → `signup` → `room_created` → `agent_connected` (first in any of the account's rooms) → first `claim_completed`, `pr_merged` or `receipt_issued` in that room. **TTFV** is the time from `signup` to that first close, reported at the median and p90.
- **K per loop**: for each `loop` and cohort week, `invites_sent_per_activated_user × conversion_to_activated`. Activated means an account (or agent) that reaches "first work closed" within 14 days. **Cycle time** is the median time from `referral_sent`/`member_invited` to the referee's activation.
- **Cohorts**: retention at week 1, 4 and 8, for humans (accounts with any human action), agents (agent members with any action) and rooms (rooms with any activity, and separately with WPR status).

## 7. Additions proposed by sibling growth prompts (not yet in the catalog)
Other growth prompts in this folder were written in parallel and use these names. Add each one to `catalog.mjs` in the PR that first emits it, with a `v`, typed props and a test. Never use free-form names.
- **ACTIVATION.md (ACT-*):** `nudge_shown`, `nudge_acted`, `starter_completed`, `onboarding_probe_run`.
- **BILL-3:** `trial_started`.
- **DX-3:** `adoption.snapshot`. Rename it to `adoption_snapshot` to match the snake_case catalog.

## 8. What's deliberately *not* tracked

- Message bodies, file contents, PR titles, emails, IP addresses (only a salted /24 hash that rotates daily) and OAuth tokens.
- Per-keystroke or UI-interaction events. When the UI later needs them (S1 or CP panes), they post to a server endpoint that tags `source=ui`. That's out of scope for AN-1.

## 9. Backfill

`npm run analytics:backfill -- --db <sqlite> [--report]` runs `scripts/analytics-backfill.mjs`. It opens that file read-only, copies the tables the tail reads into memory, and runs the tail there. It prints Weekly Productive Rooms for the last 12 ISO weeks (Monday 00:00 UTC), the same count without the human requirement (an agent and a close are still required), the room funnel (rooms created, rooms with an agent, rooms with a close, median and p90 hours), signups by week and origin, and referral K.

Every figure is labelled `backfilled; source unknown`. Visits and billing are reported as missing and are never filled in. The command does not write the input file.

AN-1b owns the minute job, the hourly export, and the R2 binding. AN-1c owns the request hook that fills `analytics_ctx`. Those are not part of this page's collector.
