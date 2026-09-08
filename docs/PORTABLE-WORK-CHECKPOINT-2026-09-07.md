# Portable work — local checkpoint

September 7, 2026 · Implementation phase 1 of the [research and implementation plan](PORTABLE-WORK-PLAN-2026-09-07.md).

## Built

- **Details → Use my AI:** an exact, selectable prompt for one work item. A single linked source message is optional and off by default. The builder excludes other work, the member directory, session/account metadata, receipt URLs, and unrelated messages. Application keys are never included. User-written task/source text can still contain sensitive material; the preview is not a secret-scanning guarantee.
- **Copy** reports only clipboard success. Permission failure offers selectable manual copying. No provider launch, model call, network handoff, scope claim, or work mutation occurs.
- **Add result:** a returned `ROOM-RETURN` reference and up to 4000 characters of proposal text. Normal authentication identifies the submitting Room member; outside authorship stays unverified. The command checks the particular work revision atomically. Older context requires explicit acknowledgment; a future revision is rejected. Unrelated conversation does not invalidate the proposal.
- The existing command ledger provides exact retry deduplication. A lost response locks the original payload for retry. Closing/reopening keeps drafts and uncertain commands in session-owned memory. Sign-out, access loss, or reload clears them; leaving with only a portable draft also warns. No browser-storage persistence was added.
- The proposal becomes a work-linked message, with original basis and submission revision. It does not change work state/revision, accountable membership, claims, receipt, review, approval, or caught-up cursor.
- The authenticated agent client has `workPacket(workId)`; the read-only inbox CLI adds `packet WORK_ID`. They share the browser's allowlisted packet model. This is not a new MCP server, runtime launcher, or externally enforceable permission system.
- Sign-in help now distinguishes an ordinary room link from access and explains guest rejoining without inventing identity recovery.

The site-building guidance influenced progressive disclosure, accessible controls, reflow checks and reuse of the existing app rather than a new platform. Existing Cloudflare architecture, identity model and schema v7 are preserved.

## Verification

**239 core/API tests, 60 browser scenarios and six local Cloudflare checks passed.** The final stricter work-reference validation also passed the complete core suite; the final screenshot/portable-only sign-out assertions passed both focused browser journeys. Syntax and whitespace checks passed.

New tests cover selected-only export, strict opt-in and timestamp values, parser bounds/unknown fields, partial/null metadata, inert markup, authenticated submitter, stale/future basis, identical retries after work changes, multiple proposals per packet, supersession, replay and unchanged workflow/cursor state. Cloudflare's shared-store fixture exercises stale rejection, explicit older proposal, retry, persistence and rebuilt projection.

Desktop and emulated touch journeys exercise real clipboard writing, denied-clipboard fallback, source selection, Enter versus touch Return, retained draft, stale return, a **server-committed response deliberately dropped by the browser test**, close/reopen with exact retry, inert HTML, focus restoration, 200% text and reachable submit control, isolated portable-draft sign-out warning, and late clipboard resolution after logout. No third-party request was observed. Six synthetic viewport screenshots are retained locally:

- `test-results/portable-desktop-packet.png`
- `test-results/portable-desktop-stale-return.png`
- `test-results/portable-desktop-large-text.png`
- `test-results/portable-mobile-packet.png`
- `test-results/portable-mobile-stale-return.png`
- `test-results/portable-mobile-large-text.png`

These are simulated human journeys, not recruited-user interviews or physical-device certification. Chromium 151 resets touch emulation during screenshot capture; the test explicitly restores touch emulation before checking keyboard semantics. The existing local Workers browser test emits self-signed-certificate probe warnings, but its real two-browser/SSE/restart assertions passed; no production trust policy was changed.

One fresh-context Codex participant received the actual synthetic exported packet and wrote an original agenda proposal. Its unchanged answer is retained in [portable-agent-2026-09-07.txt](evidence/portable-agent-2026-09-07.txt). Importing it records the human importer as author with manual-unverified provenance; it does not assign its proposed owner or manufacture a completion. Re-running the artifact test replays that captured answer; it does not invoke a model each time. Separate HTTP tests use scripted clients and are labelled accordingly.

Three read-only research/review lanes helped identify and fix strict opt-in handling, timestamp validation, uncertain-save editing/duplicate risk, draft lifetime, exact focus restoration, and guest recovery copy. Screenshots caught an oversized checkbox; browser checks caught a hidden status message. All were corrected before checkpoint.

## Release boundary and next work

**Local only. No push, deployment, hosted room write, DNS, account/provider configuration, payment or hosted inference change was made for this checkpoint.** Recorded live application remains `fb90a70`, Worker `901be347-7a39-4b56-8777-f4052bf81b38`, on the existing staging origin. Remote branch/PR23 remain at the prior published checkpoint until a separately authorized release.

Public asset allowlists now include 12 files. No database schema migration occurred. Nevertheless, older app code rejects the proposal command fields and may omit the proposal decoration during replay while keeping message text. Prefer a feature-aware roll-forward repair rather than claiming full feature fidelity after an older-code rollback.

Next: phase 2 private durable in-app reminders, with a separate request-receipt ledger and reviewed schema-v8 Node/Cloudflare fences. A v7 app is not a rollback for a migrated v8 database. Then build the explicit notify-only watcher with a separate processing checkpoint. Off-app notification delivery, autonomous execution, paid AI, recovery authenticators and final-domain/passkey policy remain separate choices/gates.
