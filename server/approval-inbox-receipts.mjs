// Approval-inbox receipt linkage (WAVE-500 guild 10 slice 7).
//
// The unified approval inbox surfaces pending HUMAN decisions as cards.
// Resolving a card emits a receipt — what ran, what it read, what changed,
// who signed off — linkable from the card.
//
// THE SEAM (read before extending): the run-receipt surface (PR #2546, open
// at time of writing) projects receipts from SETTLED WORK-CLAIMS keyed by
// receiptId = "rc_" + workItemId, resolvable at
// GET /api/rooms/{roomId}/receipts/{receiptId}. An inbox card is NOT a
// work-claim, so this module does NOT mint into that surface directly — it
// cannot, and it must not reimplement receipt storage either. Instead it
// keeps a tiny durable cardId→receiptId LINKAGE table:
//   - receiptId is the canonical link "rc_" + cardId (same shape the
//     receipt surface would use once inbox resolutions project receipts).
//   - status is "pending" until the receipt surface resolves receiptId,
//     then "linked". The flip is lazy: either the caller supplies a
//     receiptProbe(id) => boolean (wired by the HTTP layer against GET
//     /receipts/{receiptId}), or it calls markLinked(cardId) after it has
//     confirmed a 200 itself.
// Backfill: already-resolved cards get a linkage in "pending" state with NO
// payload — honesty rule: no untraceable rows, never a fabricated receipt.
// When #2546 merges and inbox resolutions project real receipts, the lazy
// probe flips "pending" rows to "linked" with no migration.
//
// Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and
// receiptProbe are injected so fixtures control time and linkage checks. The
// caller owns durability — snapshot()/restore() round-trip the table as
// plain JSON for the store layer to persist.
export class InboxReceiptError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "InboxReceiptError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new InboxReceiptError(code, message, detail); };
const check = (condition, code, message, detail) => { if (!condition) fail(code, message, detail); };

// Same receiptId contract as the #2546 receipt surface and docs/openapi.yaml:
// "rc_" + workItemId, pattern rc_[A-Za-z0-9_-]{1,128}.
export const RECEIPT_ID_PREFIX = "rc_";
export const RECEIPT_ID_MAX = 128;
const receiptIdShape = /^rc_[A-Za-z0-9_-]{1,128}$/;

// The canonical link an inbox card's resolution will resolve under once the
// receipt surface projects it. cardId must survive untouched — no mangling,
// no sanitization beyond rejecting what the receiptId contract rejects.
export function receiptIdForCardId(cardId) {
  check(typeof cardId === "string" && cardId.length >= 1, "inbox_receipt_bad_card_id",
    "cardId must be a non-empty string.", { cardId });
  const receiptId = `${RECEIPT_ID_PREFIX}${cardId}`;
  check(receiptIdShape.test(receiptId), "inbox_receipt_bad_card_id",
    `cardId cannot link to a receipt: "${receiptId}" violates the receipt surface's rc_[A-Za-z0-9_-]{1,128} contract.`,
    { cardId });
  return receiptId;
}

const textOf = (value, max, field) => {
  check(typeof value === "string" && value.isWellFormed() && value.length >= 1 && value.length <= max,
    "inbox_receipt_invalid", `${field} must be 1..${max} well-formed characters.`);
  return value;
};
const isoAt = (value, field) => {
  check(typeof value === "string", "inbox_receipt_invalid", `${field} must be an ISO-8601 timestamp.`);
  const ms = Date.parse(value);
  check(Number.isFinite(ms), "inbox_receipt_invalid", `${field} is not a valid timestamp.`, { field, value });
  return new Date(ms).toISOString();
};
const optText = (value, max, field) => {
  if (value === undefined || value === null) return null;
  return textOf(value, max, field);
};
const arrayOfText = (value, field) => {
  check(Array.isArray(value), "inbox_receipt_invalid", `${field} must be an array of strings.`);
  return Object.freeze(value.map(entry => textOf(entry, 2000, `${field}[]`)));
};
const optionalObject = (value, field) => {
  if (value === undefined || value === null) return null;
  check(value !== null && typeof value === "object" && !Array.isArray(value),
    "inbox_receipt_invalid", `${field} must be an object when given.`);
  return Object.freeze({ ...value });
};

const freezeLinkage = linkage => Object.freeze({
  ...linkage,
  payload: linkage.payload === null ? null : Object.freeze({
    ...linkage.payload,
    whatRead: Object.freeze([...linkage.payload.whatRead]),
    signedOff: Object.freeze({ ...linkage.payload.signedOff }),
  }),
});

// card: { cardId, title? } — the inbox card that resolved.
// resolution: { decision, decidedBy, decidedAt, whatRan?, whatRead?, whatChanged? }.
//   decision: "approved" | "rejected" | any terminal verdict string.
//   decidedBy: the human identity that signed off (inbox-approval.mjs
//     already enforces human-only verdicts upstream).
//   decidedAt: ISO-8601 when the verdict landed.
//   whatRan / whatRead / whatChanged: the four-field receipt core —
//     whatRan: { run, ... } what the resolution set in motion;
//     whatRead: [evidence strings] what the decision was based on;
//     whatChanged: { files?, notes? } what changed as a result.
export const buildReceiptPayload = (card, resolution) => {
  check(card !== null && typeof card === "object" && !Array.isArray(card),
    "inbox_receipt_invalid", "card must be an object.");
  check(resolution !== null && typeof resolution === "object" && !Array.isArray(resolution),
    "inbox_receipt_invalid", "resolution must be an object.");
  const cardId = textOf(card.cardId, 128, "card.cardId");
  const receiptId = receiptIdForCardId(cardId);
  const decision = textOf(resolution.decision, 64, "resolution.decision");
  const decidedBy = textOf(resolution.decidedBy, 256, "resolution.decidedBy");
  const decidedAt = isoAt(resolution.decidedAt, "resolution.decidedAt");
  return Object.freeze({
    receiptId,
    cardId,
    decision,
    decidedBy,
    decidedAt,
    whatRan: optionalObject(resolution.whatRan, "resolution.whatRan"),
    whatRead: Object.freeze(resolution.whatRead === undefined ? [] : arrayOfText(resolution.whatRead, "resolution.whatRead")),
    whatChanged: optionalObject(resolution.whatChanged, "resolution.whatChanged"),
    signedOff: Object.freeze({ by: decidedBy, at: decidedAt }),
  });
};

export function createInboxReceiptStore({ clock = () => Date.now(), receiptProbe = null } = {}) {
  const linkages = new Map(); // cardId -> linkage
  const isoNow = () => new Date(clock()).toISOString();

  const recordLinkage = ({ cardId, receiptId, decision, decidedBy, decidedAt, payload, backfilled }) => {
    check(!linkages.has(cardId), "inbox_receipt_duplicate",
      `A receipt linkage for card "${cardId}" already exists — refusing to duplicate or fabricate.`, { cardId });
    const linkage = freezeLinkage({
      cardId, receiptId, decision, decidedBy, decidedAt,
      status: "pending", payload, backfilled: backfilled === true, recordedAt: isoNow(),
    });
    linkages.set(cardId, linkage);
    return linkage;
  };

  // A live resolution lands: build the payload and record the linkage.
  // Status starts "pending" — the receipt surface resolves it later.
  function recordResolution(card, resolution) {
    const payload = buildReceiptPayload(card, resolution);
    return recordLinkage({
      cardId: payload.cardId, receiptId: payload.receiptId,
      decision: payload.decision, decidedBy: payload.decidedBy, decidedAt: payload.decidedAt,
      payload, backfilled: false,
    });
  }

  // Backfill: cards that resolved BEFORE this module existed get a linkage
  // row so they are visible as "receipt pending" — with NO payload. Their
  // whatRan/whatRead/whatChanged was never captured, and fabricating it
  // would create an untraceable receipt. Cards already recorded are skipped.
  // Entries: [{ cardId, decision?, decidedBy?, decidedAt? }].
  function backfillResolved(resolvedCards) {
    check(Array.isArray(resolvedCards), "inbox_receipt_invalid", "backfillResolved takes an array of resolved cards.");
    const added = [];
    for (const entry of resolvedCards) {
      check(entry !== null && typeof entry === "object" && !Array.isArray(entry),
        "inbox_receipt_invalid", "each backfill entry must be an object.");
      const cardId = textOf(entry.cardId, 128, "entry.cardId");
      if (linkages.has(cardId)) continue;
      const receiptId = receiptIdForCardId(cardId);
      added.push(recordLinkage({
        cardId, receiptId,
        decision: optText(entry.decision, 64, "entry.decision"),
        decidedBy: entry.decidedBy === undefined || entry.decidedBy === null ? null : textOf(entry.decidedBy, 256, "entry.decidedBy"),
        decidedAt: entry.decidedAt === undefined || entry.decidedAt === null ? null : isoAt(entry.decidedAt, "entry.decidedAt"),
        payload: null,
        backfilled: true,
      }));
    }
    return Object.freeze(added);
  }

  const get = cardId => linkages.get(cardId) ?? null;

  // Lazy resolve: if a probe is wired (the HTTP layer checking GET
  // /receipts/{receiptId}), a "pending" row whose receiptId now resolves
  // flips to "linked". No probe -> pending stays pending; never guess.
  const statusOf = cardId => {
    const linkage = linkages.get(cardId);
    if (!linkage) return null;
    if (linkage.status === "pending" && receiptProbe !== null && receiptProbe !== undefined) {
      let resolves = false;
      try { resolves = receiptProbe(linkage.receiptId) === true; } catch { resolves = false; }
      if (resolves) {
        const flipped = freezeLinkage({ ...linkage, status: "linked" });
        linkages.set(cardId, flipped);
        return flipped;
      }
    }
    return linkage;
  };

  // Caller-confirmed: the receipt surface returned 200 for this receiptId.
  function markLinked(cardId) {
    const linkage = linkages.get(cardId);
    check(linkage, "inbox_receipt_not_found", `No receipt linkage for card "${cardId}".`, { cardId });
    if (linkage.status === "linked") return linkage;
    const flipped = freezeLinkage({ ...linkage, status: "linked" });
    linkages.set(cardId, flipped);
    return flipped;
  }

  const list = () => Object.freeze([...linkages.values()]);

  const snapshot = () => Object.freeze([...linkages.values()].map(linkage => ({
    cardId: linkage.cardId, receiptId: linkage.receiptId,
    decision: linkage.decision, decidedBy: linkage.decidedBy, decidedAt: linkage.decidedAt,
    status: linkage.status, backfilled: linkage.backfilled, recordedAt: linkage.recordedAt,
    payload: linkage.payload === null ? null : { ...linkage.payload, whatRead: [...linkage.payload.whatRead] },
  })));

  function restore(entries) {
    check(Array.isArray(entries), "inbox_receipt_invalid", "restore takes an array of linkage snapshots.");
    for (const entry of entries) {
      check(entry !== null && typeof entry === "object" && !Array.isArray(entry),
        "inbox_receipt_invalid", "each restored entry must be an object.");
      const cardId = textOf(entry.cardId, 128, "entry.cardId");
      check(receiptIdForCardId(cardId) === entry.receiptId,
        "inbox_receipt_invalid", "restored receiptId does not match the rc_<cardId> contract.", { cardId });
      check(["pending", "linked"].includes(entry.status),
        "inbox_receipt_invalid", `restored status must be "pending" or "linked".`, { cardId });
      if (entry.payload !== null && entry.payload !== undefined) {
        const rebuilt = buildReceiptPayload({ cardId }, {
          decision: entry.payload.decision, decidedBy: entry.payload.decidedBy,
          decidedAt: entry.payload.decidedAt, whatRan: entry.payload.whatRan,
          whatRead: entry.payload.whatRead, whatChanged: entry.payload.whatChanged,
        });
        linkages.set(cardId, freezeLinkage({ ...entry, payload: rebuilt }));
      } else {
        linkages.set(cardId, freezeLinkage({ ...entry, payload: null }));
      }
    }
  }

  return Object.freeze({ recordResolution, backfillResolved, get, status: statusOf, markLinked, list, snapshot, restore });
}
