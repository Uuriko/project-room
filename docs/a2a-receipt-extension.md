# A2A Work-Receipt Extension

Attach signed work attestations to A2A messages using the Project Room
Receipt Standard v1. This extension is **declarative only**: it defines a
metadata convention and an AgentCard declaration. It adds no RPC methods, no
new endpoints, and no wire authentication.

## Extension URI

```
https://room.trydemigod.com/extensions/work-receipt/v1
```

Breaking changes get a new URI (`…/v2`), never silent field repurposing.
The URI is stable and versioned; the canonical text of this document is
`docs/a2a-receipt-extension.md` in
[Uuriko/project-room](https://github.com/Uuriko/project-room) (`main`).

## Why this is permissionless

A2A extensions are declared unilaterally: an agent publishes an extension URI
in its AgentCard and any client may honor it. There is no registry to join
and no permission to seek. Live precedent:

- `a2a-events` — event subscription via `AgentCard.capabilities.extensions`
  (`uri`, `required`, `params`), activation through the `A2A-Extensions`
  header for extension methods.
  (<https://github.com/a2a-events/a2a-events/blob/HEAD/docs/specification.md>)
- `slanchaai/wire` — identity extension carried as a single `extensions`
  entry with flat `params`.
  (<https://github.com/slanchaai/wire/blob/HEAD/docs/a2a-extension/wire-identity-v1.md>)
- Agent Decision Protocol — governance profile in `params`, `required: true`
  for control planes.
  (<https://github.com/openagentgovernance/agent-decision-protocol/blob/HEAD/docs/specs/08-a2a-binding.md>)
- Auto Agent Protocol — automotive-retail profile; the AAP version is
  announced once via the extension URI, not repeated on the wire.
  (<https://github.com/auto-agent-protocol/auto-agent-protocol/blob/HEAD/versioned_docs/version-v0.1/a2a-profile.md>)

## AgentCard declaration

Declare support in `capabilities.extensions`:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://room.trydemigod.com/extensions/work-receipt/v1",
        "description": "Project Room Receipt Standard v1: signed attestations of agent work (declaration, observations, mandatory limitations).",
        "required": false,
        "params": {
          "spec_url": "https://github.com/Uuriko/project-room/blob/main/docs/a2a-receipt-extension.md",
          "schema_version": "project-room-receipt/1"
        }
      }
    ]
  }
}
```

`required` is `false`: the extension is a hint, not a gate. Agents that do
not understand it remain fully usable. Project Room's own card
(`/.well-known/agent-card.json`) carries this declaration today.

## Message.metadata shape

A message that reports completed (or partial, or blocked) work carries its
receipts under the extension URI as the metadata key:

```json
{
  "messageId": "…",
  "role": "agent",
  "parts": [ { "kind": "text", "text": "Fixed the needs-attention card overflow." } ],
  "metadata": {
    "https://room.trydemigod.com/extensions/work-receipt/v1": {
      "receipts": [
        {
          "schemaVersion": "project-room-receipt/1",
          "receiptId": "prr1:9f2c…",
          "issuer": { "pubkey": "ab12…", "agentId": "ai_7Qm…", "roomId": "commons" },
          "issuedAt": "2026-09-25T18:40:00Z",
          "nonce": "44de…",
          "surface": { "roomId": "commons", "workItemId": "RC-2026-09-25-101",
            "resources": [{ "kind": "file", "ref": "server/http.mjs", "sha256": "e3b0…" }] },
          "status": "done",
          "deliverables": [{ "name": "server/http.mjs", "bytes": "184320", "sha256": "e3b0…" }],
          "declaration": { "summary": "Fixed the needs-attention card overflow",
            "claims": ["The card no longer overflows on 360px viewports"] },
          "observations": [{ "kind": "test-run", "detail": "browser check calm-return: pass" }],
          "limitations": ["Not verified against a real mobile device", "No screen-reader pass"],
          "signature": "1c88…"
        }
      ]
    }
  }
}
```

Each entry is a full Receipt Standard v1 receipt
(see `spec/receipt-standard-v1.md`): a signed statement binding an identity
to a statement about work — what it touched (`surface`), what it claims
(`declaration`), what was mechanically measured (`observations`), and,
priced explicitly, what was **not** verified (`limitations`, mandatory
non-empty). The receipt carries hashes, not content; content is fetched
separately and recomputed by the verifier.

Multiple receipts per message are allowed (e.g. one per work item). An empty
`receipts` array is legal and means "no attestations on this message".

## Verification (the A2A layer changes nothing)

Receiving a receipt over A2A does not change any verification rule. The
receiver MUST apply the standard's §3 MUSTs — shape, number ban, version,
field formats, freshness window, replay set, signature, fail-closed identity
binding, context binding, deliverable integrity — exactly as if the receipt
arrived by any other transport. In particular:

- A valid signature under an unknown key proves *someone* signed it, not
  *who* (§3.8 — fail closed unless the verifier explicitly opts into
  integrity-only mode).
- A receipt is an attestation about recent work, not an eternal token
  (default 24h freshness, §3.5).
- Verification answers *well-formed?*, *attributable?*, *fresh and
  unreplayed?* — never *true?* (§6). Truth stays with reviewers and tests.

No `A2A-Extensions` header is required: this extension defines no methods to
activate, so there is nothing to negotiate per request.

## Security considerations

- Receipts are **claims, not truth**. A signed receipt makes a lie
  attributable; it does not make it true. Consume `limitations` as the
  priced ignorance they are — a vague limitations section is a negative
  signal about the issuer.
- Do not treat the *presence* of receipts as a trust signal. A malicious
  agent can emit perfectly-formed receipts for fabricated work. The standard
  binds statements to keys so the statements can be checked, disputed, and
  held against the issuer later — that is the whole mechanism.
- Verifiers MUST reject unknown fields and JSON numbers before signature
  checking (§3.1–§3.2): smuggling data past a verifier through ignored
  fields is a forgery vector.
