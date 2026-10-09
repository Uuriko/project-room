# Host stack: host-context-policy.mjs, host-subprocess.mjs, host-verification.mjs, host-process.mjs, host-result.mjs

**Purpose.** Run an untrusted automated host (a model invocation) in a sandbox, observe what it did, and format its reply — with verification that the reported code result matches the actual checkout.

## host-context-policy.mjs — envelope + policy gate

**Purpose.** `createHostEnvelope(input)` builds the typed payload the host receives; `validateHostPolicy(policy, cwd)` is the allow/deny gate evaluated **twice**: once at `configuredHost()` build time and again inside the returned runner just before launch (a policy change between build and run is refused).

## host-subprocess.mjs — process spawning

**Purpose.** `validHostCommand(config)`: absolute command, string args, `timeoutMs` 100–3600000. `hostSubprocess(config, {cwd, env, signal, input, maxBytes, isolate})`: spawn with `shell: false`, process-group kill on timeout/abort, bounded stdout (`maxBytes`, default 32 KiB), stderr resumed-and-discarded (diagnostics may contain secrets — never disclosed).

**Invariants.** No shell, no inherited credentials in the isolated path (`isolate` → `selectedEnv = {}`). A nonzero exit is an *observation* (returned, not thrown); startup/timeout/cancellation are errors. `isolatedHostCommand` requires `/usr/bin/bwrap`; checkout must be a private workspace under `/home` or `/tmp` (never `/` or `/usr`); the executable must be system-provided or inside the checkout; **a missing sandbox fails before spawning** — never silently degrades to an unsandboxed process.

**Gotchas.** GitHub setup-node's `/opt/hostedtoolcache/node/.../bin/node` gets a special read-only bind of exactly that binary, never the whole toolcache.

## host-verification.mjs — trust the adapter, not the model

**Purpose.** `observeHostChecks(codeResult, verification, options)` runs the *local* adapter's checks against the checkout and fingerprints it before/after (HEAD + status + binary diff). If the fingerprint changes during checks, no verification is claimed.

**Invariants.** Verification requires: absolute `gitCommand`, HTTPS `repositoryUrl`, 1–3 named bounded checks; clean tree, no submodules, no untracked files; reported `patch` must byte-equal the actual `git diff`; a linked `artifactUrl` must name a real ancestor (`merge-base --is-ancestor`). Repository mismatch between `codeResult` and config is refused.

**Gotchas.** The host and the checks share an OS user — this is observation, not attestation or a sandbox. `recordObservedChecks` stores receipts in a `WeakMap` keyed by the result object (deliberately absent from JSON).

## host-process.mjs — configured host runner

**Purpose.** `configuredHost(config)` validates once, returns an async runner: builds envelope → per-checkout lock (`~/.project-room/host-locks/<sha256(cwd)>`, left intact on failure) → optional verification probe at the repo root → sandboxed `hostSubprocess` → `JSON.parse` + `hostReplyBody` validation → optional `observeHostChecks` merged into the reply.

**Invariants.** `config.env` must be absent/empty — an automatic host never receives configured environment variables (off-by-one mutant M13 allowing exactly one var is **killed**). Verification must run at the repository root (a subdirectory would hide tracked changes elsewhere). Only `PATH`/`TMPDIR`/`LANG` from the operator environment are forwarded; no operator credentials.

**Gotchas.** The lock uses the operator home while the host sees an isolated `/tmp` HOME. `rmdirSync(lock)` failure leaves the lock intact deliberately (unresolved state is visible, not silently cleared).

## host-result.mjs — reply formatting + validation

**Purpose.** `hostReplyBody(result)` validates a host's `{body, codeResult?}` and formats the single immutable reply (≤4096 chars, never truncated — over-limit fails instead).

**Invariants.** `body`: non-blank string ≤4096, well-formed UTF-8. `codeResult`: HTTPS `repositoryUrl` (no creds), 40/64-hex revisions, **exactly one** of `patch`/`artifactUrl` (XOR — the flipped mutant M10 is killed), 1–30 files (each a clean single line ≤256), ≤10 checks with outcomes in `passed|failed|not_run`. Final assembled body re-checked against 4096.

**Gotchas.** Host-reported check commands pass validation as data and are embedded verbatim in the reply markdown (fuzz A4: `<script>`-shaped command text is accepted — it is *data*, and no module in this slice renders HTML; any downstream HTML renderer must escape). External URLs/metadata are host reports: never fetched, never verified — the digest identifies exact patch bytes, not correctness.
