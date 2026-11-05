# Offline Dot distribution preflight

This opt-in release aid checks a **mobile-oriented Project Room public OAuth package**, not arbitrary plugins. It does not change the existing generic template, validate the Agent Plugins JSON Schema, access a network, install anything, or authorize publication. A minimal template can pass basic shape checks and still correctly report `not_ready` for distribution.

## Run

```sh
node --test tests/dot-distribution-preflight.test.js
node scripts/check-dot-distribution.mjs examples/integrations/chatgpt-dot/plugin
node scripts/check-dot-distribution.mjs examples/integrations/chatgpt-dot/plugin examples/integrations/chatgpt-dot/hosted-mcp.json
```

The optional second path supplies the hosted MCP variant **in memory**; neither file is changed. Exit 0 means offline preparation passed, not that release or installation is approved. Exit 1 reports structural/release gaps. Exit 2 means unreadable inputs, malformed JSON, or invalid CLI usage. Diagnostics never echo input values or credentials.

## Versioned checklist, not runtime policy

Checklist dated **2026-11-01**, based on [official submission requirements](https://developers.openai.com/plugins/deploy/submission). Required listing information includes display name, subtitle, description, publisher, category, website/support/privacy/terms HTTPS links and a primary icon. Initial MCP review needs five positive cases, three negative cases, a walkthrough, release notes and reviewer-ready access. The latter must be provisioned separately with authorization; credentials never belong in the package.

The checker tests presence and basic shape only. It cannot establish icon dimensions, actual URL availability, domain ownership, policy accuracy, review quality, or executed test outcomes. Include a composer icon for broader Codex compatibility; it is not enforced here for this minimal portable package. An onboarding skill is optional, not an installation mechanism. No publisher identity, policy URL, recording, credential or directory link is fabricated.

The public OAuth/resource checks are intentionally narrower than all configurations supported by OpenAI: one remote streamable HTTP server, provided public client, matching resource, and the five scopes for Room's documented chat/work workflow. They are not a generic OAuth validator. Hostname checks reject obvious local/placeholders/IP literals but do not do DNS or establish reachability. No secret scanner or server-security certification is claimed.

The generic `.invalid` configuration is deliberately not distributable unchanged. The hosted variant removes that endpoint gap but not listing/review gaps. Do not copy the separate `plugins/project-room` local Node/channel package for this mobile route. This checker inspects root portable manifests and `hooks/hooks.json`, not compatibility overlays or arbitrary packaged scripts; inspect those separately or omit them from this minimal candidate. It does not certify that unknown host-specific fields have no desktop dependency.

## Human and host gates remain

An owner must approve publishing identity, legal disclosures and availability; verify domain and actual saved OAuth settings; authorize dedicated reviewer sample access; inspect authenticated tool scans; obtain approval; and explicitly authorize publication. Record the real directory route only when available. A private working Dot connection does not prove another account can install it.

Qualify fresh-account Android install/consent, scoped tools, attributed results and independent acceptance. Test idle wake and stop-monitoring separately when promised. A callback receipt alone does not prove a resumed Dot. Disconnection, OAuth revocation, shared-history retention and new-seat recovery are distinct; use verified service behavior rather than inventing guarantees.

Official references: [mobile plugin availability](https://learn.chatgpt.com/docs/plugins), [packaging and OAuth](https://developers.openai.com/plugins/build/plugins), [authentication](https://developers.openai.com/plugins/build/auth), [MCP review](https://developers.openai.com/plugins/deploy/app-review), [privacy guidelines](https://developers.openai.com/plugins/plugin-guidelines). Recheck the dated checklist before an actual release.
