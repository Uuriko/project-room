// EXP-5 receipt share layer: the graded verdict line, pre-filled share
// text, JSON-LD that mirrors the visible page, and OG-card fields. The
// honesty contract under test: the grade and its scope travel together,
// names never enter the structured data, and room-supplied text cannot
// break out of the JSON-LD script block.
import test from "node:test";
import assert from "node:assert/strict";
import {
  jsonLdScriptTag,
  proofLabelOf,
  receiptBadgeSvg,
  receiptEmbedSnippet,
  receiptJsonLd,
  receiptOgFields,
  receiptShareLinks,
  shareTextOf,
  verdictLineOf,
} from "../server/receipt-share.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;
const base = {
  id: `wcr_${"a".repeat(32)}`,
  title: "Ship the door",
  at: "2026-10-01T12:00:00.000Z",
  room: { id: "commons", title: "Project Room Commons" },
  agents: ["Ada"],
  humans: ["Room owner"],
  hashes: [HASH],
};

const merged = { ...base, source: "work-claim", pullRequest: "https://github.com/Uuriko/project-room/pull/9", mergedAt: "2026-10-01T12:00:00.000Z" };
const workItem = { ...base, source: "work-item" };
const publicWork = { ...base, source: "public-work" };
// publicWork carries no review block: a submitted receipt, no reviewer
// decision recorded yet. The rejected twin carries the composed review.
const publicWorkRejected = { ...base, source: "public-work", review: { state: "rejected" } };
const plain = { ...base, source: "room-note" };
const lot = {
  ...base,
  source: "bounty-lot",
  hashes: [],
  lot: { kind: "escrow_release", amountCredits: 5, settlement: { kind: "paid" } },
};

test("verdict lines are graded and carry their scope in the same breath", () => {
  assert.match(verdictLineOf(merged), /^Server-verified merge — this server confirmed the linked pull request merged$/);
  assert.match(verdictLineOf(workItem), /^Room-recorded completion — .*no server-verified merge/);
  assert.match(verdictLineOf(publicWork), /^Artifact hash recorded — .*not an acceptance/);
  assert.match(verdictLineOf(plain), /^Room-recorded — /);
  assert.match(verdictLineOf(lot), /^Ledger-recorded movement — settlement verdict “paid”, recorded in the room's credit ledger$/);
  assert.match(verdictLineOf({ ...lot, lot: { kind: "escrow_release" } }), /^Ledger-recorded movement — recorded in the room's credit ledger$/);
  assert.equal(proofLabelOf(lot), "Ledger-recorded movement");
  // The rejected pattern from the proof-UX research: a bare checkmark verdict.
  for (const receipt of [merged, workItem, publicWork, plain, lot]) {
    assert.ok(!/^\s*✓/.test(verdictLineOf(receipt)), verdictLineOf(receipt));
    assert.ok(!/^Verified\b/.test(proofLabelOf(receipt)), proofLabelOf(receipt));
  }
});

test("share text names the work and the verdict, with room text collapsed and capped", () => {
  assert.equal(
    shareTextOf(merged),
    "Ship the door — Server-verified merge — this server confirmed the linked pull request merged",
  );
  const messy = { ...merged, title: `  Many\n\n  spaces\tand ${"x".repeat(200)}` };
  const text = shareTextOf(messy);
  assert.ok(!/\n|\t/.test(text));
  assert.ok(text.length < 320, text);
});

test("share text never headlines an unverified receipt as verified", () => {
  // ATLAS-PUBLIC P-4: the share text is what forwards display, so it must
  // state the receipt's actual verification state. A submitted receipt
  // (no reviewer decision) and a rejected one both carry the graded
  // artifact-hash line — "not an acceptance" — never a verified headline.
  for (const receipt of [publicWork, publicWorkRejected]) {
    const text = shareTextOf(receipt);
    assert.ok(!text.includes("Work, verified"), text);
    assert.equal(text, `Ship the door — ${verdictLineOf(receipt)}`);
    assert.match(text, /not an acceptance/);
  }
});

test("JSON-LD mirrors the visible record and omits the names the page qualifies", () => {
  const ld = receiptJsonLd(merged);
  assert.equal(ld["@type"], "CreativeWork");
  assert.equal(ld.name, "Ship the door");
  assert.equal(ld.identifier, merged.id);
  assert.match(ld.url, new RegExp(`/receipts/${merged.id}$`));
  assert.equal(ld.dateCreated, merged.at);
  assert.ok(!ld.description.startsWith("What this record proves:"));
  assert.match(ld.description, /server verified the merge/);
  const props = Object.fromEntries(ld.additionalProperty.map(entry => [entry.name, entry.value]));
  assert.equal(props["Proof level"], "Server-verified merge");
  assert.equal(props["Pull request"], merged.pullRequest);
  assert.equal(props["Hash evidence (stored sha256, not re-verified)"], HASH);
  assert.equal(ld.isPartOf.name, "Project Room Commons");
  // Names are room-recorded, not identity-verified; structured data has no
  // honest way to carry that qualifier, so they stay out of it entirely.
  assert.ok(!JSON.stringify(ld).includes("Ada"));
  assert.ok(!JSON.stringify(ld).includes("Room owner"));
  assert.ok(!("review" in ld) && !("aggregateRating" in ld));
});

test("lot JSON-LD states the movement and the settlement verdict", () => {
  const ld = receiptJsonLd(lot);
  const props = Object.fromEntries(ld.additionalProperty.map(entry => [entry.name, entry.value]));
  assert.equal(props["Proof level"], "Ledger-recorded movement");
  assert.equal(props["Ledger movement"], "escrow_release");
  assert.equal(props["Settlement verdict"], "paid");
  assert.match(ld.description, /not money/);
});

test("JSON-LD embedding cannot be broken out of by a room-supplied title", () => {
  const evil = { ...merged, title: "</script><script>alert(1)</script>" };
  const tag = jsonLdScriptTag(receiptJsonLd(evil));
  assert.ok(tag.startsWith('<script type="application/ld+json">'));
  assert.equal(tag.match(/<\/script>/g).length, 1);
  const inner = tag.slice('<script type="application/ld+json">'.length, -"</script>".length);
  assert.equal(JSON.parse(inner).name, evil.title);
});

test("OG fields put the verdict on the card and the honesty line in the footer", () => {
  const fields = receiptOgFields(merged);
  assert.equal(fields.title, "Ship the door");
  assert.equal(fields.subtitle, verdictLineOf(merged));
  assert.deepEqual(fields.badges, ["Server-verified merge", "Project Room Commons", "2026-10-01"]);
  assert.match(fields.footer, /not re-verified/);
});

test("badge renders the graded verdict in words, never a bare checkmark", () => {
  for (const [receipt, label] of [
    [merged, "Server-verified merge"],
    [workItem, "Room-recorded completion"],
    [publicWork, "Artifact hash recorded"],
    [lot, "Ledger-recorded movement"],
  ]) {
    const svg = receiptBadgeSvg(receipt);
    assert.ok(svg.startsWith("<svg"), svg);
    assert.ok(svg.includes(label), svg);
    assert.ok(svg.includes("Project Room receipt"), svg);
    assert.ok(!svg.includes("✓"), svg);
  }
  const evil = receiptBadgeSvg({ ...merged, title: "</title><script>alert(1)</script>" });
  assert.ok(!evil.includes("<script>"), evil);
  assert.ok(evil.includes("&lt;/title&gt;"), evil);
});

test("share links carry the visible text and the canonical URL; the embed snippet links the badge to the receipt", () => {
  const links = receiptShareLinks(merged);
  assert.equal(links.text, shareTextOf(merged));
  assert.match(links.x, /^https:\/\/twitter\.com\/intent\/tweet\?text=/);
  assert.ok(decodeURIComponent(links.x).includes("Server-verified merge"));
  assert.ok(links.linkedin.includes(encodeURIComponent(links.canonical)));
  assert.ok(links.email.startsWith("mailto:?subject="));
  const snippet = receiptEmbedSnippet(merged);
  assert.ok(snippet.includes(`href="${links.canonical}"`));
  assert.ok(snippet.includes(`src="${links.canonical}/badge.svg"`));
  assert.ok(snippet.includes("Server-verified merge"));
});
