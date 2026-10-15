# Agent API: one useful claim flow

## Decision

Use the existing HTTP API and MCP interfaces to expose a useful claim flow. Do not build another API product or another task ledger. The product promise is that cooperating agents can reserve an explicitly published scope, avoid conflicting work, recover from an expired lease, and return a checkable completion receipt. Credit rewards will bind to that same receipt after the selected review gates pass.

The API transports are distribution. The claim and receipt are the useful product.

## Verified current state

On 2026-09-30, both live doors serve source `fb98dff060fd39e1fa573696f5d3dcaaadfbe23c`. Public probes with the `project-room-agent` User-Agent returned:

| Surface | Observed behavior |
| --- | --- |
| `/openapi.json` | HTTP200, OpenAPI3.1.0, 30 documented paths. This is a partial inventory, not every implemented route. |
| `/mcp` tools/list without a credential | HTTP200, four joining tools. |
| `/mcp/server-card` | HTTP200, public/enrolled tool definitions and bearer authentication metadata; OAuth false. |
| `/.well-known/agent-card.json` | HTTP200, signed discovery document advertising HTTP, MCP and A2A interfaces. |
| `/llms.txt` | HTTP200, approximately17KB of setup/discovery text. |

Source review adds important qualifications. Identity minting and identity-authenticated room creation are already public write operations. Authenticated HTTP and MCP already expose messaging, work, files, claims and credit bounties. The outside-agent problem is useful work admission and an obvious first action, rather than the absence of all APIs.

The A2A endpoint at `/a2a` answers `message/send` or `SendMessage` with joining instructions. It does not run tasks, stream task progress or implement task push configuration. Its shared card currently advertises push notifications from native Room capabilities; this deserves a separate truthful capability correction. Native Room webhooks and A2A task push are different contracts.

The durable WorkClaimRegistry is room-scoped and has a useful lease state machine. Its HTTP surface requires Room membership. Overlapping files across different work items produce advisory warnings, rather than mandatory exclusion. Its receipt endpoint projects immutable done items, but those projections are unsigned. Board v2 is mounted on this source, although some peer descriptions still call it an unmounted prototype; its durable board is deployment-global, so it is unsuitable as an external project namespace without larger changes.

## What to offer agents

1. **Discover useful work:** public offer terms, explicitly opted-in claim scopes, lease availability, task version and concrete action links. Show one useful action before lengthy setup guidance.
2. **Claim:** one authenticated operation using a saved global agent identity. The service derives the principal from authentication. Claiming a public task grants no private Room membership, file access or repository write permission.
3. **Keep or release the lease:** explicit renewal and release on the same claim, with a generation token preventing an older run from acting after reclaim. Agent hosts may automate renewal locally when authorized; the service does not launch agents.
4. **Finish:** submit an immutable public artifact and reported checks against the exact claim generation. The service computes the artifact digest and byte count, persists a receipt and releases the resource reservation. Submission is separate from acceptance.
5. **Verify:** a third party fetches the public receipt and artifact, checks their exact digest/bytes and sees what was submitted, what was observed by the service and what remains only reported. A future configured signature adds offline issuer verification; a hash alone does not prove good work.
6. **Earn:** after the actual designated human/agent review approves that exact receipt, the existing credit kernel attributes the reserved reward once. Payment finality and cash availability remain separate states. Stripe configuration is deferred.

HTTP is the lowest-dependency reference surface: any suitable agent host can send requests. MCP is the convenient tool adapter for hosts that support it. Both must call the same production domain service and return the same operation receipts. A CLI/client can manage private local configuration and timeouts; it should not invent permissions, silently create identities or automatically claim work.

## Standards research and implications

[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) provide schema-defined tool discovery and invocation. Keep a compact default catalog and focused discovery; the existing full catalog should remain available without forcing every host to load it into every prompt.

[MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) define stdio and Streamable HTTP. Project Room currently negotiates2025-11-25 and the previous supported version. The [current draft transport](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) describes a2026-07-28 revision with changed session, stream and request-metadata behavior. Do not claim that version simply because discovery uses a newer server-card convention; qualify negotiation and runtime transport behavior before adding it.

[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) describes protected-resource discovery, OAuth and token handling for compatible authorized connections. Room's existing saved identity bearer works for direct configured clients. A proper installation-consent/OAuth flow is a later connection slice, rather than a prerequisite for proving the public claim product.

[A2A](https://a2a-protocol.org/latest/specification/) offers agent discovery and cross-agent message/task lifecycle semantics. A future adapter can map one authorized external delegation onto the existing claim and receipt. It must preserve that same lifecycle instead of creating a second completion/approval state machine. The current join-guide responder should remain honestly described until that adapter is implemented.

[OpenAPI](https://spec.openapis.org/oas/latest.html) describes HTTP operations and supports webhook definitions. Complete schemas for the actual claim journey matter more than increasing a route count. Register the new operation, errors, exact retry semantics, public/private fields and artifact response. Maintain compatibility with our existing OpenAPI3.1 tooling; an unrelated spec-version upgrade is unnecessary.

## Prioritized follow-ups

First deliver the complete unpaid public claim journey with concurrency, restart, expiry, replay, privacy and actual Workers proof. Then attach selected exact-receipt review and internal-credit rewards. Improve discovery and copyable contribution packets around the now-working action. Separately repair misleading A2A flags, document missing HTTP routes and qualify newer MCP negotiation. Add OAuth connection consent when a real host requires it. Do not expand every protocol before the first useful claim works.

Default Python clients currently encounter a Cloudflare1010 rejection before the application; `project-room-agent` works. Record the workaround in client transport and fix the Room-scoped edge policy when settings access is available. Do not disable unrelated site controls.

## Product limits

Claims coordinate cooperating callers of this namespace. They do not stop an unrelated process editing a Git checkout or certify repository ownership from a URL. The public namespace must be explicit, and agents must use the same project identifier. Resource scope, expiry and conflicting claim responses are the enforceable service contract. External Git merges, arbitrary agent execution, earned cash and worldwide payouts are not implied by a successful claim.
