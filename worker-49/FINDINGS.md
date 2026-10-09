# WORKER 49 — API fuzzing findings

Shard: sorted route-table rows, index % 50 == 48 (2 handlers).
Base: `wave2000/guild-02` @ `747f101f8`. Harness: in-process `createRoomServer`
(no network beyond loopback; own temp SQLite DBs, removed after each run).

## Handlers fuzzed

1. `POST /api/inbox/webhooks/{connectionId}` — `inbox.webhook`, `server/routes/inbox.mjs:62` (`handleInboxMount`), auth `none` + per-connection secret header.
2. `POST /api/rooms/{roomId}/squads/{squadId}/disband` — `squad-disband`, `server/routes/squads.mjs:56` (`disbandSquadRoute`), auth `room`.

45 fuzz cases, 0 crashes, 0 hangs. Full board: `worker-49/fuzz-results.json`.

## FINDING (1) — low severity, wrong-status

**`?auth=<invalid>` silently accepted when a Bearer credential is present**
— `server/http.mjs` `roomCredentials` (~line 731):

```js
const bearerToken = bearer(req);
if (bearerToken) return { token: bearerToken, bearer: true, mode: "room" }; // early return
const requested = req.headers["x-project-room-auth"] ?? url.searchParams.get("auth") ?? "room";
if (!["room", "account"].includes(requested)) reject(422, "invalid_auth_mode", "Invalid Room authentication mode");
```

The `invalid_auth_mode` 422 fires without a bearer (`?auth=bogus` → 422,
verified), but with `Authorization: Bearer <room key>` the early return skips
validation entirely, so `?auth=bogus` (or `?auth=account` on a room token)
returns **200** and the request proceeds. Invalid input is silently ignored,
contradicting the route's own validation contract. No auth bypass (bearer
still forces the room mode); strictness/contract issue only.

Repro:
```
POST /api/rooms/commons/squads/<squadId>/disband?auth=bogus
Authorization: Bearer <room access key>
→ 200 today (squad disbanded); should be 422 invalid_auth_mode
```

Fail-first test: `worker-49/authmode.test.js` (fails on current code: 200 !== 422).
Fix sketch: validate the `auth` selector before the bearer early-return, or
document that bearer pins mode=room and the selector is ignored.

## Investigated and cleared (not bugs)

- **Method confusion on webhook route**: `handleInboxMount` has an explicit
  `if (req.method !== "POST") reject(405)` (`server/routes/inbox.mjs:65`).
  GET/HEAD/DELETE/OPTIONS/PUT/PATCH with valid secret → 405, verified via raw
  sockets and curl. (An early harness artifact: node:http sends GET bodies
  with no Content-Length/Transfer-Encoding, which the HTTP parser 400s —
  client-side malformation, not a server bug.)
- **`?auth`/`x-project-room-auth` invalid value without bearer** → 422 `invalid_auth_mode`. Correct.
- **Webhook auth**: missing/wrong/weak secret → 401; non-JSON → 415;
  invalid JSON → 400; empty/oversize/malformed updates → 422; oversize body →
  413 naming limit+actual. Correct.
- **Encoded path traversal** (`%2e%2e%2f%2e%2e` as connectionId) → 404: WHATWG
  URL normalizes encoded dot-segments before routing; no escape.
- **Disband**: no credential → 401; non-owner → 403; unknown squad → 404;
  unknown room → 403; wrong methods → 405 with `Allow: POST`; double disband
  → 200 `changed:false` (idempotent); NUL/1000-char/encoded-`..` squadIds → 404;
  trailing slash → 200 (front normalizes, intentional per QA 2026-10-03).
  Invalid-JSON and 1MB bodies → 200: handler never reads the body (no body
  schema on the row) — correct, nothing to validate.
- One transient `socket hang up` on a single fuzz case did not reproduce in
  3/3 isolated retries or in the final clean run (45/45 transport-clean);
  attributed to keep-alive reuse racing the 413 half-close drain, not a
  server defect. Final run used `Connection: close`.

## Files

- `worker-49/fuzz.mjs` — 45-case fuzz harness (in-process server)
- `worker-49/fuzz-results.json` — full case board
- `worker-49/authmode.test.js` — fail-first test for the finding (currently failing)
- `worker-49/probe.mjs`, `worker-49/rawprobe.mjs`, `worker-49/clientdiff.mjs`, `worker-49/authmode.mjs` — investigation scratch
- `worker-49/.tmp/` — server logs / temp DBs from the runs
