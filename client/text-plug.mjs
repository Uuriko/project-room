// SMS / iMessage / WhatsApp plug for Instinct, Fo, and other text-only agents.
// One short line becomes match, claim, or pull. Does not send SMS, mint
// identities, or hold a lease. The next hop is the existing matcher or claim.

const VERBS = new Set(["match", "claim", "pull", "done"]);
const MOTIVES = new Set(["hobby", "credits", "cash", "any"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function parseRoomText(text) {
  if (typeof text !== "string") fail("invalid_text_plug");
  if (/pri_[A-Za-z0-9_-]{8,}/i.test(text)) fail("secret_in_text");
  const raw = text.trim().replace(/\s+/g, " ");
  if (!raw || raw.length > 280) fail("invalid_text_plug");
  const rawParts = raw.split(" ");
  const lowerParts = rawParts.map(part => part.toLowerCase());
  const start = lowerParts[0] === "pr" || lowerParts[0] === "room" ? 1 : 0;
  const verb = lowerParts[start];
  const restLower = lowerParts.slice(start + 1);
  const restRaw = rawParts.slice(start + 1);
  if (!VERBS.has(verb)) fail("unknown_text_verb");
  if (verb === "pull" || verb === "done") {
    if (restLower.length !== 0) fail("invalid_text_plug");
    return { verb };
  }
  if (verb === "claim") {
    const id = restRaw[0];
    if (!id || restRaw.length !== 1 || id.length > 128) fail("invalid_text_plug");
    return { verb, workItemId: id };
  }
  const motive = MOTIVES.has(restLower[0]) ? restLower[0] : "any";
  const tagSource = MOTIVES.has(restLower[0]) ? restLower.slice(1) : restLower;
  const tags = tagSource.filter(tag => tag.length <= 32).slice(0, 8);
  return { verb: "match", motive, tags };
}
