// Approval-inbox terminal CLI (WAVE-500 guild 10): one live surface for
// pending HUMAN decisions as cards, replacing the scattered tap list.
//
// A card is a decision a human must make:
//   { id, kind, status: "pending"|"decided", title, createdAt (ISO string),
//     what, context, options: [{ label, consequence }], decision: null |
//     { choice: "approve"|"approve-session"|"deny-stop", by, at, note } }
//
// Source: --db <path> reads cards from a JSON file (object with a `cards`
// array, or a bare array). Without --db, the script lazy-imports the sibling
// slice's module ./approval-inbox-cards.mjs (default export: array of cards,
// or { listCards() }). If neither exists it exits with a clear error.
//
// `decide` always needs --db (decisions are persisted back to the JSON file)
// and always needs --as-human <human-identity-id>: the CLI runs as the
// operator, never as an agent, so an explicit human identity is required and
// agent-shaped ids are refused.
//
// Usage:
//   node scripts/approval-inbox.mjs list [--kind KIND] [--status STATUS|all] [--db PATH]
//   node scripts/approval-inbox.mjs show <id> [--db PATH]
//   node scripts/approval-inbox.mjs decide <id> <approve|approve-session|deny-stop> --as-human <id> [--note <text>] --db PATH
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SIBLING_MODULE = resolve(HERE, "approval-inbox-cards.mjs");
const DECISIONS = ["approve", "approve-session", "deny-stop"];
// Identity ids that look like agents/bots, never a human operator.
const AGENT_ID_PATTERN = /^(agent|bot|lane|jill|jill-dot|dot|fo|tab|instinct|quill|codex|grok|claude|herdr)[-_]?/i;

const fail = message => { process.stderr.write(`error: ${message}\n`); process.exit(2); };
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

const ageOf = iso => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "?";
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const validateCard = (card, index) => {
  const where = card && typeof card.id === "string" ? `card ${card.id}` : `card[${index}]`;
  if (!isPlainObject(card)) fail(`${where} must be an object`);
  for (const field of ["id", "kind", "title"]) {
    if (typeof card[field] !== "string" || !card[field].trim()) fail(`${where} needs a non-empty string "${field}"`);
  }
  if (card.status !== "pending" && card.status !== "decided") fail(`${where} status must be pending|decided`);
  if (!Array.isArray(card.options)) fail(`${where} needs an options array`);
  return card;
};

async function loadCards(dbPath) {
  if (dbPath) {
    let raw;
    try { raw = readFileSync(dbPath, "utf8"); }
    catch { fail(`cannot read --db ${dbPath}`); }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { fail(`--db ${dbPath} is not valid JSON`); }
    const cards = Array.isArray(parsed) ? parsed : parsed.cards;
    if (!Array.isArray(cards)) fail(`--db ${dbPath} must be a JSON array or { "cards": [...] }`);
    return { cards: cards.map(validateCard), writable: true, dbPath };
  }
  // No --db: lazy-import the sibling slice's module; clear error if absent.
  let mod;
  try { mod = await import(pathToFileURL(SIBLING_MODULE).href); }
  catch { fail("no --db given and ./approval-inbox-cards.mjs is absent — pass --db <path> to a JSON card file"); }
  const exported = mod.default;
  const cards = Array.isArray(exported) ? exported : (typeof exported?.listCards === "function" ? await exported.listCards() : null);
  if (!Array.isArray(cards)) fail("./approval-inbox-cards.mjs must default-export a card array or { listCards() }");
  return { cards: cards.map(validateCard), writable: false, dbPath: null };
}

const parseArgs = argv => {
  const command = argv[0];
  const rest = argv.slice(1);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word.startsWith("--")) {
      const name = word.slice(2);
      if (!["kind", "status", "db", "note", "as-human"].includes(name)) fail(`unknown flag ${word}`);
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) fail(`${word} needs a value`);
      flags[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else positionals.push(word);
  }
  return { command, flags, positionals };
};

const listLine = card => [card.id, card.kind, ageOf(card.createdAt), card.status === "decided" ? "[decided] " + card.title : card.title].join(" ");

async function runList(flags) {
  const { cards } = await loadCards(flags.db);
  const kind = flags.kind, status = flags.status ?? "pending";
  const filtered = cards
    .filter(c => (!kind || c.kind === kind) && (status === "all" || c.status === status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const card of filtered) process.stdout.write(listLine(card) + "\n");
  if (filtered.length === 0) process.stdout.write("(no cards)\n");
}

async function runShow(flags, positionals) {
  const [id] = positionals;
  if (!id) fail("show needs <id>");
  const { cards } = await loadCards(flags.db);
  const card = cards.find(c => c.id === id);
  if (!card) fail(`no card ${id}`);
  const lines = [
    `${card.id} [${card.kind}] ${card.status} — opened ${ageOf(card.createdAt)} ago`,
    "",
    `# ${card.title}`,
    "",
    "WHAT",
    `  ${card.what ?? "(no description)"}`,
    "",
    "CONTEXT",
    `  ${card.context ?? "(no context)"}`,
    "",
    "OPTIONS",
  ];
  for (const option of card.options) {
    lines.push(`  - ${option.label}`, `      → ${option.consequence ?? "(no consequence recorded)"}`);
  }
  if (card.decision) {
    lines.push("", `DECIDED: ${card.decision.choice} by ${card.decision.by} at ${card.decision.at}`);
    if (card.decision.note) lines.push(`  note: ${card.decision.note}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function runDecide(flags, positionals) {
  const [id, choice] = positionals;
  if (!id) fail("decide needs <id> <decision>");
  if (!DECISIONS.includes(choice)) fail(`decision must be one of ${DECISIONS.join("|")}`);
  const humanId = flags.asHuman;
  if (!humanId) fail("decide needs --as-human <human-identity-id> — the CLI runs as the operator, never as an agent");
  if (AGENT_ID_PATTERN.test(humanId)) fail(`--as-human "${humanId}" looks like an agent identity — agents cannot clear decisions`);
  if (!flags.db) fail("decide needs --db <path> so the decision can be persisted");
  const { cards, writable, dbPath } = await loadCards(flags.db);
  if (!writable) fail("decide needs a writable --db JSON file");
  const index = cards.findIndex(c => c.id === id);
  if (index === -1) fail(`no card ${id}`);
  const card = cards[index];
  if (card.status === "decided") fail(`card ${id} already decided (${card.decision?.choice ?? "unknown"})`);
  const decision = { choice, by: humanId, at: new Date().toISOString(), note: flags.note ?? null };
  cards[index] = { ...card, status: "decided", decision };
  try { writeFileSync(dbPath, JSON.stringify({ cards }, null, 2) + "\n"); }
  catch { fail(`cannot write --db ${dbPath}`); }
  process.stdout.write(`${id}: ${choice} recorded by ${humanId}${flags.note ? ` — ${flags.note}` : ""}\n`);
}

const main = async () => {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));
  if (command === "list") return runList(flags);
  if (command === "show") return runShow(flags, positionals);
  if (command === "decide") return runDecide(flags, positionals);
  fail(`unknown command ${command ?? "(none)"} — use: list | show <id> | decide <id> <approve|approve-session|deny-stop>`);
};
main().catch(error => fail(error.message));
