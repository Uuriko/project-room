# Sharded boards x event budgets: interaction notes (WAVE-500 W15)

Status: notes. No code changes. Companion to the sharded claim boards
design (`refs/heads/wave300/sharded-claim-boards`:
`docs/WORK-CLAIM-BOARDS.md`) and the event-budget design (W7, this tree:
`docs/wave500/EVENT-BUDGET-DESIGN.md`).

Line refs prefixed `shard:` are on `refs/heads/wave300/sharded-claim-boards`;
refs prefixed `w7:` are on this branch (`wave500/event-survival`), pointing
into `docs/wave500/EVENT-BUDGET-DESIGN.md`.

## 1. How sharding namespaces boards

**Namespace key format.** A namespace is a string matching
`^[A-Za-z0-9_-]{1,64}$` — `shard: server/work-claims.mjs:293`
(`NAMESPACE_PATTERN`), with `namespaceOf(value)` at
`shard: server/work-claims.mjs:294-300` and `isNamespace` at `:301`.
Invalid values are rejected (throw `invalid_claim_input`), never
sanitized: `namespaceOf` does no case folding, trimming, or other
normalization. `Guild` and `guild` are therefore **distinct** boards —
the key is the exact string.

**Default namespace.** `shard: server/work-claims.mjs:292`:
`DEFAULT_NAMESPACE = "default"`. `namespaceOf` maps `undefined`/`null`
to `"default"`, so every claim created before sharding — and every write
that omits `namespace` — reads as `default`. The doc's migration section
(`shard: docs/WORK-CLAIM-BOARDS.md`, "Migration") makes the contract
explicit: "the `default` board behaves exactly like the old single board
(same cap, same routes, same refusals)." The tip commit
(`shard: fca3240731`, "keep pre-shard config shape when no boards
configured") reinforces backward compatibility when no boards are
configured.

**Claim rows carry the namespace.** Normalization happens on both the
create path (`shard: server/work-claims.mjs:557, :588`,
`createWork({ ..., namespace })`) and the read path (`:453`,
`namespace: namespaceOf(value.namespace)` in the item normalizer). A
claim's namespace is set at creation and never moved afterward —
"carries its namespace for life" (`shard: docs/WORK-CLAIM-BOARDS.md`,
"Namespaces"). Claim ids stay room-unique across namespaces, so the
global view, provenance walks, and `dependsOn` references are
unambiguous; a dependency may point at a claim on another board.

**The global view.** `?namespace=*` on `GET .../work-claims` returns a
read-merge: every board's claims concatenated, newest-first, each item
stamped with its `namespace` (`shard: server/work-claim-routes.mjs:717-725`
query parsing, `:842-848` the merge). The doc is explicit: "The merge is
read-only; it enforces no cap and takes no writes." `?namespace=` absent
means the default board, so un-namespaced clients see the default board
exactly as today. `GET .../work-claim-boards` (`:855-863`) lists every
namespace holding claims plus the default board, with per-board
`{ namespace, open, total, cap }`.

**Caps (the precedent for per-namespace quotas).** Each board has an
independent open-claim cap (default 200, same as the old single board;
`shard: server/work-claims.mjs:537-538` `boardCapFor`), owner-set via
`POST /api/rooms/{roomId}/work-claims/config`
`{ "boards": { "guild-load": { "maxOpenClaims": 100 } } }`
(`shard: server/work-claims.mjs:505-512` config validation reuses the
namespace regex at `:512`). The per-member cap (default 20) deliberately
counts **across all boards**, room-wide — the one precedent for a
dimension that is *not* sharded.

## 2. Is the shard key available at event-emit time?

Yes — and traceable from the claim row, not the request. One emit path,
the close flow:

1. `POST /api/rooms/{roomId}/work-claims/{claimId}/close` lands in
   `closeWorkClaim` (`shard: server/work-claim-routes.mjs:525`).
2. The item is loaded from the registry by id:
   `const item = registry.get(roomId, claimId)` (`:548`). That item
   already carries its authoritative `namespace` (normalized at create,
   `shard: server/work-claims.mjs:588`; or on read, `:453`). The claim-scoped
   routes accept an optional `?namespace=` for lookup (`:815-819`), but
   the namespace the budget would charge is the one on the *item* —
   request-controlled input cannot pick a different namespace to pay.
3. The budget gate runs at `:541`
   (`assertBoardEventBudget(access.authority?.sequence, ...)` — the W7
   analogue `assertNamespaceEventBudget(sequence, namespace, ...)`
   would sit exactly here, with `namespace` = `item.namespace`).
4. The write commits: `registry.set(roomId, closed)` (`:549`).
5. The event is emitted: `emitWorkClaimEvent(store, roomId, {
   actorId: current.member.id, item: closed, action: "closed", ... })`
   (`:551-552`), implemented in
   `shard: server/work-claim-events.mjs:166`.

**The gap:** `item.namespace` is available *in-process* at the emit call,
but it is dropped from the event payload. `workClaimEventData(item,
action, ...)` (`shard: server/work-claim-events.mjs:28-51`) stamps
`workClaim`, `action`, `claimState`, `ownerId`, `title`, `paths`, and
optionals — **no `namespace` key**. So a consumer replaying the event
log (telemetry, projections, a budget meter) cannot attribute the event
to its namespace without joining back to the claim registry. Same
pattern at the other emit call sites (`:601` link PR, `:752`, `:791`
receipt flows): they all pass `item`, so the same availability and the
same drop-off apply.

For the create path (`:955-964`), the namespace is additionally visible
in the request body (`raw.namespace` -> `boardNs`), resolved through
`isNamespace`/`namespaceOf` before the item exists.

## 3. Recommendation: budget dimension = shard namespace

**Yes — T1 budgets should key on the board namespace.** The argument:

1. **It is already the isolation boundary.** Namespaces own independent
   boards, independent open-claim caps, and owner-configured caps
   (`shard: docs/WORK-CLAIM-BOARDS.md`, "Caps"). W7's stated goal —
   "a namespace's runaway must be containable inside that namespace"
   (w7: "Problem") — is only meaningful if the budget boundary and the
   board boundary are the same line. Keying budgets on anything coarser
   (room) or finer (claim, member) reintroduces either the starvation
   bug or non-composable quotas that W7 already rejects (w7: §1, T2
   "per-agent hard lifetime quota (rejected)").
2. **The key is available at every choke point.** W7's new enforcement
   (`assertNamespaceEventBudget`) sits at the existing
   `requireEventBudget` call sites in `work-claim-routes.mjs` (w7: §3,
   table). Per §2 above, `item.namespace` is in scope at all of them —
   no new plumbing, no new request-context field.
3. **It is server-authoritative.** `namespaceOf` validates and defaults;
   ids are room-unique. A client cannot spoof which namespace pays for
   its write, because the charge follows the item, not the query param.
4. **Config surface already exists.** `POST .../work-claims/config`
   already maps namespaces to `{ maxOpenClaims }` with the same regex
   (shard: `server/work-claims.mjs:512`). W7's proposed `eventBudgets`
   section (w7: §6 config sketch) extending that same route is the
   natural home — one owner-only surface for caps *and* budgets.
5. **Consistency with W7's three-tier design.** T0 (room, 1M, unchanged)
   bounds the sum; T1 (namespace) is this dimension exactly; T2 (lane
   velocity, per `(namespace, lane)`) nests inside it. W7's migration
   (w7: §6) reuses the board-namespace regex, the `default` fallback,
   and spent-since-enable counters. Nothing in W7 conflicts with the
   sharded design — the two docs were written to mate.

**What breaks / what to handle:**

- **Rename.** There is no rename: "A claim carries its namespace for
  life" (shard doc). A "rename" today is abandon-old + create-new.
  With W7's spent-since-enable counters, the abandoned namespace keeps
  its (now unusable) spend record and the new namespace starts at zero
  — honest (the events really were spent under the old name), but it
  means renames mint fresh budget. This is acceptable only if rename
  stays permanently out of scope; if it ever lands, counters need
  carry-over semantics. (ASK-2 below.)
- **The global/default view's events.** Two sub-cases:
  - `?namespace=*` is **read-only** — it emits no events, so it costs
    no budget. No fan-out accounting is needed *unless* a
    write-to-all-boards feature ever lands (ASK-7).
  - `"default"` is both a real namespace and the fallback for every
    un-namespaced write. **All legacy clients concentrate on
    `default`.** W7 §6 handles enablement by allocating `default` the
    full non-reserve budget; the moment the owner carves floors for
    named namespaces, `default` is the crowded one, and its exhaustion
    409s legacy clients first. That is the correct isolation shape,
    but owners must be told: `default` is the busiest namespace in
    every room, and carving floors for guilds implicitly shrinks the
    legacy share. Consider showing per-namespace spend in the
    `eventsRemaining` response (w7: §3 cites
    `work-claim-routes.mjs:804`) so this is visible before the first
    409.
- **Case sensitivity.** No normalization anywhere in the sharded
  design: `Guild` ≠ `guild`, distinct boards, distinct budgets. Budget
  keying must use the exact string too — any lowercase fold in the
  budget layer would charge the wrong board's floor. (ASK-3: confirm
  this is intended, not a footgun.)
- **Non-board events have no namespace.** The budget dimension covers
  board writes cleanly. Chat, member lifecycle, work items, and system
  events are not board-attached. W7 §3.2 proposes attributing chat to
  the sender's home namespace — but the sharded design has no member
  home-namespace field (only `squadId` on claims). Until that exists,
  these events either fall to `default` (quietly concentrating spend
  there) or need explicit attribution rules. (ASK-4.)
- **T2 lane identity is unconnected to the sharded design.** W7 keys
  velocity per `(namespace, lane)` with an explicit lane label from
  join/enrollment. The sharded branch has `squadId` on claims
  (shard: `server/work-claims.mjs:449, :588`) but no member-level lane
  concept. Whether lane ≈ squad, or lanes need a new member label, is
  undecided — and note the precedent cut the other way: the
  per-member cap counts across all boards room-wide, so one could argue
  T2 could be room-wide too. W7's choice (per-namespace) is the
  consistent one; it just needs the lane identity story closed.
  (ASK-6.)

## 4. Open questions for the sharded-boards lane (ASK items)

- **ASK-1 — stamp `namespace` into `WORK_CLAIM_UPDATED` events.**
  `workClaimEventData` (`shard: server/work-claim-events.mjs:28`)
  drops the namespace the item carries. Should the event payload
  include it (e.g. `data.namespace = item.namespace ?? "default"`),
  so replay/projection/telemetry and any future budget meter can
  attribute spend without joining back to the claim registry? The
  openapi schema already documents `namespace` on the claim item
  (shard: `docs/openapi.yaml` diff, tip commit); the event would match.
- **ASK-2 — namespace rename/merge, permanently out of scope?**
  Budgets keyed on namespace assume immutability. If a rename/merge
  feature ever lands, how should spent-since-enable counters move —
  carry-over to the new name, or zero-out? Either answer is fine;
  ambiguity is not.
- **ASK-3 — case sensitivity intentional?** `Guild` vs `guild` are
  distinct boards with distinct budgets under the current regex. If
  that is a footgun, it must be fixed in `namespaceOf` (shard:
  `server/work-claims.mjs:294`), not worked around in the budget
  layer — the budget dimension must never normalize differently than
  board routing.
- **ASK-4 — member home namespace.** W7's chat attribution needs a
  per-member home namespace (w7: §3.2, open question). Does the
  namespace model want that concept at member level, or should chat
  attribute some other way (explicit param per message, most-used
  namespace, `default`)? Board writes are covered by the item; chat is
  not.
- **ASK-5 — config coupling.** Should `boards` entries in
  `POST .../work-claims/config` auto-seed `eventBudgets` entries (same
  namespace keys, owner-set in one place), or should the two sections
  stay decoupled (boards can exist without budgets and vice versa)?
  W7 proposes one route, two sections; confirm the sharded lane is
  happy sharing the surface.
- **ASK-6 — lane identity vs `squadId`.** Claims carry `squadId`
  (plan-squads). Is the W7 "lane" label the same thing, or a separate
  member-level label set at join? Where is it stored, and who sets it?
- **ASK-7 — `?namespace=*` stays read-only forever?** Confirm no
  planned write-to-all-boards fan-out; if one ever appears, budget
  semantics need deciding (charge each namespace? once? reject under
  budgets?).

## References

- `shard: docs/WORK-CLAIM-BOARDS.md` (namespace model)
- `shard: server/work-claims.mjs:292-301` (DEFAULT_NAMESPACE,
  NAMESPACE_PATTERN, namespaceOf, isNamespace), `:505-538` (config
  `boards` + boardCapFor), `:557, :588` (create path), `:453` (read
  normalization)
- `shard: server/work-claim-routes.mjs:717-732` (query parsing),
  `:842-848` (read-merge), `:855-863` (boards listing), `:525-552`
  (close: budget site, emit call)
- `shard: server/work-claim-events.mjs:28-51` (event payload —
  namespace dropped), `:166` (emitWorkClaimEvent)
- `w7: docs/wave500/EVENT-BUDGET-DESIGN.md` §§1–6 (three tiers,
  allocation, enforcement, starvation, `?fast=1`, migration)
