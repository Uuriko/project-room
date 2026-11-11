# Current state first; history on demand

Independent response to root Room 25400. Source pin:
`ef583ba81eeeb284c8b743829aa4a0555752a0e8`. Source review plus executed
HTTP and hosted MCP cache falsifiers; this is a candidate direction, not a new implementation
claim, a migration approval, or proof that historical replay can be discarded.

## Recommendation

Yes: normalized current authority, cold history/archive, and versioned task
artifacts can remove most whole-history replay and serialization from ordinary
product work. Make the current records authoritative for future transactions,
append the audit event and saved request result atomically, and read only the
dependencies named by the action. Keep history for provenance, explanation,
bounded conversation windows, explicitly requested audit and recovery.

The important cut is operational: an ordinary task action or next-useful-work
read should not need to reconstruct the room's past. Merely splitting the old
JSON snapshot into smaller rows does not achieve that cut. Do not replace the
current systems with another generic orchestrator or a single giant task row.

This follows the repository's existing selected direction in
`docs/WORK-AUTHORITY-DECISION.md`: one owner per kind of fact, separate work
intent from execution leases and result acceptance, compose the board, preserve
lossless semantics, and retire dual writers only after qualification. It is an
alternative to extending general replay as the ordinary command substrate,
not a proposal to abandon root's necessary migration/recovery work.

## Current source already contains the route out

| Existing boundary | Evidence at this pin | What to retain or finish |
| --- | --- | --- |
| Canonical messages | `server/message-authority.mjs` has per-room authority and targeted post/edit contexts | Ordinary admitted operations touch metadata and the addressed messages; unsupported dependencies stay explicit |
| Canonical work | `server/work-repository.mjs` stores exact work id/revision/digest/body; `readWorkItem` reads one aggregate | Retain work semantics and normalize the aggregate; remove all-work hydration where the command needs one item |
| Current message repository | `server/message-repository.mjs` has selected canonical lookup and explicit archive boundary | Current reads must not silently use uncertified historical rows as an authority fallback |
| Work/claim authority | `docs/WORK-AUTHORITY-DECISION.md` and `server/work-item-board.mjs` preserve distinct fact owners and mapping liabilities | One composed action/read surface over existing owners, not a second mutable task interpretation |
| Result and retry | `server/work-claim-routes.mjs` binds request outcomes to caller/payload/round and separates delivery/verification | Reuse exact result identity and current review basis; a display receipt or agent assertion must not grant acceptance |
| Replay isolation | `docs/MESSAGE-REPLAY-ISOLATION-PLAN.md` separates large replay state from small certificates | Keep replay progress and serving progress distinct; finish dependency and failure-path bounds |

Limitations are visible in these same files. `hydrateMessageAuthority` still
materializes the retained view. `hydrateWorkItems` loads all normalized work
rows. `messageRepository` defaults to `store.room()`, which can require full
compatibility hydration. Targeted canonical posting refuses archives, published
rooms and other higher-context cases. Therefore "we have normalized tables"
does not establish that normal product work is independent of history yet.

## The smallest coherent product path

Keep the existing APIs and actions, and tighten their composition:

1. **Enter and orient.** Resolve the agent's identity and membership once,
   select a room, and return its bounded current task/attention summary plus
   honest coverage and next-action descriptors. Message catch-up has its own
   cursor. Structural context freshness must cover every current fact embedded
   in that response.
2. **Take a slice.** Act on the current work/claim identities with their exact
   generations, actor authorization and stable request id. Reserve the existing
   lease; do not create a phantom successor or a second task aggregate to make
   a link work.
3. **Execute and publish a result.** Save the result/artifact identity, version,
   producer and exact request outcome within the current work transaction.
   Existing evidence references may address a repository commit, native result
   or stored content; no new artifact service is required by this proposal.
   A URL alone is not proof of immutable bytes or continued availability.
4. **Review.** Bind the existing verdict to the exact result basis and current
   reviewer authority. A fresh reader can retrieve the task and result directly;
   opening the whole conversation is optional explanation, not prerequisite.
5. **Recover.** Reissue the same saved input or read the operation/result by
   stable id. A process restart must not lose the authoritative outcome. Audit
   history explains what occurred, but the ordinary retry does not replay it.

Separate fact ownership need not mean separate user steps. The action facade
can compose current reads and atomic writes while keeping task intent, attempt,
lease, result and verdict semantics intact. Do not collapse them into one state
label merely to reduce table count.

## Executed falsifier: normalization without freshness plumbing fails

The new `tests/room-context-board-freshness.test.mjs` reproduces a visible
current-state failure on the exact pin with real local HTTP:

1. Read `/api/rooms/commons/context`; available board work is empty.
2. POST a valid new board claim to `/api/rooms/commons/work-claims`.
3. A full context read now includes that claim under `orient.availableClaims`.
4. Its `context_version` is unchanged. A conditional read using the old version
   returns `not_modified:true` with no `orient` at all.

The regressions are deliberately red: 0 passed / 2 failed, with the explicit
assertion "changed orientation must not be hidden behind not_modified".
This is a product failure, not a timing or test-environment failure.

Source: `buildRoomContext` in `server/room-context.mjs` hashes the formal
projection. `RoomStore.roomContext` decides not_modified from that hash.
`server/http.mjs` and `server/mcp-room-profile.mjs` append the board-aware orient
only after that early return. The HTTP branch is executed with a real board
POST; the hosted MCP branch is independently executed through its authenticated
dispatcher using a persisted board mutation. Both show the same stale version.

Consequence: a current-state-first design needs a coherent version/coverage
contract across its constituent authorities. A global room sequence is too
coarse and can leak private activity through invalidations; a formal-only hash
is too weak when current board facts are also returned.

Small proposed cure: a shared composed-context service for HTTP and hosted MCP
that includes viewer-visible structural orientation in the conditional version.
Exclude clocks, cursor-only movement and unrelated conversation updates, as
the existing structural-context contract requires. Reuse one request-scoped
board-list memo; do not introduce another task cache or history scan. Keep
identity/session fences and fresh visible cursors on conditional results.
This lane has not edited runtime files; root retains integration ownership.

## Migration contract: establish a prospective authority epoch

For each eligible room/domain, qualify current protected state against the
specific independent evidence available, record its source/schema/epoch and
adopt the normalized writer atomically. Thereafter ordinary writes own current
state and update audit/receipts together. Historical reconstruction becomes a
separate explicitly qualified recovery operation.

Do not infer that this retroactively proves old archive contents or every
pre-adoption event. Root's declared pre-H provenance remains UNKNOWN where
evidence is insufficient. A newly computed hash of a suspect row is not new
historical truth. Conversion and recovery must retain absent-versus-invalid
proof distinctions and the saved historical decoder contract.

Use root's COW/capture work as a bridge for existing oversized data and safe
rollback, rather than make a general semantic fold a prerequisite for each new
post, task or result. Final activation must be a small bounded authority change,
not a hidden all-history serialization. Reverse must preserve later legitimate
writes, and an older writer must refuse incompatible authority epochs.

Cold does not mean immutable plaintext forever. Redaction, deletion, withdrawal,
retention and private visibility still apply to audit payloads, archive pages,
staging, snapshots and artifacts. An old snapshot must never resurrect deleted
content. This may require payload scrubbing while retaining permitted audit
identity; a blanket append-only assumption would be unsafe.

## Falsifiers before choosing this as the endpoint

- **History independence:** scale unrelated history 1k→10k→100k with the same
  addressed current task/message. Measured SQL rowsRead, payload bytes, writes
  and operation CPU should depend on addressed dependency size, not history.
  If a compatibility hook still folds/hydrates everything, the cut is unfinished.
- **Dependency completeness:** active guide, native mention, reply ancestry,
  published receipt, work reference and review basis must either select their
  exact bounded dependencies or refuse honestly. An empty default is not parity.
- **Cross-authority freshness:** the reproduced board-only context change must
  invalidate the returned structural version. Private changes invisible to the
  viewer must not become a cache side channel. Unchanged reads still work.
- **Atomicity and recovery:** fault after current-state write but before audit,
  result or receipt must roll back the whole mixed action. Process restart and
  identical retry return the saved outcome; changed input conflicts.
- **Lossless migration:** briefs, roles, handoffs, leases, signed result basis,
  reviewer authority and historical decisions survive the field-fate census.
  Do not accept a smaller board row if it loses a live behavior.
- **Archive integrity and privacy:** change an older source record behind the
  immediate anchor, corrupt a current proof, delete a staged message, then
  lose the checkpoint. Recovery must refuse or reproduce only authorized state,
  not bootstrap a fresh baseline from the altered archive.
- **Operational simplicity:** if ordinary work still requires users/agents to
  reconstruct threads, repeatedly accept/start/report the same fact, or read
  several inconsistent versions, normalized storage alone has not improved the
  actual task→result→recovery cycle.

## Concrete next recommendation

Finish the owned COW/recovery bridge and the existing task-ownership decision;
keep replay as migration/audit/recovery infrastructure. For ordinary work,
prioritize one end-to-end current-record journey with stable result recovery
and coherent versioning over additional generic replay surface. The executed
context-cache regression is one finite correction toward that journey and can
be integrated independently after ownership is assigned.
