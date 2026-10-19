# QA wave seed packs

Deterministic starting worlds for the QA wave's journey seats, built
entirely through the application's own write paths (HTTP doors, store
commands, escrow, work claims, public work) against a hand-advanced seed
clock. Nothing in any pack is copied from production data; the corrupt
pack's shapes are synthetic reproductions of documented failure
signatures.

## Build

```sh
npm run qa:seeds -- --out <dir>            # all four packs
node scripts/qa-seeds/build-seed-packs.mjs --out <dir> [--pack clean|grown|corrupt|adversarial] [--force]
```

Each pack lands in `<dir>/<pack>/`:

- `room.sqlite` — the pack's store file.
- `manifest.json` — what the builder **measured** in the finished pack:
  identities by role, rooms by key, contents, invariants, and the QA
  seats that consume it. Contents are measured through the app's own
  surfaces, never asserted from the build script's intentions.
- `credentials.json` — identity secrets for the pack's roles (mode 0600).

Content (titles, counts, amounts, timestamps) is a deterministic function
of the pack definition; minted identity ids/secrets are random by nature
and are recorded in the manifest / credentials file. A failed build
removes its partial pack directory. `--bulk-target <bytes>` shrinks the
grown/adversarial bulk fills for smoke builds — shipped packs always use
the builders' default targets, and the manifest records measured bytes
either way.

## Load

Packs are build artifacts, never mutated in place. To use one, clone the
pack directory and boot a server on the clone:

```js
import { RoomStore } from "../../server/store.mjs";
// copy <pack>/ to a scratch dir first, then:
const store = new RoomStore(join(cloneDir, "room.sqlite"), { /* clock */ });
```

The corrupt pack is the one exception to default boot options: its store
must be opened with `{ integrity: "deferred" }`. At the build head an
eager open throws on the torn rooms (chaos finding 2); that behaviour is
recorded in the corrupt manifest, not worked around.

## The packs

| Pack | Contents | Consumed by |
| --- | --- | --- |
| `clean` | One fresh room, four role identities (owner / poster / worker / verifier), genesis endowment of 100 credits each, only the room's starter claim. | QA-J1, QA-J2, QA-J3, QA-X1, QA-C1 |
| `grown` | A ~2,200-claim board in production-census proportions (every lifecycle state, sweep-closed and lease-expired rows included), an escrow room with settled / disputed / refunded history and a published public-receipt surface, and an archive room bulk-filled to just under the app's 4 MiB projection guard. | QA-J5, QA-J6, QA-X1, QA-X2, QA-A1 |
| `corrupt` | Five rooms: a healthy control, two torn projections (with and without the archive marker — patrol parks them under different error classes), and two hollow projections that parse but silently drop journaled messages. Journals intact everywhere. | QA-J6, patrol/integrity verification |
| `adversarial` | A wash ring of mutually-paid bounties, a dispute ladder resting in three outcomes, the three keeper-blind census rows from #4138, a delivered claim whose lease died before review, a dangling-evidence skill card, an arena projection just under the app's 4 MiB projection guard, and a room at the 100-offer lifetime cap with the 101st attempt's refusal recorded. | QA-J4, QA-H1, QA-H2 |

## Notes for lane authors

- **Flood-guard pacing.** Message posts spend tokens from the room flood
  guard (burst 30 per room+member, refill 1 per 2 s, on the store
  clock). Bulk fills use `postBulkMessage` in `lib/common.mjs`, which
  advances the seed clock past the retry window and retries the same
  message id; a refusal spends no token and never lands, so pacing is
  exact — no real-time sleeps anywhere in a build.
- **Version coupling.** Builders pin to app APIs at the manifest's
  `builtWithAppSha`. After any overhaul of the work-record/message
  surfaces lands (e.g. PR #4114), re-run `tests/qa-seed-packs.test.js`
  and rebuild the packs before the QA wave consumes them; several pack
  shapes (corrupt projections, keeper-blind census rows) are deliberately
  coupled to current internals.
- **Smoke tests.** `tests/qa-seed-packs.test.js` builds every pack into
  a temp dir (reduced bulk targets), boots a server per pack, and checks
  the manifest's measured contents against fresh live reads.
