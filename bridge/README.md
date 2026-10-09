# herdr-bridge — host-side session broker

`bridge/herdr-bridge.mjs` translates the domain API to herdr's Unix-socket JSON
protocol. It runs on lane-worker hosts; the Cloudflare Worker (B4's
`HerdrBridgeAdapter`) talks to it over authenticated HTTPS. Design:
`~/workspace/goals/project-room-herdr-redesign/phase2/design-docs/bridge-transport.md`
(D3); fencing: `threat-model-terminal.md` (D1), `phase1/risk-review.md` §2–§3.

```
Worker ──HTTPS + bearer──▶ herdr-bridge.mjs (127.0.0.1:8443)
                              │ auth, fencing, audit, idempotency
                              ▼ Unix socket (newline-delimited JSON)
                           per-tenant herdr server (own UID, 0700 socket dir)
```

## Layout

- `herdr-bridge.mjs` — entry point (env → `createBridge` → listen).
- `lib/bridge.mjs` — HTTP routes, invoke pipeline (fence → breaker → retry → audit).
- `lib/auth.mjs` — bearer-per-tenant, `HMAC(master, "herdr-bridge-v1:"+tenantId)`.
- `lib/fence.mjs` — socket method allowlist/blocklist (deny-by-default),
  agent-kind → argv templates, report binding, resume-argv validation.
- `lib/sanitize.mjs` — **the** shared ANSI sanitizer (readPane boundary).
- `lib/redact.mjs` — key-name + secret-shape redaction.
- `lib/socket-client.mjs` — one-shot calls + persistent subscribe.
- `lib/idempotency.mjs` — 15-min write dedupe cache.
- `lib/circuit.mjs` — per-tenant circuit breaker.
- `lib/audit.mjs` — JSONL audit log (redacted; readPane bodies never persisted).
- `lib/tenants.mjs` — tenants.json loading + socket-dir drift checks.
- `deploy/` — `herdr-bridge.service`, `herdr@.service`, `logrotate.conf`,
  `tenants.json.example`, `ROTATION.md` (dual-key rotation).

## API

`GET /healthz` (unauthenticated): `{ ok, service, version, pinnedProtocol, missing[] }`.

All `/v1/*` routes require `Authorization: Bearer <token>` +
`X-Bridge-Key-Id: <generation>`; the tenant is resolved **from the verified
token**, never from request fields.

| Route | Domain method | Socket method | Notes |
|---|---|---|---|
| `POST /v1/ping` | ping | `ping` | version + method-list assertion material |
| `POST /v1/snapshot` | snapshot | `session.snapshot` | tenant-scoped; issues occupant handles |
| `POST /v1/spawn` | spawnAgent | `agent.start` | argv from kind template; needs `idempotencyKey` |
| `POST /v1/read` | readPane | `pane.read` | sanitized + secret-redacted; needs handle or paneId |
| `POST /v1/send` | sendText | `agent.prompt` | occupant-pinned; needs handle + `idempotencyKey` |
| `POST /v1/keys` | sendKeys | `agent.send_keys` | occupant-pinned, audited per call |
| `POST /v1/wait` | waitForState/waitForOutput | `agent.wait` / `pane.wait_for_output` | occupant-pinned; caller `timeoutMs` capped at 120s |
| `POST /v1/report` | reportState/Resume/Metadata | `pane.report_agent*` | caller proves `HERDR_PANE_ID == target` |
| `POST /v1/close` | closePane | `pane.close` | invalidates the pane's handles |
| `POST /v1/list` | listAgents/getAgent | `agent.list` / `agent.get` | tenant-scoped inventory |
| `GET /v1/events?since=` | subscribe | `events.subscribe` | SSE; `: ping` heartbeat every 25s |

Writes (`spawn/send/keys/wait/report/close`) require `idempotencyKey` (uuid v4);
a repeated key returns the original response without re-executing.

## Fencing (deny-by-default)

- **Blocklist** (refused for room code; stripped in the fork by B1):
  `server.*`, `plugin.*`, `integration.*`, `worktree.*`, `layout.apply`,
  `notification.show`, raw cross-pane `pane.send_text/send_keys/send_input`.
  Unknown methods → rejected.
- **Spawn:** caller supplies `kind` ∈ `claude | codex | opencode` (+ validated
  `resumeSessionId`, `workspaceRoot` clamped to the tenant root). The bridge
  builds argv/env/cwd from code templates — caller argv/env never forwarded.
- **Reads** are tenant-scoped: the bridge keeps a pane-ownership registry and
  probes the tenant's own server on a miss (per-tenant servers make ownership
  implicit).
- **Send/keys/wait** take an opaque bridge-issued handle and re-verify the
  pane occupant via `pane.process_info` on every call (`OccupantChangedError`,
  handle invalidated).
- **Report** requires `herdrPaneId === targetPaneId`; resume argv must match a
  kind template.

## Dependencies on sibling lanes (not this lane)

- **B1 (fork):** `SO_PEERCRED` UID check on socket accept — must permit the
  bridge UID explicitly (the bridge connects as `herdr-bridge`, not the tenant
  UID); fork-side `agent.start` argv/env/cwd gate; method strip list
  (threat-model §5).
- **B4 (Worker):** `HerdrBridgeAdapter` HTTPS client, route-auth table,
  circuit breaker on the Worker side, `events_lost` → re-snapshot recovery.
- **B9:** adversarial ANSI fixture suite against `lib/sanitize.mjs`.
- **B10:** fork-audit verifications (socket auth absence, argv shape, …).
- **B15/ops:** tenant UID provisioning, `/etc/herdr-bridge/env` (0600),
  `wrangler secret` distribution, cgroup/disk quotas.

## Failure semantics

Timeouts per method (5–30s, `wait` capped at 120s). Retries: idempotent reads
3 attempts; writes only on no-response with the same idempotency key (2
attempts); exponential backoff with full jitter. Per-tenant circuit breaker:
5 consecutive transport failures → open 60s → single `ping` probe. Audit log:
JSONL, redacted, denies included, 30-day retention (`deploy/logrotate.conf`).

## Tests

`TMPDIR=$PWD/.tmp node --test tests/herdr-bridge.test.js` — fail-first suite
against a fake herdr Unix-socket fixture (throws on unknown methods).
