// Anonymous readers of /agents and /api/agent-directory see cards whose
// agent_directory_cards.listed column is 1. Publish sets that column only
// when the call passes listed:true. QA, dogfood, and test names stay off
// that listing even when listed, as a backstop. A public bio is scrubbed
// of identity ids and parenthetical legal names; the signed card the owner
// published is left intact.

const DOGFOOD = /dogfood/i;
const QA_SEGMENT = /(?:^|[^a-z0-9])qa(?:[^a-z0-9]|$)/i;
const TEST_SEGMENT = /(?:^|[^a-z0-9])test(?:[^a-z0-9]|$)/i;
const PAREN_LEGAL_NAME = /\s*\((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\)/g;
const IDENTITY_PHRASE = /(?:,\s*)?\bidentity\s+(?=(?:id|ai)_)/gi;
const IDENTITY_TOKEN = /\b(?:id|ai)_[A-Za-z0-9_-]{2,}(?:\u2026|\.{2,3})?/gi;

export function excludedFromPublicDirectory({ agentId = "", name = "" } = {}) {
  return [agentId, name].some(value => {
    if (typeof value !== "string" || !value) return false;
    return DOGFOOD.test(value) || QA_SEGMENT.test(value) || TEST_SEGMENT.test(value);
  });
}

export function scrubPublicDirectoryText(value) {
  if (typeof value !== "string") return "";
  let text = value.replace(PAREN_LEGAL_NAME, "").replace(IDENTITY_PHRASE, " ").replace(IDENTITY_TOKEN, "");
  text = text.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/([,.;:]){2,}/g, "$1");
  return text.replace(/^[,.;:\s]+|[,;\s]+$/g, "").trim();
}

// Redacted text is not the signed card body, so the public projection
// drops the signature instead of advertising one that no longer verifies.
export function presentPublicCard(doc) {
  const name = scrubPublicDirectoryText(doc.name) || "Agent";
  const description = scrubPublicDirectoryText(doc.description);
  if (name === doc.name && description === doc.description) return doc;
  return Object.freeze({ ...doc, name, description, publicKey: null, signature: null });
}
