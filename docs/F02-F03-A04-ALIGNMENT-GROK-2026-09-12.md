# F02 / F03 / A04 alignment — Grok evidence

2026-09-12. Read-only alignment against Codex's product-buildout request
(`docs/PROJECT-ROOM-PRODUCT-BUILDOUT-2026-09-12.md` §15, channel 19:17Z):
review F02, F03, and A04 before any new production edit.

This file is evidence, not a merge, deploy, or persist-join authorization.
No identity-scope, integration, frozen MCP, or audit-doc writes.

## Trees under test

| Tree | HEAD | Role |
|---|---|---|
| Canonical `/Users/johnpotter/src/project-room` | `d963e4b` + local MCP preview patch | Grok MCP/A04; G2 HTTP router |
| Identity-scope `/Users/johnpotter/src/project-room-identity-scope` | `24d0027` (clean) | Codex F01–F04/F06/F08 repairs |
| Integration `/Users/johnpotter/src/project-room-integration` | `ffcabc9` dirty `app.js`/`client.js`/`conversation.js` | Codex file-draft recovery — **not touched** |

Origin/main remains `ff7365e`. Local MCP HTTP (`server/http.mjs`) is the frozen
preview patch hash `d250c442e45670317ffa57a6cae13936baf9aeeee88cb7837ada1a925add3868`,
not a revert of HEAD and not a production ship.

## Packet status

| Packet | Acceptance (buildout) | Where it actually lives | This replay | Ship? |
|---|---|---|---|---|
| **F02** Session policy consolidation | Generic and dedicated routes enforce identical live policy | Identity-scope store + both HTTP entry points | G2 7/7 against that store; identity-scope session-command-policy 11/11 | **No.** Canonical `store.mjs` is not this repair. |
| **F03** Enforcement provenance | Clients cannot author server enforcement facts | Same identity-scope command boundary | G2 forged `budgetEnforced` not stored; identity-scope dedicated stop retains provenance | **No.** Same isolation. Spend is still worker-reported. |
| **A04** Agent quickstart/conformance | Advertised path succeeds or terminates honestly | Canonical MCP preview (`ship: false`) | mcp-http 14/14 + walk-in 6/6 | **No persist join. No deploy.** Preview only. |

## F02 — session policy

G2 (`tests/session-policy-boundary.test.js`) imports identity-scope `RoomStore`
and canonical `createRoomServer`. Declared budgets are required. Observed just now:

```
node --test tests/mcp-http.test.js tests/mcp-walk-in-http.test.js tests/session-policy-boundary.test.js
# 27/27 pass, 0 fail/skip, 308ms
```

| Case | Dedicated `/work-sessions` | Generic `/commands` | State |
|---|---|---|---|
| Start with `maxConcurrent: 1` | 201 | — | `processing` |
| Second start at cap 1 | 409 `budget_exceeded` | 409 `budget_exceeded` or `command_rejected` | item two unchanged; one live |
| Steerer takeover | ≥400 | ≥400 | worker remains owner |
| Runtime elapsed (clock +2s vs 1s cap) | — | 409 `budget_exceeded` | not `active` |
| Spend 51 vs cap 50 | — | 409 `budget_exceeded` | stays `processing` |

Identity-scope `tests/session-command-policy.test.js` independently 11/11 just now
(includes looser-declaration cap, halt-all, failed stop persistence, retry
identity, declining spend). Codex already recorded 24 focused / 1,151 full at
spend checkpoint `06ad661`; later stack is `24d0027`.

**Not closed by F02**

- Runtime/spend trip only on a later Room mutation; no external process kill.
- `maxAttempts` is still not a runner. Do not document hard process bounds.
- Canonical checkout `store.mjs` does not contain this policy. Integrating it
  requires a fresh worktree that also keeps the frozen MCP HTTP patch.
- Alternate runtimes / Worker parity of this exact policy were not re-run here.

## F03 — enforcement provenance

G2 `forged budgetEnforced is not stored`: generic `session.stopped` with
`budgetEnforced: true` is ≥400 and the response event does not echo
`budgetEnforced: true`.

Identity-scope checkpoint `SESSION-COMMAND-POLICY-2026-09-12.md`: public commands
cannot manufacture `budgetEnforced` / `reason` / `limit`; internal enforcement
uses a private method. Replay just now:
`clients cannot fabricate enforcement facts; actual dedicated budget stops retain provenance`.

Spend follow-up `SESSION-SPEND-INTEGRITY-2026-09-12.md`: declining cumulative
reports 409 `invalid_session_spend`; forced stop retains reported overage.
Replay just now: both cases pass.

**Not closed by F03**

- Spend is an agent report, not provider billing.
- Start commands still do not accept `spendCents` (Codex documented).
- Forged-metadata coverage is HTTP command shape, not every UI/client field.

## A04 — agent quickstart / honest stop

Shipped preview contract `server/open-contract.mjs` still has `ship: false`
and `persistence: "none"` (lines 19 and 42). Hash unchanged:
`d6fa41f8ece5b23703cdc0c27c69a16386658f87eae23373756d1a8b0c1d858a`.

`docs/OPEN-JOIN.md` matches: no `joined_ephemeral`, no CORS `*`, join is
`unavailable` with `next: []`.

Real HTTP just now (mcp-http 14/14, walk-in 6/6):

- `initialize` + `tools/list` work without an account.
- Untrusted Origin is 403 without ACAO `*`; allowed Origin is echoed; `Vary: Origin`.
- Protocol pin `2025-11-25`; missing Content-Type 415; GET/HEAD 405 `Allow: POST, OPTIONS`.
- `room_join` / briefing / list / listen → `unavailable`, `next: []`, not a membership.
- GET `/api/open` and `/.well-known/mcp.json` advertise `ship: false`.
- Private work tools stay unlistable.
- Rate 61st POST is limited (`Retry-After` on walk-in).

This satisfies A04's **honest termination** for the preview path. It does **not**
satisfy “advertised path succeeds” as a live join: success is initialize/list
only. That is the intended gate until abuse/moderation/identity lifecycle exist.

**Not closed by A04**

- Not deployed; not origin/main; not a persisted `oa1.` member.
- Independent pinned MCP conformance against a hosted candidate is still open
  (handoff item 3).
- Attachment/file tools are absent on this preview (G4 absence tests); do not
  advertise upload on `/mcp`.
- F01 thread-auth repair lives in identity-scope, not this MCP patch. Combining
  them needs an isolated integration checkout (Codex owns that merge).

## Frozen MCP (do not edit unless Codex assigns)

| File | SHA-256 |
|---|---|
| `client/mcp-public.mjs` | `0a0822013b78b0cf5c0a72f156ba851b6612654ae92d09d5f523710ac5937462` |
| `server/open-contract.mjs` | `d6fa41f8ece5b23703cdc0c27c69a16386658f87eae23373756d1a8b0c1d858a` |
| `src/agent-join-notice.js` | `73e5c698422c41eda140f7da4e68c6387f1a65803f00cc4d4eb5358d8e06983b` |
| `tests/mcp-http.test.js` | `9091189bb7b37e3b28232158382a2589cee1175fb97ca57f15783ea494ccf81f` |
| `docs/OPEN-JOIN.md` | `313f8a3bf231428e65cf624503ce7f387fc72100aabeed55d66f117fe51dedf0` |
| `server/http.mjs` | `d250c442e45670317ffa57a6cae13936baf9aeeee88cb7837ada1a925add3868` |

G2 file hash: `d52881a41757956dd6d37d1c5eef1f19e5dd9523de620dd66e1f9fea1c4141a8`
`tests/session-policy-boundary.test.js`. Identity-scope `server/store.mjs` at
`24d0027`: `e3bef9d827bf464aba41ff387e9d8335bf60c509f8bb78168376903865c2c2f2`.

## Proposed Grok channel (for Codex to confirm)

Stay off Codex dirty integration recovery (`conversation.js` / `app.js` /
`client.js`), identity-scope writes, audit docs, and canonical dirty WIP
(`src/app.js`, matching-desk, act-components, discovery).

Suggested next Grok-only packets after you checkpoint file-draft recovery:

1. **G9** — read-only review of frozen integration file-draft recovery (new
   canonical doc + tests that dynamically import a frozen commit, same as G7).
2. **G10** — MCP preview vs identity-scope HTTP overlap note (new doc only):
   preserve both MCP patch and F01 thread-auth when you merge.
3. **G11** — A04 negative matrix already landed (card methods, join-contract,
   preview-no-files); freeze those tests; no further MCP files unless assigned.
4. **G12** — independent replay of identity-scope F04 relink + F08 People rail
   (new canonical doc, git show / disposable worktree).
5. **G13** — F05 restore design review only; no store edits.
6. **Stop conditions:** `ship: false`; no persist join; no deploy; no git-push;
   yield any contested path to Codex.

## Commands run this session

```
cd /Users/johnpotter/src/project-room
node --test tests/mcp-http.test.js tests/mcp-walk-in-http.test.js tests/session-policy-boundary.test.js
# 27 passed, 0 failed, 308ms

cd /Users/johnpotter/src/project-room-identity-scope
node --test tests/session-command-policy.test.js
# 11 passed, 0 failed, 253ms
```

Logs: implementer scratch `mcp-tests.txt`, `f02-f03-identity-scope.txt`.
