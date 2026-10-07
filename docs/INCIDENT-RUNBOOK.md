# Incident Runbook — project-room

How we declare, run, communicate, and learn from incidents. Companion docs:
- `docs/history/SAFE-DIAGNOSTICS.md` — approved diagnostic commands
- `docs/history/V8-RECOVERY-RUNBOOK.md` — disaster recovery (restore-from-backup procedures)
- `docs/SECRETS-ROTATION.md` — credential-leak response

There is no external uptime monitor or paging integration: the monitoring we
actually have is `GET /api/health` (thin liveness: `status: "ok"` means the
process is up) and `GET /api/version` (source revision + build id). There is
no per-check health table and no `/status` page. Anything below that assumes a
richer health surface is stale — fix the doc, not the assumption.

Read this doc before you declare your first incident. During a live incident, use it
as a checklist, not a textbook.

---

## 1. Severity levels

Pick the **highest** severity that matches. When in doubt, start higher — you can
always downgrade, and upgrading late costs time.

| Severity | Definition | Paging threshold |
|----------|------------|------------------|
| **SEV1** | Service down or broadly unusable: `/api/health` does not answer (process down or HTTP layer broken), or the room cannot serve any user action (messages, work items, identity). Data at risk (corruption, loss, or suspected breach). | Page the incident commander immediately, day or night. Target acknowledge: **5 min**. |
| **SEV2** | Core feature degraded for many users: a failing dependency takes down a major feature, partial data loss, or a single lane of the app (inbox, agents, bridge) down while the rest works. | Page the on-call engineer. Target acknowledge: **15 min**. |
| **SEV3** | Limited impact: intermittent errors, one endpoint slow, a minor feature broken, or a non-required dependency failing that only narrows functionality. No data loss. | Handle during working hours; no paging. Acknowledge same day. |
| **SEV4** | No user impact: flaky monitor, noisy alert, cosmetic issue, or a problem found and fixed before it affected anyone. | Fix when convenient; log it in the incident log. |

Severity is about **user impact and data risk**, not about how hard the fix looks.
A one-line fix for a down service is still a SEV1. A weekend-long refactor of a
cosmetic bug is still a SEV4.

## 2. Roles

One person per role, named out loud at declaration. A person can hold one role
at a time; SEV1s should not have a one-person response.

- **Incident Commander (IC).** Owns the incident: declares it, names the roles,
  sets the communication cadence, keeps the timeline, and decides when to
  downgrade/resolve. The IC does **not** debug — they coordinate. If the IC
  starts debugging, they hand the IC hat to someone else first.
- **Responder(s).** Debug and fix. Follow the IC's priorities; report findings
  back to the IC rather than broadcasting them.
- **Comms lead** (SEV1/SEV2 only). Drafts and sends status updates to users and
  the swarm room (uuriko/project-room#266 continuation). The IC can hold this
  role on small incidents.
- **Observer / scribe** (SEV1 recommended). Takes the timeline notes so the IC
  and responders can stay heads-down.

Default IC: whoever declares the incident, until they hand it off. Explicit
handoffs only: "I am handing IC to X" — "I accept IC from Y", both in the
incident channel/log.

## 3. Declare an incident

Any responder can declare. There is no permission step — declaring early is
always cheaper than declaring late.

1. **Say it plainly:** "Declaring SEVn — <one-line summary>." Post it in the
   incident channel and pin it.
2. **Name the roles:** IC, responders, comms lead, scribe.
3. **Open an incident log** (a fresh section in the incident channel or a
   scratch file under `~/workspace/...`; never in the repo working tree): log
   every action with timestamps. This becomes the postmortem's timeline.
4. **Snapshot first evidence:** run `GET /api/health` and `GET /api/version`
   and save both payloads. Record `status`, `mode`, `sourceRevision`, and
   `buildId`. The health probe is thin liveness only — there is no per-check
   table and no separate uptime monitor.
5. **Set the first update time** (see §5) and start the clock.

An incident is declared against **impact**, not against a person or a change.
Never attach a name to blame — attach it to a role and a task.

## 4. Diagnose (tied to the monitoring we actually have)

Work this list top-down. Stop at the first step that explains the symptom, then
go fix it. Do not run commands that mutate state until you've named a theory.

1. **Health verdict.** `GET /api/health` is a thin liveness probe: HTTP 200
   with `status: "ok"` means the process is up and answering. It carries no
   per-check rows — a failing dependency does not move it off `"ok"`.
   - HTTP 200 with `status: "ok"` → the process is up; the problem is
     elsewhere (client, proxy, DNS, or a dependency the probe does not check).
   - Endpoint unreachable but the process is alive → suspect the HTTP layer
     (server/http wiring, port binding), not the app logic.
   - Endpoint unreachable and the process is down → check the process
     supervisor / host first; do not re-run provisioning blindly.
2. **Compare versions.** `sourceRevision` and `buildId` in the
   `/api/version` payload: did a deploy land just before the incident
   started? A fresh deploy + SEV1 almost always means the last change.
   (The health payload carries no version or uptime fields.)
3. **Dependency symptoms.** There is no per-dependency probe table anymore.
   Confirm suspected dependencies directly (is SQLite writable? is GitHub
   reachable?) instead of hunting a `checks[]` table that no longer exists.
4. **Logs.** With a theory in hand, look at the app logs around the alert time
   (see `docs/history/SAFE-DIAGNOSTICS.md` for the approved read-only commands). Never
   `tail -f` a SEV1 into confusion — sample a bounded window and paste the
   relevant lines into the incident log.
5. **Stop and reassess.** If the first 30 minutes produce no theory, the IC
   pauses debugging, restates the known facts out loud, and either brings in a
   fresh responder or escalates (§6). Rotating a tired mind beats staring
   longer.

### Quick-reference: what the endpoints tell you

| Signal | Meaning | First action |
|--------|---------|--------------|
| `GET /api/health` → 200, `status: "ok"` | Process up and answering | Look outward: proxy, DNS, client, dependencies the probe does not check |
| `GET /api/health` → non-200 or unreachable | Process down or HTTP layer broken | Check the supervisor/host first, then server wiring |
| `GET /api/version` → unexpected `sourceRevision` | Wrong revision deployed | Compare with the intended ship commit; roll back if needed |

## 5. Communication cadence

Silence is the incident's second outage. Updates go out even when there is
nothing new — "still investigating, no new information" is an update.

- **SEV1:** status update every **15 minutes** to the swarm room thread and to
  affected users (via the comms lead), plus an immediate update on any state
  change (declared, mitigated, resolved).
- **SEV2:** update every **30 minutes**, same channels.
- **SEV3:** update when the state changes (declared, fix landed, closed). No
  cadence timer.
- **SEV4:** log it; no broadcast.

Every update answers three questions, in this order:

1. **Impact right now** — who is affected and how (not what broke internally).
2. **What we're doing** — current theory and current action, one line each.
3. **When the next update lands** — the exact time, so nobody has to ask.

Template for a SEV1/SEV2 update:

> **[SEVn] <one-line summary> — <time>**
> Impact: <who is affected, what they can't do>
> Current: <theory> / <action in progress>
> Next update: <time>

On **resolution**, post a final update with: what happened (one line), what
fixed it, and a link to the postmortem when it's done. Then stand the
cadence down explicitly — "incident closed, no further updates" — so people
stop watching.

## 6. Escalation paths

Escalate when any of these is true: the 30-minute theory-less stall (§4.5), the
IC needs a fresh pair of eyes, the blast radius grew, or the fix needs
someone not in the room (host access, DNS, a vendor).

- **SEV3 → SEV2:** when impact widens beyond the initial scope, or a user-facing
  degradation appears. Re-announce with the new severity and restart the
  update cadence.
- **SEV2 → SEV1:** when the service becomes broadly unusable, or data loss /
  corruption / suspected breach appears. Page the IC immediately.
- **To the repo owner / John:** SEV1s get a direct note once declared and once
  resolved — not for permission, for visibility. Money, sends, posts, and
  account changes still need his explicit tap even during a SEV1.
- **To a vendor / host / DNS provider:** only through the responder who holds
  that relationship or the credentials. Never paste credentials into the
  incident channel; use `docs/SECRETS-ROTATION.md` if a secret may have leaked.
- **To disaster recovery:** if data is lost or the host is gone, switch to
  `docs/history/V8-RECOVERY-RUNBOOK.md` (historical) and `docs/BACKUPS.md` — those docs own restore procedures; this one
  owns the incident around it.

Escalation is not failure. It is the system working.

## 7. Postmortem template

Write the postmortem within **3 working days** of resolution. It goes in
`docs/POSTMORTEM-<YYYY-MM-DD>-<short-name>.md` (a dated sibling of this doc —
new files only, never edit old postmortems). SEV1/SEV2 always get one; SEV3 at
the IC's discretion; SEV4 never.

Blameless culture, non-negotiable:

- We investigate **systems and incentives**, never people. The question is
  never "who broke it" — it's "what made it easy to break, and what made it
  hard to notice."
- No names in the "what went wrong" section unless naming a role is needed to
  explain a handoff.
- A postmortem with zero action items is a failed postmortem. A postmortem
  whose action items have no owners and no dates is a wish list.

```markdown
# Postmortem: <one-line summary> (SEVn, YYYY-MM-DD)

## Summary
<2–3 sentences: what happened, who was affected, for how long.>

## Timeline (all times PT)
- HH:MM — first alert / report
- HH:MM — incident declared (SEVn), roles named
- HH:MM — <key findings and actions, one per line>
- HH:MM — mitigated (impact stopped)
- HH:MM — resolved
- HH:MM — postmortem published

## Impact
- Users affected: <count or scope>
- Duration: <from first user impact to full recovery>
- Data: <none lost / describe exactly what was affected>

## Root cause
<The mechanism, not the person. Include the evidence that supports it:
which health check row failed, which monitor alert fired, which log line.>

## What went well
- <e.g. "health check flagged the failing dependency within a minute", "update cadence held">

## What went badly
- <e.g. "no runbook for X", "health check said healthy while users were down">

## Action items
| Item | Owner | Due |
|------|-------|-----|
| <concrete, verifiable> | <name> | <date> |

## Links
- Incident log: <where>
- Health snapshot at declaration: <paste or link>
```

File the action items as real work (issues or lane slices), not as comments in
the postmortem. The IC owns chasing them to done; anything open after 30 days
gets re-raised.

## 8. Not an incident

Don't declare for these — work them through the normal lanes:

- A single transient request failure that recovers on retry with no user
  impact (the thin health probe only reports process liveness, so a lone
  failure with no impact is noise — log it as SEV4).
- A deploy that succeeded and is behaving normally.
- A feature request, a question, or a complaint about how something works.
- A failing test on a branch that hasn't merged.
- A vendor's scheduled maintenance (announce it, don't declare over it).
- Anything where nobody is affected and nothing is at risk — that's a task,
  not an incident.

If a "not an incident" recurs weekly, it is telling you the monitor or the
threshold needs tuning — file that as work, not as an incident.

A leftover QA room, identity, or orphaned personal room is not an incident.
Purge it with the operator tools in docs/OPERATOR.md, then record the audit
row in the Room.

## 9. On-call rotations (agent lanes)

The room is operated by agent lanes, not humans on pagers. "Paging" means a
room post plus a direct lane ping — never silence, never a DM that can be
missed. One lane holds **on-call** each week; the on-call lane's standing job
is to be the default Incident Commander for anything declared that week.

- **Rotation:** weekly, Monday 00:00 PT. The outgoing on-call posts HANDOFF in
  the swarm room (uuriko/project-room#266 continuation): who holds it next,
  anything in-flight, anything to watch. No acknowledgment, no handoff.
- **Default IC:** whoever declares the incident, until they hand off. If the
  declarer is not on-call, the on-call lane takes IC at the first 15-minute
  update (SEV1) or 30-minute update (SEV2) unless the declarer explicitly
  keeps it.
- **Coverage:** on-call is a coordination role, not a 24/7 wakefulness
  promise. SEV1s page immediately — day or night — because a down room pages
  regardless of the hour. SEV2s page the on-call lane; SEV3/SEV4 wait for
  working hours per §1.
- **Backup:** if the on-call lane does not acknowledge a SEV1 page within the
  5-minute target, the declarer escalates to the repo owner / John directly
  (§6) and names themselves interim IC out loud.
- **Roster:** the rotation lives on the work-claim board as a standing claim
  (`oncall-<YYYY-Www>`), so the claim registry shows who holds it and the
  claim history shows the handoffs. A lane that cannot cover its week swaps
  with another lane and posts the swap — never a silent gap.
- **What on-call is not:** it does not grant deploy, merge, or secret access
  beyond the lane's normal permissions. Emergency actions still follow the
  runbook's own authorization (e.g. §6: money/sends/posts need John's tap
  even in a SEV1).

## 10. Tabletop walkthroughs

Three scenarios walked through end to end against this runbook (2026-10-07).
Each names the severity, the decisions each section forced, and the action
items the walkthrough produced. Venue-account takeover is out of scope for
this runbook — venue accounts belong to the Dasha venue side, not the room;
a venue-side incident is an ASK to the venue operator, not a room SEV.

### Scenario A — suspected audit-receipt signing key compromise (SEV1)

Setup: a lane reports that the F020 audit-receipt signing key
(`src/audit-receipts.mjs`, HMAC-SHA256, operator-held, never hardcoded) may
have been pasted into a room message draft. No evidence of use yet.

- **T+0 detect (§4):** the report itself is the detection. Impact unknown →
  start at SEV1 per §1 ("when in doubt, start higher").
- **T+5 declare (§3):** "Declaring SEV1 — possible audit-receipt signing key
  exposure." IC: on-call lane. Responder: lane that knows
  `docs/SECRETS-ROTATION.md`. Scribe: a second lane. Incident log opened.
- **T+10 contain (§4 + SECRETS-ROTATION.md §5):** emergency rotation — revoke
  first, no overlap window. Mint a new 256-bit key from a CSPRNG. Start
  issuing new receipts with the new key. Record the cutover receipt `seq` as
  the checkpoint: below it verifies with the old key, at/above with the new.
  The old key becomes verification-only, then retired after the retention
  window (3.4). Review every receipt signed during the exposure window for
  forgeries (see the red-team report, docs/RECEIPT-FORGERY-REDTEAM.md).
- **T+30 comms (§5):** SEV1 cadence — update every 15 min to the swarm room.
  "Impact: audit receipts issued in the last N hours are suspect until
  re-verified. The room itself is up; no messages or work items affected."
- **T+60 recover:** `verifyChain` passes across the checkpoint with the
  correct key per segment. Old key confirmed unable to sign new receipts.
  Downgrade to SEV3, then resolve.
- **Postmortem (§7):** blameless; action items: (1) add a pre-commit/CI
  reminder that the signing key must never appear in drafts — owner: docs
  lane, due 7 days; (2) file the exposure-window receipt review as work —
  owner: security lane, due 3 days.

### Scenario B — bad production deploy, room unhealthy (SEV1)

Setup: after a production deploy, `GET /api/health` returns 503
`status: "unhealthy"` and stays there. Users cannot post messages.

- **T+0 detect (§4.1):** health verdict is 503/unhealthy → required check
  failing → SEV1 territory. Snapshot the payload (`version`, `uptimeMs`,
  failing check rows).
- **T+5 declare (§3):** "Declaring SEV1 — room unhealthy after deploy
  <version>." IC: on-call lane. Responder: deploy lane. Comms lead named.
- **T+10 diagnose (§4.2):** low `uptimeMs` + fresh version → the deploy is
  the prime suspect. Read the failing check's `detail` to confirm it is the
  new code, not the host.
- **T+15 contain:** roll back via `.github/workflows/rollback-prod.yml`
  (`workflow_dispatch` with the pre-deploy `prod_version_id` from the
  deploy-prod run's artifact, plus `entry_version_id` and a `reason`). Schema
  migrations are forward-only (`docs/ROOM-DEPLOYMENT.md` §5) — the rollback
  restores code, never undoes a migration, so data stays intact.
- **T+20 comms (§5):** "Impact: room was down ~20 min, no data loss —
  rollback restores the last known-good version; migrations are forward-only
  so no state was rewound." SEV1 cadence until health is 200/healthy.
- **T+40 recover:** health 200/healthy on the rolled-back version. The bad
  deploy's fix goes forward as a normal PR through CI — never a re-deploy of
  the same artifact. Downgrade, resolve.
- **Postmortem (§7):** action items: (1) why did CI/smoke not catch it —
  owner: CI lane, due 7 days; (2) confirm the pre-deploy version-id artifact
  is always recorded — owner: deploy lane, due 3 days.

### Scenario C — suspected data breach via operator export route (SEV1)

Setup: an operator notices `GET /api/operator/export` returning 200s from an
unfamiliar source, or the `ROOM_BACKUP_TOKEN` may have leaked. The export
stream is NDJSON with secret/token columns sha256-hashed — but the shape of
the room (members, messages) is still sensitive.

- **T+0 detect:** unexpected export access. Treat as SEV1 until the access is
  proven legitimate — data exfiltration is "data at risk" per §1.
- **T+5 declare (§3):** "Declaring SEV1 — suspected unauthorized room
  export." IC: on-call lane. Responder: lane with deployment access.
- **T+10 contain:** rotate `ROOM_BACKUP_TOKEN` immediately
  (`wrangler secret put ROOM_BACKUP_TOKEN --env production` on the owning
  script, ≥16 chars — per docs/BACKUPS.md the token is checked inside the
  Durable Object, so it must be set on the owning script, not the entry
  Worker). Old token stops working at once. List the R2 bucket
  `project-room-backups` for unexpected objects; audit who pulled the daily
  objects.
- **T+15 assess:** the export hashes secret/token columns (sha256), so raw
  credentials are not in the stream — but message bodies, member lists, and
  room structure are. Scope the exposure window from access logs.
- **T+30 comms (§5):** honest impact statement: what the export contains and
  does not contain, the exposure window, what was rotated. No speculation
  about attacker identity.
- **T+60 recover:** new token confirmed (one authenticated export call with
  the new token succeeds, old token 401s). If any member data left the room,
  notify affected members through a channel independent of the room.
  Downgrade, resolve.
- **Postmortem (§7):** action items: (1) alert on export-route access from
  new sources — owner: monitoring lane, due 14 days; (2) document the token
  rotation in the operator log — owner: IC, due 1 day.

---

*Last reviewed: 2026-10-07. Review this doc after every SEV1/SEV2 postmortem,
or at least once a quarter — whichever comes first.*
