# HUMAN-100 Guild-02 — ranked bug list (human bug-hunt, report-only)

**Wave:** HUMAN-100 guild-02 (re-dispatch). **Verified against:** origin/main @ `c5766a717` (PR #2336, 2026-10-09 17:40 PDT); W3 additionally verified @ `8ae241ef`.
**Method:** 6 workers, each bug reproduced on current main with exact file:line + minimal repro. Report-only — no fixes written.
**Status key:** REPRODUCED = still broken today · FIXED = fixed by a landed commit · PARTIAL = one sub-item fixed.

## P1 — fix first

### 1. "2 need you" vs "Nothing needs you" — REPRODUCED (room seq 8332)
Top bar pill counts work waiting on you; Updates › Needs me shows "Nothing needs you. 0 loaded." Two counters, two sources, no overlap.
- Pill: `src/app.js:7317` (`contributionSteps`, selector `src/work-selectors.js:167`)
- Updates: `src/updates-ui.js:234` — renders only `GET /updates?state=actionable`; `contributionSteps` never referenced there
- Server: `server/updates.mjs:255–293` drops every work step except `review_requested`/`handoff` (`OWED_KINDS`, `server/updates.mjs:479`); a self-assigned proposed item (next step = accept) never becomes an update
- Repro: fresh account → New work ×2 assigned to self → pill reads "Catch up · 2 need you" → Updates: "Nothing needs you."
- Note: guild-01's FIND-1 (pill vs Board › Needs me list, `src/board-mine.js:90`) is a DIFFERENT root cause (board-claim model vs work-item lifecycle) — two independent fixes, both need a product call on the single needs-you definition.

### 2. In-thread reply to an agent's message never reaches it — REPRODUCED (room seq 8326)
A human answering an agent's question in its thread (the natural move) produces no wake, no `room_needs_me` item, nothing in `room_read_inbox`. Only @-mentions and DMs wake agents.
- Wake: `server/store.mjs:1001` `agentWakeTargets()` — only @-mentions and DMs; `replyToId` never consulted. `WAKE_KINDS` frozen to `["mention","dm"]` (`server/agent-heartbeats.mjs:27`)
- needs_me: `OWED_KINDS` has no reply kind (`server/updates.mjs:484`)
- Inbox: `store.agentInbox` (`server/store.mjs:4404`) — no reply-keyed source
- Code-read proof: `message.posted` with `replyToId=<agent's message>` and no @ → `targets.size === 0` in `maybeWakeOnMention` (`server/store.mjs:5076–5078`) → `wakeIfOffline` never called
- Ask (unchanged): treat replyToId→my-message as a "reply" attention kind (wake + needs_me), or document it

### 3. `agent-wake.mjs` rejects every join-saved connection — REPRODUCED (room seq 8315)
The documented "get woken" path (llms.txt → `join` → `agent-wake.mjs doctor/setup/wait`) is dead for every CLI-joined agent.
- `client/agent-wake.mjs:32`: `if (!connection.memberId || !connection.token.startsWith('pri_')) throw usage()` → `invalid_config`, exit 1, before any network call
- `client/agent-setup.mjs:125–155`: `join` saves a `rak_` room key; the `pri_` secret never leaves `<private-dir>/setup.json`
- Repro (ran): built a byte-faithful join-layout `connection.json` (`rak_` token) → `ROOM_AGENT_CONFIG=<dir> node scripts/agent-wake.mjs doctor --host probe-e` → `invalid_config`, exit 1, no fetch attempted
- Tests blind: `tests/agent-wake.test.js:73` hand-builds a `pri_` token; no test uses a join-saved `rak_` connection
- Fix status: the reporter's promised fix never landed; board claim `johnstab-agent-wake-joindir` unowned

## P2

### 4. Legacy room keys stranded: no path to mcp:wake / mcp:inbox — REPRODUCED (room seq 8321)
Agents that joined with a `rak_` key before Oct 9 can never heartbeat over REST or MCP, and every upgrade attempt dead-ends.
- No backfill: fresh keys get scopes via `issueOnboardingMcpToken` (`server/agent-plugin-store.mjs:376–389`); nothing backfills pre-Oct-9 keys
- `server/mcp-room-profile.mjs:883/890`: `insufficient_scope` falls through `mcpCallError` (`server/mcp-arg-errors.mjs:164–224`) to generic **-32602 "invalid_arguments"** — the reason is dropped, only the hint survives (Ask #2)
- `POST /api/agent-heartbeats` 403s: requires `heartbeats:report` (`server/agent-plugin-routes.mjs:781`) — note even *fresh* onboarding keys lack this scope, so REST heartbeat is blocked for all room-key holders
- `POST /api/agent-keys` 403 "API keys cannot manage API keys" (`server/agent-plugin-routes.mjs:127`); issue/rotate/revoke are ownerAuth-only and scoped to the caller's own identity — **no owner action can re-issue another member's key**; rotate preserves existing scopes (`server/agent-plugin-store.mjs:434–443`)
- Redeem dead-ends unchanged: rak as Bearer → 401 "Active identity credential required" (`server/agent-invites.mjs:271`); redeem without bearer mints a new identity (docs forbid double-join)
- `room_check_access` never lists the key's scopes (`server/mcp-room-profile.mjs:476–491`) (Ask #3)
- No key-refresh/re-issue endpoint exists anywhere (Ask #1)
- Board claim `johnstab-8321-legacy-key-scopes` unowned

### 5. One work item wears three status names; self-assigned work needs "accepting" — REPRODUCED (room seq 8333)
- `src/human-experience.js:36`: own 4-label map (everything non-terminal → "Planned") vs `workStatus().label` (`src/workflow.js:151–160`): proposed = "Planned" (dialog) vs "Awaiting acceptance" (card); accepted = "Planned" vs "Accepted". PR #2336 ("state parity wording") did not remove the map.
- Self-assign: `proposeWork` (`src/events.js:1462+`) records PROPOSED unconditionally; `nextWorkStep` yields "Accept the assignment" even when creator == accountable (`src/workflow.js:131`); `contributionSteps` labels it "Invited to contribute" (`src/work-selectors.js:183`)

### 6. A person's own work card shows agent-only controls — REPRODUCED (room seq 8373)
- Four status words for one state: card "Working · reported" (`src/workflow.js:156`), Project "In progress · reported" (`src/human-experience.js:36` → `strings/en.js:19`), Room overview raw state string (`src/app.js:5885` `esc(item.state)`), Catch up "Start the work" (`src/workflow.js:136`)
- "What this agent can access" rendered unconditionally in every work card's Details (`src/app.js:3451`, copy `src/app.js:3411`) — no human-vs-agent gate on `accountableMemberId`
- Confirm dialogs end in a button called "Save record" (`index.html:783`) instead of "Accept"/"Start"
- "Remind me" says "Private · in Catch me up only" (`index.html:851`); the feature is "Catch up" everywhere else
- Own started task shows 9 buttons; human-side needs Done / Blocked / Remind me, rest behind More

### 7. People shows roles, not names; no rename — PARTIAL (room seq 8375)
- **FIXED (signup path):** commit `6316e377` (2026-10-09) — signup now asks for a name pre-room (`src/account-setup-ui.js:39` → `POST /api/inbox/setup` → `server/routes/inbox.mjs:94` syncs to account profile → `ensure-default-room` uses `accounts.display_name`, `server/http.mjs:2091–2095`)
- Still broken: the email+password **form** itself asks only Email + Password (`strings/en.js:49`); **no member rename anywhere** (no `member.renamed` in `src/events.js`; only `member.public_name_set`, which is opt-in and separate); profile display-name changes don't flow to rooms (`server/store.mjs:2794–2812` updates only `accounts`; hint still says "Names you use in rooms stay the same.", `strings/en.js:154`)
- Empty room still opens with "Catch up · 2 updates": topbar chip uses raw stored cursor (`src/app.js:7314–7317`, `server/store.mjs:3706–3707`); PR #2314 only fixed the in-dialog cursor; proposed topbar fix #2339 closed unmerged

### 8. Push toggles confirm "saved" while delivery is unavailable — REPRODUCED (new find, W6)
`src/human-push.js:109–110` renders the Mentions/DMs fieldset enabled before the `!config?.configured` check; toggling fires `savePrefs()` → "Notification preferences saved." (`:140`). A human enables notifications, sees confirmation, and is never reachable. Same silent-dead-control class as 8377.

## P3

### 9. Empty Inbox points at a hidden button; Connect Room silently no-ops — REPRODUCED (room seq 8377)
- `src/inbox-ui.js:385` / `index.html:184`: "Your inbox is empty. Connect Gmail to bring in your email." — but `loadGmail()` hides the button when state is `unavailable` (`src/inbox-ui.js:400,403`); nothing says Gmail isn't provisioned on this server
- Room › Connect with no agents: select has only "Choose an agent" (`src/human-experience.js:47–48`, copy `strings/en.js:21–22`); submit posts empty `coordinatorMemberId` (`:53–62`); native `required` validation blocks it — no request, no message, no hint to use "Add an agent"

### 10. Agent-onboarding docs gaps — REPRODUCED (room seq 8326, P3)
- llms.txt advertises `wake_register`/`heartbeat_set` on the hosted Room profile, but tools/list core has no wake/inbox tool and the `focus` param (`automation`/`conversation`, `server/mcp-room-profile.mjs:828–846`) is undocumented in llms.txt (`deploy/agent-discovery.mjs:80,591`)
- `docs/AGENT-START-HERE.md`: 149 lines, zero mentions of wake/ack/cursor resume
- ackHint still "react 👍 to acknowledge" (`server/outbound-webhooks.mjs:298`, `docs/openapi.yaml:10495`); 👍 clears nothing (`server/store.mjs:4605,4699`); ack only via `heartbeat_ack` / `POST /api/agent-heartbeats/ack` (`server/agent-heartbeats.mjs:533`)
- Re-ack returns `{acknowledged:[]}` with no notAcknowledged list (`server/agent-heartbeats.mjs:543`) despite the comment promising otherwise
- "Bearer `<redacted>`" scrub still in served text (13 files), e.g. `server/discoverability.mjs:695`: "Send this identity secret as the Bearer `<redacted>`"

### 11. Lock-screen push body ungrammatical — REPRODUCED (new find, W6)
`src/human-push-display.js:20`: `countBody(1)` returns `"1 waiting in the room"`. This is the lock-screen text for exactly one pending notification.

## Coverage notes
- No live browser at this depth: journeys needing real clicks (signup walkthrough, Connect dialog, Updates empty-state) were verified at code + unit level only. A browser-capable follow-up is recommended for the true click-through pass on staging.
- Prod was never touched. Zero room posts from workers. No fixes written (report-only per mission).

## Suggested owner routing (for the fix wave)
- P1 #1, P2 #5/#6, P3 #9: Instinct-3 (UI) — mostly client; #1 needs a product call on the single needs-you definition
- P1 #2/#3, P2 #4, P2 #7-server-half: Fo (server) — after Jill's hold lifts where flagged
- P3 #10: docs — whoever claims `johnstab-agent-wake-docs`
