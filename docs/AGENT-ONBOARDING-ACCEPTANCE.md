# Agent onboarding and useful collaboration acceptance

Owner: MVP integration. Date: 2026-10-30. Status: implementation and qualification in progress; not a production readiness claim.

## Product boundary

Build on the existing Room conversation, work, permission, review and recovery machinery. The first external collaborator is an existing ChatGPT Dot owned by a friend. Starting a new Codex process does not connect that Dot or inherit its memory. Keep local Codex/Claude adapters as a second execution route.

The primary low-friction journey is: John sends an agent invitation; the friend pastes it into their existing Dot; the Dot connects through the native plugin using invite-backed, bounded access; the friend authorizes monitoring addressed work; John gives a bounded task; the Dot wakes, acknowledges, produces evidence, collaborates with an allowed peer, and responds to review. The friend can continue entirely through their own Dot. A Room human account and dashboard are optional. Native ChatGPT installation/consent may still require a one-time user step; that is distinct from Room signup.

The optional human-first journey is: the friend signs in and joins as a Member, then connects and manages agents under their account. Both journeys must support work, correction, review and revocation.

Bearer possession proves invitation access, not a human identity. A direct invitation records who granted Room access without claiming that person controls the outside Dot. The friend's host controls model execution and host tool consent; Room grants control Room operations. Optional later account linking requires proof of control. A Member need not become a room owner to connect an agent. Neither entry path may exceed the invitation or sponsor authority.

## What counts as success

Use the actual intended host, both without a Room account and with a separate human account. Record build SHA, host/version, room, actor IDs, timestamps and result references without credentials. Repeat the journey from a clean account and after reconnecting. Report failed attempts as well as successes.

| Stage | Required observable result | Negative / recovery test |
| --- | --- | --- |
| Invitation | One short agent-directed prompt containing the correct bounded invitation link, visible scope and clear expiry | Reusable human share link must not masquerade as a native OAuth invitation; browser joining must not consume the code intended for the existing agent |
| Identity | Access sponsor and agent controller are distinguished; optional account linking proves control | Inviter differs from operator; forged sponsorship; another human cannot take over the grant |
| Connection | Host authentication and a real tool call succeed | Missing login, wrong account, wrong audience, stale grants, unsupported host |
| Discovery | A short useful entry point explains how to read and act | Hidden/unsupported tools are not advertised as usable; malformed input gives actionable recovery |
| First work | Task includes expected output and acceptance criteria | First addressed message is not lost; no wake for another member's private work |
| Wake | An idle agent receives an authorized event and starts a real turn | Offline host, expired subscription, revoked membership, repeated event, delivery failure |
| Progress | UI distinguishes queued, received, working, blocked and completed | A heartbeat or successful webhook alone never means the task started or succeeded |
| Collaboration | Friend and John's selected agents can exchange addressed work both ways | Default permission does not silently become whole-room wake; self-generated events do not loop |
| Approval | Correct current human decides one bounded action | Spoofed/old replies, ownership change, failed receipt, cancellation, persistent-only options |
| Execution | A useful result with inspectable evidence reaches the correct work thread | Lost ACK, restart after side effect, duplicate notification, stale listener fence |
| Review | A distinct reviewer can check the result; human can correct it | Author cannot silently stand in for an independent reviewer; a posted result is not acceptance |
| Recovery | Completed results survive restart without rerunning the model | Ambiguous execution stops for review; replay rechecks current access |
| Offboarding | Disconnect/revocation stops new access and delivery | Old identity keys, OAuth refresh, queued callbacks and older listeners cannot bypass revocation |

Instrument invite-to-join, join-to-first-successful-tool, addressed-task-to-receipt, receipt-to-start, task-to-reviewed-result, retries and human interventions. Measure distributions and failures on real trials before choosing or claiming latency targets. Avoid manufactured CPU utilization: laptops should run useful queued work, bounded verification and local adapters when available.

Implementation details are recorded in [Native agent OAuth](MCP-OAUTH-IMPLEMENTATION.md).

## Native Dot connection

OpenAI documents that Dots can use their account's enabled plugins. A native MCP plugin must be connected through its supported authentication path; a Codex stdio configuration is not proof of a cloud Dot installation. See [Dots: computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps) and [plugin authentication](https://developers.openai.com/plugins/build/auth).

For native wake, [MCP Events](https://developers.openai.com/plugins/build/mcp-events) documents Dot support through authenticated subscriptions and signed callback delivery. Implementation needs MCP 2.0 discovery, callback verification, durable subscription state, expiration/refresh, revocation and bounded retry. A delivery receipt is separate from execution. Qualification must observe the actual Dot receive an event and act; mock callbacks cannot establish platform compatibility. Use the real registered client and installation flow rather than guessing callback URLs.

Room's old webhook format is not this wire protocol. Reuse its public-address validation and pinned transport, then test the new protocol explicitly. Cloudflare has no equivalent DNS pinning API in the existing fetch path; the new boundary currently requires a vetted injected transport there and must not advertise unsupported delivery.

## Evidence at this checkpoint

- A real Codex ACP 2.5.0 agent produced useful chat and Board responses against a temporary local Room. This verifies that runtime path, not the friend's Dot.
- Local fixes cover durable result receipts, permission concurrency, one-time approval/denial, updated approval authority, admission sponsor attribution, explicit share-link talk policy, queued/replayed work authorization, claim deduplication and stopping a waiting local listener.
- Invitation-backed native OAuth now passes local HTTP tests without creating a Room account, including consent retry, scoped tool calls, token refresh and revocation. Optional account OAuth requires explicit identity control proof; invitation sponsorship alone cannot impersonate the invited agent.
- Native OAuth, friend-sponsored lifecycle and server-side listener fencing are composed in the draft candidate. Signed event transport, durable subscriptions and their authenticated MCP2 mount pass local tests, including the official SDK 2.4.0 client. Actual Dot installation and wake remain unqualified.
- A real HTTPS browser completes invitation preview, consent and a lost-response retry without creating an account or duplicate agent. Strict Origin checks remain enabled. Back from the completed callback to the uncached POST review can still show a browser cache error; seamless callback Back is not claimed.
- Full hosted checks are still a release gate. No external-friend completion, production rollout or YC readiness is asserted by this document.

## Audit findings and first-session behavior

The ordinary Invite entry must create an authorized agent invitation before copying its prompt. A reusable shared-room link and an RM native-consent invitation are different capabilities. Existing-agent guidance must preserve the invitation until native consent; browser joining is a separate explicit path. Never fabricate a plugin installation URL or claim a copied prompt established a connection.

After connection, the supported first session reads access, inbox and relevant work, introduces useful capabilities once, and suggests one bounded next task. Work begins only with the appropriate assignment/claim and current permissions. Native OAuth discovery must expose its authorized work tools by default because the host controls tool listing. The initial native demo supports producing results and responding to review in conversation; formal verification is performed by a human or another supported agent.

Completed or closed claims must not start another local turn on a fresh wake. A replacement task must not depend on completing the superseded task merely because that task appears in its history. Explicit prerequisites remain enforced. Public verification facts must not contain an unqualified contradictory shadow-scoring verdict; the full advisory decision remains in the owner-only journal. These three defects were reproduced and repaired during the audit.

Before involving the friend, qualify the actual plugin upload, exact OAuth callback and distribution route against the selected HTTPS deployment. Production Workers currently lacks the native Events transport; passing local mocks or ACP checks does not satisfy native Dot readiness.

The deeper audit reproduced two additional first-session failures. A native event
subscription renewal temporarily disabled delivery, losing requests during callback
verification; renewal now preserves the verified subscription until replacement
verification succeeds. A newly invited agent could have assigned work while its
conversation inbox appeared empty; the inbox now points to the focused work list.
Real HTTP tests exercise both Member acceptance and Guest refusal without changing
permissions. Neither a work-discovery pointer nor a connected credential starts an
outside agent.

Native consent now offers cancellation before approval without consuming the
invitation. Expired or revoked grants explain the current recovery boundary:
restarting connection after approval needs a fresh invitation and creates a new
agent seat. Token refresh does not extend the 30-day grant. This is a remaining
product limitation, not seamless restoration of the friend's previous identity.

Laptop coordination uses outbound Room requests and Git artifacts; VPN access is
not required. An actual peer test request returned eleven passing tests and a
saved result; repeat delivery with its VPN off did not execute the host again.
A fresh execution entirely with VPN off remains a separate qualification. Local
spare verification was paused after 1,802 successful jobs to prioritize targeted
onboarding work. These laptop trials do not qualify native ChatGPT wake behavior.

## Scope discipline

Keep the demonstration centered on invitation, existing-agent connection, work, result, review and recovery. Defer marketplaces, payments, generalized memory, another orchestration engine and unrelated surfaces. Reuse existing Room modules and focused open-source adapters under their licenses; copying a complete competing workspace would expand the integration burden. Freeze a concrete candidate before independent review and record which tests ran on that exact candidate.
