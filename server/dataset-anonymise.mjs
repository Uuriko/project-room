// Dataset anonymisation — EXTRACT-TIME ONLY (data programme W4, Lane 1 §3).
//
// Capture stays verbatim (it is the proof layer). This module is a pure,
// re-runnable transform over canonical work-episodes (work-episode/1, Lane 1
// §2.1) assembled from a frozen snapshot. A bad extract is revocable; nothing
// here ever writes to the store.
//
// Two tiers, never mixed in one file (Lane 1 §3.3):
//   Tier R (rows) — structured records. Ids become keyed pseudonyms
//     HMAC-SHA256(extract_key, domain|packageId|kind|id), truncated to
//     128 bits. The key is per-package and, for external packages, destroyed
//     after packaging, so linkage survives WITHIN a package and is
//     impossible ACROSS packages. Names/handles are dropped, role labels kept.
//   Tier T (text) — free text (specs, criteria, verdict reasons, artefacts),
//     shipped only as a separate package behind the heavier pass: secret
//     scrub, pattern pass (email/phone/URL), and a person dictionary built
//     from accounts/identity_links + GitHub handles, replaced with typed
//     placeholders consistent within the package.
//
// Bright lines are enforced HERE, as code, not documentation (Jill's
// rulings, 2026-10-18): B1 private rooms never licensed onward · B4 DMs
// absolute · B5 pre-acceptance drafts absolute · B6 dispute NARRATIVES never
// licensed (structured rulings/reason codes are core provenance and stay) ·
// B7 sensitive categories absolute · B8 client-NDA/enterprise rooms absolute
// for licensing · B9 connected-inbox content absolute · U2 de-identified,
// re-identification barred · U5 lives in dataset-package.mjs (visibility
// filter, applied before this module's transforms).
//
// Fields that are NEVER emitted in any tier, by construction (the text
// builder whitelists fields; these names are not on the whitelist):
// journal `memo`, claim-history `note`s, dispute narratives (Tier T).

import { createHmac } from "node:crypto";
import { scrubString } from "./feedback-scrub.mjs";

export const DATASET_TRANSFORM_VERSION = "dataset-anonymise/1";
export const DATASET_ROW_SCHEMA = "dataset-row/1";
export const DATASET_TEXT_SCHEMA = "dataset-text/1";

const PSEUDO_BITS = 128;

// ---------------------------------------------------------------------------
// Pseudonyms
// ---------------------------------------------------------------------------

// The domain string binds the transform version, the package, and the id
// kind, so the same raw id in two packages — or in two roles in one package —
// never produces the same pseudonym (Lane 1 §3.4 failure mode 6).
export function createPseudonymiser({ key, packageId } = {}) {
  if (!key || (typeof key !== "string" && !Buffer.isBuffer(key)) || String(key).length < 16) {
    throw new Error("createPseudonymiser: a per-package key of at least 16 chars is required");
  }
  if (!packageId || typeof packageId !== "string") {
    throw new Error("createPseudonymiser: packageId is required");
  }
  const pseudo = (kind, id) => {
    if (id === null || id === undefined || id === "") return null;
    const hex = createHmac("sha256", key)
      .update(`w4/1|${packageId}|${kind}|${String(id)}`)
      .digest("hex")
      .slice(0, PSEUDO_BITS / 4);
    return `ps_${kind}_${hex}`;
  };
  return Object.freeze({
    packageId,
    actor: id => pseudo("actor", id),
    room: id => pseudo("room", id),
    episode: id => pseudo("episode", id),
    row: id => pseudo("row", id),
    entry: id => pseudo("entry", id),
    session: id => pseudo("session", id),
    principal: id => pseudo("principal", id),
    pr: ref => pseudo("pr", ref),
    generic: (kind, id) => pseudo(kind, id),
  });
}

// ---------------------------------------------------------------------------
// Coarsening helpers
// ---------------------------------------------------------------------------

export function coarsenTimestamp(value, precision) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  if (precision === "day") return `${iso.slice(0, 10)}T00:00:00.000Z`;
  return `${iso.slice(0, 13)}:00:00.000Z`; // hour precision
}

export function memberCountBand(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 1) return "1";
  if (n === 2) return "2";
  if (n <= 4) return "3-4";
  if (n <= 9) return "5-9";
  if (n <= 19) return "10-19";
  return "20+";
}

export function amountBand(millis) {
  if (!Number.isFinite(millis)) return null;
  const v = Math.abs(millis);
  if (v < 100) return "<100";
  if (v < 1000) return "100-999";
  if (v < 10000) return "1k-9.9k";
  if (v < 100000) return "10k-99.9k";
  return "100k+";
}

// ---------------------------------------------------------------------------
// Bright-line classification
// ---------------------------------------------------------------------------

// Content classes that can ride on an episode's source material (supplied by
// the assembler from the surfaces it read). dm/inbox material attaches no
// verdicts; an episode carrying either is excluded from every dataset tier.
export const CONTENT_CLASS_DM = "dm";
export const CONTENT_CLASS_INBOX = "inbox";

// Decide an episode's fate for a package. packageClass: "external" |
// "internal". Room meta is operator-supplied extract metadata (the product
// has no room-class flags yet — named seam): { privateRoom, enterpriseNda,
// sensitive, memberCount, surfaceMix }.
//
// Returns { include, licence: "licensable"|"never", reasons: [bright-line
// ids], dropTextFields: [field names withheld even when the episode ships] }.
export function classifyEpisode(episode, room = {}, { packageClass } = {}) {
  const reasons = [];
  const classes = new Set(episode?.contentClasses ?? []);
  if (classes.has(CONTENT_CLASS_DM)) reasons.push("B4");
  if (classes.has(CONTENT_CLASS_INBOX)) reasons.push("B9");
  if (reasons.length) return { include: false, licence: "never", reasons, dropTextFields: [] };

  if (room.enterpriseNda) reasons.push("B8");
  if (room.privateRoom) reasons.push("B1");
  if (episode?.sensitive === true || room.sensitive) reasons.push("B7");
  if (reasons.length) {
    // B1/B7/B8 are licensing lines: an internal package may carry the
    // episode only with licence:"never" stamped on every record, so a later
    // external cut cannot silently inherit it. B7's dataset value is ~zero
    // and its exposure highest, so it is excluded from internal too.
    const internalOk = packageClass === "internal" && !reasons.includes("B7");
    return { include: internalOk, licence: "never", reasons, dropTextFields: [] };
  }
  return { include: true, licence: "licensable", reasons, dropTextFields: [] };
}

// Text fields that exist on the input contract but must never be emitted.
// The Tier T builder whitelists; this list is exported so tests (and the
// package gate) can plant these fields and prove their absence.
export const NEVER_EMITTED_TEXT_FIELDS = Object.freeze([
  "memo", // bounty_journal free text inside the hash core (Lane 1 §3.3)
  "historyNotes", // claim history[].note — highest third-party density
  "disputeNarrative", // B6 — written for an adjudicator, never licensed
]);

// ---------------------------------------------------------------------------
// Tier R — row transform
// ---------------------------------------------------------------------------

const CRITERION_OUTCOME_KEYS = Object.freeze(["id", "criterionId", "outcome", "result", "pass"]);

// Whitelist-copy a criteria-outcomes array: ids + enum outcomes only. Any
// free-text a producer attached is dropped here, not scanned later.
function sanitiseCriteriaOutcomes(outcomes) {
  if (!Array.isArray(outcomes)) return null;
  return outcomes.map(o => {
    if (!o || typeof o !== "object") return o;
    const clean = {};
    for (const k of CRITERION_OUTCOME_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v.length <= 40) clean[k] = v;
      else if (typeof v === "boolean" || typeof v === "number") clean[k] = v;
    }
    return clean;
  });
}

function anonymiseVerdict(row, ctx) {
  const { pseudonymiser, precision } = ctx;
  return {
    row: pseudonymiser.row(row.rowId),
    subject: pseudonymiser.actor(row.subjectId),
    verifier: pseudonymiser.actor(row.verifierId),
    decisionKind: row.decisionKind ?? null,
    outcome: row.outcome ?? null,
    accepted: row.accepted ?? null,
    tier: row.tier ?? null, // GQ-5: carried verbatim, never upgraded
    rubricVersion: row.rubricVersion ?? null,
    criteriaOutcomes: sanitiseCriteriaOutcomes(row.criteriaOutcomes),
    criteriaHash: row.criteriaHash ?? null,
    decidedAt: coarsenTimestamp(row.decidedAt, precision),
    submittedAt: coarsenTimestamp(row.submittedAt, precision),
    supersedes: pseudonymiser.row(row.supersedesRowId),
    session: pseudonymiser.session(row.sessionInstanceId),
    principal: pseudonymiser.principal(row.authorizingPrincipalId),
    claimedModelVersion: row.claimedModelVersion ?? null,
    claimedHarnessVersion: row.claimedHarnessVersion ?? null,
  };
}

function anonymiseProvenance(prov, ctx) {
  if (!prov || typeof prov !== "object") return null;
  const { pseudonymiser } = ctx;
  return {
    session: pseudonymiser.session(prov.sessionInstanceId),
    principal: pseudonymiser.principal(prov.authorizingPrincipalId),
    claimedModelVersion: prov.claimedModelVersion ?? null,
    claimedHarnessVersion: prov.claimedHarnessVersion ?? null,
    claimedEnvironment: prov.claimedEnvironment ?? null,
    stampSource: prov.stampSource ?? null,
  };
}

// ctx: { pseudonymiser, precision: "hour"|"day", licence, pooled: bool, room }
// Amount uniqueness banding is a package-level post-pass (dataset-package).
export function anonymiseEpisodeForRows(episode, ctx) {
  const { pseudonymiser, precision, licence, pooled, room } = ctx;
  const claim = episode.claim ?? null;
  const delivery = episode.delivery ?? null;
  const settlement = episode.settlement ?? null;
  const dispute = episode.dispute ?? null;
  return {
    schema: DATASET_ROW_SCHEMA,
    episode: pseudonymiser.episode(episode.recordId ?? episode.episodeId),
    surface: episode.surface ?? null,
    cohort: episode.cohort ?? null, // GQ-5: drill/fleet labelled, never hidden
    licence: licence ?? "licensable",
    room: pooled
      ? { ref: "room_pooled", memberBand: null, surfaceMix: null }
      : {
          ref: pseudonymiser.room(episode.roomId),
          memberBand: memberCountBand(room?.memberCount),
          surfaceMix: room?.surfaceMix ?? null,
        },
    task: episode.task
      ? {
          specHash: episode.task.specHash ?? null,
          criteriaHash: episode.task.criteriaHash ?? null,
          rubricVersion: episode.task.rubricVersion ?? null,
          rewardMillis: episode.task.rewardMillis ?? null,
          rewardBand: null,
          termsVersion: episode.task.termsVersion ?? null,
        }
      : null,
    claim: claim
      ? {
          claimant: pseudonymiser.actor(claim.claimantRef),
          claimedAt: coarsenTimestamp(claim.claimedAt, precision),
          leaseHours: claim.leaseHours ?? null,
          deliveryGeneration: claim.deliveryGeneration ?? null,
        }
      : null,
    delivery: delivery
      ? {
          artefactHash: delivery.artefactHash ?? null,
          artefactKind: delivery.artefactKind ?? null,
          submittedAt: coarsenTimestamp(delivery.submittedAt, precision),
          prRef: delivery.prUrl ? pseudonymiser.pr(delivery.prUrl) : null,
        }
      : null,
    verdicts: Array.isArray(episode.verdicts)
      ? episode.verdicts.map(v => anonymiseVerdict(v, ctx))
      : [],
    settlement: settlement
      ? {
          entries: Array.isArray(settlement.journalEntryIds)
            ? settlement.journalEntryIds.map(id => pseudonymiser.entry(id))
            : [],
          netMillis: settlement.netMillis ?? null,
          netBand: null,
          outcome: settlement.outcome ?? null,
        }
      : null,
    dispute: dispute
      ? {
          // Structured ruling only — the narrative is B6, never licensed.
          outcome: dispute.outcome ?? null,
          reasonCodes: Array.isArray(dispute.reasonCodes) ? [...dispute.reasonCodes] : [],
          decider: pseudonymiser.actor(dispute.deciderRef),
          openedAt: coarsenTimestamp(dispute.openedAt, precision),
          resolvedAt: coarsenTimestamp(dispute.resolvedAt, precision),
        }
      : null,
    provenance: anonymiseProvenance(episode.provenance, ctx),
    outcomeLabel: episode.outcomeLabel ?? null, // computed upstream, copied — never asserted here
    retentionClass: episode.retentionClass ?? null,
  };
}

// Distinct raw actor ids an episode touches (cohort-rule input, §3.4.3).
export function episodeActorIds(episode) {
  const ids = new Set();
  const add = v => { if (v !== null && v !== undefined && v !== "") ids.add(String(v)); };
  add(episode.claim?.claimantRef);
  add(episode.dispute?.deciderRef);
  add(episode.provenance?.authorizingPrincipalId);
  for (const v of episode.verdicts ?? []) { add(v.subjectId); add(v.verifierId); }
  return ids;
}

// ---------------------------------------------------------------------------
// Tier T — text scrubbing
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>()]+/g;
// Phone-shaped: >=10 digits allowing single separators, optional leading +.
// (Dates have 8 digits and never match; ISO timestamps are colon-broken.)
// A candidate only counts when it is NOT embedded in a longer alphanumeric
// token — a 10-digit run inside a hex pseudonym or hash is not a phone
// (the W4 red team hit exactly that false positive at package scale).
const PHONE_RE = /\+?\d(?:[\s().-]?\d){9,}/g;
function isPhoneCandidate(text, offset, match) {
  const before = offset > 0 ? text[offset - 1] : "";
  const after = text[offset + match.length] ?? "";
  if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) return false;
  return match.replace(/\D/g, "").length >= 10;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// people: [{ names: [displayName, ...], handles: [githubHandle, ...] }]
// roomTerms: room ids/names — free text mentions rooms ("the room_big
// workstream"), and a room name can identify (client-named rooms), so room
// terms scrub to a single unnumbered [ROOM] placeholder: room identity in
// text is not linkable even within the package. (Found by the W4 red team:
// GQ-3's scan caught room ids surviving in spec text; the scrubber, not just
// the scan, now knows them.)
// Placeholder assignment is first-seen order; the packager feeds records in
// a stable sorted order so a package is reproducible (GQ-6).
export function createTextScrubber({ people = [], roomTerms = [] } = {}) {
  const placeholderByKey = new Map(); // person index -> [PERSON-n]
  let counter = 0;
  const placeholderFor = key => {
    if (!placeholderByKey.has(key)) {
      counter += 1;
      placeholderByKey.set(key, `[PERSON-${counter}]`);
    }
    return placeholderByKey.get(key);
  };
  // Every term of one person — full names, the name's component tokens
  // (people write "Maria" for Maria Chen), handles with and without "@" —
  // maps to the SAME placeholder. Longest-first so "Maria Chen" is replaced
  // before "Maria".
  const dictionary = [];
  people.forEach((person, personIdx) => {
    for (const name of person.names ?? []) {
      if (typeof name !== "string" || name.trim().length < 2) continue;
      dictionary.push({ term: name.trim(), key: personIdx });
      for (const part of name.trim().split(/\s+/)) {
        if (part.length >= 3) dictionary.push({ term: part, key: personIdx });
      }
    }
    for (const handle of person.handles ?? []) {
      if (typeof handle !== "string" || handle.trim().length < 2) continue;
      dictionary.push({ term: handle.trim(), key: personIdx });
      dictionary.push({ term: `@${handle.trim()}`, key: personIdx });
    }
  });
  dictionary.sort((a, b) => b.term.length - a.term.length);

  function scrub(text) {
    if (typeof text !== "string" || text === "") return text ?? null;
    let out = scrubString(text); // secret shapes first (feedback-scrub patterns)
    out = out.replace(EMAIL_RE, "[EMAIL]");
    out = out.replace(URL_RE, "[URL]");
    out = out.replace(PHONE_RE, (m, offset, s) => (isPhoneCandidate(s, offset, m) ? "[PHONE]" : m));
    for (const { term, key } of dictionary) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`, "gi");
      out = out.replace(re, () => placeholderFor(key));
    }
    for (const term of roomTerms) {
      if (typeof term !== "string" || term.trim().length < 3) continue;
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term.trim())}(?![A-Za-z0-9_])`, "gi");
      out = out.replace(re, "[ROOM]");
    }
    return out;
  }
  return Object.freeze({ scrub, placeholderCount: () => counter });
}

// Whitelisted Tier T fields, in fixed processing order (determinism).
export const TEXT_FIELD_ORDER = Object.freeze([
  "spec",
  "criteria",
  "criteriaSummaries", // { rowId: text }
  "verdictReasons", // { rowId: text }
  "artefact",
]);

// Build one Tier T record for an episode, or null when it has no shippable
// text. A draft delivery's artefact text never ships (B5): the artefact
// field is withheld and named in withheldFields. Journal memo, history
// notes, and the dispute narrative are not on the whitelist and are never
// read here (B6 / Lane 1 §3.3).
export function anonymiseEpisodeForText(episode, ctx) {
  const { pseudonymiser, scrubber, licence } = ctx;
  const texts = episode.texts ?? {};
  const withheld = [];
  const out = {
    schema: DATASET_TEXT_SCHEMA,
    episode: pseudonymiser.episode(episode.recordId ?? episode.episodeId),
    surface: episode.surface ?? null,
    cohort: episode.cohort ?? null,
    licence: licence ?? "licensable",
    spec: null,
    criteria: null,
    criteriaSummaries: null,
    verdictReasons: null,
    artefact: null,
    withheldFields: withheld,
  };
  let any = false;
  if (typeof texts.spec === "string" && texts.spec) { out.spec = scrubber.scrub(texts.spec); any = true; }
  if (typeof texts.criteria === "string" && texts.criteria) { out.criteria = scrubber.scrub(texts.criteria); any = true; }
  for (const field of ["criteriaSummaries", "verdictReasons"]) {
    const bag = texts[field];
    if (bag && typeof bag === "object") {
      const scrubbed = {};
      for (const rowId of Object.keys(bag).sort()) {
        if (typeof bag[rowId] === "string" && bag[rowId]) {
          scrubbed[pseudonymiser.row(rowId)] = scrubber.scrub(bag[rowId]);
          any = true;
        }
      }
      if (Object.keys(scrubbed).length) out[field] = scrubbed;
    }
  }
  if (typeof texts.artefact === "string" && texts.artefact) {
    if (episode.delivery?.draft === true) withheld.push("artefact:draft");
    else { out.artefact = scrubber.scrub(texts.artefact); any = true; }
  }
  return any || withheld.length ? out : null;
}

// ---------------------------------------------------------------------------
// Leak scanning (GQ-3's automated half)
// ---------------------------------------------------------------------------

const SECRET_SHAPE_RES = Object.freeze([
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/, // JWT
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, // PEM
  /\b(sk-|rk-|ghp_|gho_|ghu_|ghs_|xox[bap]-|AKIA|glpat-)[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/, // vendor prefixes
  /\b(?:pri_|rak_|ga1\.)[A-Za-z0-9_-]{8,}/, // room-export token shapes
]);

// Scan serialized package output for direct-identifier leaks. Returns an
// array of { kind, detail } hits; empty = clean. Checks: raw input ids
// (the strongest signal — a pseudonym can never collide with a raw id),
// person names/handles, emails, URLs, phone shapes, secret shapes.
export function scanForLeaks(serialized, { people = [], rawIds = [] } = {}) {
  const hits = [];
  EMAIL_RE.lastIndex = 0;
  URL_RE.lastIndex = 0;
  PHONE_RE.lastIndex = 0;
  const text = typeof serialized === "string" ? serialized : JSON.stringify(serialized);
  for (const id of rawIds) {
    if (typeof id === "string" && id.length >= 4 && text.includes(id)) {
      hits.push({ kind: "raw-id", detail: id });
    }
  }
  for (const person of people) {
    for (const term of [...(person.names ?? []), ...(person.handles ?? [])]) {
      if (typeof term !== "string" || term.trim().length < 3) continue;
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term.trim())}(?![A-Za-z0-9_])`, "i");
      if (re.test(text)) hits.push({ kind: "person-term", detail: term });
    }
  }
  if (EMAIL_RE.test(text)) hits.push({ kind: "email", detail: "email-shaped string present" });
  if (URL_RE.test(text)) hits.push({ kind: "url", detail: "URL present" });
  PHONE_RE.lastIndex = 0;
  let phoneMatch;
  while ((phoneMatch = PHONE_RE.exec(text)) !== null) {
    if (isPhoneCandidate(text, phoneMatch.index, phoneMatch[0])) {
      hits.push({ kind: "phone", detail: "phone-shaped string present" });
      break;
    }
  }
  for (const re of SECRET_SHAPE_RES) {
    if (re.test(text)) hits.push({ kind: "secret-shape", detail: String(re).slice(0, 40) });
  }
  EMAIL_RE.lastIndex = 0;
  URL_RE.lastIndex = 0;
  return hits;
}

// Word shingles for the Tier T uniqueness check (§3.4 failure mode 1): a
// task text that also lives in a public corpus is a fingerprint even after
// names are scrubbed.
export function wordShingles(text, size = 8) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const shingles = new Set();
  for (let i = 0; i + size <= words.length; i += 1) {
    shingles.add(words.slice(i, i + size).join(" "));
  }
  return shingles;
}

// Fraction of the candidate's shingles found in the public document.
export function shingleOverlap(candidateText, publicText, size = 8) {
  return shingleOverlapSets(wordShingles(candidateText, size), wordShingles(publicText, size));
}

// Set form: callers checking many candidates against a corpus build each
// document's shingle set ONCE (the packager does — per-pair recomputation
// is quadratic waste at extract scale).
export function shingleOverlapSets(candidateShingles, publicShingles) {
  if (candidateShingles.size === 0) return 0;
  let shared = 0;
  for (const s of candidateShingles) if (publicShingles.has(s)) shared += 1;
  return shared / candidateShingles.size;
}
