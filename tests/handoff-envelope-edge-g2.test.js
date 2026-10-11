// Adjacent gap to grok-handoff-url-credentials-1010 (#2544): that fix rejects
// userinfo (username/password), but the "without credentials" promise still
// leaks when the secret rides in the query string or the fragment. The
// envelope journal persists the full envelope JSON verbatim and list()
// returns it to every room member, so a ?token=... in a url input is
// room-visible. These cases are fail-first: they assert rejection, which the
// current validator does not do. Fix belongs to server/work-handoff.mjs,
// which is claimed by grok-handoff-url-credentials-1010 — this file is the
// repro for that lane to adopt.
import test from "node:test";
import assert from "node:assert/strict";
import { handoffEnvelope, handoffEnvelopeVersion } from "../server/work-handoff.mjs";

const NOW = Date.parse("2024-10-18T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

const record = ref => handoffEnvelope({
  envelopeVersion: handoffEnvelopeVersion,
  id: "he_edge",
  from: "agent-a",
  to: "agent-b",
  createdAt: iso(NOW),
  objective: "Fetch the public brief and draft a reply",
  inputs: [{ kind: "url", ref }],
  authority: {
    permissions: ["accept_work"],
    scope: { rooms: ["room-1"] },
    expiresAt: iso(NOW + 24 * 3600 * 1000),
  },
  expectedOutput: { kind: "text_result", description: "A short public brief" },
  acceptanceTest: { checks: [{ kind: "result_submitted", workId: "work-1" }] },
  termination: { expiresAt: iso(NOW + 24 * 3600 * 1000), onExpiry: "release" },
  provenance: { createdBy: "agent-a", claimId: "lane", taskId: "work-1", chain: [] },
});

test("handoffEnvelope rejects a URL carrying a bearer token in the query string", () => {
  assert.throws(
    () => record("https://example.test/repo?token=s3cret"),
    error => error.code === "invalid_handoff_envelope",
  );
  assert.throws(
    () => record("https://example.test/repo?api_key=AKIA-EXAMPLE"),
    error => error.code === "invalid_handoff_envelope",
  );
});

test("handoffEnvelope rejects a URL carrying a token in the fragment", () => {
  assert.throws(
    () => record("https://example.test/repo#access_token=xyz"),
    error => error.code === "invalid_handoff_envelope",
  );
});

test("handoffEnvelope still accepts benign query strings", () => {
  const paged = record("https://example.test/file?raw=1");
  assert.equal(paged.inputs[0].ref, "https://example.test/file?raw=1");
  const searched = record("https://example.test/s?q=hello%20world");
  assert.equal(searched.inputs[0].ref, "https://example.test/s?q=hello%20world");
});
