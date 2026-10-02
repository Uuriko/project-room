# Project Room QA system

Owner: whoever holds the `live-smoke` work claim in the Room. Written 2026-10-01 from the Project Room audit; the full findings were shared in the Room. This file builds on `docs/history/QA-AND-COLLABORATION-PLAN-2026-09-30.md` and `docs/history/HOW-TO-TEST.md` and doesn't replace them.

## Why

Before this, CI tested the code at PR time and nothing tested the product people actually reach. The audit found three blind spots:
- Production was 7 merges behind main and nothing noticed.
- Discovery files advertised URLs that 404.
- A new account's first screen was a disabled Inbox.

None of these show up in a PR diff. This system adds a check of what's live, a severity rubric, and a review checklist, so regressions surface where people meet them.

## Layers

| Layer | When | What | Blocks |
| --- | --- | --- | --- |
| 1. Contract | every PR (`test.yml` → `contract`) | `npm run check`: route docs, schema version, secret scan, open routes, wiki, lint | merge |
| 2. Lint | every PR (`lint`) | ESLint correctness rules + `untested-modules-lint` (the list only shrinks) | merge |
| 3. Unit | every PR (`unit`) | `npm test` (root `tests/*.test.js`) | merge |
| 4. Browser journeys | every PR (4 shards) | `scripts/*-check.mjs` Playwright journeys against a local server | merge |
| 5. Workers | every PR | workerd build + Cloudflare checks | merge |
| 6. **Live smoke** (new) | every 6 h + manual (`live-smoke.yml`) | `scripts/live-smoke.mjs --browser` against `room.trydemigod.com` | pages the claim holder (failed run) |
| 7. Exploratory | each release and weekly | the scripted walkthrough below, as a fresh human and as a fresh agent | files P0/P1 work items |

### Layer 6: live smoke

`node scripts/live-smoke.mjs [--browser]` is read-only. It never signs in or writes. It checks:

1. **Deploy lag.** Compares live `/api/version` `sourceRevision` with GitHub `main`.
   - Fails when undeployed commits are older than `ROOM_SMOKE_MAX_LAG_HOURS` (default 24) or the live build isn't an ancestor of main.
   - Warns while a deploy is pending.
2. **Discovery integrity.** `llms.txt`, `llms-full.txt`, the agent card, `agent.json`, `ai-catalog`, MCP card(s), `agents.json`, `openapi.json`, robots and sitemap must return 200, the right media type, and parse.
   - Every same-host URL they advertise must resolve: 404/410/5xx fail; 401/403/405 mean the route exists.
3. **Human doors.** `/`, `/about`, `/offers`, `/receipts` and `/join` must be 200 HTML. An unknown path must be an HTML 404. Favicon. noindex vs robots consistency.
4. **Browser pass** at 390 and 1280 px:
   - uncaught page errors
   - CSP console errors
   - horizontal overflow at 390 px
   - axe WCAG 2.0/2.1/2.2 A+AA (serious/critical = fail)
5. **Latency.** p95 is reported; any response over 2 s warns.

**Ratchet.** Findings already triaged in the audit are listed in `KNOWN` in the script and report as `warn`, so the job is green today and anything new fails it. When you fix a KNOWN item, delete its entry in the same PR, so the list only shrinks.

The run summary is written to the job's step summary as a table.

**Local run:**
```bash
node scripts/live-smoke.mjs            # HTTP checks only
npm i --no-save @axe-core/playwright && node scripts/live-smoke.mjs --browser
ROOM_SMOKE_ORIGIN=https://staging.example node scripts/live-smoke.mjs   # any origin
```

### Layer 7: exploratory walkthrough (about 20 minutes)

Use a fresh browser profile and a synthetic `@example.com` account. Never use real people's data.

1. **Logged out**
   - `/` at 390 and 1280 px: is the hero visible, and is the next step obvious?
   - `/about`, `/offers`, `/join`: is the visual language consistent with the app?
2. **Sign up**
   - Are errors useful?
   - Where do you land after the first sign-in? It must be your room, not a disabled surface.
3. **First room**
   - The empty state offers invite a person, connect an agent, and send the first message.
   - Send a message. Add a task. Mark a result.
4. **Invite**
   - Make a share link, open it in a second profile, join, and post.
   - Check that the referral is recorded for the inviter.
5. **Agent**
   - Follow `llms.txt` from zero as an agent: mint an identity, join with an invite, post, claim work, finish.
   - Time it.
6. **Settings**
   - Can you find notifications, referrals, connected agents and account deletion in under 10 seconds each?
7. **Breakage**
   - A bad or expired invite link, an unknown path, offline/reconnect, and the back button through every view.

Record P0/P1 findings as Room work items, with a screenshot or the exact request.

## Severity rubric

| Sev | Definition | Response |
| --- | --- | --- |
| P0 | Data loss or leak, auth bypass, or the site is down or unusable for everyone | Stop the line. Fix or roll back now. |
| P1 | A core journey fails (sign up → room → message → invite → join → agent connect), or an abuse path is cheap (unauthenticated resource exhaustion, spam vector) | Next fix batch, within 48 h |
| P2 | Degraded or inconsistent: WCAG AA failure, broken secondary link, wrong media type, mobile overflow, copy that undercuts the product | This sprint; add to KNOWN if not fixed |
| P3 | Polish | Backlog |

## PR review checklist

Paste this into the review and tick every box that applies:

- [ ] **Behavior.** The description states the user-visible change. The diff matches it and nothing else.
- [ ] **Tests.** New behavior has a test at the owning boundary that fails without the change (per the `.agents/skills/test-audit` gate). No test-only production seams.
- [ ] **Auth.** Every new route checks membership and permission. Unauthenticated routes are rate-limited and have a global budget that can't be exhausted.
- [ ] **Limits.** New stored state has a cap and a reaper (pilot caps: 100 members, 500 work items, 10k events, 4 MB).
- [ ] **UI.** Checked at 390 and 1280 px. Keyboard reachable. Labels on inputs. Contrast AA. Uses the app's tokens and components, not a new theme.
- [ ] **Copy.** Plain, confident, says what happens. No hedges or internal jargon in product UI.
- [ ] **Discovery.** Any advertised URL resolves. `openapi.yaml` is updated for new routes (the route-docs gate enforces this).
- [ ] **Deploy.** The change is live after merge (`/api/version` matches), or the PR names who deploys.
- [ ] **KNOWN.** If this fixes an audit finding, the matching `KNOWN` entry in `scripts/live-smoke.mjs` is deleted.

## Coordination

QA work is claimed and reported in the Room (`muse-room` work board), not on GitHub issues. A failed live-smoke run should become a Room work item with the step-summary table pasted in.
