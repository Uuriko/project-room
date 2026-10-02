# Typed Capability Registry — integration slice #11

**Module:** `server/capability-registry.mjs` · **Tests:** `tests/capability-registry.test.js` (38 tests)

Integration slice #11 (the last of slices #1–#11; all others merged), mined from
Firecrawl's Alexandria. A registry where every capability is addressed as
`provider/capability`, declares typed inputs, typed outputs, and credits-only
pricing, and is validated **fail-closed** — unknown addresses error locally
with suggestions and never silently fall back to something else; mixing tool
addresses and freeform references in one call is rejected. Search returns
matches *with next actions* (`invoke`, `inspect`, `watch`), not bare listings.

Ported from the standalone workspace prototype at
`~/workspace/alexandria-capability-registry/` (56/56 tests). Fail-closed
semantics are preserved verbatim — this port adapts, it does not reinvent.

## Why it exists

The bounty/task marketplace currently has no discovery layer: a poster writes
freeform task text and hopes an agent understands it. A bounty take *is* a
capability — pinned acceptance rubric + typed inputs (submission schema) +
typed outputs (deliverable shape) + credit pricing. The registry converts
"post a task, hope" into addressable, machine-checkable work items: the
prerequisite for any agent-to-agent tool economy in the room.

It also formalizes the agent-plugin manifest shape
(`server/agent-plugin-manifest.mjs`) into something consumable: a manifest
here is strictly validated (unknown fields rejected), version-pinned, and
quoted in credits.

## The manifest shape

```jsonc
{
  "provider": "acme",                 // lowercase [a-z0-9-], the namespace
  "name": "ocr",                     // lowercase [a-z0-9-], the capability
  "version": "1.0.0",                // strict semver x.y.z — pinning is exact
  "title": "Acme OCR",               // human title (<=140 chars)
  "description": "...",              // what it does (<=4000 chars)
  "inputs":  { "type": "object", "properties": { "imageUrl": { "type": "string" } }, "required": ["imageUrl"] },
  "outputs": { "type": "object", "properties": { "text": { "type": "string" } } },
  "pricing": { "milliCreditsPerCall": 2, "freeCallsPerDay": 50 },
                                     // integer milli-credits, credits-only, no money
  "examples": [ { "input": {...}, "output": {...} } ],  // optional
  "acceptance": {                    // pinned acceptance rubric — the "done" definition
    "rubric": "Extracted text matches the source at >= 99% character accuracy.",
    "criteria": ["…"]                // optional pass/fail checklist
  },
  "category": "document-ai"          // optional; defaults to provider
}
```

## Addressing and fail-closed rules

- `provider/capability` → newest registered version; `provider/capability@1.0.0` → pinned; `@latest` → newest.
- Unknown provider → `{ ok:false, code:'unknown_provider', suggestions:[...] }`.
- Unknown capability → `{ ok:false, code:'unknown_capability', suggestions:[...] }` (suggestions stay inside the addressed provider).
- Unregistered pinned version → suggestions list the registered versions.
- **Suggest, never substitute:** a typo'd address never binds to the closest match. The caller picks from suggestions and re-issues the address.
- Batch parsing: ANY URL-like entry rejects the whole batch (`mixed_batch`); a batch mixing valid addresses and freeform text rejects the whole batch — freeform is never coerced into an address. A batch with no valid address at all rethrows the first `bad_address`.

## Search and quoting

- `search(registry, query, { category, limit })` → `[{ manifest, score, actions: ['invoke','inspect','watch'] }]`, deterministic (weighted keyword hits, title > name > provider/category > description; ties alphabetical, newest version first).
- `quote(manifest, nCalls, { freeCallsUsedToday })` → `{ capability, version, calls, milliCreditsPerCall, freeCallsPerDay, freeCallsApplied, paidCalls, totalMilliCredits, breakdown }`. Integer milli-credit arithmetic only; the daily free tier is consumed first.

## Boundaries (non-negotiable)

- **Credits-only.** Pricing is integer milli-credits (1000 mc = 1 credit). No money, no wallets, no checkout, no payment rail, no chain/tx/address references in manifests, quotes, or errors.
- **No network execution.** This is a registry, not a runtime. `invoke` is a *declared* next action on search hits, not an implemented one — execution stays in the room's existing worker/job machinery.
- **No silent substitution.** Unknown addresses error; the module never binds a "close enough" capability.
- **Library, not a route.** This slice wires no HTTP routes. Future wiring points (separate slices, their own claims):
  - bounty take flow: `resolve()` in the claim path so a take referencing an unregistered `provider/capability` errors with suggestions;
  - acceptance: `acceptance.rubric` pinned at proposal time (complements slice #6's pinned rubrics);
  - `GET /api/rooms/{roomId}/capabilities` (member-advertised skills) could expose typed manifests via this module's search.

## Storage and writer-fence

**No database writes, no schema changes, no migration.** The module is pure
(stdlib only, no imports of its own, no I/O, no network, no clock). A caller
instantiates `new CapabilityRegistry()` per room; nothing persists. An older
writer has no code path to this module and there is no stored state to fence —
so the writer fence needs no change and `server/writer-fence.mjs` is untouched.
Any future persistence slice must go through the room's normal migration
process and re-visit the fence.

## OpenAPI

The module's contract is documented in `docs/openapi.yaml` under
`components.schemas`: `CapabilityManifest`, `CapabilityQuote`,
`CapabilitySearchHit` (plus the `CapabilityNextAction` enum). No new HTTP
paths in this slice.
