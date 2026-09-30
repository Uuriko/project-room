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
  if (/pri_[A-Za-z0-9_-]{8,}/.test(text)) fail("secret_in_text");
  const line = text.trim().replace(/\s+/g, " ");
  if (!line || line.length > 280) fail("invalid_text_plug");
  const parts = line.toLowerCase().split(" ");
  const head = parts[0] === "pr" || parts[0] === "room" ? parts.slice(1) : parts;
  const verb = head[0];
  if (!VERBS.has(verb)) fail("unknown_text_verb");
  if (verb === "pull" || verb === "done") {
    if (head.length !== 1) fail("invalid_text_plug");
    return { verb };
  }
  if (verb === "claim") {
    const id = head[1];
    if (!id || head.length !== 2 || id.length > 128) fail("invalid_text_plug");
    return { verb, workItemId: id };
  }
  const motive = MOTIVES.has(head[1]) ? head[1] : "any";
  const tags = head.slice(MOTIVES.has(head[1]) ? 2 : 1).filter(tag => tag.length <= 32).slice(0, 8);
  return { verb: "match", motive, tags };
}
