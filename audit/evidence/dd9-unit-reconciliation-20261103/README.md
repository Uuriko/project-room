# Exact dd9 CI failure reconciliation

CI run [41737780046](https://github.com/Uuriko/project-room/actions/runs/41737780046), unit artifact [13282237579](https://github.com/Uuriko/project-room/actions/runs/41737780046/artifacts/13282237579), source `dd9f34d324ad32eb359bd48d7eb6eafa98dfc14b`. Compared against exact candidate `23a8936d504e44ecdcde6fb0d801fd531ac4cbad`; test-only repair `135354b554717d859a4ebed5cbd3dfbd290ce69e`.

JUnit contains **28 failing unit cases**. The runner's JSON failures array lists only the 20 upgrade names; use the complete JUnit for reconciliation. Exact case names, files and mappings are in failure-mapping.json.

| Cases | File / cause | Adopted candidate repair / proof |
|---|---|---|
| 20 | agent-upgrade: genuine v8 through v27; nullable draft lineage was an undocumented-to-fixture added field | f2ac2cf6a; existing main-ci-contracts-20261103 receipt records 62/62 focused greens, original values/NULL/auth/fences retained |
| 2 | current-scoped-inbox: forced nextRead at limit5 despite legitimate hidden47 skip | Still reproduced on exact23a; repaired here with complete47 and actual limit1 continuation controls; affected file4/4 greens |
| 1 | normalized-agent-work: nine invisible requests now fit bounded refill | f2ac2cf6a; positive empty/privacy preserved, partial refusal moved beyond fixed maximum to33; same existing62/62 receipt |
| 1 | mcp-public-context-recovery: formerly excessive public preview is now legal | 31c573dd2; actual sanitized positive plus targeted optional-preview fault; existing restart-ci-contracts-20261103 receipt16/16 greens |
| 1 | mcp-search-actions: old full tool count123 vs124 with wait tool | 31c573dd2; exact tool membership and uniqueness; same existing16/16 receipt |
| 2 | room-acp-restart: second ordinary reply inside local60s suppression | 31c573dd2; injected reservation clock only, original session/load/uncertain tests retained; same16/16 plus28 neighbor proof |
| 1 | room-roster: brittle obsolete presenceLabel import string | f2ac2cf6a; actual observedPresenceLabel named import, exact roster retained; same62/62 proof |

Thus 26 cases map to already adopted repairs and existing source-pinned evidence; they were **not rerun in this lane**. The remaining two were actually rerun and failed at their original assertions. The limit5 response already contained every expected useful item and no private sentinel, with cursor after47/hasMorefalse/nextReadnull. Standing mention coverage remained explicitly incomplete with its own room-scoped pointer. This is a test contract mismatch, not evidence of a runtime defect.

The repair keeps exact useful IDs, private negative, cold reopen, revoked key, scope and no-operator-write assertions. It verifies complete47/null conversational continuation at limit5, then traverses real emitted limit1 pointers to complete47 with monotonic progress and each addressed conversation item exactly once. HTTP derives its route/query directly from emitted room_read_inbox arguments; MCP calls that emitted tool/arguments verbatim. No fake HTTP action path is claimed. Standing mention incompleteness remains checked. No runtime, manifest, cap or grant change.

## Worker/browser counts

There are **two additional direct failing cases**, not four:

- Worker: `actual Worker projects bounded historical message envelopes before unrelated HTTP catch-up, including cold reopen` — old one-atom counter assertion; candidate contains 6e5a3eb1f's exact source-atom/lookahead reconciliation. Not rerun here; source presence is not a new Native pass claim.
- Browser: `refresh after expiry ends at actionable sign-in` — old English regex; f2ac2cf6a uses the authoritative localized copy with original actionable controls. Existing main-ci-contracts receipt has actual Chromium1/1 proof; no browser rerun here.

Four additional failed jobs after unit are cloudflare, browser shard4/6, browser aggregator and test aggregator. The last two are failed dependencies, not extra test cases. Direct failed-case total across these logs is30:28unit+1Worker+1browser.

## Commands / scope

```sh
gh api repos/Uuriko/project-room/actions/artifacts/13282237579/zip > /tmp/dd9-unit-artifact-13282237579.zip
node --test --test-name-pattern='^(actual five-scope API-key HTTP inbox traverses overlapping obligations without leaks/duplicates and survives cold reopen|MCP inbox continuation can be called verbatim)$' tests/current-scoped-inbox.test.mjs
node --test tests/current-scoped-inbox.test.mjs
node node_modules/eslint/bin/eslint.js tests/current-scoped-inbox.test.mjs
node scripts/secret-scan-diff.mjs --files tests/current-scoped-inbox.test.mjs
```

Node v24.22.1. Before2/2 fail; after4/4 pass, zero skipped. Lint/secret/diff checks exit zero. No historical full suite, Native, concurrent burst or browser suite was run. No Root tree or live state changed. This is not a claim that a fresh full candidate CI run is green. Archive and JUnit hashes, exact mappings, raw-byte log hashes and compressed targeted logs are adjacent; the large original artifact is not duplicated in the repository.
