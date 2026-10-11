// WAVE-500 guild-7 A5 (Grok Bot lane support): handoff UI copy vs the
// credential-bearing-URL hardening in server/work-handoff.mjs.
// The envelope renderer (src/handoff-envelope-ui.js) is the human-facing end
// of the handoff flow. Envelopes minted before the hardening — and on any
// base whose server check still lets them through — can carry
// `https://user:pass@host/path` url inputs. Fail-first probes:
//   1. A credential-bearing URL must not render as a clickable link whose
//      href embeds the secret (click leaks credentials to the host, and the
//      secret sits in browser history).
//   2. It must not print the secret as the link text either.
//   3. Empty/unknown states must stay honest (never blank, never misleading).
// The credentialed fixtures are built as plain receipt objects on purpose:
// they model legacy/pre-hardening envelopes, and stay valid no matter what
// the server validator accepts or rejects.
import test from "node:test";
import assert from "node:assert/strict";
import { handoffEnvelopeHtml, handoffEnvelopeListHtml } from "../src/handoff-envelope-ui.js";

const NOW = 1729219200000; // 2024-10-18T00:00:00Z
const iso = ms => new Date(ms).toISOString();

const receipt = (inputs, overrides = {}) => ({
  envelopeId: "he_cred",
  roomId: "room-1",
  status: "proposed",
  fromAgent: "agent-a",
  toAgent: "agent-b",
  createdAt: NOW,
  updatedAt: NOW,
  envelope: {
    objective: "Sync the artifact and draft a reply",
    inputs,
  },
  history: [{ status: "proposed", at: iso(NOW), by: "agent-a" }],
  ...overrides,
});
const credUrl = input => receipt([{ kind: "url", ref: "https://agent:secret@example.test/sync", ...input }]);

test("credential-bearing URL input does not render a clickable link with the secret in the href", () => {
  const html = handoffEnvelopeHtml(credUrl({ label: "sync endpoint" }));
  assert.ok(!html.includes("href=\"https://agent:secret@"),
    `rendered a live link to the credential-bearing URL:\n${html}`);
});

test("credential-bearing URL input does not print the secret as the link text", () => {
  const html = handoffEnvelopeHtml(credUrl({}));
  assert.ok(!html.includes("agent:secret"),
    `rendered the credential in plain text:\n${html}`);
  // The human still sees what the link was, redacted.
  assert.match(html, /example\.test\/sync/, "redacted ref should still identify the host/path");
});

test("plain https URL inputs still render as live links", () => {
  const html = handoffEnvelopeHtml(receipt([{ kind: "url", ref: "https://example.test/spec", label: "spec" }]));
  assert.match(html, /<a class="source-link" href="https:\/\/example\.test\/spec"/);
});

test("empty handoff list copy is an honest hint, not a blank region", () => {
  assert.match(handoffEnvelopeListHtml([]), /No handoffs reference this work yet/);
});

test("missing envelope details copy is honest, not a blank card", () => {
  assert.match(handoffEnvelopeHtml({ envelopeId: "he_9", status: "proposed" }),
    /This handoff's details are unavailable/);
});
