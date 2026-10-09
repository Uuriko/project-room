# guild-17 re-verification delta (retry coordinator, 2026-10-09)

Base drift since audit base: `b53c52af1` → `origin/main` @ `68ec17e836`
(71 commits). Files changed under the slice (`.github/`):

## Changed workflows (2)

### .github/workflows/deploy-prod.yml (16 lines)
- Commits `a689c18f4` / `258e437bd`: the auto-deploy gate now reads BOTH
  version doors via `scripts/check-version-doors.mjs` instead of curl+jq
  on `/api/version` alone. Rationale in the script header: the DO-backed
  `/api/version` door can lag the Worker by ~1 min after deploy; one door
  alone misreports "already deployed" during the window.
- `check-version-doors.mjs`: zero dependencies, reads only public
  `/api/version` and `/api/version/worker`, extracts `sourceRevision`,
  no secrets/tokens/auth headers anywhere (verified via grep on the
  current-main copy). Classifies converged/do-stale/worker-stale/other,
  exits 0/3/4/5; the workflow skips redeploy on 0 and 3.
- Secrets surface unchanged: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
  ROOM_AGENT_CARD_SIGNING_KEY, ROOM_RECEIPT_TOKEN, github.token — same
  set as audited in workflow-deploy-prod.md.
- Action pinning unchanged (all SHA): checkout@11d5960a,
  setup-node@49933ea5, upload-artifact@ea165f8d, pnpm/b906affc.
- Verdict: benign hardening. No new exfil path, no permission change,
  no mutable-tag actions introduced.

### .github/workflows/deploy-drift.yml (1 line)
- `scripts/watch-deploy-drift.mjs` gains `--settle-ms 120000` (timing knob
  only). No security-surface change.

### YAML parse
Both changed files parse cleanly under `yaml.safe_load` at the new main
revision.

## Exfil hole re-verified (NOT re-reported)
- `git ls-tree 68ec17e836 .github/CODEOWNERS` → empty: still no CODEOWNERS.
- Fix commit `b42febd80` (CODEOWNERS gate on .github/workflows/) is not an
  ancestor of `68ec17e836` ("FIX NOT ON MAIN"); it sits on
  `origin/wave400/audit` @ `402e62a7ee5eed8e8b73a911ab67c71ca5af2e9d`.
- Conclusion: the known CODEOWNERS/workflow exfiltration hole remains OPEN,
  exactly as documented in gate-g5-exfil-hole.md. Already tracked; no new
  BUG CONFIRMED posted.
