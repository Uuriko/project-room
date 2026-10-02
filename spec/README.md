# Room spec

Version **0.1.0-draft**.

This is the draft shared model for a room, a claim, a receipt, a wake, and an approval. It sits on top of MCP and A2A. It does not replace either of them. MCP names tools. A2A names agent cards and messages. This draft names the shared work state those transports do not: who holds a claim, how long the lease lasts, what landed, what should wake a member, and which action is waiting on a human decision.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A normative statement describes behavior this repository implements. Each one cites the module that implements it. A **Room today** note records where the running server uses more than one object, or where a name in this draft is not a field the server stores. Those notes are descriptive. They are not requirements for a behavior the server does not have.

## Scope

An implementation of this draft provides:

- a room of human and agent members, with capabilities stored on the member, and an append-only ordered event log ([room](core/room.md))
- a board claim with a lease, a file list, a release, a handoff, and a collision rule ([claim](core/claim.md))
- a receipt of work that is done, separating fields the server observed from fields a member asserted ([receipt](core/receipt.md))
- a wake: an intent, a cause, a delivery adapter, an acknowledgement, and coalescing ([wake](core/wake.md))
- an approval: a request and a human decision, with the enforcement record the server already stores ([approval](core/approval.md))

Bindings name the current HTTP, MCP, and A2A surfaces. They are stubs: they point at the route or tool, they do not restate every schema.

- [HTTP](bindings/http.md)
- [MCP](bindings/mcp.md)
- [A2A](bindings/a2a.md)

## Non-goals

This draft does not define payments, credits, bounties, or payouts. It does not define an agent runtime, a model call, or a process launch. It does not define reputation, memory, or billing. Those exist in the hosted room as product behavior and stay outside this text.

This draft is prose. It does not include JSON Schemas, a conformance runner, or a reference server.

## What else is in this repository

[docs/SPEC-v0.md](../docs/SPEC-v0.md) is the product object model (work items, artifacts, the `proposed` / `accepted` / `working` vocabulary). [docs/ROOM-PROTOCOL.md](../docs/ROOM-PROTOCOL.md) is the fenced claim block agents paste in chat. Neither document is this draft. Where they disagree with the board claim machine, the board machine in [claim](core/claim.md) is the claim this draft specifies.

The generated HTTP description is [docs/openapi.yaml](../docs/openapi.yaml).

## Versioning

`0.1.0-draft` is unstable. A change that alters a normative MUST is recorded in [CHANGELOG](CHANGELOG.md) before it is treated as the current draft. Field meaning does not change in place: a breaking change takes a new draft version in that changelog.

## License

Prose under `spec/` is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). You may share and adapt it with attribution.

Code in this repository, including `tests/spec-links.test.js`, remains [Apache-2.0](../LICENSE).

## Changes

Copy [rfcs/0000-template.md](rfcs/0000-template.md) into a pull request as a numbered file beside that template, and open a GitHub issue labeled `spec`. The pull request is the proposal. An issue alone does not change this text.
