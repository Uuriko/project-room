## VERDICT (2026-10-08, guild-17)

**Hole is STILL OPEN on main — verified, not re-filed (already BUG CONFIRMED).**

1. `.github/CODEOWNERS` does not exist on `origin/main` (checked at b53c52af1).
2. No `jill/codeowners-workflows` branch exists. BUT: a fix commit DOES exist —
   `b42febd80` "Add CODEOWNERS gate on .github/workflows/ (workflow-integrity fix)",
   authored by jill 2026-10-08 18:31 UTC — sitting on **`origin/wave400/audit`**
   (also `upstream/wave400/audit`), **NOT merged to main** (`git merge-base
   --is-ancestor b42febd80 origin/main` → NOT-ON-MAIN).
3. The fix is also only HALF a fix: its own commit message says it "takes effect
   once branch protection enables 'Require review from Code Owners' (admin
   setting)" — and branch protection currently has
   `require_code_owner_reviews: false`. So even landing the file alone would not
   close the hole; it needs John's/admin tap on the setting (per MEMORY rules,
   a settings change needs John's tap — flagged, not acted on).

### Exploit sketch (verified end-to-end at the config level)

1. Attacker opens a PR that edits `staging.yml` to add a step posting
   `${{ secrets.CLOUDFLARE_API_TOKEN }}` to an external endpoint.
2. PR needs: required checks green at head (test/contract/lint/browser/cloudflare —
   attacker writes code that passes), conversation resolution, NO approval
   (`required_approving_review_count: 0`, reviews advisory per #1786).
3. Merge. On the merge push, GitHub runs **the workflow file from the merged
   commit** — `staging.yml` has `on: push: branches: [main]` and injects
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ROOM_AGENT_CARD_SIGNING_KEY`
   into its jobs (staging.yml lines 33-34, 67-69). The exfil step runs with the
   real secrets.
4. Blast radius of CLOUDFLARE_API_TOKEN: Workers scripts/routes edit on the
   account (production worker rewrite); ROOM_AGENT_CARD_SIGNING_KEY: agent-card
   signing key (identity spoofing surface per docs/AGENT-CARD-CUSTODY.md).

### Correction to §4 above
`trace-entry.yml` and `zero-bug-quarantine.yml` do NOT run on push to main
(the grep matched "push" in comments). Verified push-to-main workflows:
**test, schema-gate, mime-fuzz, mcp-registry-publish, machine, relay, staging.**
Of these, the ones with secrets in post-merge runs: **staging** (deploy secrets,
above), **mcp-registry-publish** (id-token:write, scoped to MCP registry publish
— narrow), **test** (GH_TOKEN read-scoped only), **machine/relay/schema-gate/
mime-fuzz** (no secrets injected).

### What WOULD close it
Merge `b42febd80`'s CODEOWNERS (or the wave400/audit branch's version) AND flip
`require_code_owner_reviews: true` on main's protection (admin/John tap).
Additionally/alternatively: remove deploy secrets from the push-triggered
`staging.yml` path (dispatch-only deploys), which the fix commit's message also
implies.
_head 6efe5fdbe_

## 1. CODEOWNERS present?
  NO .github/CODEOWNERS — still absent

## 2. jill/codeowners-workflows branch or merged fix?
  (no such branch on origin — checked 2026-10-08)

## 3. Any merged PR adding CODEOWNERS since 2026-10-07?
b42febd80 Add CODEOWNERS gate on .github/workflows/ (workflow-integrity fix)
7b11094ea Add CODEOWNERS gate on .github/workflows/ (workflow-integrity fix)
  (none)

## 4. Push-to-main workflows (post-merge execution surface)
  - machine.yml
  - mcp-registry-publish.yml
  - mime-fuzz.yml
  - relay.yml
  - schema-gate.yml
  - staging.yml
  - test.yml
  - trace-entry.yml
  - zero-bug-quarantine.yml

## 5. Secrets available to a post-merge push run (what exfil would reach)
              echo "trace-entry: secrets.TRACE_ENTRY_TOKEN is not set."
            ADOPTION_SEARCH_TOKEN: ${{ secrets.ADOPTION_SEARCH_TOKEN }}
            ANALYTICS_INGEST_TOKEN: ${{ secrets.ANALYTICS_INGEST_TOKEN }}
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
            CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
            CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
            GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            GH_TOKEN: ${{ secrets.TRACE_ENTRY_TOKEN }}
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
            PERPLEXITY_API_KEY: ${{ secrets.PERPLEXITY_API_KEY }}
            ROOM_AGENT_CARD_SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
            ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
            ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
            ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}
            ROOM_RECEIPT_TOKEN: ${{ secrets.ROOM_RECEIPT_TOKEN }}
            SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
            XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
        - run: node scripts/scan-secrets.mjs --base "$BASE_SHA"
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
