# Context Packing — shared-context packs for swarm-wave worker briefs

**Wave:** WAVE-500 (coordination-overhead), worker 5/17.
**Status:** prototype (`scripts/pack-context.mjs`) + v1 pack (`context-packs/swarm-wave-pack.v1.md`).
**Scope:** `scripts/` + `docs/` only. Complements `docs/BATCH-DISPATCH-SPEC.md`
(worker 4/17): batch-dispatch factors shared context out of the *wire envelope*;
context-packing factors it out of the *brief authoring* — the pack is the
versioned artifact a coordinator pins instead of pasting kilobytes per worker.

## 1. Problem

Every worker brief in a coordination wave repeats the same standing context:
one-shot semantics, worktree/branch rules, TMPDIR hygiene, commit/push
discipline, claims (first-claim-wins), backward compatibility, honest
reporting, safety. At 500 workers that is the same ~3 KB × 500 ≈ 1.5 MB of
repeated context per wave — paid in coordinator output tokens on every
dispatch, and drift-prone when coordinators paraphrase instead of pasting.

## 2. Mechanism

Split each worker brief into two parts:

1. **Shared-context pack** — one file per pack version,
   `context-packs/<name>-pack.<version>.md` (e.g. `swarm-wave-pack.v1.md`).
   Written once, content-addressed, never edited in place.
2. **Per-worker template** — the worker-specific delta only, with
   `{{SLOT}}` placeholders and a one-line `contextRef: <name>@<version>:<sha12>`
   pointer back to the pack, plus a `slots:` declaration block.

Wire cost goes from `N × (shared + delta)` to `shared + N × (delta + ref)`.

## 3. Pack file format

```markdown
---
pack: swarm-wave          # pack name
version: v1               # pack version (immutable once published)
sha256: <hex>             # sha256 of the body below the front matter
created: 2026-10-08
status: stable
supersedes: none          # previous version this replaces, if any
forbidden:                # phrases a conforming brief must not assert
  - "push to main"
  - "skip the claims board"
---
<shared context body; rules tagged [REQ] are mandatory for full briefs>
```

Rules:

- **Immutability:** a published pack file is never edited. `split`/`extract`
  refuse to overwrite an existing pack unless `--force` is passed (and the
  validator then flags the checksum mismatch — see §5).
- **Checksum binding:** the front-matter `sha256` covers the body. Templates
  pin the first 12 hex chars in their `contextRef`; any edit breaks the pin.
- **`[REQ]` tags:** rules marked `[REQ]` must appear verbatim in a *full*
  (unpacked) brief. Templates are exempt — they inherit the rules by reference.
- **`forbidden` list:** phrases that contradict pack rules. A brief containing
  one (outside a negation) gets a warning, or an error under `--strict`.

## 4. Template format

```markdown
---
worker: {{WORKER_ID}}
contextRef: swarm-wave@v1:ef16b4ee3b7e
slots:
  WORKER_ID: "e.g. wave500-coord-cost-worker5"
  TASK_TITLE: "..."
  BRIEF_BODY: "..."
  DELIVERABLES: "..."
  DONE_CONDITION: "..."
---

WAVE-500 coord-cost worker {{WORKER_ID}}/17 ({{TASK_TITLE}}).
...delta only...
```

Every `{{SLOT}}` used must be declared in `slots:`; declared-but-unused slots
warn. A template with a `contextRef` but no slots warns ("is the delta missing?").

## 5. CLI (`scripts/pack-context.mjs`)

| Command | Purpose |
|---|---|
| `split --in <brief.md> --name <pack> --version <v> --out-dir <dir> [--template-out <f>]` | Split one marker-annotated brief (`<!-- SHARED -->` / `<!-- PER-WORKER -->`) into pack + template |
| `extract --briefs <dir\|-> --name <pack> --version <v> --out-dir <dir> [--min-share 0.8]` | Multi-brief mode: paragraphs present in ≥ min-share of briefs become the pack; residuals become templates |
| `validate --brief <brief.md\|-> --pack <pack.md> [--strict]` | Validate a brief (full or template) against a pack |
| `measure --briefs <dir\|-> --pack <pack.md> [--json]` | Byte + token counts: full briefs vs packed form |
| `list [--dir context-packs]` | List packs with version, checksum, supersession chain, integrity |
| `gen-briefs --out <dir> --workers <n> --pack <pack.md> [--seed <n>]` | Generate deterministic realistic briefs for measurement |

Validation checks, in order:

1. Pack integrity — front-matter `sha256` matches body (tamper-evident).
2. Reference binding — template's `contextRef` name/version/checksum match the pack
   (a v1 template fails loudly against a v2 pack, and vice versa).
3. Slot hygiene — all `{{SLOT}}`s declared; no undeclared slots; no unused declarations.
4. Rule containment (full briefs only) — every `[REQ]` rule present verbatim.
5. Drift scan — `forbidden` phrases warn (error under `--strict`).

Exit 0 = conforms; exit 1 = errors. Warnings go to stderr.

## 6. Versioning policy

- Versions are `v1`, `v2`, … — monotonically increasing, no semver theatrics.
- **Additive change** (new rule, clarifying reword that keeps `[REQ]` semantics):
  publish a new version with `supersedes: v<n-1>`; old templates keep working
  against the old pack until re-pointed.
- **Rule change** (a `[REQ]` rule's meaning changes): new version; all templates
  must be re-validated (`validate` fails on version/checksum mismatch until
  re-pointed) — this is deliberate, not a bug.
- `list` shows the supersession chain; `measure` accepts any pack version so
  v1-vs-v2 savings can be compared.
- Shipped packs: `swarm-wave-pack.v1.md` (8 rules, W1–W8, distilled from
  WAVE-300/400/500 coordinator briefs), `swarm-wave-pack.v2.md` (adds W9 —
  DONE-receipt rule).

## 7. Measured savings — realistic 25-worker brief set

Method: `gen-briefs` produced 25 deterministic full briefs (seed 42), each =
pack body verbatim (the shared context, as real coordinator briefs repeat it)
+ a realistic unique delta (worker id, task title, deliverables, done-condition,
edge cases) modeled on actual WAVE-500 worker briefs. `measure` then compared
Σ full briefs against pack-once + per-worker template (residual + `contextRef`
header). Token estimate: 1 token ≈ 4 chars (rough; applied equally to both sides).

```
pack: swarm-wave@v1  sha256 ef16b4ee3b7e…
workers: 25
pack coverage (min fraction of pack found per brief): 0.983

                          bytes        tokens(~)
  full briefs             92258           23065
  packed                  22517            5630
  saved                   69741           17435  (75.6%)

saved per worker: 2790 bytes (~698 tokens)
```

Reproduce:

```sh
node scripts/pack-context.mjs gen-briefs --out .tmp/w5-briefs --workers 25 \
  --pack context-packs/swarm-wave-pack.v1.md --seed 42
node scripts/pack-context.mjs measure --briefs .tmp/w5-briefs \
  --pack context-packs/swarm-wave-pack.v1.md
```

Scaling: the per-worker saving is constant (the shared context is fixed), so a
500-worker wave saves ≈ 500 × 2,790 B ≈ **1.4 MB (~349K tokens)** of repeated
context per dispatch — 75.6% of brief bytes eliminated. The pack itself
(3,033 bytes) is paid once.

Caveats:

- Savings assume the shared context is truly repeated verbatim; paraphrased
  briefs score lower coverage (reported per run — here 0.983, the 1.7% gap is
  short header paragraphs below the 40-char match floor, conservatively left in
  the residual).
- `extract` mode re-derived the pack from the 25 briefs at 3,066 bytes vs the
  true 3,033 — paragraph-frequency factoring is near-lossless at min-share 0.8.
- The token ratio is an estimate for comparison, not a billing figure.

## 8. Examples

- `docs/examples/context-pack-full-brief-example.md` — a full worker brief with
  `<!-- SHARED -->` / `<!-- PER-WORKER -->` markers (input to `split`).
- `docs/examples/context-pack-template-example.md` — the packed per-worker
  template produced from it (5 slots, `contextRef: swarm-wave@v1:ef16b4ee3b7e`).

## 9. Not in scope

Transport binding (how workers resolve a `contextRef` to pack text — shared
store, broadcast, or coordinator-side expansion, cf. BATCH-DISPATCH-SPEC §2),
slot-value validation beyond declaration, and pack content governance (who may
publish v3) are deliberately out of scope for this prototype.
