# Supply-chain audit: the Project Room deploy pipeline

**Task:** 200-hard-tasks #171 (⭐) — audit the deploy pipeline (stamp-version,
deploy-live.py, Cloudflare): who can deploy, what can be injected, artifact
integrity.
**Date:** 2026-10-07 · **Lane:** HT-7 · **Head audited:** `3a365ce4a`

## Deploy paths

| Path | Trigger | What it does |
|---|---|---|
| `.github/workflows/deploy-prod.yml` | `workflow_dispatch` (sha input) or `workflow_run` auto-deploy when `test` + `schema-gate` both succeed on main | Canonical Worker (`project-room`) + public entry (`project-room-staging`) via `wrangler deploy`, then smoke, then receipt |
| `.github/workflows/rollback-prod.yml` | `workflow_dispatch` | Re-deploy a prior Worker version, schema-floor gated |
| `scripts/deploy-live.py` | Manual operator run | Uploads a bundle to a Cloudflare Worker via API (legacy/operator path) |
| `docs/DEPLOY-LANE.md` runbook | Human/agent following the runbook | Documents the shared deploy lane |

## Who can deploy

- **Actions path:** anyone with `workflow_dispatch` rights on `Uuriko/project-room`
  can ship any green main commit. This is intentional (the shared deploy lane),
  and it is the single biggest supply-chain fact: **deploy capability ≈ repo
  write access**. There is no second human in the loop by default.
- **Cloudflare account:** anyone holding `CLOUDFLARE_API_TOKEN` (Actions secret)
  can deploy outside the pipeline entirely. The token needs Workers
  scripts/routes edit on the account.
- **Manual path:** `scripts/deploy-live.py` uses a surrogate credential
  (`custom.cloudflare` → `access_token`); whoever can run the script on a
  machine with that surrogate can deploy.
- **Mitigations in place:** the gate job refuses any SHA that is not on main,
  is not full 40-hex, or lacks green `test` + `schema-gate` runs at that exact
  commit; `workflow_dispatch` still requires the operator to name the SHA.
  Concurrency group `production-deploy`, `cancel-in-progress: false`.

## Injection points (what an attacker with partial access can change)

1. **`cloudflare/wrangler.jsonc` → `build.command`.** Runs on every deploy:
   `node ../scripts/stamp-version.mjs && node ../scripts/build-capabilities.mjs
   && node ../scripts/sign-agent-card.mjs && node build-assets.mjs`.
   A compromised commit to any of these four scripts (or to wrangler.jsonc
   itself) executes with deploy privileges. This is why green-CI-before-merge
   is the real supply-chain gate: it is the only review between a malicious
   script and production.
2. **`npm ci` / `pnpm --dir cloudflare install --frozen-lockfile`.** Frozen
   lockfiles pin dependencies; `scripts/deploy-checks.mjs` verifies the
   lockfile is in sync with package.json (dependency sections, name, version).
   A dependency-confusion or lockfile edit lands only via a merged commit,
   again covered by the merge gates.
3. **`stamp-version.mjs` itself.** Stamps `SOURCE_REVISION`/`BUILD_ID` into
   `server/version.mjs`. It validates the revision is 40-hex and re-imports
   the stamped file before swapping it in. It trusts `git rev-parse HEAD` —
   correct, because the Actions checkout is pinned to the gated SHA with
   `fetch-depth: 0`.
4. **Actions secrets.** `CLOUDFLARE_API_TOKEN`, `ROOM_AGENT_CARD_SIGNING_KEY`,
   `CLOUDFLARE_ACCOUNT_ID`, `ROOM_RECEIPT_TOKEN`. Names only, never values, in
   git (enforced by convention; see `scripts/secret-scan-check.mjs`).
5. **Playwright browser install** (`npx playwright install --with-deps`) in the
   probe job — third-party binaries, but the probe job is skipped unless
   `ROOM_ONBOARDING_GATE=1` and cannot block or alter the deploy when skipped.

## Artifact integrity controls (existing)

- **Stamping:** `stamp-version.mjs` writes the exact commit SHA into the bundle;
  post-deploy, `scripts/prod-deploy-smoke.mjs` requires `/api/version` to
  report the gated SHA before the deploy is considered done.
- **Lockfile + asset hashes:** `scripts/deploy-checks.mjs --check` (F007)
  verifies lockfile sync and SHA-256 asset hashes against `.asset-hashes.json`.
- **Signed agent card:** `scripts/sign-agent-card.mjs` signs the A2A agent card
  (Ed25519 + A2A v1.0 §8.4 JWS) binding the served build's revision; the build
  **fails closed** without `ROOM_AGENT_CARD_SIGNING_KEY` (unless explicit
  `--allow-unsigned`). Post-deploy, the smoke requires EVERY
  `/.well-known/agent-card.json` fetch on both doors to carry a signature that
  verifies against the pinned key in `deploy/agent-card-key.mjs` and binds the
  deployed revision — any unsigned or flapping state fails the smoke and the
  pipeline rolls back.
- **Rollback:** pre-deploy snapshot (`scripts/deploy-recovery.mjs snapshot`);
  on failure, recover only to prior code meeting the schema floor; lower or
  unknown schemas require roll-forward. Recovery artifacts are uploaded with
  90-day retention.

## Gap found and fixed in this change

The pipeline verified the *signature after deploy* (smoke) but had no
**pre-upload signed-artifact verification**: a build-time tamper between
`sign-agent-card.mjs` and `wrangler deploy` (e.g. a modified generated
`deploy/agent-card-signed.mjs`, or a stamped `server/version.mjs` that does not
name the gated commit) would ship first and only be caught post-hoc by the
smoke.

**Fix (companion implementation PR, branch `ht-7/sec-impl-171-180`):**
`scripts/verify-build-artifacts.mjs`, wired into the wrangler `build.command`
immediately after `sign-agent-card.mjs`. It fail-closes when:
- the stamped `server/version.mjs` `SOURCE_REVISION` is not a full commit SHA
  or does not equal the build checkout's `git rev-parse HEAD`;
- `BUILD_ID` is not valid JSON-string stamped content;
- `deploy/agent-card-signed.mjs` fails signature verification against the
  pinned key in `deploy/agent-card-key.mjs`, or the signed card does not bind
  the stamped revision;
- `deploy/agent-card-signed.mjs` is unsigned while the pinned key exists
  (no silent unsigned builds in the pipeline).

Because it runs inside the wrangler build command, it covers every deploy path
that builds through wrangler (prod, entry, staging, local) with no workflow
edits required.

## Residual risks (accepted, not fixed here)

1. **Deploy capability ≈ repo write access.** Accepted by design (shared deploy
   lane); mitigated by merge gates (green CI + review + no CHANGES REQUESTED)
   and the serial merge slot.
2. **No artifact transparency log.** There is no append-only public log of
   (SHA → Worker version id) mappings beyond the 90-day Actions artifacts and
   muse-room receipts. A future improvement: publish the pre-deploy snapshot +
   version ids to a transparency record.
3. **`scripts/deploy-live.py` manual path** bypasses the Actions gates (no
   dual-green requirement). It is an operator tool; access is via the surrogate
   credential, not repo rights. Operators should prefer the Actions lane.
4. **Supply-chain of the runners themselves** (GitHub-hosted `ubuntu-latest`,
   pinned Action SHAs — actions are SHA-pinned, good) is inherited trust.

## Verdict

The pipeline is in good shape: SHA-pinned actions, frozen lockfiles,
dual-green deploy gate, fail-closed signing, post-deploy signature + revision
smoke with rollback. The one real gap — no pre-upload verification of the
signed artifacts — is closed by `scripts/verify-build-artifacts.mjs` in the
companion implementation PR.
