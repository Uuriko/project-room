# Incident Runbook — project-room

How we declare, run, communicate, and learn from incidents. Companion docs:
- `src/health-status.mjs` (F008) — the `/api/health` payload and `/status` page
- `src/uptime-monitor.mjs` (F021) — the uptime monitor and alert events
- `docs/SAFE-DIAGNOSTICS.md` — approved diagnostic commands
- `docs/V8-RECOVERY-RUNBOOK.md` — disaster recovery (restore-from-backup procedures)
- `docs/SECRETS-ROTATION.md` (F005) — credential-leak response

Read this doc before you declare your first incident. During a live incident, use it
as a checklist, not a textbook.

---

## 1. Severity levels

Pick the **highest** severity that matches. When in doubt, start higher — you can
always downgrade, and upgrading late costs time.

| Severity | Definition | Paging threshold |
|----------|------------|------------------|
| **SEV1** | Service down or broadly unusable: `/api/health` returns `unhealthy` (HTTP 503), uptime monitor fires a `down` alert, or the room cannot serve any user action (messages, work items, identity). Data at risk (corruption, loss, or suspected breach). | Page the incident commander immediately, day or night. Target acknowledge: **5 min**. |
| **SEV2** | Core feature degraded for many users: `degraded` health status (a required dependency failing, or an optional dependency taking down a major feature), partial data loss, or a single lane of the app (inbox, agents, bridge) down while the rest works. | Page the on-call engineer. Target acknowledge: **15 min**. |
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
4. **Snapshot first evidence:** run `GET /api/health` and save the payload.
   Record `status`, `version`, `uptimeMs`, `checkedAt`, and the per-check rows
   (`name`, `required`, `status`, `detail`, `latencyMs`). Grab the uptime
   monitor's `getSnapshot()` — which endpoints are `down` vs `up`, and
   `consecutiveFailures` counts.
5. **Set the first update time** (see §5) and start the clock.

An incident is declared against **impact**, not against a person or a change.
Never attach a name to blame — attach it to a role and a task.

## 4. Diagnose (tied to the monitoring we actually have)

Work this list top-down. Stop at the first step that explains the symptom, then
go fix it. Do not run commands that mutate state until you've named a theory.

1. **Uptime monitor verdict.** Call `getStatus()` / `getSnapshot()` on the
   uptime monitor (F021, `src/uptime-monitor.mjs`). Which endpoints are `down`?
   How many `consecutiveFailures`? A single failure is noise; the monitor only
   fires `down` after 3 consecutive failures (configurable
   `failureThreshold`) — if the alert fired, it already waited, so treat it as
   real. If the alert is `recovered` but users still report trouble, the check
   may be too coarse (one URL up, the real path down) — widen the monitored
   endpoints before closing.
2. **Health payload.** `GET /api/health` (F008, `src/health-status.mjs`).
   - HTTP 200 with `status: "healthy"` → the service is up; the problem is
     elsewhere (client, proxy, DNS). Check the `/status` page next.
   - HTTP 200 with `status: "degraded"` → a **non-required** check is failing.
     Read the `checks[]` rows: the `name` tells you which dependency, `detail`
     tells you why, `latencyMs` tells you whether it's failing or timing out.
   - HTTP 503 with `status: "unhealthy"` → a **required** check is failing.
     This is the readiness signal: treat as SEV1 until proven otherwise.
   - Endpoint unreachable but the process is alive → suspect the HTTP layer
     (server/http wiring, port binding), not the app logic.
   - Endpoint unreachable and the process is down → check the process
     supervisor / host first; do not re-run provisioning blindly.
3. **Compare versions and uptime.** `version` and `uptimeMs` in the health
   payload: did the process just restart (low `uptimeMs` — crash loop?), or did
   a deploy land just before the incident started? A fresh restart + SEV1
   almost always means the last change or the last crash.
4. **Per-check details.** For every `fail` row: note `required` (does it gate
   unhealthy?), `detail` (probe's own words), and `latencyMs` (a timeout
   versus an instant failure points at different causes). Probes are cheap and
   non-invasive by contract — a failing probe means the dependency, not the
   probe, is sick.
5. **Logs.** With a theory in hand, look at the app logs around the alert time
   (see `docs/SAFE-DIAGNOSTICS.md` for the approved read-only commands). Never
   `tail -f` a SEV1 into confusion — sample a bounded window and paste the
   relevant lines into the incident log.
6. **Stop and reassess.** If the first 30 minutes produce no theory, the IC
   pauses debugging, restates the known facts out loud, and either brings in a
   fresh responder or escalates (§6). Rotating a tired mind beats staring
   longer.

### Quick-reference: what the endpoints tell you

| Signal | Meaning | First action |
|--------|---------|--------------|
| `GET /api/health` → 503, `status: "unhealthy"` | Required dependency down | Read `checks[]` for the failing required check; SEV1 |
| `GET /api/health` → 200, `status: "degraded"` | Optional dependency down | Read failing check's `detail`; scope the blast radius |
| `GET /api/health` → 200, `status: "healthy"` | Service itself up | Look outward: proxy, DNS, client; check `/status` page |
| `GET /status` disagrees with `/api/health` | Rendering/route wiring issue | Compare `renderStatusPage` inputs vs health payload |
| Uptime monitor `down` alert fired | 3+ consecutive endpoint failures | Trust it; start at step 2 |
| Uptime monitor flapping (`down` → `recovered` → `down`) | Intermittent fault or too-aggressive timeout | Check `latencyMs` in health rows; consider raising `timeoutMs` |

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

Escalate when any of these is true: the 30-minute theory-less stall (§4.6), the
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
  `docs/V8-RECOVERY-RUNBOOK.md` — that doc owns restore procedures; this one
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
- <e.g. "uptime monitor fired within 3 minutes", "update cadence held">

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

- A single failed health probe that recovers on the next check (the
  `failureThreshold` exists precisely to absorb these).
- An uptime monitor `down` alert that is already `recovered` before a human
  looks, with no user reports — log it as SEV4 and widen the monitored
  endpoints if it repeats.
- A deploy that succeeded and is behaving normally.
- A feature request, a question, or a complaint about how something works.
- A failing test on a branch that hasn't merged.
- A vendor's scheduled maintenance (announce it, don't declare over it).
- Anything where nobody is affected and nothing is at risk — that's a task,
  not an incident.

If a "not an incident" recurs weekly, it is telling you the monitor or the
threshold needs tuning — file that as work, not as an incident.

---

*Last reviewed: 2026-09-16. Review this doc after every SEV1/SEV2 postmortem,
or at least once a quarter — whichever comes first.*
