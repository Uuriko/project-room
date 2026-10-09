# Work pipeline: work-actions.mjs, reply-actions.mjs, help-actions.mjs, begin-work.mjs, work-preparation.mjs, assignment-watcher.mjs, trust-tools.mjs

## work-actions.mjs — typed work verbs

**Purpose.** The finite vocabulary of work mutations (`room_accept_work`, `room_start_work`, `room_submit_text_result`, `room_record_completion`, `room_acquire_claim`, …): JSON-schema-ish descriptors (`workTools`), a hand-rolled validator (`conforms` — not a general JSON Schema engine), `validWorkArguments`, `buildWorkCommand` (16 KiB command cap, stable `requestId`), `confirmsAgentCommand` (receipt verification: sequence > 0, idempotency key = `sha256(memberId:commandId)`, causation, deep-equal data), `recordedWorkAction`, `submitWorkAction`, and `workActionRefusal` (typed refusal messages).

**Invariants.** Input schemas are closed (`additionalProperties: false`); id patterns reject `constructor`/`prototype`/`__proto__`; producer attribution is explicit, never inferred; a receipt describes the original operation, not current ownership/approval.

**Gotchas.** `conforms` recursion on hostile input is bounded by the schema walk — fuzz C1: 8k-deep nesting, circular refs, 100k-item arrays, `__proto__` payloads all return booleans without hangs or pollution. `confirmsAgentCommand`'s `receipt.sequence > 0` is load-bearing; the `>= 0` mutant is killed (M11).

## reply-actions.mjs / help-actions.mjs — sibling verb families

**Purpose.** Same architecture as work-actions for reply-request verbs (`room_respond_to_request`, …) and help-offer verbs (`room_offer_help`, `room_select_help_offer`, …). Each family has its own `definitions` table, `valid*Arguments`, `build*Command`, `recorded*Action`, and `*Refusal`.

**Invariants.** Reply commands route via `replyRoute(name)`; help-offer release requires `externalActivityUnverified: true` (explicit acknowledgement that release never stops a runtime). Help text fields cap at 600 chars.

## begin-work.mjs — the next verified operation

**Purpose.** `planBegin(item, member, {scope, now})` computes the single next verified room operation (accept → claim → start) or a stop reason (`not_accountable`, `permission`, `exact_scope_required`, `scope_mismatch`, `ready`, `nothing_to_begin`). `beginSelectedWork()` executes up to 4 stages, re-reading current work between stages; `beginRequestId()` derives stable ids (`begin-<sha256(workItemId,action,revision,scope)>`) so unchanged retries match.

**Invariants.** `working` follows room work state only — never inferred from a disconnected call, unknown write, or scope mismatch (`invented: false` everywhere). An invocation id that doesn't match the planned stage is only executed if the exact claim or its recorded receipt already landed (`claimLanded` / `beginReceipt` with idempotency-key check). A later revision is not proof of an accept.

**Gotchas.** `findBeginReceipt` pages ≤100; a missing receipt is null, not a guessed revision. `sameExactScope` compares ordered path arrays — reordered identical paths are a mismatch (deliberate: exactness over convenience).

## work-preparation.mjs — bounded read composition

**Purpose.** `prepareWork(client, workItemId, {includeSource, includeOffers, discussionSince, signal})`: work context + ≤4 discussion pages (25 items each, cursor-advance enforced) + fresh context read; reports `changedDuringRead` and `eventsAfterDiscussion`.

**Invariants.** No writes, no acks, no dispatch. `discussionSince` must be a non-negative safe integer from a completed read; numeric checkpoints are not recovery-safe (discard after suspected history recovery).

## assignment-watcher.mjs — snapshot observer

**Purpose.** `AssignmentWatcher.reconcile()` validates a room snapshot (member binding, sequence anchors via `client.changes`, charter context) and reconciles attention/request notices into the `WatchJournal`. `attentionNotices` (v1), `contextNotices` (v2, + charter instructions), `requestContextNotices` (v3, + reply requests).

**Invariants.** Snapshot observer, not event replay: state is authoritative as of each snapshot; intermediate changes may be quiet. History is anchored: event 1 must be `ROOM_CREATED`; the snapshot's last event id must match the anchored event at its sequence, else `history_changed`. `tick()` re-reconciles before each bounded drain (≤20) and re-authenticates.

## trust-tools.mjs — trust annotation verbs

**Purpose.** `trustTools` / `validTrustToolArguments`: the content-trust annotation surface (marking board/work listings per `CONTENT_TRUST`). Validators follow the same boolean-on-hostile-input contract (fuzz C4).
