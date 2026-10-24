# Room instructions: local checkpoint

September 8, 2026. Local-only implementation. The broader goal remains active and
incomplete. No push, deployment, live migration, provider setup, paid compute,
outreach or recurring automation. Root was sole editor; three independent agents
reviewed architecture, agent contracts and human interaction.

## Delivered

People and agents now read the same optional, versioned room brief: purpose,
expected outputs, boundaries and when to ask for help. This is shared context,
never permission to act. Existing conversation, work and participant flows remain
the center of the product; no new dashboard or required setup.

- **About → Add instructions / Room instructions.** The active human room owner
  can explicitly edit and save; other members read selectable text. Empty legacy
  rooms remain unchanged. Each field is bounded to 1,000 UTF-16 code units, with
  the existing serialized command limit also enforced.
- Immutable history, previous-version reads, deliberate clear, exact-original
  retries and expected-revision conflicts. Missing historical versions refuse
  rather than silently returning current. A clear is a new version, not deletion.
- Unknown saves retain the original draft and identity through Close/reopen.
  Conflicts show latest text beside the retained draft and require an explicit
  choice. Refresh works without live updates. Confirmed saves remain confirmed
  when their follow-up refresh fails. Retry memory does not survive a confirmed
  reload; pending-save warnings make that boundary visible.
- Session-owned callbacks, access-end cleanup, keyboard containment/focus return,
  mobile reflow and actual 200% text. Screenshot review also simplified the footer
  into one Save/Close row.
- Authenticated current/selected charter reads and shared agent orientation/work
  context. Metadata identifies the revision, event and evaluation horizon. An old
  service that does not provide instructions is distinct from a confirmed unset
  charter. Existing 17 MCP tools suffice; no new owner-edit tool or system prompt.
- Historical reads select at most two matching event bodies without loading all
  room discussion into application memory. Recovery audits all retained charter
  events, including checkpoint prefixes, owner provenance and active authority.
- Schema/writer 11, still 20 application tables. Genuine frozen v8/v9/v10 upgrades,
  rollback and cached/reopened old-writer refusal are exercised on Node and local
  Workers. Exact charter retry/readback survives local Workers restart.

Review caught and root fixed owner-bootstrap provenance hidden by checkpoints,
missing/contradictory agent metadata, unknown-save refusal classification, broken
live-update conflict refresh and closed-retry discard warnings. Historical schema
assertions were updated after the full regression exposed their old v10 values.

## Actual producer and independent reviewer

Two Codex subagents used separate scoped MCP subprocesses in one disposable local
room. The producer read the instructions and task, independently authored an
agenda, accepted/started work, posted and submitted its exact native text. It
reopened MCP and checked the exact stored body, digest and completion identity.
The reviewer separately read the task, charter and stored result, independently
counted/hashed it and recorded an honest PASS. No finding was invented to force
rework. This was actual semantic agent participation, not scripted verdicts.

- Charter revision 1: `ea29eeb2-b135-4cd2-915d-46720d9e59e9`.
- Seed sequence 10 → final 15; work revision 4.
- Agenda: 43 whitespace-delimited words, 292 UTF-8 bytes, a named owner and three
  timeboxes totaling 15 minutes, against a 60-word maximum.
- Draft: `045e75da-2eeb-4009-89ce-89ce97accbe6`.
- Completion: `fdc5813c-dd7c-43cb-bf9f-89efdd8ffd9f`.
- Independent verification: `b5ef6474-ece4-45d0-84fd-337f745cde69`.
- SHA256: `5abf0847a34ab10430bd8f536ef76de32514a58f8898a2a3d1bcc5e03a01a452`.
- Human decision remains null; next actor is owner/decide. Owner, producer and
  reviewer read markers remain 0. Manual-unverified source attribution is intact.

Root independently checked the exact text/hash, receipt/review, final authority,
cursors and schema 11 recovery audit. Both MCP processes and the dedicated fixture
exited; its temporary database and credentials were removed and absence verified.
Existing user previews were preserved. Evidence:
`test-results/charter-participants-20260908.json` (ignored synthetic test artifact).
Shared OS access was not an isolation boundary. This is not a human usability
study, native Claude/Grok/Instinct host acceptance or proof of outside execution.

## Exact candidate and verification

Product runtime: `bf3ac3ac75321ac9c84664608f7d0fb371d58718`.
Final tested candidate: `ae75d07435ed011c8b973a7418c091686c3568ae`; its additional
changes correct historical test assertions only, not product/runtime code.

**458 core/API/package, 159 browser and 11 local Workers checks pass.** Syntax
checks pass. The full browser suite includes seven new instruction checks and
finished with zero failures/skips. One preliminary launch was blocked by sandbox
localhost permissions; the permitted full rerun passed. All test processes have
exited; no dedicated participant fixture remains.

Root inspected five screenshots: desktop, mobile, conflict comparison and the
top/bottom of the actual 200%-text view. All controls remain scroll-reachable.
These are simulated human journeys, not measured human preference or retention.

Exact schema 11 package, under the project mirror:
`work/project-room-runtime-packages-20260908/candidate-ae75d07`.
59 files, 18 public assets; source tree
`40c2cd0313e2b0981790bf9269e4953b35444886`; manifest
`6f229faf4e7462bbac4e2b7be90e7eb054d8c3527c664cd0a705de8638e41363`.

## Boundaries and next work

Recorded live app `fb90a7083e9f5866c8df242778a6a72f4a58536d`, Worker
`901be347-7a39-4b56-8777-f4052bf81b38`, schema 7: unchanged and not reverified.
This slice is **not live**. Publication still requires a separately qualified
v11-compatible fallback, hosted restore/current-authority reconciliation and
fresh release authority. The v8↔v8 switch exercise is historical, not a v11 fallback.

Charter revisions do not fence work revisions or automatically invalidate prior
results/reviews. Agents should reread instructions after reconnect and before new
work; an unknown write must first resolve by exact retry. Historical provenance is
audited at recovery, not by replaying the entire event history on each current read.

Next: pull-first durable attention with explicit cause, charter/work revision and
deduplication; then eligible-work suggestions and opt-in standing responsibilities.
Seen, delivered, accepted and completed must remain distinct. No model launch or
human read-marker change merely to poll. Native-host acceptance and v11 release
recovery remain parallel gates. Later, isolated attempts/tool adapters can connect
repositories and Dasha compute with explicit workspace, scope, cancellation and
budget; start with a fake-runner contract, not a live provider.

Keep free/manual/BYO-agent participation useful. Do not silently enable unattended
work or claim iMessage/WhatsApp/Claude/Grok integration from local stdio proof.
See the [charter roadmap](AGENT-CHARTERS-NEXT-2026-09-08.md) for the preserved plan.
