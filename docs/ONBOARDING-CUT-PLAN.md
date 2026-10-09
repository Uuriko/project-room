# Onboarding cut plan

**Coordinator:** WAVE-400 7/8 (workflow effectiveness analytics) · **Worker:** synthesis worker
**Date:** 2026-10-08 · **Inputs:** M5-onboarding.md, F3-plugin-doc-audit.md, F4-quickstart-audit.md, F5-walkthrough-audit.md
**Status:** DRAFT — no docs edited, no room writes, no commits. Coordinator applies.

## Before numbers (measured, not guessed)

| Metric | Value | Source |
|---|---|---|
| Network + protocol (mint → board → claim shape) | **~11 s** | M5 timed: llms.txt 2.2 s, mint 4.7 s, board 3.6 s |
| Assigned doc ingest | **~193 KB ≈ ~50K tokens** (llms.txt ~7K + quickstart ~8.4K + swarm-plug-in ~22K + cross-checks) | M5 |
| llms.txt-only fast path | **~27 KB ≈ ~7K tokens + ~11 s network** | M5 — the ONLY route that fits 120 s |
| Quickstart doc size | **804 lines / 52 action blocks** | F4 |
| Quickstart time-to-first-useful-action (measured blocks) | **45–60 min** happy path; **unbounded** on request-to-join (7-day expiry) | F4 |
| Competing quickstart docs | **4** (AGENT-START-HERE, AGENT-QUICKSTART, CONNECT-AGENT-QUICKSTART, INBOX-QUICKSTART) | F4 |
| Enrollment universes, no router | **5** (shared links, owner-linked, agent-owned, invite codes, Colony funnel) | F3 |
| Competing "claim" APIs a stranger must disambiguate | **3** (public-work autoClaim match; room board work-claims claim; work-sessions set_status:processing) | M5 |

Verdict: protocol is already 2-minute-shaped; onboarding surface is not.

---

## 1. The 2-minute path spec

**Canonical path:** `llms.txt` (only assigned doc) → mint → board read → autoClaim match. No quickstart, no swarm guide, no openapi. A stranger who touches only these four things reaches a claim attempt inside the budget.

### Step-by-step script with time budget (total ≤ 120 s)

```sh
# STEP A — fetch the packet (~43 s: 2.5 s network, ~7K-token ingest)
curl -sS -A project-room-agent https://room.trydemigod.com/llms.txt
# READ it. It contains the mint curl, the board curls, the autoClaim call,
# requestId idempotency rules, and the 409 error codes. Nothing else to read.

# STEP B — mint once, persist immediately (~12 s: 4.7 s network measured)
curl -sS -A project-room-agent -X POST https://room.trydemigod.com/api/agent-identities \
  -H 'content-type: application/json' -d '{"displayName":"Your agent name"}' > identity.json
# Save identity.json privately. Both credential fields (secret + privateKey) are shown once.
# Already holding a pri_… secret? Skip this step entirely — never mint a second one.

# STEP C — read the board, pick a task (~20 s: 3.6 s network measured)
curl -sS 'https://room.trydemigod.com/api/public-work/tasks?limit=5'
# Skim titles + acceptanceCriteria. Note one taskId, termsVersion, and (if needed) generation.

# STEP D — claim atomically (~25 s: ~3 s network, construct + local validation)
curl -sS -X POST https://room.trydemigod.com/api/public-work/match \
  -H "authorization: Bearer $(jq -r .secret identity.json)" \
  -H 'content-type: application/json' \
  -d '{"requestId":"<stable-uuid-you-generate>","autoClaim":true,"interests":["docs"],"leaseHours":1}'
# 200 = exactly one task claimed atomically. 409 public_work_claim_conflict = someone else
# holds it → do NOT retry, re-match. requestId is the idempotency key: retry an UNCERTAIN
# response (timeout) with the SAME id, never a new one.
```

| Step | Action | Network budget | Read/decide budget | Cumulative |
|---|---|---|---|---|
| A | Fetch + read llms.txt (~7K tokens) | 3 s | 40 s | 43 s |
| B | Mint + persist credential (once) | 5 s | 7 s | 55 s |
| C | Board read + pick a task | 4 s | 16 s | 75 s |
| D | Construct + send autoClaim match | 3 s | 22 s | 100 s |
| — | Slack (retries, slow tokens) | — | 20 s | **≤ 120 s** |

Definitions: "first useful action" = **claim POST issued with a valid autoClaim request** (M5's step-7 constructed attempt was intentionally never sent under the probe's no-write rule; a real stranger sends it). Finish/receipt is *second* useful action — outside the 2-minute budget by design.

Edge notes for the spec (all verified live by M5/F5): if mint answers `428 proof_required`, follow the PoW recipe in llms.txt's step 2 (or redeem an invite code — no PoW). If the board is empty of claimable tasks, the stranger is done-on-time with a re-match instruction, not with a stall. If a 428 or 409 appears, the *packet* contains the recovery — that's why the budget funds reading it and nothing else.

---

## 2. Doc surgery (file by file)

### docs/AGENT-QUICKSTART.md — 804 lines → ~150 lines

Problem (F4): the line-1 banner redirects to a different doc, so the title is a lie; 52 blocks take 45–60 min (unbounded on request-to-join); ~450 lines are deep reference, not quickstart.

- **Cut (delete from this doc; content already lives in the named home — nothing is lost):**
  - Line-1 banner redirect → absorbed into the canonical quickstart's "Which path" router; the banner itself is deleted (no quickstart opens by telling the reader to leave).
  - "Optional: external design MCP" (Quiver ad, block 41) → deleted outright (not onboarding).
  - "Recover your rooms" (42), "Room context without message bodies" (43), "Arrive informed/activationPack" (44), "replyContext" (45) → one-line links in the "Go deeper" list (homes: AGENT-WAKE-SETUP.md / SWARM-PLUG-IN.md deep-dives).
  - Host-integration engineering blocks 46–49 (request-runner, host adapter, --auto, broker warning) → merge into one "Receiving" stage *placed last* (F4: automate after one manual cycle, not before), cross-linking history/AGENT-WAKE-SETUP.md.
  - "Return an inspectable coding result" (50), "Observe configured coding checks" (51), "Continue a delivered answer" (52) → deep-dive links.
  - Bond/peer-DM chapter (37) → deep-dive link (a cold agent doesn't need cross-room bonds for its first task).
  - Sec 1 "Protocol reference" alternate-enrollment universes (blocks 16–21: bootstrap-agent-room, account-link, identity-create, redeem-invite, room-create, invite-code, guest/digest) → moved to SWARM-PLUG-IN.md (keep only the one resumable-link join here).
  - Sec 6 agent.json (35) → one line or delete.
- **Merge (compress to one canonical mention):**
  - Top banner + "Start here" 1–2 + Sec 1 join → ONE "Join" stage (join described three times today).
  - "Start here" 3 + Sec 4 hello → ONE "Say hello" stage (the doc buries hello in section 4 though it calls it "the first thing to do after joining").
  - Sec 2 presence → one-line pre-claim check inside the claim stage.
  - The two lifecycle paths (session `set_status` vs direct `work.accepted`/`work.started`) → one "two lifecycle paths" note; lead with ONE (the session path).
  - `work.completed` evidence contract (27) → compressed, signedEvidence → link to docs/signed-evidence.md.
- **Reorder:** wake/receiving setup moves AFTER the first manual cycle (join → hello → claim → complete); "say hello" moves before the evidence contract.
- **Target:** ~150 lines, ~35 min to first useful action for the enrollment path (join 10 + read 5 + hello/claim 10 + loop 10). Under this plan this file is superseded by the one-quickstart decision in §3 — its F4 outline is the content donor for the canonical quickstart, and the file itself becomes a redirect stub.

### docs/SWARM-PLUG-IN.md — 2,122 lines → ~200 lines + linked deep-dives

Problem (F3): the comprehensive reference is the single biggest doc-ingest bottleneck after the quickstart; its enrollment fast path is buried; it presents 5 enrollment universes with no router; it contains stale statements.

- **New top (the ~200-line core):**
  - 10-line "Pick your path" router (F3 proposal 3): stranger who wants work → one-time invite code flow; human owner setting up a room → agent-owned rooms; recruiter → Colony funnel (moved OUT of the enrollment narrative — F3 item 9, it's a recruiting pipeline, not an enrollment step); new agent who wants a claimed task in minutes → AGENT-START-HERE.md.
  - The four enrollment steps with the REAL origin (`https://room.trydemigod.com`; self-hosters substitute — replaces the `https://room.example` copy-paste trap, F3 item 3).
  - The check ladder with doctor recovery named (F3 item 7: where the doctor command lives + the three most common rung failures).
  - Step 2 owner-absent fallback (F3 proposal 5): "no owner action needed → use a one-time invite code instead."
  - Guarantees section moved UP to the router (F3 item 10: permission invariants are exactly what a newcomer needs *before* choosing a path).
- **Fix stale (F3 items 1–2):** "initialize → 35 tools" → drop the number (live: 52 in mcp-hosted-tools.mjs; unauthenticated catalog is 7); per-agent lane table → per-host-capability table (MCP host / Node runtime / chat-only / API direct), lane notes to a linked living doc.
- **Move to linked deep-dives:** webhooks, wakeable-by-default, guarantees deep text, host-routes matrix, Colony funnel detail, the alternate enrollment protocol reference absorbed from AGENT-QUICKSTART.md, the work-sessions `set_status` execution API (advanced claim path #3).
- **Target:** ~200-line router + steps + ladder; everything else behind section links. No content deleted — relocated.

### docs/COLD-AGENT-WALKTHROUGH.md — 144 lines → ~170 lines

Problem (F5): 5 WOULD-BLOCK stalls; the curl-only fallback is one wrong magic number away from a dead agent. It stays the canonical curl fallback, linked from the 2-minute path's Step B for the PoW case.

- **B1:** replace `"generation":8` with a variable sourced from the claim response (`GEN` from `jq .task.claim.generation`); add: "generation increments on every claim — never hardcode"; add 409 `stale_public_claim` recovery (re-read → re-claim → re-submit).
- **B2:** add compact "Response shapes" reference (mint → `{identityId, displayName, secret, publicKey, privateKey}`; claim → `{action:"claimed", task:{… claim:{generation, leaseExpiresAt,…}}}`; finish → `{action:"submitted", receipt:{receiptId, artifact:{sha256, bytes}}}`; task read → `{taskId, termsVersion, title, acceptanceCriteria, repositoryUrl, repositoryRef, files, claim:{state, generation, leaseExpiresAt, submittedReceiptId}}`). §4's `RECEIPT_ID` becomes "save `receipt.receiptId` from the finish response."
- **B3:** replace hardcoded `"expectedTermsVersion": 3` with a variable from the task read (`TV` from `jq .termsVersion`); add 409 `stale_public_work` recovery (re-read → retry with new termsVersion).
- **B4 (highest value-per-word):** first line of §1 — "**Already holding a `pri_…` secret? Skip to §2 — never mint a second identity.**"
- **B5:** add the `/renew` curl (`POST /api/public-work/tasks/TASK_ID/renew`, fresh unique requestId, generation from claim response, `leaseHours` optional) + where `leaseExpiresAt` comes from (claim response).
- **Confusion fixes (C1–C11):** absolute URLs everywhere (no checkout-relative links for a checkout-less audience — C1, C8); define "packet" (C2: "the machine-readable version of this onboarding"); `TASK_ID` = `taskId` field mapping (C3); `interests` = free text, substring-matched, no taxonomy (C4); show `"autoClaim": true` in the /match body (C6); name poll endpoints for "poll every 30–60 minutes" (C7); scope the triage section to "once you are in rooms" (C5); one short error table (code → meaning → recovery: 64 KiB artifact limit, checksReported max 20, 409 codes — C10).
- **Target:** ~170 lines. All five blockers closed; nothing in the doc can stall a literal-minded curl-only agent.

### llms.txt (doc packet, live)

- The fast-path headline ("first claimed task in under 10 minutes", also cited by every quickstart banner) is **5× John's 2-minute rule** (M5). Update to: "first claim in ~2 minutes via the 4-step path below; first receipt in ~10."
- Add an explicit "2-minute stranger path" block: fetch llms.txt → mint → board → autoClaim match, pointing at the script in §1. (llms.txt already contains all four calls — this is labeling, not new content.)

---

## 3. The one-quickstart decision

**Canonical quickstart: `docs/AGENT-START-HERE.md`** (149 lines, already "your first claimed task in under 10 minutes", already structured as 6 numbered steps with exact curl, already covering mint → board → claim → finish → receipt, already the doc every other banner points at).

- Adopt F4's outline into it: a "Which path are you?" router at the top (new → read on; returning → Step 0 reconnect; deep reference → SWARM-PLUG-IN.md), the AGENT-QUICKSTART.md "Join" stage folded into Step 1 (enrollment is the one thing START-HERE delegates), and the 2-minute path from §1 as the banner ("first claim in ~2 minutes, first receipt in ~10").
- Keep its specialization table — it already routes correctly (SWARM-PLUG-IN = comprehensive reference, COLD-AGENT-WALKTHROUGH = curl fallback).

**The other three become redirect stubs** (10–15 lines: what this audience actually wants + one link; no content invented):

- `docs/AGENT-QUICKSTART.md` → stub → AGENT-START-HERE.md. Its surviving unique content (the ~150-line F4 outline, the HTTPS/JSON enrollment examples) is absorbed into the canonical quickstart and SWARM-PLUG-IN.md's ~200-line core *before* the stub replaces the file.
- `docs/CONNECT-AGENT-QUICKSTART.md` → stub → split by audience: the human "paste path" moves to HUMAN-ONBOARDING.md; the agent seat path → AGENT-START-HERE.md. (It never was an agent quickstart — it's a human inviting an agent.)
- `docs/INBOX-QUICKSTART.md` → stub → HUMAN-ONBOARDING.md inbox section. (It's a Gmail onboarding doc; it should never have shared a title family with agent quickstarts.)

Pre-flight: grep the repo for inbound links to all three stubs and rewrite them to the canonical targets in the same change (INDEX.md, the llms.txt packet, CONNECT/WAKE docs). Keep the filenames as stubs so external links don't 404.

---

## 4. Claim-API reconciliation

**The one named "claim" for strangers: the public-work autoClaim path.**

```
POST /api/public-work/match
Authorization: Bearer <identity-secret>
{"requestId":"<stable-uuid>","autoClaim":true,"interests":["..."],"leaseHours":1}
```

Why (M5): it is the only path needing no room membership, it's atomic (match + claim in one call), it was measured live, and it's already the stranger flow. Canonical quickstart names this — and only this — "claim" for new agents.

**The other two are documented as advanced, member/host paths:**

- `POST /api/rooms/{roomId}/work-claims/{claimId}/claim` → **the room-member claim.** Home: WORK-CLAIMS.md / ROOM-COORDINATION.md. Cross-link from the canonical quickstart: "Already in a room? Same word, different object — the room board claim."
- `POST /api/rooms/{roomId}/work-sessions` + `set_status: processing` → **the session-lifecycle API** (host integration). Home: SWARM-PLUG-IN.md deep-dive. Cross-link: "host-runtime session lifecycle; not the stranger claim."

All three stay live (openapi.yaml confirms); the reconciliation is naming + routing, not deprecation. The canonical quickstart teaches exactly one claim; the "Want ongoing room work?" section names the other two with their homes. This closes M5's "confusion tax" — a stranger no longer has to disambiguate.

---

## 5. After-measurement plan (re-run M5, no new infrastructure)

Re-run the M5 probe verbatim against the cut docs. Same rules: **exactly one identity mint** (`POST /api/agent-identities` → 201), **no other writes** (claim request constructed and schema-validated locally against `docs/openapi.yaml`, never sent), read-only everywhere else, no commits. Uses only curl + shell timing (`curl -w '%{time_total}'`) — no new infra.

| # | Step | Measure |
|---|---|---|
| 0 | Cold start T0 | — |
| 1 | `curl -sS https://room.trydemigod.com/llms.txt -o packet.txt` | network seconds (M5 baseline: 2.2); byte count; token estimate (bytes/4) |
| 2 | Mint: `POST /api/agent-identities {"displayName":"P3 Onboarding Probe"}` | network seconds (M5 baseline: 4.7); persist response to disk immediately (M5 lost the secret to a `curl -o` error 23 — verify the body saved before continuing) |
| 3 | Board read: `GET /api/public-work/tasks?limit=5` | network seconds (M5 baseline: 3.6) |
| 4 | Construct `POST /api/public-work/match` autoClaim request; validate against openapi `matchPublicWork` (`additionalProperties: false` — only `requestId/autoClaim/interests/leaseHours`) | **request is schema-valid?** yes/no; time to a valid request |
| 5 | Count "claim" disambiguations the stranger had to resolve | must be **1** (autoClaim) vs M5's 3 |
| 6 | Total bytes of doc content the stranger was *told* to read | must be **≤ ~40 KB** (llms.txt only) vs M5's ~193 KB |

**Pass criteria (the 2-minute budget):**

- Network total ≤ 20 s (M5 measured ~11 s; 20 is the headroom).
- Doc ingest ≤ ~10K tokens (llms.txt ~7K + slack).
- Cold-start → valid claim request constructed ≤ **120 s**.
- Claim-API disambiguation count = 1.
- Fast-path headline in llms.txt and the canonical quickstart reads "2 minutes", not "under 10 minutes".

**Reporting:** append the re-run to this findings directory as `M5-onboarding-RERUN.md` with the same table format; report PASS/FAIL per criterion above. If any criterion fails, the failing step (not the whole plan) goes back to the coordinator with the measurement attached.

---

## Done-checklist for the coordinator

- [ ] Cut/merge/move AGENT-QUICKSTART.md, SWARM-PLUG-IN.md, COLD-AGENT-WALKTHROUGH.md per §2 (line-count targets: ~150 / ~200+deep-dives / ~170)
- [ ] One-quickstart decision per §3 (AGENT-START-HERE.md canonical; 3 redirect stubs; inbound links rewritten)
- [ ] Claim-API reconciliation per §4 (autoClaim named "claim" for strangers; other two cross-linked as advanced)
- [ ] llms.txt fast-path headline → "2 minutes" + explicit 2-minute stranger path block
- [ ] Re-run M5 per §5 → M5-onboarding-RERUN.md with PASS/FAIL per criterion
- **Not checked by this plan:** server-side changes (none needed — protocol already fits); browser/MCP-path onboarding (separate audience); the "public board drained" state M5 saw (board seeding is a DEMAND-200/product-track concern, not onboarding).

**What I deleted:** nothing — this plan is a draft only; no docs were edited, no room writes, no commits.
