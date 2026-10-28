# herdr Operator Runbook — Project Room

How to run the per-tenant herdr servers and the bridge that Project Room's
session adapter talks to. Companion docs: `docs/SESSION-ADAPTER.md` (the
contract), `docs/INCIDENT-RUNBOOK.md` (severity levels, roles — this runbook's
SEV references mean those definitions).

**Status:** the code does not exist yet. Everything this runbook installs or
rotates is Phase-3 output: fork binaries (pending B1), `bridge/herdr-bridge.mjs`
(pending B3), `server/session-adapter/*` (pending B2/B4), session tables
(pending B5), supervision routes (pending B6). Do not follow these procedures
until the lanes land and this runbook is refreshed against the actual flags.
The *shape* of the procedures is settled; exact paths and unit files come from
the build lanes.

The governing constraint: production (`room.trydemigod.com`) is a Cloudflare
Worker (`cloudflare/wrangler.jsonc`). herdr **cannot run in the Worker** — no
PTYs, no Unix sockets, no persistent processes. All herdr processes run on
lane-worker hosts; the Worker reaches them only over authenticated HTTPS to
the bridge.

## 1. Topology (one tenant = one server)

From `phase1/risk-review.md` §2 and REDESIGN.md §2.1. herdr enforces **no
authentication, no authorization, no isolation** — every pane inherits
`HERDR_SOCKET_PATH` and is a peer of the supervisor. Therefore every
cross-tenant boundary lives in the bridge + the OS:

- **One herdr server process per tenant** (agent). Process-per-tenant is the
  default until the fork audit proves named-session separation (pending B10).
- **Distinct OS UID per tenant.** Same-UID processes can signal and
  `/proc`-inspect each other — separate sockets alone are not isolation.
- **Per-tenant socket directory:** `0700`, owned by the tenant UID; socket
  file `0600`. Default socket is `~/.config/herdr/herdr.sock` — in the
  per-tenant shape this lives under the tenant's home, not a shared path.
- **Per-tenant `TMPDIR`** and cgroup/disk quotas on the tenant UID.
- The fork binary is hermetic: no network, no remote catalog, no phone-home
  (strip list, pending B1; the fork carries `DEMIGOD-CHANGES.md` per
  Apache-2.0 §4(b)).

```
tenant "jill" (uid 31001)
 ├─ /srv/herdr/tenants/jill/socket/herdr.sock        (dir 0700, sock 0600)
 ├─ /srv/herdr/tenants/jill/data/                    (session.json persistence)
 ├─ herdr server process (uid 31001, pinned binary)  (pending B1)
 └─ bridge/herdr-bridge.mjs (pending B3) — bearer auth, per-tenant route auth,
    method allowlist/blocklist, per-call audit log with secret redaction
```

Install binaries **only** from our fork (https://github.com/Uuriko/herdr) at
the pinned commit in `server/session-adapter/pinned-herdr.json`
(`binarySha256` checksum-verified at install; pending B2/B4). Never `latest`,
never upstream's installer. `connect()` throws `VersionMismatchError` on any
protocol/binary drift — fail closed, never downgrade.

## 2. Per-tenant herdr server setup (operator steps)

Per tenant `T`, UID `U` (all pending B1/B3 for exact binaries and unit files;
the procedure shape is settled):

1. Create the tenant user and UID: `useradd -r -u U herdr-T` (no login shell,
   locked password). The tenant UID must be distinct per tenant.
2. Create the socket dir and data dir as that user:
   `/srv/herdr/tenants/T/socket/` mode `0700`, socket file mode `0600` after
   bind; `/srv/herdr/tenants/T/data/` for `session.json` persistence.
3. Set per-tenant `TMPDIR=/srv/herdr/tenants/T/tmp` (mode `0700`) and apply
   cgroup/disk quotas to the UID.
4. Install the pinned binary from the fork at the pinned commit; verify
   `sha256sum` against `binarySha256` in `server/session-adapter/pinned-herdr.json`.
5. Start the server under process supervision with a per-tenant unit
   (systemd unit example ships with the bridge lane — pending B3 — as docs,
   not installed): supervise **bridge + herdr** together per tenant so a
   dead herdr is noticed by the bridge's health path, not silently masked.
6. Point the bridge's per-tenant route at the tenant socket:
   `HERDR_SOCKET_PATH=/srv/herdr/tenants/T/socket/herdr.sock`, never a
   shared path.
7. Verify: `ping` through the bridge returns `{ ok: true, protocolVersion,
   herdrVersion }` matching the pin; then `snapshot` returns the tenant's
   (empty) workspace.

**What to check before declaring a tenant live:** pin match (protocol +
binary + sha256), socket file `0600` and dir `0700` owned by the tenant UID,
no other tenant UID has the dir on its path, bridge audit log writing with
secret redaction on.

## 3. Bridge deploy

`bridge/herdr-bridge.mjs` (pending B3) runs on each lane-worker host as plain
Node (this is the only place `net.createConnection` is allowed). Per deploy:

1. **Auth:** bearer tokens, per-tenant route auth (tenant T's bearer only
   reaches T's socket route). Same discipline as the room's
   `docs/ROUTE-AUTH-TABLE.md`. The bridge never trusts network location.
2. **Allowlist/blocklist:** the never-expose blocklist
   (`server.*`, `plugin.*`, `integration.*`, `worktree.*`, `layout.apply`,
   `notification.show`, raw cross-pane send — see `docs/SESSION-ADAPTER.md`
   §8) is deny-by-default; allowlist is tenant-scoped reads,
   occupant-pinned `sendText`/`sendKeys`/`waitForState`, and
   adapter-constructed `agent.start` argv from allowlisted kinds only. No
   caller argv/env, ever.
3. **Audit:** every call is audit-logged with secret redaction. The audit
   log is the primary forensic source in the broker-down playbook (§5).
4. **Reconciliation:** the bridge's socket client implements `events_lost` →
   re-snapshot → reconcile (the adapter owns recovery; callers never see a
   silent gap).
5. **Supervision:** bridge and herdr are supervised together per tenant
   (systemd unit example — pending B3). A bridge deploy restarts one tenant
   at a time; never all tenants' bridges at once.

**Health model:** bridge exposes `ping`; room-side `HerdrBridgeAdapter`
(pending B4) degrades to the legacy backend on any failure (see
`docs/SESSION-ADAPTER.md` §6). Fork health/last-error is recorded in the
`herdr_backend_state` table (pending B5) — that's the diagnostics feed, not
a pager.

## 4. Key rotation

Bearer tokens are per-tenant and per-route. Rotate without dropping sessions:

1. Set the global flag off for *new* sessions only if the deployment shape
   requires it — normally rotation is live: mint the replacement token for
   tenant T alongside the old one (dual-accept window), update the room-side
   bridge client config, then revoke the old token.
2. Verify: `ping` succeeds with the new token, fails (401) with the old.
3. Confirm no active subscription was dropped: check the bridge audit log
   for `events_lost` spikes around the rotation window; a spike means
   subscriptions were re-snapped (expected, auto-recovered) — a gap without
   re-snapshot is not.
4. Rollback for a bad rotation: re-enable the old token (dual-accept is
   reversible), then re-cut.

Rotation cadence and the exact secret store are the operator's call; the
rotation procedure must stay **documented and rehearsed** — an unrehearsed
rotation is how bridges go dark at 2am.

## 5. Incident playbook: broker down

**Severity.** The room fails closed to the legacy backend
(`docs/SESSION-ADAPTER.md` §6), so a broker outage is **not** a room outage:
work claims still claim, sessions still spawn, heartbeats still flow. Map to
`docs/INCIDENT-RUNBOOK.md`: broker down with room healthy ≈ **SEV3** (feature
degraded for herdr-opted-in lanes only); broker down *plus* room request-path
impact (timeouts not bounded, fallback failing) ≈ **SEV2** — check that first,
because an unbounded seam call is the actual SEV2.

**Triage (in order):**

1. **Confirm the room is healthy.** `GET /api/health` and `/status` must be
   green. If they are not, this is not a broker incident — follow
   `docs/INCIDENT-RUNBOOK.md`.
2. **Confirm the degradation.** Query `herdr_backend_state` (pending B5):
   broker health + last error should show the failure. The degradation log
   in `herdr_session_journal` (pending B5) shows which seam calls fell back
   to legacy and when — this is the fail-closed evidence.
3. **Locate the fault.**
   - Bridge process dead? → restart per-tenant unit; check the bridge audit
     log tail for the last accepted call.
   - herdr server dead but bridge alive? → `ping` fails with the pin
     fields missing; restart the tenant's herdr unit. In-flight panes are
     PTY state — herdr's `session.json` persistence may recover some; assume
     panes are gone and let workers re-report via `reportState`.
   - herdr alive but socket unreachable? → check `0700`/`0600` ownership
     (did a deploy run as the wrong UID?), check disk (quota exhaustion
     presents as socket weirdness).
   - TLS/auth failing? → check certificate expiry and bearer config; see
     §4 before rotating anything under pressure.
   - Version mismatch (`VersionMismatchError`)? → **fail closed: do not
     downgrade.** A protocol/binary drift means the binary moved under the
     pin. Roll forward only via the pinned-upgrade lane process.
4. **Decide: fix forward or kill switch.** If the fault is tenant-scoped,
   fix forward per tenant. If the fault is systemic (bad bridge deploy,
   fleet-wide cert expiry), use the kill switch: **`ROOM_HERDR_SESSIONS=off`
   + redeploy** (see §6) — one deploy, provably the old behavior, no data
   cleanup (Phase A creates no herdr sessions; Phase B/C sessions drain).
5. **Verify recovery.** `ping` through the bridge matches the pin;
   `herdr_backend_state` flips healthy; `herdr_session_journal` stops
   recording fallbacks. For opted-in lanes, new herdr sessions spawn; do
   **not** force-migrate in-flight legacy sessions — Phase B migration is
   lane-initiated, never operator-forced.
6. **Post-incident.** The journal is append-only — the incident is already
   recorded. Add the operator narrative to the incident log per
   `docs/INCIDENT-RUNBOOK.md`. If the fork itself was at fault, file against
   the fork-audit lane (`docs/FORK-AUDIT.md` in the fork — pending B10).

**Do-not list:** never downgrade the pin to match a drifted binary; never
expose a blocklisted method as a "temporary workaround"; never treat agent
`working`/`blocked`/`done` state as an auth or payment signal during the
incident (state is spoofable); never delete journal rows.

## 6. Rollback — `ROOM_HERDR_SESSIONS=off`

The global kill switch. From `phase1/compat-plan.md` §5 (rollback matrix):

| Phase | Revert action | In-flight herdr sessions | Data left behind | Time to restore |
|---|---|---|---|---|
| A (default off) | nothing — old path is live | none exist | none | n/a |
| A (canary room) | remove room from flag list / flag off + redeploy | force-released via normal `done`/`failed`; claims → `unclaimed` | journal rows remain, unread | one deploy |
| B | `ROOM_HERDR_SESSIONS=off` + redeploy | drain naturally via stale-heartbeat release; no new herdr sessions | 4 additive tables dormant; legacy never reads them | one deploy (flag flip); drain bounded by heartbeat timeout |
| B (per-lane) | lane re-issues without the opt-in marker | reverse migration: release herdr, re-attach legacy, history-append | journal records both migrations | one command |
| C | flag off (hides surfaces) or frontend-only revert | unaffected | none new (Phase C adds no backend state) | one deploy |

Rules: rollback testing is part of each phase's gate (demonstrate flag-off
with in-flight herdr sessions on staging before promotion). Claims are always
intact across rollback; claim id, owner, and `claimedAt` never change on
migration (`server/work-claims.mjs` CAS semantics, 409 `session_claimed` —
existing contract, unchanged). There is **no Phase D** — the legacy backend
stays forever as the fail-closed fallback; removing it needs a new compat
plan.

## 7. Monitoring checklist (daily/weekly)

- `herdr_backend_state` healthy for every tenant with sessions; no tenant
  red longer than one heartbeat window.
- `herdr_session_journal` fallback rate: occasional fallbacks are normal
  (that's the seam doing its job); a rising trend is a bridge-health
  signal — investigate before it becomes §5.
- Bridge audit log: blocklist hits (denied calls) are reviewed, not just
  logged — a spike in denied `server.*`/`plugin.*` calls is an attack
  signal, not noise.
- Pin drift: binary `sha256sum` vs `pinned-herdr.json` on every deploy;
  fork `DEMIGOD-CHANGES.md` vs deployed binary on every fork PR merge.
- Disk/quota per tenant UID (quota exhaustion kills sockets before it
  kills the server — it looks like §5.3's "socket weirdness").
