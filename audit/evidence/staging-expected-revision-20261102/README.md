# Isolated staging candidate revision gate

Base `2ebce68b3c556f313476716afdae84f2a2b33e6d`; red `471c8d136`, source `025729bb1`.

Candidate staging deliberately deploys a reviewed branch SHA before main integration. The existing deploy-lag ancestry check classified that valid candidate as diverged. Optional expectedRevision now applies ONLY to explicit isolated mode on a non-production origin, validates a canonical 40-character lowercase hexadecimal SHA, and requires a successful valid version response to equal it exactly. A wrong revision is a hard deploy_revision_mismatch failure. A failed or malformed version response remains unverified and fails. No prefix matching or main-ancestry requirement substitutes for equality.

CLI: ROOM_SMOKE_EXPECTED_REVISION carries the exact SHA; staging.yml supplies github.sha. Passing this option outside isolated mode is a configuration error before network requests. Production defaults and isolated calls without an expected SHA retain existing GitHub ancestry/deploy-lag behavior. Discovery origin isolation, redirect refusal, signing configuration, endpoint checks, public page checks, optional browser checks, CSP/overflow/axe gates and artifact upload behavior remain unchanged. The new mode proves the staging candidate version, not canonical production availability or production deployment.

Red focused staging tests: 6 pass / 4 fail before implementation (ignored expected SHA and missing workflow binding). Final combined staging isolation, actual CLI smoke and staging configuration: 21/21 pass, 0 skips. Controls cover a non-main candidate equality pass without GitHub ancestry calls, wrong-SHA failure, invalid configuration and version responses, actual CLI environment wiring, production-mode option refusal, default ancestry/staleness, broken/redirected advertised routes and existing browser CSP failure classification. No actual browser run or remote staging/deployment was performed by this lane.

Targeted ESLint 0 errors / 0 warnings. Whole-tree secret scan 1913 files / 0 findings. Root owns final composition, workflow dispatch and deployment.
