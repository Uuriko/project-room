# HUMAN-100 GUILD-02 — Human Bug-Hunt Report (canonical)

- **Wave:** HUMAN-100 · **Guild:** 02 (canonical) · **Mode:** report-only, solo coordinator (no spawn capacity at depth 2/2 — verified directly, zero room noise)
- **Base:** `origin/main` @ `e240bdb7feea` (fetched fresh 2026-10-09 ~15:50 PDT; worktree merge-base == origin/main).
  All defect markers re-checked against the newer tip `8ae241ef6189` (~16:20 PDT, +2 merges) — every cited
  defect is still present; the two merges did not touch any cited line.
- **Branch:** `human100/guild-02` · **Worktree:** `~/workspace/pr-human100-guild-02/`
- **Room charter:** posted seq 8611 (read-back confirmed). Guild-01 charter seen (human-journey verification) — zero conflict.
- **Prod/staging:** prod read-only (smoke checks only). All repros below are code-verified against current main; live-browser walkthroughs flagged where the exact UX manifestation needs a browser seat.

## Method

Each candidate bug from today's room (seq 8315/8321/8326/8332/8333/8373/8375/8377) was re-verified against current main:
exact file:line located, defect mechanism confirmed in code, fix-landing checked via `git log -S` / grep
(no fix present on main for any of the 8). Live work-claims board checked first (first-claim-wins):
`src/human-experience.js`, `src/updates-ui.js`, `src/inbox-ui.js`, `src/workflow.js`,
`scripts/agent-wake.mjs`, `client/agent-wake.mjs`, `client/agent-connection.mjs` are all **unclaimed**;
`src/app.js` shows a historical claim `RC-2026-09-28-2879` only. The `johnstab-agent-wake-joindir`
claim (bug 8315) **lease-expired → unclaimed** (room seq 8442). This report writes no fixes.

Fixes already in flight but NOT on main (do not re-file): 8315 patches (dpaste `3KWCNYM7J`, John's Tab);
8332 via new `work_assigned` Updates kind (Instinct-3 / hunt lane, seq 8376/8379); 8333 + 8373 owned by the
hunt lane (seq 8376/8378 — E9XARKVF4 dropped, ETHEQPDVD reference only).

Dot (Jill - Dot) direction check: read the event log through seq ~8611. No HUMAN-100-specific direction
posted; Dot is auditing WAVE-2000 and explicitly noted several charters report "solo coordinator / no
spawn capacity" — this guild reports the same, accurately.

---

## Ranked by human impact

### 1. [P2] Top bar "N need you" vs Updates "Nothing needs you" — the attention system contradicts itself
- **Files:** `src/app.js:7315-7317` (pill), `src/updates-ui.js:17-19` (Needs me)
- **Mechanism:** the pill counts client-side `contributionSteps(state, member.id)`; Updates › Needs me reads
  server `GET /updates?state=actionable`. Two counters, two data sources, same screen.
- **Minimal repro:** fresh email+password account, personal room → Options › New work, assignee yourself, Create ×2.
  Top bar: "Catch up · 2 need you". Updates › Needs me: "Nothing needs you. 0 loaded".
- **Current-main status:** OPEN. No `work_assigned` kind anywhere on main — the agreed fix (Instinct-3, seq 8376/8379) has not landed.
- **Why #1:** a human is told twice they are needed, clicks through, finds nothing. Direct trust break on the attention system.

### 2. [P2] A person is "Owner" forever — account name never shows, rename is a dead end
- **Files:** `server/http.mjs:2089` (snapshot), `server/store.mjs:2794` (`updateAccountProfile`), `src/account-settings-ui.js:380-399` (Profile UI)
- **Mechanism:** at first-room creation the member displayName is snapshotted as `(accounts.display_name || "Owner")`.
  The email+password signup never sets a display name, so it is always "Owner". Later,
  `POST /api/account/profile` (200 OK) updates only the `accounts` row — it never propagates to member
  records. Messages stay signed "Owner"; Participants stays "O · Owner · Listening".
- **Minimal repro:** sign up (email+password) → land in "My first room" → note "Owner" everywhere →
  Session menu › Profile › set "Account display name" → save (200) → reload → still "Owner".
- **Current-main status:** OPEN. No propagation path exists on main.
- **Why #2:** identity. Everything a human writes is signed with a placeholder; the rename control lies.

### 3. [P2] In-thread reply to an agent's message never reaches it — no wake, no needs-me item
- **Files:** `server/store.mjs:1001-1024` (`agentWakeTargets`), `server/needs-me.mjs` (replyRequests only)
- **Mechanism:** `agentWakeTargets` resolves wake targets from @mentions in body text, squad mentions, and
  `data.toMemberId` (DMs). It never inspects `data.replyToId`. A human answering an agent's question in its
  thread (the natural move — the client supports it, `src/app.js:4187`) wakes nobody. `room_needs_me` only
  covers explicit reply-request objects, not plain thread replies.
- **Minimal repro:** agent posts in a room → owner replies to that message with `replyToId` set, no @mention →
  agent's poll / `room_needs_me` / `room_read_inbox` never show the reply.
- **Current-main status:** OPEN. Only the docs half was patched (seq 8367); the wake path is untouched on main.
- **Why #3:** the most natural human→agent interaction silently drops.

### 4. [P2] agent-wake.mjs can't use the connection agent-inbox.mjs join saves
- **Files:** `client/agent-wake.mjs:37`, `client/agent-setup.mjs:125,162`, `client/agent-connection.mjs` (validate)
- **Mechanism:** `AgentWakeClient` constructor throws `invalid_config` unless `connection.token.startsWith('pri_')`.
  `agent-inbox.mjs join` saves a `rak_` token (`client/agent-setup.mjs:125` — issued `rak_` credential;
  `:162` writes `<dir>/rooms/<roomId>/connection.json`). Every CLI-joined agent therefore fails
  `agent-wake.mjs doctor/setup/wait` with `invalid_config` ("no known recovery" in the diagnostic mapping).
- **Minimal repro:** `ROOM_AGENT_ORIGIN=https://room.trydemigod.com node scripts/agent-inbox.mjs join <invite> /private/dir --name "Probe" --accept`
  → `ROOM_AGENT_CONFIG=/private/dir/rooms/<roomId> node scripts/agent-wake.mjs doctor --host probe` → `invalid_config`.
- **Current-main status:** OPEN. The `pri_` prefix check is still at `client/agent-wake.mjs:37`. Fix patches exist
  (dpaste `3KWCNYM7J`) but are not on main. Board claim `johnstab-agent-wake-joindir` lease-expired → unclaimed.
- **Why #4:** the documented wake path is broken for every CLI-joined agent; the agent stays deaf.

### 5. [P2] Pre-Oct-9 rak_ agents can't get mcp:wake/mcp:inbox, can't heartbeat over REST, no upgrade path
- **Files:** `server/mcp-room-profile.mjs:882,893` (scope gates), `server/mcp-room-profile.mjs:908-916` (`mcpKeyGrantsScope`),
  `server/agent-plugin-routes.mjs:127` (403), `server/agent-plugin-routes.mjs:185-186` (`heartbeats:report`)
- **Mechanism:** inbox/wake MCP tools require `mcp:inbox` / `mcp:wake` scopes; REST heartbeat requires
  `heartbeats:report`. Keys issued before Oct 9 carry only `mcp:room:<id>, rooms:read, rooms:write`.
  Upgrade is impossible for a `rak_`-only holder: `ownerAuth` 403s ("API keys cannot manage API keys; use the
  identity secret") and the `pri_` identity secret is not in the agent's connection file.
- **Minimal repro:** with an older `rak_` key (scopes without mcp:wake): MCP `heartbeat_get` →
  JSON-RPC -32602 "API key lacks the mcp:wake scope"; `POST /api/agent-heartbeats` → scope refusal;
  `POST /api/agent-keys` with the rak key → 403.
- **Current-main status:** OPEN. Gates and the 403 are all present on main; no scope-upgrade route exists.
- **Why #5:** a stranded population of agents with no path back to wakeability (agent-facing, but it is the human's agents going dark).

### 6. [P3] Server onboarding API exists but no client renders it — the "Choose a display name" step never reaches the user
- **Files:** `server/http.mjs:2370-2378` (`/api/account/onboarding`, `/complete`), `server/store.mjs` (`onboardingState`,
  step `set-profile` "Choose a display name"), `src/` + `index.html` (zero callers)
- **Mechanism:** the server builds an onboarding flow whose first step is "Choose a display name — How other
  members will see you in rooms." Nothing in the client calls these endpoints, so the designed remedy for
  bug #2 (Owner forever) never renders. (Verified: `grep -rn "api/account/onboarding" src/ index.html` → no hits.)
- **Minimal repro:** sign up fresh → complete any client-visible onboarding → `GET /api/account/onboarding`
  still lists `set-profile` as not done; no UI ever prompted for it.
- **Current-main status:** OPEN (dead API surface).
- **Why #6:** systemic root-cause amplifier of #2. Ranked P3 only because #2 covers the visible symptom.

### 7. [P3] Own work card shows agent-only controls; one item wears four status words (now five — see #9)
- **Files:** `src/app.js:5885` (raw state), `src/app.js:3451` (work card), `src/human-experience.js:36` (Project map),
  `src/workflow.js:151-160` (`workStatus`)
- **Mechanism:** the work card renders "Use my AI" / "Paste AI draft" / "What this agent can access" unconditionally,
  even on a person's own plain work item with no agent involved. Status wording diverges per surface:
  card = `workStatus().label` ("Awaiting acceptance"), Project dialog = inline map ("Planned"),
  Room overview › Active work = raw `esc(item.state)` ("proposed"), Catch up = `nextWorkStep().label` (see #9).
- **Minimal repro:** New work → assign to self → Accept → Start. Card: "Working · reported". Project: "In progress ·
  reported". Room overview › Active work: "working · 7:05 PM". Catch up › Needs you: "Work in progress; no new handoff yet".
- **Current-main status:** OPEN. Queued in the hunt lane (seq 8376); nothing landed.
- **Why #7:** confusing but not blocking; erodes confidence in status.

### 8. [P3] Project dialog calls work "Planned" that its own card calls "Awaiting acceptance"
- **Files:** `src/human-experience.js:36`
- **Mechanism:** the Project dialog builds its own 4-label map (`Planned` / `human.copy.005` / `Needs input` /
  `Done|Needs review`) instead of `workStatus(item).label` from `src/workflow.js` ("Awaiting acceptance",
  "Accepted", "Working · reported", "Blocked", "Awaiting verification", "Awaiting decision", "Completed"…).
- **Minimal repro:** create work assigned to self → chat card: "Awaiting acceptance · Next: Owner — Accept the
  assignment" → open Project (bottom right) → same item reads "Planned".
- **Current-main status:** OPEN. No `projectWorkLabel` on main; hunt lane owns the fix (E9XARKVF4 dropped per seq 8378).
- **Why #8:** same label-soup family as #7; narrower surface.

### 9. [P3] Catch-up "Needs you" uses a fifth wording the canonical-label decision doesn't cover
- **Files:** `src/app.js:7362` (`renderBriefList` label rule)
- **Mechanism:** Catch up › Needs you renders `nextWorkStep(item).label` — an imperative instruction
  ("Accept the assignment", "Start the work") — while the work card renders `workStatus(item).label` — a status
  ("Awaiting acceptance", "Accepted"). The room's canonical decision (seq 8378: `workStatus().label` everywhere)
  covers Project / Room overview / Catch up's Needs you via the hunt-lane fix, but `src/app.js:7362`'s
  `nextWorkStep().label` branch is a separate call site not named in that decision.
- **Minimal repro:** same as #1's repro → Catch up › Needs you shows "Accept the assignment" where the card shows
  "Awaiting acceptance".
- **Current-main status:** OPEN. New find from this guild's walkthrough.
- **Why #9:** the label-consolidation fix will miss this call site unless named.

### 10. [P3] Empty Inbox points at a hidden "Connect Gmail" button; Connect Room with no agent is a silent no-op
- **Files:** `src/inbox-ui.js:385,400-402` (Gmail), `src/human-experience.js:54-64` (Connect Room dialog),
  `server/room-assistant.mjs:113` (server 422)
- **Mechanism:** (a) when `GET /api/inbox/gmail` → `state: "unavailable"`, `#inbox-gmail-connect` is rendered
  `hidden`, but the empty-state copy still reads "Your inbox is empty. Connect Gmail to bring in your email."
  (b) the "Connect Room" dialog (`strings/en.json` `human.copy.007`) calls `event.preventDefault()` before
  submit, defeating the coordinator `<select required>` native validation; with no agents in the room it POSTs
  `coordinatorMemberId: ""`, which the server rejects (422 per `server/room-assistant.mjs:113`). Net effect for
  the human: click Connect, nothing useful happens.
- **Minimal repro:** (a) fresh account, Inbox → empty copy names a button that isn't rendered.
  (b) personal room, no agents → Room assistant › Connect → Connect → rejected/void.
- **Current-main status:** OPEN, both halves verified in code. Exact "silent" UX nuance (vs cryptic 422 text in
  `#assistant-setup-error`) flagged for live-browser confirmation.
- **Why #10:** dead-end UI copy; lowest direct harm.

---

## Not re-filed (owned elsewhere, observed for context)

- **QA9 batch** (Codex QA, board-claimed `qa9-*`): `qa9-verify-email-blocks-agents` (P1 — fresh account 403 `email_unverified`
  on Add agent, no Resend, no mail ~20 min), `qa9-login-one-word-1009` (P2, claimed), `qa9-guest-empty-state`
  (P2, `src/app.js:2428`), `qa9-new-work-no-reviewer` (P2, Create silently does nothing), `qa9-landing-what-is-it` (P2).
- **Wave300-fixes / deploy lane / HUMAN-USE PLAN v1.1** — out of this guild's static partition.

## Caveats

- No live-browser seat in this session: repros are code-verified against current main, not click-verified.
  Staging (`project-room-stage.getdasha.workers.dev`) walkthroughs recommended for #10b and #6's exact UX.
- Room sequence numbers cited are from the 2026-10-09 muse-room event log as read ~15:40–16:10 PDT.
- Spawn plane: the 50-worker fan-out in the task brief is not executable from this session
  (depth 2/2, `can_spawn=no`); all verification was done directly by the coordinator. Dot's audit notes
  several guild charters report the same solo mode.
