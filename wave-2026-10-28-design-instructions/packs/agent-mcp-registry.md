# Instruction Pack — MCP Registry listing (`server.json` republication, PR #3647)

Slug: `agent-mcp-registry`. This pack commissions **no new build**. It instructs
(a) the landing of the already-bound PR #3647, (b) the content-quality rules
that govern every future edit to the listing, (c) the version discipline that
keeps republication possible, and (d) the post-publish verification that
closes the piece. Do not re-author, rebase, or "improve" #3647.

## 1. The piece

**What it is.** Project Room's listing on the official MCP Registry
(`registry.modelcontextprotocol.io`) as `io.github.Uuriko/project-room`. The
listing is not maintained on the registry site. It is published from this
repo: the manifest `server.json` at the repo root is the listing, and CI
publishes it. Whoever edits `server.json` edits the public listing; there is
no other copy to update (downstream directories ingest this one — §3).

**Where it lives (verified at main `aaa749065a6451321a949ddcb923f3174504fe35`,
read via `gh api …/contents/<path>?ref=<sha>` on 2026-10-28):**

| Surface | Path / endpoint | What it does |
|---|---|---|
| Manifest | `server.json` (repo root) | `$schema` `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`; `name` `io.github.Uuriko/project-room`; `title` `Project Room`; `description` (≤100 chars, see §2); `version`; `websiteUrl` `https://room.trydemigod.com`; `repository` github `Uuriko/project-room`; one icon `https://room.trydemigod.com/icon.svg` (`image/svg+xml`, `sizes:["any"]`); one remote, `streamable-http` at `https://room.trydemigod.com/mcp`, with an optional, secret `Authorization` header (`Bearer <room identity secret or connection token>`; without it, public join and public-work tools) |
| Publish workflow | `.github/workflows/mcp-registry-publish.yml` | On a push to `main` that changes `server.json` (decided by diffing the push's exact before/after trees, not `HEAD^`), on a `v*` tag, or on `workflow_dispatch`: validates with `node scripts/server-json-check.mjs --against-registry`, installs pinned `mcp-publisher` **v1.8.1** with sha256 verified against the release checksums file, runs `mcp-publisher login github-oidc` (keyless; `id-token: write`, no registry secret, no token), then `mcp-publisher publish`. Concurrency group per ref, `cancel-in-progress: false` |
| Offline + bump check | `scripts/server-json-check.mjs` | Exports `DESCRIPTION_MAX = 100`, `CANONICAL_ORIGIN = https://room.trydemigod.com`, `NAMESPACE_PREFIX = io.github.Uuriko/`; enforces required fields, namespace, description length, strict semver, canonical remote origin; `--against-registry` additionally requires `version` **greater than** the registry's latest, read from `https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Uuriko%2Fproject-room/versions` |
| Pinning tests | `tests/mcp-registry-server-json.test.js`, `tests/server-json-check.test.js` | Pin the exact current `version` in two places, plus the version-increase fixture's stubbed registry latest (three pins in total — §4, Step F2). Neighbour suites: `tests/mcp-registry-publish.test.js`, `tests/listing-check.test.js` |
| Listings doc + weekly check | `docs/LISTINGS.md` §"Official registry publish"; `scripts/listings.json` row `mcp-registry`; `scripts/listing-check.mjs` (`classifyRegistry`); `.github/workflows/listing-check.yml` (Mondays 14:00 UTC + manual) | `LISTINGS.md`: "The registry one-liner is the `description` field in `server.json`. The weekly check reads that field." `classifyRegistry` reports `listed` only when the registry latest's **version and description both equal** `server.json`'s; otherwise `stale` |
| README link (arrives with #3647) | `README.md`, "Connect your agent" section | Names the official MCP Registry listing as `io.github.Uuriko/project-room` next to the hosted endpoint. Absent at main `aaa749065a` |

**The bound PR.** #3647, "Discovery metadata: MCP Registry description names
the work loop (server.json 1.1.1) + README registry link", branch
`jill/exp1-discovery-metadata`, head `bf2ba43b3f83d7ce6baed2ee160c8d2daf4e2547`,
4 files, +8/−5 (diff re-read fresh for this pack):

- `server.json`: `version` 1.1.0 → **1.1.1**; `description` →
  `People and AI agents, one room: claim tasks, hand off work, prove what shipped with public receipts.`
  (exactly **100 characters** — the schema cap, counted for this pack).
- `tests/mcp-registry-server-json.test.js` + `tests/server-json-check.test.js`:
  the three version pins move with the bump (shipped version ×2, fixture
  stub → 1.1.1).
- `README.md`: +3 lines, the registry link above.

**Trees named.** Source above is main `aaa749065a`. The publish target is
whatever main becomes when #3647 merges (a merge-up at landing is the seat's
act, §4 Step 1). Production build `ca37fee4` is not the publish source; it
matters only as the live origin the remote and icon point at (icon probed
fresh for this pack: `GET https://room.trydemigod.com/icon.svg` → 200,
`image/svg+xml`).

## 2. Current state

**The listing is stale by exactly one release, and only the seat can unstick
it.** Executed evidence:

- **Fresh, this pack (2026-10-28):** `gh pr view 3647` → `OPEN`,
  non-draft, label `ready-to-land` present, `mergeable: MERGEABLE`,
  `mergeStateStatus: BLOCKED`, head unchanged at
  `bf2ba43b3f83d7ce6baed2ee160c8d2daf4e2547`. Status rollup: `test`,
  `browser`, `cloudflare`, `unit`, `contract`, `visual-refresh-guard`,
  `lint`, `gates`, `mechanical`, `schema-gate`, `changes` all `SUCCESS`;
  `coverage`, `quarantined-tests`, `full`, browser-shard template `SKIPPED`
  (the designed `ready-to-land` label-gate residue, not failures); Cursor
  approver `NEUTRAL`. Bindings file
  (`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`):
  #3647 is **bound at `bf2ba43b…`**, record `1d4b567d`, noted SETTLED-GREEN
  (settle pass 19, composed head, run 40578289289 SUCCESS).
- **Fresh, this pack (2026-10-28):** live registry reads —
  `GET https://registry.modelcontextprotocol.io/v0/servers?search=project-room`
  and `GET …/v0.1/servers/io.github.Uuriko%2Fproject-room/versions` — both
  return two versions: 1.0.0 (`isLatest: false`, published 2026-09-24) and
  **1.1.0 (`isLatest: true`, published 2026-10-04)** with the old
  99-character description `Your team's coding agents from any vendor claim work, hand off and prove what shipped, in one room.`
  That is byte-identical to `server.json` at main `aaa749065a`: repo and
  registry agree, both are one release behind #3647.
- **Keep-going Cluster E (executed 2026-10-27):**
  `~/workspace/wave-2026-10-27-keep-going/lanes/E/E1.md` (API state of #3647,
  registry read), `E2.md` (on-branch cure assessment: **no failing check, no
  manifest error, no missing label, no review requirement — no cure exists
  or is needed**; behind-main is not blocking and a fixer merge-up "would
  only void its green head"), `E-SUMMARY.md` Workstream 1, and
  `SYNTHESIS.md` §Cluster E. Verdict, verbatim in substance: the **sole
  block** is the required status check `room/release-lease` standing
  `pending` — the landing seat mints it via the reviewed #4115 coordinator
  from John's Mac. It is not a defect in the PR, not John's personal act,
  not a registry-side act, and it must never be forged or simulated.
- **Discoverability limit (do not let 1.1.1 oversell itself):** the registry's
  own search matches **name tokens only** (#3647 PR body, EXP-1 baseline
  2026-10-15: `search=collaboration` returns only a server *named*
  collaboration; `search="project room"` returns zero). Cluster E `E7.md`
  finding 8 (EXP-1 probe 2026-10-26): the listing is found only on the
  owner-name query (`uuriko`, position 1); `project room`, `tasks`,
  `receipt`, `workspace`, `collaboration` all return 0 presence. The new
  description therefore improves what a **reader or an ingesting directory**
  (Glama, PulseMCP — `docs/LISTINGS.md` directory table) sees; it does not
  and cannot improve registry search rank. The `name` is fixed by the
  `io.github.Uuriko/*` OIDC namespace and is not a content lever.
- **Not part of this piece:** `package.json`'s stale prototype-era
  description at main `aaa749065a` and the `docs/LISTINGS.md` EvoMap row are
  Cluster E finding 5/6 (`E7.md`), already carried by PR #5118 — do not fold
  them into a registry bump. `package.json`'s `version` (0.1.0) is
  **unrelated** to the registry version; never conflate them (§4, Step F3).

Nothing else is broken. No code defect, no workflow defect, no registry
account step is outstanding. Anything beyond the above is UNVERIFIED.

## 3. What fantastic means

The end state, all simultaneously true:

1. **Published:** the registry's `isLatest` row for
   `io.github.Uuriko/project-room` is version **1.1.1** with the exact
   100-character description in §1, `status: active`, `publishedAt` after
   #3647's merge timestamp; 1.1.0 and 1.0.0 remain in the version history
   with `isLatest: false` (history is expected, not staleness).
2. **Zero manual publish steps, zero secrets:** republication happened in
   **one** `mcp-registry-publish` run on the merge push, OIDC only. From
   merge to a confirming registry read: one verification pass, completable
   in under 15 minutes of fleet work once the publish run finishes.
3. **Two agreeing reads:** the search endpoint and the versions endpoint
   (§5) return the same latest version + description, **and** the
   `mcp-registry` row of `listing-check` classifies `listed` — the
   repo's own definition (version *and* description equal `server.json`).
4. **Content at the cap, spent on the loop:** the description uses
   100/100 characters and names, in order, who shares the room
   (people + AI agents), the work loop a searching agent is looking for
   (claim tasks, hand off work), and the differentiator (prove what
   shipped, public receipts). Every word is a factual claim about the
   deployed product — rooms, claimable tasks, and public receipt pages
   are live; it claims no paid/cash work and no OAuth (the header text
   stays truthful: auth optional, public tools without it).
   The long-form exemplar to stay consistent with is the repo's own
   GitHub description (Cluster E `E7.md` finding 7, verified accurate):
   the same loop at full length. `server.json` is its 100-char compression;
   the two must never contradict.
5. **Future releases are boring:** any later listing change ships as a
   small PR (manifest + the three pins, ~4 files like #3647) that any
   implementer can produce from §4 Step F alone, and no published version
   is ever reused, edited in place, or republished (§4, Step F3) — the
   registry's greater-than gate makes a reuse a hard failure, not a
   warning.

## 4. The instruction

### Part A — Land #3647 (the only act between now and republication)

1. **Landing seat only:** mint `room/release-lease` for #3647 through the
   reviewed #4115 coordinator (from John's Mac; never forged, the installer
   never run by the fleet), merge-up at landing per standing discipline,
   and land the PR at its bound head lineage. This is a non-money,
   non-schema, non-shared-core metadata change; it still lands only under
   the lease because branch protection requires that check on every PR.
2. **Everyone else: hands off the branch.** No fixer merge-up, no rebase,
   no description edit, no extra file. Any push moves the head off
   `bf2ba43b…`, voids the SETTLED-GREEN evidence bound to it (Ruling 41 /
   Rules v2 discipline), and buys nothing — GitHub already reports the PR
   mergeable (Cluster E `E2.md`).
3. **On merge, stop and watch, do not intervene:** the merge push changes
   `server.json`, so `mcp-registry-publish.yml` must fire with
   `publish=true` (§5, Check 2). If it does not, follow §5's failure
   branches — never land a second, empty `server.json` change to retrigger
   it, and never create a registry token or secret as a fallback. John has
   **no act** in this part; the registry has **no act**.

### Part B — Post-publish verification (fleet, immediately after Part A)

Run §5 Checks 1–5 in order and file the outputs (PR state, publish run id,
both registry payloads, listing-check result) as the closing evidence.
Acceptance is §5, not a summary claim.

### Part C — Listing content quality (standing rules for any future edit)

These rules bind the *next* editor of `server.json`; #3647's text is
settled and is not reopened by them.

- **C1. The description is the whole pitch.** Registry search ignores it
  (§2); its readers are humans, agents that already found the listing, and
  ingesting directories (Glama, PulseMCP per `docs/LISTINGS.md`). Write for
  comprehension in one pass, not for keywords: audience → work loop →
  differentiator, as in §3.4.
- **C2. Spend the cap, never exceed it.** Target 95–100 characters;
  `scripts/server-json-check.mjs` hard-fails at 101 (`description_too_long`)
  and the registry schema caps the same field. Count the final string
  programmatically and quote the count in the PR body (as #3647 did).
- **C3. Factual-claims only, checked against the deployed product.** Every
  capability named must be live on the canonical origin at publish time.
  Standing traps: do not claim paid/cash/bounty work as the product (the
  product centre is the collaboration room; bounties are one bounded
  tool); do not claim OAuth (auth is an optional bearer header; public
  join/public-work tools work without it — the 1.0.0 listing's `No OAuth`
  point must not silently regress into an implied OAuth story); do not
  name vendors as an endorsement. One adversarial read of the sentence
  before filing: *could a stranger act on this and be misled?*
- **C4. The other fields are content too — audit them in the same PR:**
  `title` stays `Project Room`; `websiteUrl` and every remote URL stay on
  the canonical origin `https://room.trydemigod.com` (the check enforces
  origin; the `getdasha.com` alias is **not** an acceptable remote — a
  `server-json-check` test pins it as a failure); remote stays
  `https://room.trydemigod.com/mcp`, `streamable-http`; the `Authorization`
  header block stays `isRequired: false, isSecret: true` with its
  description matching real behaviour; `repository` stays the GitHub repo;
  the icon URL must return 200 with the declared MIME type (probe it, as
  §1 did) — a dead icon is a broken listing face.
- **C5. One source of truth.** `docs/LISTINGS.md` is explicit: the weekly
  check reads `server.json`'s description. Never edit a directory, the
  README, or `scripts/listings.json` to a *different* one-liner; downstream
  rows that lag after a publish are ingestion lag (record `stale`/`unknown`
  via listing-check), not a cue to file submissions. Glama claiming,
  Smithery, awesome-list follow-ups, and every other beyond-repo placement
  in the `LISTINGS.md` table are separate maintainer/John-gated acts and
  are **non-goals** of any registry-bump PR.

### Step F — Future releases: version discipline (the recipe)

- **F1. Read the registry first.** `GET …/v0.1/servers/io.github.Uuriko%2Fproject-room/versions`
  (or `node scripts/server-json-check.mjs --against-registry` once the new
  file is drafted). The new `version` must be **strictly greater** than
  the `isLatest` version; equal or lower fails the publish gate with
  `version_not_greater`, after merge — the worst place to learn it.
- **F2. One PR, all pins together:** `server.json` (`version`, plus
  `description` if the release is a wording change) +
  `tests/mcp-registry-server-json.test.js` (pinned version) +
  `tests/server-json-check.test.js` (pinned shipped version **and** the
  version-increase fixture's stubbed registry latest, set to the version
  you are superseding). #3647's diff is the template: 4 files, +8/−5.
  A bump PR that misses a pin fails its own tests; one that touches
  anything else (product code, routes, `package.json`) is out of scope —
  split it.
- **F3. Bump semantics (listing version only — it versions the *listing*,
  not the product, and not `package.json`'s 0.1.0):**
  - **Patch** (`1.1.1 → 1.1.2`): description/title/icon/website wording or
    metadata corrections; no change to how a client connects.
  - **Minor** (`1.1.x → 1.2.0`): the connection surface changes — a remote
    added, transport added, the auth header's requirement or meaning
    changes, or the declared tool posture (public vs enrolled) changes.
  - **Major** (`1.x → 2.0.0`): the canonical origin moves, a transport is
    removed, or the namespace/name would change. A name change also breaks
    the `io.github.Uuriko/*` OIDC grant assumption in `docs/LISTINGS.md` —
    stop; that is a separate, seat-coordinated piece, not a bump PR.
  - Plain `x.y.z` only: no `v` prefix, no ranges (`1.x`, `^1.1.0`,
    `latest` are all pinned as failures in `tests/server-json-check.test.js`).
  - **Never reuse a published version, and never expect an edit to a
    published version to propagate.** The registry keeps every version;
    `isLatest` only moves to a greater version. A typo in a published
    listing is fixed by the *next* patch bump, not by re-publishing.
- **F4. Publish path: merge is canonical.** Land via a normal PR (lease,
  Rules v2; fix lanes never merge). The two other triggers are recovery
  tools, not alternatives: `workflow_dispatch` republishes the file *as
  committed on main* — legitimate **only** when a merge already changed
  `server.json`, the publish run failed or never fired, and that version
  is still unpublished and still greater than the registry latest
  (re-check F1 first). A `v*` tag makes the workflow **overwrite** the
  version from the tag name — do not tag-publish unless the seat
  coordinates it and a same-cycle PR syncs the file + pins to the tagged
  version; an unsynced tag leaves repo and registry permanently diverged.
- **F5. Failed publish ≠ new bump.** If the publish run fails *before*
  `mcp-publisher publish` succeeds (validation, OIDC, network), the
  version is unconsumed: fix the cause and re-run / dispatch with the
  **same** version. If the run reports success but a registry read still
  shows the old latest, wait for and re-take the direct read (§5) before
  concluding anything — and if the registry in fact holds a ≥ version
  with wrong text, the cure is F3's next patch bump, never a force.

### Explicit non-goals

No change to #3647's branch, text, or pins. No new registry, directory, or
awesome-list submissions. No registry token/secret creation (auth is OIDC
by design). No MCP tool, route, or server-behaviour change. No
`package.json` metadata work (PR #5118's lane). No redesign typed-object
work (paused, FOCUS-REVIEW) — this piece has no dependency on it. Neither
of John's pending forks (verified-delivery vocabulary; sponsor human
surface) touches this piece.

## 5. Acceptance

The coordinator/Jill accepts Part A+B only when **all** of Checks 1–5 pass
on executed output filed with the closing report. A 429 from GitHub at any
point is a fleet-wide stop: report and wait, do not retry through another
route.

1. **PR landed at the bound lineage.**
   `gh pr view 3647 --repo Uuriko/project-room --json state,mergedAt,mergeCommit,headRefOid`
   → `state: MERGED`; merge-up at landing is expected, but the merged diff
   for `server.json` must be exactly the §1 change (verify with
   `gh api repos/Uuriko/project-room/contents/server.json?ref=main --jq .content | base64 -d`:
   `version` `1.1.1`, description byte-identical to §1, all other fields
   unchanged from §1's table).
2. **Publish run executed and succeeded.**
   `gh run list --repo Uuriko/project-room --workflow mcp-registry-publish.yml --branch main --limit 5`
   → the run for the merge push concludes `success`, and its log shows the
   gate step emitted `publish=true`, `Validate server.json`
   (`--against-registry`) succeeded, the v1.8.1 checksum verified, and
   `Publish server to MCP Registry` succeeded.
   *Failure branches:* `publish=false` on a push whose diff contains
   `server.json` → BLOCKED-named (gate/diff defect; file it, use §4 F4's
   `workflow_dispatch` recovery only after F1 re-check). Validation
   `version_not_greater` → re-read the registry: if 1.1.1 is already
   there with the correct text, treat as published and proceed to Check 3;
   if a ≥ version with other text exists, BLOCKED-named → §4 F3 next-patch
   PR. OIDC/login failure → seat/maintainer act; no token fallback exists.
3. **Registry latest is 1.1.1 — two agreeing reads.**
   `curl -fsS "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Uuriko%2Fproject-room/versions"`
   and `curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=project-room"`:
   in **both**, the `isLatest: true` row has `version: "1.1.1"`, the exact
   §1 description, `name: io.github.Uuriko/project-room`,
   `websiteUrl: https://room.trydemigod.com`, remote
   `https://room.trydemigod.com/mcp`, `status: active`, and a
   `publishedAt` after the merge; 1.1.0/1.0.0 rows show `isLatest: false`.
4. **Repo's own listing check agrees.**
   Dispatch or await `.github/workflows/listing-check.yml`
   (Mon 14:00 UTC) and read the `mcp-registry` row of `listing-check.json`
   / job summary → `listed`. (Definition, `scripts/listing-check.mjs`
   `classifyRegistry`: latest version **and** description equal
   `server.json`.) Other rows (`stale`/`unknown` downstream directories)
   are recorded, not acceptance failures for this piece.
5. **README + discoverability baseline recorded.**
   `gh api …/contents/README.md?ref=main` contains the official-registry
   link naming `io.github.Uuriko/project-room`. EXP-1-style probes are
   re-run and filed honestly (`search=uuriko` found; generic capability
   terms expected to remain 0 per §2 — that is the recorded baseline for
   future discovery work, **not** an acceptance failure).
6. **For any future bump PR (Step F), additionally:**
   - `node --test tests/mcp-registry-server-json.test.js tests/server-json-check.test.js tests/mcp-registry-publish.test.js tests/listing-check.test.js` — all pass at the PR head.
   - `npm run verify:affected` exit 0; `npm run lint` 0 errors.
   - PR body states: registry latest before the bump (with the F1 read),
     the new version and why its F3 tier, and the description's character
     count (≤100).
   - Checks 1–4 above, re-run for the new version, replace 1.1.1 with it.

**Registration sweep** (`node ~/workspace/fleet-tools/registration-sweep.mjs --pr <n>`)
for a Step F bump PR — run it; expected dispositions:

| # | Item | Disposition |
|---|---|---|
| 1 | Runtime-package closure | n/a — no `server/**` module added or imported; `server.json` is a root manifest, not a runtime module (if the sweep flags a manifest pin for it, that flag is item 6, and it governs) |
| 2 | Error-code catalogue, both copies | n/a — no error code added, removed, or remapped |
| 3 | Route triple | n/a — no route added; the remote URL is an external registry declaration, not a row in `server/routes/table.mjs` (and §4 C4 forbids changing it outside a minor/major release) |
| 4 | Harness copy sets | n/a — unless the PR edits `scripts/server-json-check.mjs` or `scripts/listing-check.mjs`; if it does, this item becomes REQUIRED and the harness copy/re-point sets for those scripts must be checked by name |
| 5 | Store registries | n/a — no table, no store change |
| 6 | Generated/mirrored artifacts | **APPLIES** — the version pins in `tests/mcp-registry-server-json.test.js` + `tests/server-json-check.test.js` (incl. the fixture stub) are the mirrored copies of `server.json`'s version and must move in the same diff (§4 F2); any sweep-flagged candidate-manifest pin on `server.json` likewise. Re-run the sweep until no MISSING |
| 7 | Diff hygiene | Applies by rule — a conforming bump is ~4 files / <20 lines (§4 F2), far under 300; anything larger must carry the `## Large diff justification:` section or be split |
| 8 | Close-out | **APPLIES** — `npm run verify:affected` + the four named suites in Check 6. `CI=1 npm run check` is required only if the diff touches `server/**` (a conforming bump does not) |
| 9 | Refusal-shape step | n/a — no error code removed, no refusal status remapped |

For #3647 itself the sweep was already satisfied at its bound head
(SETTLED-GREEN, §2); Part A adds no diff, so no sweep re-run is owed —
acceptance for #3647 is Checks 1–5 only.

## 6. Routing

- **Landing (Part A): the landing seat.** The `room/release-lease` is
  minted only by the reviewed #4115 coordinator run by the **Codex release
  seat from John's Mac**; landing order/slot coordination sits with
  **Grok Bot** as landing seat with John's Tab. Handover channel:
  `room_request_reply` to the Codex seat member with a concrete ask,
  a `workItemId`, and the expected result stated exactly as: *"#3647,
  bound head `bf2ba43b3f83d7ce6baed2ee160c8d2daf4e2547`, SETTLED-GREEN —
  mint `room/release-lease` and land; expected result: PR MERGED and the
  `mcp-registry-publish` run for the merge push started."* All Codex
  utilisation stays inside Project Room. **Jill's fleet never merges and
  never mints or forges the lease.**
- **Verification (Part B): Jill's fleet.** Direct registry + GitHub API
  reads (§5 Checks 1–5) are fleet verification work; file the payloads,
  don't summarise them from memory. **John's Tab** is the optional
  post-publish browser spot-check (registry web page shows 1.1.1) — a
  second surface, never a substitute for the API reads.
- **Future bump PRs (Step F): Jill's fleet authors** (small, metadata-only,
  template = #3647's diff), **Codex** does readiness review in-room, the
  seat lands as above. **Claude** and **Fo** have no part in this piece
  unless a future release bundles a client-surface change — at which point
  it is no longer a Step F bump and gets its own pack.
- **John:** no act at any step — no key custody, no registry account, no
  approval. Surface to him only the one-line outcome (published 1.1.1,
  verified) or a BLOCKED-named failure from §5.
