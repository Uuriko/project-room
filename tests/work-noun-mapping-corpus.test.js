// U1 — work-noun mapping corpus: coverage + replay check.
//
// Proves, mechanically (not by eyeball):
//  1. mapping.json covers EVERY state string grep-able in the legacy state
//     enums — the four machines of the UNIFY-WORK-NOUN design §1 (bounty,
//     offer, board claim, work item) plus the two sub-machines the design
//     carries along (dispute child §2.5, escrow journal lot lanes §4) and
//     the public-work facade's derived states. Coverage is bidirectional:
//     no enum state without a mapping entry, no mapping entry without an
//     enum state.
//  2. Every mapped target is a state of the one unified machine (§2.2);
//     every carried state names its home; every dropped behaviour carries
//     a signed rationale (§2.3).
//  3. The golden fixtures replay green against current main: each fixture's
//     legacy record actually sits in its claimed legacy state, every door
//     shape spells that state identically, and applying the mapping data
//     reproduces the fixture's recorded unified projection exactly.
// If an anchor below stops matching, the source moved — that failure is the
// drift alarm doing its job; re-anchor deliberately, never silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAPPING, expectedUnified, UNIFIED_STATES, CLOSE_REASONS } from "./work-noun-corpus/apply-mapping.mjs";
import { BOUNTY_STATES, stateGroup } from "../server/bounty-escrow.mjs";
import { WORK_STATES } from "../src/events.js";

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const quoted = (text, re = /"([a-z_]+)"/g) => [...text.matchAll(re)].map(m => m[1]);
const slice = (text, from, to) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `anchor missing: ${from}`);
  const b = text.indexOf(to, a);
  assert.notEqual(b, -1, `anchor missing: ${to}`);
  return text.slice(a, b);
};

// --- enum extraction, straight from the source of truth ---------------------
const escrowSrc = read("../server/bounty-escrow.mjs");
const disputeSrc = read("../server/bounty-disputes.mjs");
const offerSrc = read("../server/project-offers.mjs");
const claimSrc = read("../server/work-claims.mjs");
const eventsSrc = read("../src/events.js");
const publicSrc = read("../server/public-work-claims.mjs");

const ENUMS = {
  bounty: () => quoted(slice(escrowSrc, "BOUNTY_STATES = Object.freeze([", "])")),
  "bounty-lot": () => quoted(slice(escrowSrc, "const LOT_STATES = [", "]")),
  dispute: () => quoted(slice(disputeSrc, "const STATES = Object.freeze([", "])")),
  offer: () => {
    // Statuses live in the transition ternaries (guard + update) of
    // ProjectOffers.transition; the create insert seeds 'draft'.
    const body = slice(offerSrc, "transition(roomId", "ownerList(");
    const out = new Set();
    for (const m of body.matchAll(/\?\s*'([a-z]+)'\s*:\s*'([a-z]+)'/g)) { out.add(m[1]); out.add(m[2]); }
    for (const m of offerSrc.matchAll(/INSERT INTO project_offers VALUES[^;]*?'([a-z]+)'/g)) out.add(m[1]);
    return [...out];
  },
  "public-task": () => {
    const starter = slice(publicSrc, "_starterTaskState(row) {", "\n  }");
    const packetLine = publicSrc.split("\n").find(l => l.includes("const state = receipt ?")) ?? "";
    return [...new Set([...starter.matchAll(/'([a-z_]+)'/g), ...packetLine.matchAll(/'([a-z_]+)'/g)].map(m => m[1]))];
  },
  "board-claim": () => [...slice(claimSrc, "const CLAIM_LIFECYCLE = Object.freeze({", "\n});").matchAll(/\n {2}([a-z_]+):/g)].map(m => m[1]),
  "work-item": () => quoted(slice(eventsSrc, "WORK_STATES = Object.freeze({", "})"), /:\s*"([a-z_]+)"/g),
};

const STATE_FIELD = { bounty: "state", "bounty-lot": "lot_state", dispute: "state", offer: "status", "public-task": "claim.state", "board-claim": "state", "work-item": "state" };
const atPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

test("extractors agree with the importable enums (oracle check)", () => {
  assert.deepEqual(new Set(ENUMS.bounty()), new Set(BOUNTY_STATES));
  assert.deepEqual(new Set(ENUMS["work-item"]()), new Set(Object.values(WORK_STATES)));
});

test("mapping covers every grep-able legacy state, bidirectionally", () => {
  for (const [machine, extract] of Object.entries(ENUMS)) {
    const fromSource = new Set(extract());
    assert.ok(fromSource.size > 0, `${machine}: extractor found no states — anchor drift?`);
    const fromMapping = new Set(Object.keys(MAPPING.machines[machine]?.states ?? {}));
    assert.deepEqual(fromMapping, fromSource, `${machine}: mapping keys != enum states`);
  }
  assert.deepEqual(new Set(Object.keys(MAPPING.machines)), new Set(Object.keys(ENUMS)), "machine set drift");
});

test("mapping entries are well-formed against the unified machine (§2.2/§2.3)", () => {
  for (const [machine, m] of Object.entries(MAPPING.machines)) {
    for (const [state, entry] of Object.entries(m.states)) {
      if (entry.disposition === "mapped") {
        assert.ok(UNIFIED_STATES.includes(entry.unified), `${machine}/${state}: target ${entry.unified} is not a unified state`);
        if (entry.closeReason) assert.ok(CLOSE_REASONS.includes(entry.closeReason), `${machine}/${state}: bad closeReason`);
      } else if (entry.disposition === "carried") {
        assert.ok(typeof entry.home === "string" && entry.home.length > 0, `${machine}/${state}: carried without a home`);
      } else if (entry.disposition === "dropped") {
        assert.ok(entry.rationale && entry.signedBy, `${machine}/${state}: dropped without signed rationale`);
      } else {
        assert.fail(`${machine}/${state}: unknown disposition ${entry.disposition}`);
      }
    }
  }
  for (const drop of MAPPING.droppedBehaviours) {
    assert.ok(drop.rationale && drop.signedBy, `dropped behaviour ${drop.id} lacks a signed rationale`);
    assert.ok(MAPPING.machines[drop.machine], `dropped behaviour ${drop.id} names an unknown machine`);
  }
});

// --- fixtures ----------------------------------------------------------------
const FIXTURE_DIR = fileURLToPath(new URL("./work-noun-corpus/fixtures/", import.meta.url));
const fixtures = readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json"))
  .map(f => JSON.parse(readFileSync(`${FIXTURE_DIR}/${f}`, "utf8")));

test("every legacy state has at least one golden fixture", () => {
  assert.ok(fixtures.length >= 40, `expected >= 40 fixtures, got ${fixtures.length}`);
  const ids = new Set(fixtures.map(f => f.id));
  assert.equal(ids.size, fixtures.length, "fixture ids must be unique");
  for (const [machine, extract] of Object.entries(ENUMS)) {
    for (const state of extract()) {
      assert.ok(fixtures.some(f => f.machine === machine && f.legacyState === state), `no fixture for ${machine}/${state}`);
    }
  }
});

test("fixtures replay green against current main", () => {
  for (const f of fixtures) {
    const where = f.id;
    assert.ok(ENUMS[f.machine]().includes(f.legacyState), `${where}: state no longer in the source enum`);
    assert.equal(atPath(f.legacy, STATE_FIELD[f.machine]), f.legacyState, `${where}: legacy record is not in its claimed state`);
    assert.ok(Object.keys(f.doors).length > 0, `${where}: no door shapes`);
    for (const [door, shape] of Object.entries(f.doors)) {
      assert.equal(shape.state, f.legacyState, `${where}: door ${door} spells the state differently`);
    }
    if (f.machine === "bounty") assert.equal(f.legacy.group, stateGroup(f.legacyState), `${where}: group disagrees with stateGroup()`);
    if (f.variantOf) {
      // A variant pins extra unified attributes (e.g. snooze -> claimableFrom)
      // on top of its base state's mapping; check it extends, never contradicts.
      const base = expectedUnified(f.machine, f.legacyState);
      assert.equal(f.expectedUnified.state, base.state, `${where}: variant changes the unified state`);
      for (const [k, v] of Object.entries(base.attributes ?? {})) assert.equal(f.expectedUnified.attributes?.[k], v, `${where}: variant contradicts base attribute ${k}`);
    } else {
      assert.deepEqual(f.expectedUnified, expectedUnified(f.machine, f.legacyState), `${where}: fixture projection != mapping data`);
    }
  }
});
