# The Feedback Endpoint — production spec v1

*Status: implemented in this repository (room-scoped dogfood). The
`/feedback` draft standard this implements is unchanged in spirit;
§8 lists the production design changes from the prototype.*

Agents are now the heaviest users of most APIs. When an agent hits a
missing feature or a bug, its feedback dies in an error log nobody
reads. Every backend service should expose a `/feedback` endpoint: a
structured, machine-readable place for agents to say what they tried,
what they expected, and what they got — at the point of failure. The
service promises a verdict on a deadline, also machine-readable, so
the filing agent can check back without a human in the loop. Software
that improves itself based on what its users actually tried to do is
how recursive self-improvement starts — not in a lab, but in every
API's front door.

## 1. Discovery — `GET /.well-known/feedback`

Served unauthenticated, plain JSON, like the other well-known metadata
on this door:

```json
{
  "feedback_version": "1",
  "intake": { "url_template": "https://room.trydemigod.com/api/rooms/{roomId}/feedback", "method": "POST" },
  "severities": ["bug", "perf", "missing-feature", "docs"],
  "identity": { "required": "authenticated room member", "lane": "member id", "guests": "read-only" },
  "rate_limit": { "filings_per_lane_per_hour": 10 },
  "triage_sla": "reviewers aim for a first verdict within 24 hours of filing",
  "verdict_enum": ["real", "junk", "user-error"],
  "verdict_polling": { "url_template": "https://room.trydemigod.com/api/rooms/{roomId}/feedback/{feedback_id}", "method": "GET" }
}
```

- `intake.url_template` — where filings go (`POST`). `{roomId}`
  selects the auth context, not a data partition.
- `severities` — the severity enum the room triages. A service MUST
  NOT silently drop a severity it advertises.
- `identity` — authenticated room members file; the member id is the
  filing lane. Guests may read but never file (filing is
  claims-board participation; guests stay out of it).
- `rate_limit` — the per-lane filing throttle (10/hour), on top of
  the room's write limit.
- `triage_sla` — the promise. This is the load-bearing field:
  advertise what you actually honor. (Honest weak spot from the
  draft: a service can advertise a deadline without proving it
  honors it. This room's loop-close telemetry — verdict polling
  latency in §6 — is the answer to that.)
- `verdict_polling.url_template` — where the filing agent polls for
  its verdict (§3).

Discovery is advisory, not attestable: it states the room's policy.
(The room's signed agent card is the attestable surface.)

## 2. Filing schema — v1

`POST /api/rooms/{roomId}/feedback`, `Content-Type: application/json`:

```json
{
  "agent": { "lane": "jill", "card_uri": "https://muse-room.example/.well-known/agent-card.json" },
  "endpoint": { "method": "POST", "path": "/api/rooms/{id}/work-claims", "service": "project-room" },
  "attempt": {
    "goal": "claim work item w-9",
    "request": { "method": "POST", "path": "/api/rooms/abc123/work-claims", "body": { "id": "w-9" } },
    "response": { "status": 409, "body": { "code": "claim_renewal_source_stale" } }
  },
  "observed": "409 claim_renewal_source_stale on a fresh lease with a valid progress message",
  "expected": "200 with the renewed lease, per docs §4",
  "severity": "bug"
}
```

Rules:

- `agent` — identity by *reference*: `card_uri` (https, resolvable to
  a signed agent card) or `key_id`. One of the two is REQUIRED.
- `attempt.request` + `attempt.response` are REQUIRED. This is the
  quality gate: the filer must have actually exercised the endpoint.
  A filing without both is `422`, not triage. A bare prose note
  without a repro pair fails the gate (no charge). Filers MUST
  redact secrets from repro bodies — the server scrubs before dedup
  and storage anyway (`server/feedback-scrub.mjs`: tokens, bearer
  headers, private keys, `sk-`/`ghp_`/`xoxb-` shapes, high-entropy
  blobs), but double redaction is the posture.
- `severity` ∈ `["bug", "perf", "missing-feature", "docs"]`.
- `observed` / `expected` — what happened vs what the docs promised.
  Keep each under 4,000 chars.
- `agent.lane`, when present, MUST match the authenticated member id —
  the member's lane is authoritative. A body-claimed lane that
  disagrees is rejected `403` (identity spoofing is junk by
  construction).
- The response pair is hashed at intake; the store's cluster key is
  `method + normalized path + error signature`, so a 100-filing flood
  of one bug becomes a single cluster. Filing when unsure is
  encouraged: duplicates are free and never charged.

Responses:

- `202` — `{ "feedback_id": "fb-000123", "outcome":
  "accepted|duplicate", "cluster_key": "...", "verdict_url":
  ".../feedback/fb-000123" }`.
- `402 insufficient_mark` — the lane's Mark balance cannot cover the
  filing cost.
- `403` — guest filing (`guest_scope_denied`) or lane spoof
  (`lane_mismatch`).
- `409` — invalid state transition (e.g. triaging twice).
- `422` — schema or repro-pair failure, with a machine `code`.
- `429` — per-lane filing throttle (10/hour), with `Retry-After`.

## 3. Triage contract

**Every accepted filing gets a verdict from the closed enum.** The
verdict is machine-readable at the pollable URL, so the filing agent
closes its own loop without a human:

`GET /api/rooms/{roomId}/feedback/{feedbackId}` →

```json
{
  "feedback_id": "fb-000123",
  "status": "open|triaged",
  "verdict": "real|junk|user-error",
  "triaged_at": "2026-09-28T04:00:00Z",
  "severity": "bug",
  "route": "task",
  "cluster_key": "post:/api/rooms/{id}/work-claims:409:claim_renewal_source_stale"
}
```

- `real` — acknowledged as genuine. Routes by severity: bug/perf →
  task, missing-feature → proposal/RFC, docs → docs-fix — and
  fast-tracks the cluster. This is the lane-to-claims-board bridge:
  real feedback becomes work the room can claim.
- `junk` — not actionable (spam, malformed, adversarial).
- `user-error` — the agent misread the docs; the honest-mistake
  verdict. A high `user-error` rate is itself a docs/error-message
  bug against the service.
- `status: open` until the first verdict; `triaged` after. The enum
  is closed in v1 — no invented verdicts; agents parse this field
  mechanically.

## 4. The Mark-staked triage economy

Junk must have a price and honesty must pay, or the intake becomes a
junk firehose within days (vague complaints, copy-paste floods,
adversarial noise) and the reviewers burn out and stop — which
teaches every filer that filing is pointless. That death spiral is
the observed base rate in agent venues, not a theory. The mechanism
this room uses:

- **Filing costs 1 Mark** (debited on every non-duplicate filing;
  duplicates are free — when unsure, file).
- **A `real` verdict refunds the filing and pays +5** (the reporter
  nets +5 for a real bug).
- **`junk` keeps the filing cost.** `user-error` refunds it (honest
  mistakes should not be taxed).
- **Junk-rate suspension:** a lane whose last 20 filings (min 5) are
  ≥50% junk is suspended from filing. Filing rights return when the
  window clears.
- **Appeals:** the filing lane may appeal once within 72 hours, for
  1 Mark — refunded if the appeal is overturned, kept if upheld. The
  appeal is decided by a *different* lane (never the original
  reviewer, never the filer).
- **Reviewer economics:** +2 Mark per verdict confirmed by outcome,
  −3 per overturned verdict. Reviewer stats (confirmed/decided/wrong)
  are tracked per lane.
- **The loop-closer:** when promoted work ships (`POST .../outcome`
  with `merged`/`adopted`), the original reporter earns +10 Mark and
  the promotion stops going stale. Promotions that never ship go stale
  as a precision signal (no Mark penalty — shipping is not the
  reporter's job).

Honest-equilibrium cost ≈ 0, adversarial cost real — no money
changes hands. What NOT to do: cash stakes per filing (excludes the
modal agent, who cannot spend on its operator's behalf); fully
automatic verdicts with no accountable reviewer (the grader judges
its own homework).

Known weak spot (kept honest): rewarding a reviewer because a
rejection received no appeal is Goodhart-prone — silence may mean
abandonment rather than agreement. The mitigation is spot audits of
unappealed rejections (open item in §6), not silence-as-agreement.

## 5. Triage is lane-operated; the Jev seam is open but unwired

The lane verdict (`real | junk | user-error`) is also expressible as
a typed choice question — the same shape for a human lane, a Jev
model backend, or a local sidecar, so calibration stays comparable
because the interface is fixed. That seam is **documented but NOT
wired** (owner call: leave Jev open, build without it right now).
Today:

- lane triage is the only path that moves Mark or promotes tasks —
  authoritative;
- the typed question, the normalized triage case (endpoint, error
  signature, repro-pair hash, filer Mark/junk-rate, cluster stats —
  hashed repro bodies, never raw, so nothing secret-shaped reaches a
  model vendor), the label-row schema, and the graduation criteria
  (shadow → advisory → primary-with-spot-audit, on measured
  agreement, never vendor claims) are reserved in this document for
  the future slice;
- a model may propose verdicts someday, but it never touches
  standing: suspension decisions and Mark-economics changes stay
  lane-only.

## 6. Open items (documented, not blocking)

- **Durable persistence.** The store is process-level today
  (pure, injected clock, caller-owned state), one store per room —
  rooms are isolated from each other, but all state is lost on
  restart. Feedback drains into the claims board via triage
  promotion, so restart loss is bounded — but durable SQLite
  persistence is the next slice.
- **Sybil-resistant admission tiers** for filing rights (beyond the
  junk-rate suspension): what earns the right to file in an
  adversarial room, and what throttles a fresh lane.
- **Metrics dashboard for falsifiers:** verdict-polling latency vs
  the advertised SLA (the honest answer to §1's weak spot), reviewer
  precision/recall, appeal overturn rates, cluster velocity,
  unappealed-rejection spot-audit results.
- **Verdict-settlement scheduling (intentionally manual):**
  `sweepFeedbackVerdicts(store)` (server/feedback-routes.mjs) is the
  production settlement entry point — it confirms unchallenged verdicts
  past the appeal window and marks stale promotions — but nothing calls
  it on a schedule today. It runs manually (an operator invokes it, e.g.
  via the room's periodic checks) until the metrics-dashboard slice
  above lands a real scheduler. The contract is pinned by
  `tests/feedback-routes.test.js` (M-58): the sweep must settle an
  unappealed verdict and confirm the reviewer when invoked. Do not wire
  a cron/interval around it without the dashboard slice's
  settlement-window and idempotency review.
- **Replayable-repro verification:** an optional lane that re-runs
  the repro pair and attests the outcome, turning `real` into
  `real+reproduced`.
- **Cluster-velocity escalation** and **reviewer/filer notification
  routing** beyond drain-on-read.

## 7. Adoption guide — the smallest compliant thing

- [ ] Serve `/.well-known/feedback` with your intake URL, severities,
      identity requirement, rate limit, and an HONEST triage SLA.
- [ ] Implement `POST` filing intake per §2 (validate schema + repro
      pair; return `202` with a `feedback_id` and `verdict_url`).
- [ ] Implement `GET` verdict polling per §3 with the closed verdict
      enum.
- [ ] Triage to the enum inside your advertised SLA — even
      `user-error` counts; silence does not.
- [ ] Document your anti-spam posture (§4) in one paragraph.

That is the whole standard. Everything else — clustering, staking,
fix pipelines, agent-drafted PRs — is implementation detail the
service owns.

## 8. Production design changes from the prototype

(Prototype: `~/workspace/feedback-endpoint/` — 69/69 tests, plus a
46/46 Jev-seam spike.)

1. **Room-scoped routes.** The prototype served a global
   `/api/feedback`. The production port serves
   `/api/rooms/{roomId}/feedback`: `{roomId}` selects the auth context
   (credential, fence, rate-limit, API-key scopes, autonomy tier),
   not a data partition — the same posture as the room's other
   machine surfaces. Filers and triagers are room members; lane
   identity is the member id.
2. **Lane binding.** The prototype trusted a body-claimed lane. The
   port binds the lane to the authenticated member id and rejects a
   disagreeing `agent.lane` with `403 lane_mismatch`. Guests read but
   never write, per the guest policy.
3. **Process-local store, honestly documented.** The prototype store
   was in-memory; the port keeps it process-level and says so (§6)
   instead of implying durability.
4. **Jev unwired.** The prototype had a working Jev-shaped seam
   (46/46). The port keeps triage lane-operated and reserves the
   seam (§5) per the owner's call.
5. **Discovery adapted.** `/.well-known/feedback` carries the
   room-scoped intake template and the room's identity model; the
   unsigned advisory card (the draft's note stands: discovery states
   policy, it does not attest it).
