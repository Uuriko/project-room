// Rank listings for an agent that entered matchmaking.
// Does not claim, reserve, or talk to the network. Claim is a later verb.

const MOTIVES = new Set(["hobby", "credits", "cash"]);
const KINDS = new Set(["offer", "bounty", "claim"]);

function fail(code) { const e = new Error(code); e.code = code; throw e; }

function tagsOf(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("invalid_match_input");
  const out = [];
  for (const tag of value) {
    if (typeof tag !== "string" || !tag.trim() || tag.length > 32) fail("invalid_match_input");
    const lower = tag.trim().toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  if (out.length > 16) fail("invalid_match_input");
  return out;
}

export function normalizeSeeker(seeker) {
  if (!seeker || typeof seeker !== "object") fail("invalid_match_input");
  const motive = seeker.motive === "any" || MOTIVES.has(seeker.motive) ? seeker.motive : fail("invalid_match_input");
  return { motive, tags: tagsOf(seeker.tags) };
}

export function normalizeListing(listing) {
  if (!listing || typeof listing !== "object") fail("invalid_match_input");
  if (typeof listing.id !== "string" || listing.id.length < 1 || listing.id.length > 128) fail("invalid_match_input");
  if (!KINDS.has(listing.kind) || !MOTIVES.has(listing.motive)) fail("invalid_match_input");
  if (typeof listing.title !== "string" || listing.title.length < 1 || listing.title.length > 200) fail("invalid_match_input");
  if (listing.open !== true) fail("invalid_match_input");
  return {
    id: listing.id,
    kind: listing.kind,
    motive: listing.motive,
    title: listing.title,
    tags: tagsOf(listing.tags),
    roomId: typeof listing.roomId === "string" ? listing.roomId : null
  };
}

export function listingFitsMotive(seekerMotive, listingMotive) {
  if (seekerMotive === "any") return true;
  return seekerMotive === listingMotive;
}

export function scoreListing(seeker, listing) {
  const s = normalizeSeeker(seeker);
  const l = normalizeListing(listing);
  if (!listingFitsMotive(s.motive, l.motive)) return null;
  const overlap = s.tags.filter(tag => l.tags.includes(tag));
  const titleHits = s.tags.filter(tag => l.title.toLowerCase().includes(tag));
  const score = overlap.length * 2 + titleHits.length;
  const reasons = [];
  if (s.motive === l.motive) reasons.push(`motive:${l.motive}`);
  else reasons.push("motive:any");
  for (const tag of overlap) reasons.push(`tag:${tag}`);
  return { listing: l, score, reasons };
}

export function matchListings(seeker, listings, { limit = 5 } = {}) {
  if (!Array.isArray(listings)) fail("invalid_match_input");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail("invalid_match_input");
  normalizeSeeker(seeker);
  const ranked = [];
  for (const listing of listings) {
    if (listing && listing.open === false) continue;
    const hit = scoreListing(seeker, listing);
    if (hit) ranked.push(hit);
  }
  ranked.sort((a, b) => b.score - a.score || a.listing.id.localeCompare(b.listing.id));
  return ranked.slice(0, limit);
}
