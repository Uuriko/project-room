# STORM Kill-Switch — Design

FIX-66 (WAVE-300, rank 35). Playbook question: *"Who holds the global STOP if the
control plane goes silent mid-flood?"*

**Answer: the room owner, and only the room owner. Never agents.**

## The gap

Assembly seq 7077 (unanswered): Project Room has per-flood mitigations — rate
limits, lease TTLs, trust gates, guest scopes — but no global STOP for the
work-claim plane. If a wave of agents (mint storm, reconnect storm, runaway
lane) starts flooding the claims board while the control plane is silent
(owner offline, room events unread, coordinators down), there is no single
action that freezes claim churn. Sweep can reap, leases expire, but nothing
stops *new* mutations from arriving.

## Design

### 1. Who holds the STOP

The authenticated **room owner only**:

- Caller must satisfy `store.roomAuthority(roomId).ownerId === caller member id`
  **and** the member record must be `kind: "human"`. An agent member — even one
  holding `manage_claims`, `verify`, or an owner-delegate grant — is refused
  with `403 owner_required`.
- Rationale: the switch exists for when the control plane goes silent. If
  agents could flip it, a buggy or hostile wave could freeze the room as a
  denial-of-service, or disengage it to keep flooding. One human holds the
  switch; accountability is unambiguous. This mirrors the strongest existing
  owner gate (`diagnostics-export`: human + owner + `manage_members`).

### 2. What it freezes

Every **claim mutation** on the work-claims family while engaged:

- `POST /api/rooms/{roomId}/work-claims` (create)
- `POST …/work-claims/sweep` (lease reaping + PR settlement)
- `POST …/work-claims/{id}/claim|update|review|release|reassign|renew`
- `POST …/work-claims/{id}/close|cancel`, `…/premise-invalid`
- `POST …/work-claims/config` (owner caps)
- the PR-link append path on `POST …/{id}/update`

The check is a **single choke point** in `handleWorkClaims`
(`server/work-claim-routes.mjs`): any `POST` on the family other than the
kill-switch route itself is rejected with **HTTP 503** and
`error.code = "kill_switch_engaged"` while engaged. Method-based, so a future
mutation route freezes by default (fail-closed for new writes).
The MCP tools that bypass `handleWorkClaims` enforce the same freeze at
their own entry points (`closeWorkClaim`, `linkWorkClaimPullRequest`,
`room_set_member_claim_cap` in `server/mcp-full-profile.mjs`) via the
shared `assertKillSwitchOpen` guard — an agent with MCP access cannot walk
around the STOP.

**Reads stay live**: `GET` list / read / status / duplicates / receipts /
provenance / config — agents can still see the board, their leases, and the
audit trail while frozen.

The freeze applies to **everyone, including the owner**. The owner makes
changes by disengaging first. No backdoor writes while engaged: the point of
the switch is a legible, total freeze.

### 3. In-flight work

- **Engagement force-releases nothing.** Live claims keep their owners, files,
  and lease TTLs untouched.
- **Leases keep their TTLs — literally.** The freeze covers *agent-initiated*
  mutations only. The room's own time-based housekeeping — lease-expiry
  reaping (on requests and on the cron), the land/deploy live-close, and PR
  settlement — keeps running while engaged. A lease that lapses during
  engagement expires normally; its holder simply cannot renew, extend, or
  re-claim until the owner disengages. The STOP halts agent churn; it does
  not stop the room's clock.
- No new claims can be taken while engaged; existing claims cannot be
  updated, released, renewed, or closed by any member or agent.

### 4. Engage / disengage

- `POST /api/rooms/{roomId}/work-claims/kill-switch` —
  body `{ "action": "engage" | "disengage", "reason"?: string }`, owner-only.
- `GET …/kill-switch` — `{ roomId, engaged }`; any authenticated member
  (a read; reads stay live).
- **No auto-disengage.** If the owner goes silent while engaged, the room stays
  frozen until the owner returns. Auto-release would reopen a storm the moment
  the timer lapsed; the room's existing ownership-transfer path covers a
  permanently-unavailable owner.
- While engaged, the kill-switch route itself stays reachable so the owner can
  always disengage.

### 5. Audit trail

Engage and disengage are recorded as **room events** —
`work_claim.kill_switch_set` — carrying who (`actorId`), when (`at`), the new
state (`engaged`), and why (`reason`). The audit projection is separate from
enforcement (see fail-safe below); the event log is the durable record the
owner, coordinators, and post-mortems read.

### 6. Fail-safe defaults

- The switch defaults **OFF**.
- Enforcement state is **in-memory only, per room, on the store** — never
  persisted to SQLite. A crashed or restarted server comes back **OFF**; it
  can never boot stuck ON. The audit events survive (they are the record),
  but enforcement does not.
- Rationale: a persisted ON that survives a crash would freeze the room with
  the owner possibly locked out of the control plane — exactly the failure
  mode this switch is meant to survive. If a storm is still in progress after
  a restart, the owner re-engages (one call); the audit trail shows the
  previous engagement and its reason.

## Precedent reused

- `room.trust_set` (`ROOM_TRUST_SET`): owner kill-switch for cross-owner
  assign/wake — same owner-gate shape, same "one binary switch" concept.
- `work-claims/sweep` 409/422 refusal bodies: the 503 body uses the same
  `{ error: { code, message }, hint, next }` envelope.

## What this is NOT

- Not a room freeze: messages, chat, DMs, and every other family are
  untouched. It is a **claim-plane** STOP only.
- Not a permission system change: member permissions, profiles, and the
  autonomy tiers are unchanged.
- Not a lease policy change: TTLs, renewal rules, and review policies are
  unchanged.

## Review checklist (merge lane + John)

This is a global STOP — it must not merge without:

- [ ] Merge-lane review of `server/kill-switch.mjs`, the choke point in
  `server/work-claim-routes.mjs`, the `http.mjs` route wiring, and the new
  event type in `src/events.js`.
- [ ] John's explicit eyes on the "who holds the STOP" answer (owner-only,
  human-kind) and the no-auto-disengage decision.
- [ ] Full affected-test run green (`tests/work-claim-kill-switch.test.js`
      plus the route-docs gate `tests/route-docs-check.test.js` and the
      work-claims suites).
- [ ] `docs/openapi.yaml` documents the new route (route-docs gate enforces).
- [ ] Confirm no other agent-reachable work-claim mutation was missed: search
      `workClaimRoute ===` in `server/work-claim-routes.mjs`, and the MCP
      direct paths (`closeWorkClaim`, `linkWorkClaimPullRequest`,
      `room_set_member_claim_cap`).
- [ ] Confirm the archived-room path still refuses engagement (applyEvent
      throws on archived rooms — engagement is a room event and must fail
      there, same as every other room write).

> Status: staged on `wave300/fix66-kill-switch`. NOT merged — awaiting the
> merge lane and John's review per the checklist above.
