# Cross-product bug and improvement findings — 2026-09-15

Evidence from this machine: `node scripts/live-audit.mjs` green against `https://room.trydemigod.com` (Worker `c5690272aed3ceb1f750547cb2f5496a1cdd3963`, `ship: false`). GitHub `production` is `379705e` (docs-only ahead of the Worker). Occupied Room paths were not edited (`.gitignore`, `.wrangler/`, `docs/*RESEARCH*`). Dasha `compute/` was not edited.

Each item: **bug** or **improvement**, **reproduced** or **inferred**, with a path or URL.

Trees covered: **Project Room**, **Dasha**, **Desk**, **Demigod**.

---

## Project Room (`src/project-room-integration`, `https://room.trydemigod.com`)

1. **Bug, reproduced.** `https://www.trydemigod.com/room` Join href is `https://project-room-staging.getdasha.workers.dev`, not `https://room.trydemigod.com`. Curl of the door HTML contains `staging` and no `room.trydemigod`. Overlay `src/demigod-site-cdn` has no `project-room-staging` string — the door is not in this paste tree.
2. **Bug, reproduced.** GitHub `refs/heads/production` (`379705e`) ≠ live `/api/version` `sourceRevision` (`c569027`). Docs commits were pushed without a Worker deploy. Correspondence is split.
3. **Bug, reproduced.** Extra GitHub head `quill/specs-queue` (`8ccae42`) besides `main` and `production`. `git ls-remote --heads https://github.com/Uuriko/project-room.git`.
4. **Improvement, reproduced.** `main` is `6641218` (Schema 34 README). Live is Google PKCE on schema-26 object. Do not merge `main` onto this host. Inferred risk if someone treats GitHub default branch as live.
5. **Improvement, reproduced.** `node scripts/live-audit.mjs` passes: Google start PKCE, privacy 200, `channels.js` 200, `ship: false`. Keep running it after deploys (`src/project-room-integration/scripts/live-audit.mjs`).
6. **Bug, inferred (fixed on Worker, still a pattern).** Browser import not on both `cloudflare/build-assets.mjs` `assetPaths` and `server/http.mjs` `assets` Map 404s the whole app (Connecting hang). Guard is the live-audit import crawl.
7. **Bug, inferred (fixed on Worker).** Google OAuth 302 + `SameSite=Strict` dropped the account cookie. Interstitial is `googlePostLoginPage` in `server/google-oauth.mjs`. Re-test in Chrome is still the human proof.
8. **Improvement, reproduced.** `/api/auth-config` is `provider: google`, `/api/open` `ship: false`. Public MCP walk-in remains unpublished.
9. **Improvement, inferred.** Second Google account should not receive `manage_members` (first empty-Welcome grant in `server/provider-onboarding.mjs`). Not re-run with two live Gmails this writeup.
10. **Improvement, inferred.** Opt-in Tree/pigment UI only after auth (`docs/CYBERNETICS-KABBALAH-HERMETIC-BOTH-2026-09-15.md`). Not implemented; not a login-gate change.

---

## Dasha (`src/dasha-desk`, `https://lobby.getdasha.com/compute`)

11. **Bug, reproduced.** `GET https://lobby.getdasha.com/v1/network` → **404**. `GET https://lobby.getdasha.com/compute/v1/network` → **404**. Live network is `GET https://lobby.getdasha.com/compute/api/network` → **200**, `providers_online: 1`.
12. **Bug, reproduced.** `src/dasha-desk/compute/package.json` version **0.3.0**; live `https://lobby.getdasha.com/compute/api/healthz` version **0.3.1**.
13. **Improvement, reproduced.** GitHub `Uuriko/dasha-desk` has **13** heads including leftover `ocm-p1-2-chat-request`, `ocm-p2-agent-build`, `ocm-p3-machine-identity`, `ocm-p5-earnings`, `ocm-p8-dry-run-uninstall`, `cursor/*`, `quill/*`, `Uuriko-patch-1`. Report-only; do not delete from this lane.
14. **Improvement, reproduced.** Compute `agent.json` at `https://lobby.getdasha.com/compute/agent.json` states Not Room — keep the split.
15. **Bug, inferred.** `src/dasha-desk/docs/LIVE-STATUS.md` `last_verified: 2026-09-02` is stale vs healthz 0.3.1. Path exists; not edited (paste-agent / growth history).

---

## Desk (`src/desk-chat`)

16. **Bug, reproduced.** `src/desk-chat` has a `.git` directory but **no remotes** (`git remote -v` empty) and **all tracked-looking files are untracked** (`?? README.md`, `?? server.py`, …). There is no GitHub backup of the Slack replacement.
17. **Improvement, reproduced.** `src/desk-chat/README.md` documents local `python3 server.py` on `127.0.0.1:3847`, DMs, pins, work objects in `src/desk-chat/work.py`. Product split vs Demigod/Dasha is stated. Not mixed into Room.
18. **Improvement, inferred.** Desk DMs (`POST /api/dm`) are a real store; Room A2 DMs should stay a **projection** and not copy Desk’s SQLite. See `src/desk-chat/README.md` and Room `src/channels.js`.

---

## Demigod (`src/demigod-site-cdn`, `https://www.trydemigod.com`)

19. **Bug, reproduced.** Same as (1): `https://www.trydemigod.com/room` Join still staging. Overlay grep for `project-room-staging` in `src/demigod-site-cdn` is empty — door HTML is not in the overlay paste, so Room deploys cannot fix it.
20. **Improvement, inferred.** Dirty `src/demigod-site-cdn/docs/ops/*` and `docs/SITE-AUDIT-2026-08-31.md` are occupied; do not edit from this hunt.

---

## What this hunt did not do

- No Room or Dasha deploys, no `ship: true`, no Schema 34 cutover, no `compute/` edits, no branch deletes.
- GitHub GraphQL/REST was previously resetting; heads verified with `git ls-remote`.
