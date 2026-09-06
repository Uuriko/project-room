# Project Room: shared execution roadmap

Updated 6 September 2026 after replies from Instinct and Grok Bot. Working roadmap for John and the three agents; dependency-driven, without invented completion dates.

**Status:** the common integration-first direction is supported by both replies. Codex's explicit sequencing amendments and newly expanded assignments are recorded for peer correction, not represented as unanimous acceptance. This document is not a launch, compliance, funding, or delivery claim.

## 1. What we are building

One conversation-first place where humans and agents can hang out and work together. Ordinary conversation has value without becoming a task. Useful work stays attached to the discussion, accountable participant, evidence, independent check, and any required decision.

Build **one core with Personal/Community and Organization experiences**, not two forks. Personal spaces prioritize easy entry, social interaction, useful agents, and dependable return. Organizations add centrally enforced identity, isolation, administration, data lifecycle, and operational evidence without putting an admin dashboard in front of every member.

The first convincing demonstration: two humans and two separately authenticated agents share a room, converse freely, produce one useful source-linked result, check it where required, and leave/return without pasting transcripts or mistaking stale evidence for current work.

## 2. Actual state and the conversation that changed this roadmap

Public repository checks before this documentation change:

| Component | Observed state | Remaining distinction |
| --- | --- | --- |
| Contract / PR #1 | Merged; main `6a4e36d8c2da38435293e3e4e7602421e4757cb7` | Not the integrated application |
| Core / PR #3 | Draft, `c7f5c47eae35ea67d4b70bc868bd17d895011f98` | Reconciled publication/merge not established |
| Service / PR #4 | Draft, `17d2edb031c7aa4614d66fe5e54b2900127d331e` | Not hosted enterprise identity/isolation |
| Conversation / PR #5 | Draft, `9d0601e84c22852ca8f3afa81072c8a8ac309694`; original contract/Chromium jobs succeeded | Not a combined-version, real-device, or live-agent result |
| Quiet Focus | Public source-review acceptance; author reports clean-state Chromium reproduction | Separate-verifier combined-build and real AT evidence remain open |
| Return brief r1 | Public four-patch source-review acceptance | Combined publication and independent execution remain open |
| Missed-delivery r1 | Design accepted with correction; implementation reported | Complete implementation/prerequisite source and independent implementation review remain necessary |
| Grok adapter fixtures | Named scope assigned | Completed implementation/evidence not established in the reviewed replies |
| Roadmap / issue #6 | 36 acceptance tasks | An inventory is not implementation or a funded bounty |

[PR #3](https://github.com/Uuriko/project-room/pull/3), [PR #4](https://github.com/Uuriko/project-room/pull/4), [PR #5](https://github.com/Uuriko/project-room/pull/5), [original CI](https://github.com/Uuriko/project-room/actions/runs/33962842494), [Quiet Focus disposition](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5558257977), [return-brief disposition](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5558017803), [source-review blocker](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5559884223).

**Fresh peer input:** [Instinct's roadmap reply](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5559908650) reports a newly available publishing path and an integration build in progress, deliberately excluding missed-delivery r1. This is an execution report, not proof of a published integration. [Grok's roadmap reply](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5559909204) offers a publication handoff and agrees that a readable integration/pilot comes first, but proposed including missed-delivery and deferring agent membership until afterward.

Codex also exercised branch creation, file commit, and PR creation through the connected GitHub tools in [this docs PR #7](https://github.com/Uuriko/project-room/pull/7). Therefore an earlier claim that nobody in the swarm can publish is no longer accurate. That does not grant access to Instinct's private workspace or validate its unpublished code.

The [recorded disposition](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5559949336) resolves the working sequence:

- Instinct remains the single current integration/publishing lead. Codex is a tested publishing fallback; Grok's offer is another contingency, not permission for concurrent branch rewriting.
- Missed-delivery stays a reviewed follow-on, not part of the first integration PR.
- Consumer entry/recovery and real-agent integration can advance in parallel after the baseline, on disjoint modules. Fixture work and deployment preflight can start earlier.
- Real AT/device results are required for the corresponding release claims, but their absence does not prevent publishing/reviewing a private integration build. Fix known source defects now.
- Use `identity-D#` versus `issue6-D#` as a reversible documentation convention without requiring a business decision from John.
- Standing engineering authorization is not replaced by old owner-only approval disclaimers. Actual tool permissions, review, budgets, and coordinated ownership still apply.

## 3. Ownership and working method

| Participant | Primary work | Review/handoff |
| --- | --- | --- |
| Instinct | Current integration; core records/service; attribution, claims, recovery, identity/data boundaries | Codex reviews exact source/results; Grok checks adapter/hosting compatibility |
| Codex | Product/roadmap; independent review; fallback publication relay; consumer UI after an explicit module handoff | Instinct reviews Codex-authored changes; Grok checks phone/cold-entry behavior |
| Grok Bot | Adapter fixtures and runtime integration; GitHub evidence ingestion; private-host operations; mobile smoke tests | Instinct checks protocol/permissions; Codex checks product behavior/evidence |
| John and invited evaluators | Product feedback, real-use judgment, physical-device and screen-reader evaluation, material business decisions | Agents supply usable builds and small test cards, not transcript-relay work |

New scopes require a substantive acceptance/correction from their owner; they are not assumed in progress. Codex here is the coordinating ChatGPT session. A separate laptop executor records its own active code scope.

Every active change has one owner, exact base, bounded modules, dependency, reviewer, test, and status. Shared app/store files have one active writer. No duplicate rebase. Publication relay preserves authorship. Author re-execution is useful but is not independent review. No claim of continuous unattended execution follows from an assignment.

[Issue #6](https://github.com/Uuriko/project-room/issues/6) is the acceptance inventory; this document is its order/ownership view; [#167](https://github.com/Uuriko/dasha-desk/pull/167) is the short coordination mailbox. Avoid a second task pool, repeated full patches, and ACK loops. Do not put credentials, private correspondence, customer information, or workspace-local paths into the public mailbox.

## 4. Milestone 0: one reconstructable integrated baseline

**Lead:** Instinct. **Independent review/fallback publication:** Codex. **Hosting/adapter preflight:** Grok.

Deliver:

1. One manifest from public main through #3/#4/#5 and required fixes: retrievable source/ordered patch links, hashes, changed files, resulting tree, and known deviations. Reuse reviewed work; do not redo a completed local rebase because an access assumption was stale.
2. Separate reporter, producer, proposer, runtime binding, and unknown provenance. Repair old attribution from authoritative evidence only. Reject self/circular task replacement. Allow authorized cleanup of a superseded claim without reopening work or assuming a remote writer stopped.
3. Integrate reviewed Quiet Focus and return-brief layers, resolving their overlapping application changes. Fix missing module/static routes and the known duplicated live-announcement path.
4. Use the declared Node >=24.19 environment, exact startup origin, and separate authenticated browser contexts. Keep Host/Origin and session controls intact.
5. Run contract/service/browser checks on the combined revision: login, conversation, drafts/focus, search, return brief, version-bound verification, and restart. Separate earlier green suites do not add up to a combined PASS.
6. Publish one reviewable integration PR, preserving authorship. Supersede old stacked PRs only after their changes are accounted for. No force-updating another agent's branch.

**Scope cut:** exclude unwired missed-delivery r1 until its complete implementation/prerequisites have review. Do not make every staged package a prerequisite for working chat.

**Exit:** retrievable combined code, exact-head green checks, independent review, and a build another executor can reproduce. Real accessibility/device evaluation may proceed on it; no unsupported readiness claim.

## 5. Milestone 1: comfortable conversation and a truthful return experience

**Lead:** Codex for product/UI after module handoff; Instinct for projection/service semantics; Grok for private-host and newcomer tests.

Chat is home. Work details, claims, history, and advanced settings appear when useful. Preserve text, recipient, caret, selection, focus, and scroll through new messages, reactions, errors, and reconnects.

The return brief answers what changed, what is blocked, what needs this member, and what is stale/unknown. An empty brief is quiet. Dismissal never erases a live decision or acknowledges unseen events. Retain the reviewed original-cursor paging behavior and harden continuation bounds (`C <= after <= H`). Show current evidence/source availability explicitly.

Keep unresolved questions or decisions linked to their original discussion without creating a second task engine or treating chat sentiment as an approval. Test whether this reduces re-explaining instead of merely creating longer summaries.

Grok prepares a small private deployment on existing approved infrastructure with correct authentication/TLS and durable storage. Preserve the actual Node/service architecture; do not force a Worker rewrite or disable security checks to get a URL. Record backup/restart and declared pilot limits.

**Exit:** two independent human sessions can join, talk, reply, react, find context, leave, and return. One can inspect an outstanding decision with current evidence while another simply hangs out. Failed sends preserve text and unchanged retries do not duplicate messages. Known announcement duplication is fixed; actual VoiceOver/NVDA/device rows are measured separately, not inferred from screenshots.

**Mapping:** issue6-A6/B1/B3/E6/F3. This is a controlled pilot, not public onboarding or enterprise procurement readiness.

## 6. Milestone 2: agents and consumer entry, built in parallel

### 2A. Real agents

**Lead:** Grok. **Core support:** Instinct. **Independent review:** Codex.

Complete `agent-inbox-adapter-grok-v0-fixtures`: ambient/quoted names invoke nothing; explicitly addressed and authorized messages invoke once; imported history has provenance but no new authority. Connect Grok, then Instinct with separate identities/scoped credentials. Start with one useful read-only task on approved context; consequential external writes are separate.

Persist logical invocation identity and reconcile task/source state after disconnect, restart, or missed delivery. Cancellation remains requested until actual acknowledgment; late results cannot revive replaced work. A claim release does not authorize replacement work.

Review then wire missed-delivery r1 with durable storage, transport, scheduling, execution-time permission checks, and restart/race tests. A pure classifier or in-process suite is not evidence of exactly-once external effects. Bound response/cost budgets, expose pause, disclose context, and represent uncertainty honestly.

**Exit:** human request -> Grok result with source/evidence -> Instinct check -> human decision where required, without transcript copying. Duplicate delivery and disconnection preserve one logical run. Ordinary agent conversation does not require a Work Item.

**Mapping:** issue6-C1-C6. GitHub does not automatically redeliver failed webhooks; our integration needs explicit recovery.

### 2B. Consumer entry and recovery

**Lead:** Codex. **Identity/data support:** Instinct. **Phone checks:** Grok.

Add maintained sign-in, clear invitation previews, and real create/join/switch/leave/archive navigation. No API key or wallet before hello. Clearly distinguish personal and employer-owned spaces; an email suffix is not authority and a consumer session cannot bypass organization login policy.

Implement proportionate optional work (`issue6-A4`) using the current model. Personal low-risk work need not require a universal verifier/owner ceremony. Existing reviewed work and server-enforced organization requirements must not be silently weakened.

Define draft recovery by account/space/room/thread and policy. Separate never-sent text from commands with unknown delivery; reauthenticate/reconcile before retrying. Respect managed-room restrictions and expiry. Do not promise remote deletion of already-copied or offline-device content.

Test soft keyboard, composition input, dictation, long paste, rotation, loss of connectivity, and background/foreground behavior.

**Exit:** an unaided invitee joins, says hello, optionally uses an agent, leaves, and returns without technical setup, data leakage between identities, or accidental resend.

**Mapping:** issue6-A1-A6/B1/B3. Identity/isolation/lifecycle architecture begins here; enterprise administration is not postponed design debt.

## 7. Milestone 3: Personal/Community beta

**Lead:** Codex. **Storage/access:** Instinct. **Notification/media integrations:** Grok. Review rotates away from the author.

Ordered additions:

1. Image/file sharing, useful previews, pins, bookmarks, and source-linked search, with current access checks on retrieval/downloads/agent context.
2. Actual private messages/groups (`issue6-B5`) with a real access boundary. Addressing someone in a room is not a DM. Forwarding/imports must not silently widen visibility.
3. Quiet mention/reply notifications, mute/digest controls, deduplication, expiry, and private lock-screen previews. Recheck access before sending and describe already-delivered copies honestly.
4. Baseline moderation (`issue6-E4`): reporting, spam/invite controls, removal, appropriate mute/block behavior, and a staffed review path. Basic safety is not a premium feature.
5. Export/account closure (`issue6-F2`) and retention/deletion across payloads, projections, search, files, summaries, and backups. Event replay or restoration must not resurrect deleted content.
6. One permission-preserving import (`issue6-F1`) chosen from actual pilot demand, preserving historical attribution and creating no live agent invocations.
7. Real drop-in voice/screen sharing after text/access/moderation is sound. Explicit microphone, screen, recording/transcription, and agent attendance; no fake call buttons or default recording.

**Exit:** a small invited community returns voluntarily and enjoys social use without work rituals. Private boundaries, basic moderation, portability, and recovery work. Public discovery waits for tested abuse handling/capacity; merely exposing a prototype is not the beta milestone.

**Mapping:** issue6-B2/B4-B6/D6/E4-E6/F1-F3. Small room templates may help onboarding; a general workflow engine does not.

## 8. Milestone 4: Organization design-partner release

Can run alongside Milestone 3 once shared identity/data interfaces stabilize. Do not wait for voice or a consumer growth launch. Do not collect sensitive customer data before its controls pass.

**Lead:** Instinct on service/data/identity. **Member/admin UX:** Codex. **Deployment/connector operations:** Grok.

Deliver tenant-aware PostgreSQL exercised under the restricted runtime role; isolation across APIs, search, streams, queues, attachments, exports, and agent context; maintained SSO integration with organization enforcement; directory/SCIM provisioning and group mapping; session inventory and controlled recovery.

Offboarding reaches live sessions, connectors, guests, and queued/active agent authority. Remove/re-add must not recover former permissions automatically. Do not claim already-delivered information can be recalled.

Add least-privilege administration, expiring guests, approved connectors/models, finite budgets, inspectable external data paths, and an operational audit export distinct from chat history. Preserve actor, source, operation, target, version, decision, and result, including admin/export/denied actions.

Define retention/deletion/preservation where offered, region boundaries, subprocessors, agent-memory treatment, and backup restoration. A region setting must account for model/connector traffic, not only database placement. Exercise migrations, rollback, alerts, capacity, and support ownership.

**Exit exercise:** provision two similarly named organizations plus a guest/agent; complete one source-linked result; remove the guest; prove prohibited retrieval/execution fails across every channel; inspect authorized audit/export and isolated restore. Measure actual recovery bounds. This does not create a certification or SLA.

**Mapping:** issue6-D1-D6/E1-E3/E5/F4/F6. Basic privacy/identity protections apply to both product experiences; enterprise adds administration, not weaker consumer safety.

## 9. Milestone 5: production hardening, portability, and demonstrated value

**Operations:** Grok. **Data/reliability:** Instinct. **Product/design partners:** Codex with John and users.

Measure command durability, message latency, reconnect recovery, queue age, storage/history growth, agent completion, and noisy-neighbor behavior. Replace pilot limits with tested bounds, not larger arbitrary constants. Exercise slow clients, storage-full, interrupted deployment, key rotation, database failure, backup restore, and uncertain external effects.

Complete portable exports/migrations and deletion obligations after restore. Package human memberships separately from runtime identities and AI usage; show measured costs and finite budgets. Validate pricing rather than promise unlimited agents.

Prepare accurate security/privacy/incident/procurement materials. Independent assessment, certifications, regulated-data support, multi-region operation, and SLAs are separately evidenced scope, not consequences of passing unit tests.

Compare matched user exercises against the team's actual incumbent workflow, including recaps they already use. Measure unaided join success, useful return sessions, re-explanation effort, correct recognition of unresolved decisions/current evidence, completed useful outcomes, duplicate/wrong-context incidents, and cost per useful interaction.

**Hypothesis:** evidence-aware continuity should reduce re-explanation and missed decisions compared with a shared thread plus recaps. Instinct's six-case paper comparison informs this test but does not prove undocumented competitor capabilities are absent. If the outcomes do not improve, simplify/rethink rather than add agent chatter.

**Mapping:** issue6-E1-E6/F1-F6. Private dogfooding and design-partner conversations start earlier; promotion follows evidence.

## 10. Next three deliverables per agent

**Instinct:** I1, publish the reconstructable integration manifest/PR or one current precise blocker; I2, combine #3-#5 with attribution/supersession/announcement fixes, Quiet Focus and return brief and report exact-head service/browser evidence; I3, define the minimal identity/policy/lifecycle interfaces supporting consumer entry and organizations. Missed-delivery review remains a separate follow-on.

**Grok:** G1, report adapter fixtures BUILT with evidence or NOT BUILT; G2, private-host preflight/runbook and phone/cold-entry checklist, without touching Instinct's branch; G3, actual addressed-agent round trip against the integrated revision. Its publication offer is fallback only after an explicit handoff, not a concurrent integration PR.

**Codex:** C1, consolidate the agents' roadmap replies in #7 and cross-reference #6; C2, independently review the published combined source/results and provide publication relay if requested; C3, specify then implement proportionate-work/onboarding/draft UX only after an explicit shared-module handoff, with Instinct reviewing Codex-authored code.

These are bounded responsibilities, not nine simultaneous edits to shared files. New ownership expansions await substantive acknowledgment/correction. Do not keep rewriting accepted designs without a concrete counterexample. Missing source, missing tool action, missing tests, and product readiness are distinct statuses. Routine engineering does not need another approval loop from John.

## 11. Deferred and source references

Defer separate codebases, speculative microservices, universal policy language, agent marketplace/token incentives, broad ambient activation, unlimited memory, custom identity cryptography, automatic irreversible actions, and a mandatory signed-receipt framework. Native wrappers, voice expansion, public discovery, and multi-region operation need user and operating evidence. Keep unrelated Dasha production incidents in their own owner/workstream; they are not automatically Project Room dependencies.

Use existing standards at integration boundaries with pinned versions. An Internet-Draft is work in progress, not an adopted IETF standard. Candidate signed receipts are research inputs, not prerequisites for a useful room or a reason to replace reviewed core records.

References checked for this roadmap:

- [Issue #6](https://github.com/Uuriko/project-room/issues/6): existing 36 acceptance tasks.
- [Instinct original synthesis](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5557407851): dependency phases, numbering collision, and missing build tasks A4/B5/E4/F1/F2.
- [Instinct paper comparison](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5557407683): documented/limited/unknown evidence labels and falsifiable outcomes.
- [Instinct fresh reply](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5559908650), [Grok fresh reply](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5559909204), [Codex disposition](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5559949336).
- [GitHub failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries): no automatic redelivery; application recovery required.
- [W3C status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) and [ARIA status technique](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22): accessible status without stealing focus; measure actual announcements.
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): account for table-owner and BYPASSRLS behavior in real isolation tests.
- [Signed action receipts Internet-Draft](https://datatracker.ietf.org/doc/draft-sahu-agent-action-receipts/): work in progress, without IETF endorsement/formal standing.

No application tests were run merely by writing this documentation. Source review, author execution, independent verification, merge, and live delivery remain separate evidence states.
