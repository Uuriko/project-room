# Deploy supply-chain audit — 2026-10-07 (wave40-W11)

Scope: who can deploy, what can be injected into the pipeline, and artifact
integrity — for the current production deploy path (not the shelved 2026-09-21
machinery; `stamp-version`, `deploy-live.py` references in the old task draft
are obsolete: stamping is now `scripts/stamp-version.mjs`, deploys are
`.github/workflows/deploy-prod.yml`).

Files audited: `.github/workflows/deploy-prod.yml`,
`rollback-prod.yml`, `staging.yml`, `deploy-drift.yml`, `test.yml` (unit job),
`scripts/sign-agent-card.mjs`, `scripts/worker-ci-build.mjs`,
`scripts/stamp-version.mjs`, `scripts/deploy-checks.mjs`,
`scripts/deploy-recovery.mjs`, `scripts/prod-deploy-smoke.mjs`,
`scripts/live-smoke.mjs`, `cloudflare/wrangler.jsonc`,
`cloudflare/package.json`, `package.json`, `package-lock.json`,
`cloudflare/pnpm-lock.yaml`, `deploy/agent-card-key.mjs`,
`docs/DEPLOY-LANE.md`, `docs/AGENT-CARD-CUSTODY.md`.

## 1. Who can deploy

- Two triggers in `deploy-prod.yml`: manual `workflow_dispatch` (anyone with
  repo write access, per GitHub's dispatch permission) and `workflow_run`
  auto-deploy (only when a `test` or `schema-gate` run on `main` succeeds AND
  the merged commit title begins `[deploy-production]`, or the repo variable
  `ROOM_AUTO_DEPLOY` is `1`). Both paths deploy only the current `main` tip,
  only when **both** `test` and `schema-gate` push runs on the exact 40-hex SHA
  concluded `success`, and only when the SHA is an ancestor of `origin/main`.
  No direct push to `main` exists (all lanes land through PRs).
- Secrets involved: `CLOUDFLARE_API_TOKEN` (Workers edit), required
  `ROOM_AGENT_CARD_SIGNING_KEY` (fail-closed without it — verified in the
  workflow's "Require deploy secrets" step), optional `CLOUDFLARE_ACCOUNT_ID`,
  optional `ROOM_RECEIPT_TOKEN` (room receipt post only). Workflow permissions
  are minimal: `contents: read`, `actions: read`. Concurrency group
  `production-deploy` serializes deploys; `cancel-in-progress: false` never
  cancels a started deploy.
- `rollback-prod.yml` is also `workflow_dispatch`-only and takes Cloudflare
  version ids as inputs. `staging.yml` requires the same two secrets and fails
  with "missing \<NAME\>" instead of deploying unsigned.

## 2. Injection surfaces — reviewed, all sound

- **Actions supply chain:** `actions/checkout`, `actions/setup-node`,
  `pnpm/action-setup`, `actions/upload-artifact` are all SHA-pinned (no
  floating tags). No third-party composite actions.
- **Dependency install:** root `npm ci` uses the committed
  `package-lock.json` (lockfileVersion 3); `cloudflare/` uses
  `pnpm install --frozen-lockfile --ignore-scripts` against the committed
  `pnpm-lock.yaml`. Only one package (`fsevents`) declares an install script —
  the standard native optional dep, not an anomaly. `wrangler` is pinned to
  exactly `4.116.0`. `scripts/deploy-checks.mjs` additionally enforces
  lockfile/package.json sync and asset-hash manifests.
- **Input validation:** the dispatch `sha` input is stripped of whitespace,
  must be exactly 40 lowercase hex chars, must name an existing commit, and
  must be an ancestor of `origin/main`. `reason` and `probe_override` are used
  only in the human receipt text. The gate reads prior CI conclusions via the
  API for push runs only, and refuses (dispatch) or skips (auto) unless both
  gates are `success` — a stale or in-progress run cannot satisfy it.
- **Build-command integrity:** `cloudflare/wrangler.jsonc`'s build command is
  `stamp-version && build-capabilities && sign-agent-card && build-assets`;
  `tests/asset-packaging.test.js` pins it exactly. `worker-ci-build.mjs`
  (CI `--dry-run` only) injects `--allow-unsigned` into a throwaway config and
  refuses to run if the config already contains it — the unsigned escape hatch
  cannot leak into the real build through that script.
- **No `--allow-unsigned` in production paths:** verified by grep over all
  production workflows and `wrangler.jsonc` (2026-10-07), and now guarded in
  CI by `tests/deploy-signing-failclosed.test.js` (this audit's addition).
- **`--keep-vars` on both `wrangler deploy` steps** keeps existing Worker vars
  — deploys cannot silently reset production config.

## 3. Artifact integrity — verified end to end

1. `stamp-version.mjs` stamps the exact 40-hex commit SHA into
   `server/version.mjs` at build time (fails unless the SHA is a real commit).
2. `sign-agent-card.mjs` signs the agent card with the Ed25519 private key and
   **fails closed** without it; it also verifies the on-file private key
   matches the pinned public key in `deploy/agent-card-key.mjs` before signing.
3. Post-deploy, `prod-deploy-smoke.mjs --sha <SHA>` waits for `/api/version`
   to report the SHA on both doors, then fetches `/.well-known/agent-card.json`
   repeatedly and requires **every** fetch to carry a signature that verifies
   against the pinned key and binds the deployed revision (hardened after the
   QA-b/#1524 flapping-card finding). Any failure rolls back automatically via
   `deploy-recovery.mjs` to prior code meeting the schema floor; a receipt is
   posted to the room with the run URL.
4. `deploy-drift.yml` (hourly) reports when production's public
   `/api/version` lags `main`.

In short: unsigned or wrong-revision artifacts cannot survive the smoke, and
the smoke's failure path is automatic rollback — not a human noticing.

## 4. Findings

- **F1 (fixed by this PR):** no CI guard prevented `--allow-unsigned` from
  being baked into a production workflow or the wrangler build command — the
  one edit that would silently defeat fail-closed signing. Added
  `tests/deploy-signing-failclosed.test.js`: forbids the flag in
  `deploy-prod.yml`/`rollback-prod.yml`/`staging.yml`, asserts deploy-prod's
  secret gate refuses without the key, and asserts the build command still
  signs the card.
- **F2 (info, open):** the public entry door (`www.getdasha.com/room`) is
  served by the worker whose wrangler env is named `project-room-staging`
  (the default env deploys it in deploy-prod). The name is a leftover; it is
  production traffic, not staging. Incident-response hazard under pressure —
  recommend a rename or a loud comment at the deploy step.
- **F3 (info, open):** both deploy steps hardcode
  `--var ROOM_BODIES_AT_REST:1` — the 2026-10-07 incident workaround is now
  part of the pipeline. Recommend moving it to a persistent var/secret and
  returning the workflow to a clean shape, so a future incident flag doesn't
  accumulate silently.
- **F4 (info, open):** `rollback-prod` takes raw Cloudflare version ids from
  the operator; a typo rolls back to the wrong version (ids are opaque, no
  repo-side binding possible). Mitigated today: deploy-prod records
  pre-deploy version ids in the `pre-deploy-<sha>` run artifact for copy-paste.
- **F5 (by design, recorded):** GitHub write access = deploy access (documented
  in `docs/DEPLOY-LANE.md`). The trust boundary is repo membership, not a
  separate deploy role. Combined with Codex's standing deploy authority, this
  means any lane with write access can ship a dual-green commit — intended,
  but worth stating plainly.

## 5. Residual risks (accepted, not actionable zero-tap)

- `CLOUDFLARE_API_TOKEN` scope ("Workers scripts/routes edit") is broader than
  the two workers; narrowing is a John/cloud-console action, not repo work.
- npm/pnpm registries remain a transitive-trust point (lockfiles + hashes
  bound it; `deploy-checks.mjs` enforces sync).
- Key rotation for `ROOM_AGENT_CARD_SIGNING_KEY` follows
  `docs/AGENT-CARD-CUSTODY.md`; rotation is untested in CI by design (the
  private key must never touch a test).
