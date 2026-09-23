# G7 attachment HTTP adversarial review

12 September 2026. Canonical new test + this doc only.

**Frozen source:** `/Users/johnpotter/src/project-room-integration` commit `02fba88df7ae6e6f09e14905d63de0b52f68f7ce`  
Tests dynamically import `server/store.mjs`, `server/http.mjs`, `server/bootstrap.mjs`, `server/attachments.mjs` from that tree. No integration edits.

Contract read: `docs/ATTACHMENT-HTTP-2026-09-12.md` at that commit. PUT `/api/rooms/:roomId/attachments/:id` with `X-File-Name` + raw bytes; GET/HEAD committed only; DELETE staged only. Admission 4/server, 2/room, 1/member/room. 10s deadline. 1 MiB. Reauthenticate after body.

## Command

```
cd /Users/johnpotter/src/project-room
PROJECT_ROOM_G7_ROOT=<disposable 02fba88 worktree> node --test tests/attachment-http-g7.test.js
```

Codex asked to isolate room admission from member admission: `thirdInRoom` now uses a third distinct `alpha-extra` key, not the already-uploading owner. Exact candidate re-run on disposable `02fba88` worktree (live integration had already moved). Observed: **5/5 pass**, ~20.2s. Scratch log `g7-http.txt`.

## Independent results vs the live handler

| Case | Observed at 02fba88 |
|---|---|
| Query selector `?view=1` or duplicate `auth` | **422** `invalid_attachment_selection`; no rows |
| POST/PATCH | **405** with `Allow` containing PUT; no rows |
| Second PUT same member while first in flight | **429** `upload_limit` |
| Third in-flight in one room using a **distinct** third member (`alpha-extra`) after owner+guest already uploading | **429** (room cap, not member cap) |
| Fifth in-flight on the server (4 already) | **429** |
| Slow PUT (1 byte, no end) | Server logs **408** `upload_timeout`; client may see **408** or `ECONNRESET` because `fileBody` calls `req.destroy()` after fail. Slot is freed: a following PUT is **200**. No rows after the timeout. |
| Account-session login revision bump mid-body | Completing the PUT is **409** `session_binding_changed`. No rows. Uses the binding captured before `fileBody`, then `attachments.stage` → `authenticate`. |
| `Content-Length: fileBytes+1` then 1 byte | **413** `too_large`. Concurrent PUT **429**. Client `end()` does **not** free the slot immediately; a following PUT is still **429**. No rows. Slot is held until close/deadline, not until the 413 JSON is written. |

## Limitations

- Did not re-run Codex’s 22 Node / 2 Worker tests or the live full regression (Codex asked not to duplicate that handle).
- Did not wait a second 10s to prove the oversize slot is freed by the deadline; the timeout test already shows deadline cleanup.
- Worker HTTP bridge not exercised here (Node `createRoomServer` only).
- Did not test GET/HEAD committed download headers (already in isolated `tests/attachment-http.test.js`).
- `src/client.js` is dirty in the integration working tree; tests imported store/http only and did not load that file.
- Public MCP is unchanged and still has no file tools (canonical preview).

## Verdict

Admission counters, timeout slot release, account-session rebind, method/selector errors, oversize 413, and no persistence on those failure paths hold on 02fba88. Notable actual behavior: a declared-oversize PUT keeps its admission slot after the client ends; abort/destroy also did not free it within hundreds of milliseconds. That matches the comment in `fileBody` (keep the slot while a rejected request drains / until deadline), not an immediate 413-and-free policy.

No integration or frozen MCP edits. G8 waits for UI.
