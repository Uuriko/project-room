# Open-source launch plan — 2026-09-20

## Decision and product boundary

Make original Project Room code and documentation Apache-2.0, preserve third-party
rights, and keep the useful core self-hostable: shared human/multi-agent rooms,
conversation and work, private Inbox boundaries, invitations and agent APIs.
Commercial hosting can charge for operation, support and managed integrations.
The license permits others to host and modify the software commercially too.
Do not introduce license keys, a crippled community edition or paid data export.
Product names and logos do not acquire a trademark license through Apache-2.0;
forks should clearly identify their operator without implying official endorsement.
This is a project direction, not a new paid plan or trademark registration claim.

## What the research changes

| Source | Lesson applied here |
| --- | --- |
| [GitHub Open Source Guides](https://opensource.guide/starting-a-project/) | Make the license, purpose and contribution route obvious; avoid process scaffolding before there is a community. |
| [Zulip history](https://docs.zulip.com/history/) | A complete Apache-licensed collaboration product is a viable model to learn from; openness does not require fragmenting the core experience. |
| [Discourse](https://www.discourse.org/open-source) | Learn from the full product plus managed hosting model; its GPL choice is different from ours. |
| [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | Use the standard license, retain notices and dependency rights; patent terms are included, trademark rights are not. |
| [Maintainer practices](https://opensource.guide/best-practices/) | Keep scope and review decisions public and set realistic support expectations. |
| [GitHub private reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) | Provide a private vulnerability channel before inviting public security reports. |
| [CHAOSS responsiveness](https://www.chaoss.community/practitioner-guide-responsiveness/) | Watch first useful response and stalled contributions, not stars alone. |

These are design precedents, not evidence that Project Room already has product
market fit or that open source automatically creates adoption.

## Execution sequence and acceptance

1. **Audit publication scope.** Inspect authors, imported code/assets, dependency
   metadata and secret alerts. Preserve Rowboat notices. Exclude third-party
   research screenshots/quotations from the license grant. Do not rewrite history
   or fabricate contributor consent. Git author names are not a legal clearance.
2. **Publish the foundation.** Add the standard license, NOTICE and scope record;
   update package metadata, README, contribution and security instructions.
   Keep governance and community expectations in CONTRIBUTING instead of creating
   a committee or several overlapping policy files.
3. **Make starting real.** Document persistent Node provisioning, private key
   handling, agent attachment, backup/restore and upgrade constraints. Verify from
   an independent checkout with fresh npm dependencies and a fresh local database.
4. **Open a useful front door.** Add concise bug/feature forms and a PR checklist;
   enable private vulnerability reporting and retain existing branch/CI protection.
   Update repository description/topics. Keep issues as the single discussion
   entry point; do not start empty parallel forums or an automated PR flood.
5. **Verify and merge.** Check license text, local document links, package locks,
   clean install/start/restart/write/read/backup, existing checks and required CI.
   Publish a receipt with exact revision and limits. Repository-only changes do not
   require redeploying the application.

## Audit baseline

The repository was already public but had no root license. Git history includes
John/Uuriko and the named agent lanes; the existing lane records identify these
as work through the owner's account. This is the owner's authorized licensing
of the project, not retroactive copyright assignment by those names. Existing
Rowboat adaptations are Apache-2.0 with attribution retained. Third-party research
images and quotations remain excluded. No exhaustive legal provenance guarantee
is inferred from a text search. Dependencies retain their original licenses.

The historical Telegram-token alert is checked separately against the provider;
only the status, never the secret or account identity, belongs in a receipt.
Tree scanning is a limited guard and does not establish that all Git history or
operator infrastructure is free of secrets.

## Next after this launch

Prioritize three contributor-sized outcomes from the product roadmap: a real
multi-vendor agent continuation example, one proven end-to-end Inbox provider
journey, and an accessible room invite/arrival flow. Each needs a reproducible
problem and observable acceptance criteria before applying a help-wanted label.
No new feature is justified solely by being interesting to contributors.

On maintainer review days, check unanswered setup issues, time to first useful
response, whether newcomers get a first change merged, and whether people return
to use their rooms. Gather opt-in feedback; do not add new tracking for this launch.
Use that evidence to decide whether a container installer, SDK packaging, a
public roadmap board or a second maintainer is the next real bottleneck.
