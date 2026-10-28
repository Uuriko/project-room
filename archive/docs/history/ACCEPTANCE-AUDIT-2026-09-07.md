# Local milestone acceptance audit

**Superseded by the final local audit:** [FINAL-LOCAL-ACCEPTANCE-2026-09-07.md](FINAL-LOCAL-ACCEPTANCE-2026-09-07.md) contains current candidate evidence, the completed browser-created handoff, full local requirement findings and separate open release gates. The blocked/incomplete statuses below are historical.

**Current evidence pointer:** [Guest recovery acceptance](BROWSER-GUEST-ACCEPTANCE-2026-09-07.md) records the 163-test candidate, browser/database proof of one guest and one use after a lost result, additional recovery fixes and the exact remaining checks. The original audit below is historical, not a current completion verdict.

**Latest resumed evidence:** [Browser acceptance progress](BROWSER-RESUME-2026-09-07.md) records 160 passing current tests, browser approval/restart recovery, a visible-owner identity fix and actionable timeout guidance. Full acceptance remains incomplete; use that report's remaining checklist.

**Later checkpoint:** browser access was restored and testing began; 157 current core/API checks pass and a hidden invitation-feedback bug was fixed. John requested a pause before the remaining browser tests. See [the browser checkpoint and screenshots](BROWSER-CHECKPOINT-2026-09-07.md). The blocked status and 155-test inventory below are historical; full acceptance is still incomplete.

7 September 2026 UTC. **Completion is not established.** Browser access is still denied because its required admin-policy check is unavailable. The original objective is preserved; this document does not substitute API tests for browser acceptance or independent review.

Goal status at this checkpoint: **blocked**, not complete. The same browser-policy condition persisted across three consecutive goal turns; this turn revalidated it through the actual preview tab. Useful implementation, regression checks and the acceptance audit were completed before stopping. Resume the unchanged goal when approved browser access is restored, execute the remaining checklist below, and fix any findings. No policy bypass is authorized.

## Tested configuration

- Canonical working directory: `work/project-room-canonical` in the Project Room project mirror.
- Base commit: `7b5e92fa3245eab684e4a0f2e9c8f16c90441801`, with retained uncommitted implementation. The base commit alone does not identify the tested candidate.
- Node `v24.19.0`; SQLite schema v7; loopback-only single-node service. No runtime package dependencies or live AI connections.
- Source/test/config inventory digest: `a1bf188ef90663082ede7aa5eb01026485be6fbbecd2f7140be2e5f51555e370`. Derived by the command below; documentation is outside this fingerprint.
- `node scripts/check.mjs`: syntax checks and **155/155 core/API tests passed**. `git diff --check`: clean. No current browser pass is claimed.

Recompute the candidate fingerprint from the canonical directory:

```sh
rg --files src server client scripts tests index.html package.json server.mjs | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
```

## Requirement-by-requirement evidence

| Requirement | Current evidence | Verdict and remaining scope |
| --- | --- | --- |
| Preserve canonical work, sources and coordination | Existing dirty work retained; edits confined to canonical app plus additive board/bus coordination; no synced sources edited | Met for this checkpoint; no new agents/tasks |
| Complete invitation joined-event evidence and immutable membership checks | `invitation-evidence.mjs`, `invitation-evidence.test.js`, invitation journal and service tests | Local checks pass; not an independent security review |
| Atomic migration, recovery and older-writer exclusion | `writer-fence.test.js` checks one migration transaction, failure rollback, pre-open writer exclusion, v6-to-v7 compatibility; read-only audit refuses to migrate | Local fixtures pass; actual production restore drill remains separate |
| Conversation remains human-usable without becoming work | Message/thread/reaction/search tests; explicit work proposal with source message | Service behavior passes; current UI usability unverified |
| Source-linked bounded work and exact artifact | `agent-handoff.test.js` submits an inline text artifact with SHA-256 evidence version, definition of done and source-message ID | Meets synthetic inline-artifact scope; URL is explicitly nonlive, no fetched external artifact claimed |
| Distinct producer/reviewer and human decision | Separate authenticated scripted members, exact completion event/version checks, failed review, correction, passing review, synthetic human-role decision | Local record exchange passes; one operator owns all fixtures, no organizational independence or real-human approval claimed |
| Changed work inherits no review or approval | Handoff plus event/service regression tests exercise new result revision and retired previous checks/decisions | Local checks pass |
| Recovery after interruption and current next actor | Service/database actually close and reopen mid-handoff; shared next-step selector, orientation and return brief identify correction/review/decision | Local checks pass; browser representation not yet inspected |
| Retry, cancellation, access changes and unknown outcomes | Stable command/redemption IDs, duplicate receipts, revision checks, supersession, cancelled links, revoked access, client lost-response/ownership tests | Local contracts pass; external execution is absent, not automatically retried |
| One service and permission model | Browser and `RoomAgentClient` use the same service, records and next-step selector; HTTP operations tested | API/client implemented; MCP explicitly deferred under the goal's permitted option |
| Runnable orientation/context/work/evidence/resumption | `AGENT-CLIENT.md`, `agent-inbox.mjs`, `room-agent.mjs`, executable end-to-end test | Available locally; bounded Room-wide context, no per-task privacy or public interoperability claim |
| Anyone-with-link entry without owner-key sharing | Nine share-link service/HTTP tests; distinct guests, fixed guest grants, limits, expiry, cancellation, identity reuse and rollback | Local service passes; UI interaction and clipboard fallback unverified |
| Calm UI, preservation and honest claims | Existing return brief/cursor contracts; shared next-action copy; invitation preview now retains account ownership; no fake read/presence or auto-execution claims | Client ownership tests pass; actual focus, drafts, announcements and visual behavior remain unverified |
| Browser, keyboard/focus and narrow screen | Current in-app tab selection attempted again; required policy check denied access. Earlier 28 checks predate the new UI | **Blocked, not met. Do not use an alternate browser path to bypass the policy** |
| Something John can try and runnable handoff | Existing local preview and guest invitation supplied; instructions below and linked service/client docs | Tryable local build; a successful full interactive handoff remains unverified |
| Research-informed scope, fair alternatives and no adoption overclaim | Prior research documents retain dedicated-room, chat-complement and incumbent alternatives; no monetization, recruitment or external integration added | Met as scope discipline; no demand/productivity/retention conclusion |
| No unauthorized external actions | Local edits/tests/coordination only; no push, merge, hosting, money, live accounts or runtimes | Met for this checkpoint |

## Runnable local checks and operator setup

With Node 24.19+ available, run from the canonical directory:

```sh
node scripts/check.mjs
node --test tests/agent-handoff.test.js
```

On this Mac, if `node` is not on the shell's path, the tested executable is `/Users/johnpotter/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. Use that full executable path for the commands above. Loopback service tests require the local environment's normal approval. A bind refusal is not a PASS.

The handoff test creates disposable data, performs the entire proposal → first result → failed review → restart → correction → passing review → human-role decision sequence, checks that a repeated review persists once, and cleans up its own fixture. It does not send messages outside the fixture or run a real agent. Its exact inline artifact and revision can be inspected in `tests/agent-handoff.test.js`.

For a fresh **operator-created** local room, choose a new database path so existing member keys are not rotated accidentally:

```sh
room_demo_directory="$(mktemp -d)"
ROOM_DB="$room_demo_directory/room.sqlite" node scripts/provision.mjs --init --member owner --account account-owner
ROOM_DB="$room_demo_directory/room.sqlite" node server.mjs
```

Keep the resulting database path (`$room_demo_directory/room.sqlite`) and printed private owner key, and use the local address the service prints. Do not rerun provisioning against an existing member unless key rotation is intended. Guest recipients do not need this operator setup: the owner chooses **Invite people**, and recipients open the copied link and choose a name. Localhost links only work on this Mac. These instructions do not authorize publishing or bypassing browser-policy checks.

## Exact browser acceptance still required

Once the approved browser policy check works, reuse the existing preview rather than creating a workaround surface. Reload it to load the latest modules. Verify:

1. Owner entry, ordinary conversation and source-linked work proposal; no hidden automatic work or read acknowledgments.
2. Invite people: defaults, changed limits/expiry, creation, copy fallback, cancellation and clear local-only/history-access wording.
3. Join: new guest name, existing membership reuse, invalid/expired/full/cancelled links, storage/network error and same-request retry. Separate identities must remain visible and no owner impersonation may occur.
4. Draft continuity: enter a draft, preview and dismiss a link, then reopen a link to the same membership. The draft, identity and reply context must remain; a genuinely different identity must clear private state only through the explicit join flow.
5. Keyboard opening, Tab/Shift+Tab containment, Escape when safe, blocked dismissal during a pending join, error focus and return focus. Check actual behavior rather than inferring it from native dialog markup.
6. Narrow layout and 200% text enlargement: controls, full invitation warnings, name entry, copied-link field and work next-step text must remain usable without clipped actions.
7. Full handoff representation: producer, reviewer, exact version, correction, decision and next actor match canonical state after refresh/restart, without stale review or approval.

Any finding reopens implementation and verification. Until these checks pass, the goal remains incomplete.

## Separate gates—not local-milestone claims

Independent code/security review, separately operated live runtimes, real retrieved external artifacts, physical devices, non-Chromium browsers, assistive technology testing, production operations/restore drills, representative-team dogfooding and adoption measurement remain open. No self-review or synthetic test closes those gates. MCP integration needs its own dependency/protocol/host verification before compatibility is claimed.
