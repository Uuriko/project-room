import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postAnalyticsSnapshot, postOpsSummary, redact, resolveIngestPath } from "./snippet-adoption.mjs";

// Weekly check: the same prompts go to ChatGPT, Claude, Perplexity, and Grok,
// one call each. Scores are derived from the response text and the URLs it
// cites. Raw answers are written for the workflow artifact and are not
// committed. A missing key skips that engine and exits 0 when nothing was called.

const sleep = ms => new Promise(done => { setTimeout(done, ms); });
export const DEFAULT_PROMPTS = new URL("../docs/answer-engine-prompts.json", import.meta.url);

const CUE = /\b(recommend(?:ed|s|ation)?|suggest(?:ed|ion|s)?|try|use|using|option|best|consider|choose|pick|worth|ideal)\b/i;
const NEGATION = /\b(not recommend|don't recommend|do not recommend|avoid|wouldn't recommend|would not recommend)\b/i;

export function loadPromptConfig(url = DEFAULT_PROMPTS) {
  const config = JSON.parse(readFileSync(url, "utf8"));
  if (!Array.isArray(config.prompts) || config.prompts.length === 0) throw new Error("answer-engine prompts are missing");
  if (config.prompts.some(prompt => typeof prompt !== "string" || !prompt.trim())) throw new Error("answer-engine prompts must be non-empty strings");
  if (!config.engines || typeof config.engines !== "object") throw new Error("answer-engine engines are missing");
  return config;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lexiconOf(config) {
  const room = config.room ?? {};
  const needles = [
    ...(room.names ?? []).map(name => ({ kind: "room", label: "Project Room", needle: name })),
    ...(room.hosts ?? []).map(host => ({ kind: "room", label: "Project Room", needle: host })),
    ...(room.paths ?? []).map(rule => ({ kind: "room", label: "Project Room", needle: `${rule.host}${rule.prefix}` })),
    ...(config.competitors ?? []).map(name => ({ kind: "competitor", label: name, needle: name })),
  ];
  return { names: room.names ?? [], hosts: room.hosts ?? [], paths: room.paths ?? [], competitors: config.competitors ?? [], needles };
}

function orderedTools(text, lexicon) {
  const matches = [];
  const needles = [...lexicon.needles].sort((a, b) => b.needle.length - a.needle.length);
  for (const needle of needles) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(needle.needle)}(?![A-Za-z0-9])`, "gi");
    for (const match of text.matchAll(pattern)) {
      matches.push({ start: match.index, end: match.index + match[0].length, kind: needle.kind, name: needle.label });
    }
  }
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const taken = [];
  const ordered = [];
  for (const match of matches) {
    if (taken.some(span => match.start < span.end && span.start < match.end)) continue;
    taken.push(match);
    const id = match.kind === "room" ? "room" : match.name.toLowerCase();
    if (ordered.some(item => item.id === id)) continue;
    ordered.push({ id, kind: match.kind, name: match.name });
  }
  return ordered;
}

export function extractUrls(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

export function isOurUrl(value, lexicon) {
  let parsed;
  try { parsed = new URL(value); }
  catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if ((lexicon.hosts ?? []).some(item => host === item.toLowerCase() || host === `www.${item.toLowerCase()}`)) return true;
  return (lexicon.paths ?? []).some(rule => host === String(rule.host ?? "").toLowerCase() && parsed.pathname.startsWith(rule.prefix ?? ""));
}

function mentionsRoom(segment, lexicon) {
  if ((lexicon.names ?? []).some(name => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, "i").test(segment))) return true;
  return extractUrls(segment).some(url => isOurUrl(url, lexicon))
    || (lexicon.hosts ?? []).some(host => segment.toLowerCase().includes(host.toLowerCase()));
}

function segmentsOf(text) {
  const segments = [];
  for (const line of String(text ?? "").split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^([-*]|\d+[.)])\s/.test(trimmed)) segments.push(trimmed);
    else segments.push(...trimmed.split(/(?<=[.!?])\s+/).filter(Boolean));
  }
  return segments;
}

export function scoreAnswer(text, citations, config) {
  const lexicon = config.needles ? config : lexiconOf(config);
  const answer = String(text ?? "");
  const cites = (citations ?? []).filter(item => typeof item === "string");
  const combined = `${answer}\n${cites.join("\n")}`;
  const tools = orderedTools(combined, lexicon);
  const citedOurs = [];
  const citedOther = [];
  for (const url of extractUrls(combined)) {
    const bucket = isOurUrl(url, lexicon) ? citedOurs : citedOther;
    if (!bucket.includes(url)) bucket.push(url);
  }
  const mentioned = tools.some(tool => tool.kind === "room") || citedOurs.length > 0;
  const roomIndex = tools.findIndex(tool => tool.kind === "room");
  const position = mentioned ? (roomIndex >= 0 ? roomIndex + 1 : tools.length + 1) : null;
  const recommended = mentioned && segmentsOf(answer).some(segment => mentionsRoom(segment, lexicon) && !NEGATION.test(segment) && (CUE.test(segment) || /^([-*]|\d+[.)])\s/.test(segment)));
  return {
    mentioned,
    recommended,
    position,
    cited_urls: citedOurs,
    competitors: tools.filter(tool => tool.kind === "competitor").map(tool => tool.name),
    other_cited_urls: citedOther,
  };
}

function textFromBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(block => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n");
}

export function parseAnswer(engineId, payload) {
  const fail = { ok: false, error: "unrecognized response", text: "", citations: [] };
  if (!payload || typeof payload !== "object") return fail;
  if (engineId === "claude") {
    if (!Array.isArray(payload.content) && typeof payload.content !== "string") return fail;
    const citations = [];
    if (Array.isArray(payload.content)) {
      for (const block of payload.content) {
        for (const cite of block?.citations ?? []) if (typeof cite?.url === "string") citations.push(cite.url);
      }
    }
    return { ok: true, text: textFromBlocks(payload.content), citations };
  }
  if (engineId === "perplexity") {
    const choice = payload.choices?.[0]?.message?.content;
    const message = Array.isArray(payload.output) ? payload.output.find(item => item?.type === "message") : null;
    const agentText = textFromBlocks(message?.content);
    const text = typeof choice === "string" ? choice : agentText;
    if (typeof choice !== "string" && !message) return fail;
    const citations = [];
    if (Array.isArray(payload.citations)) citations.push(...payload.citations.filter(item => typeof item === "string"));
    for (const result of payload.search_results ?? []) if (typeof result?.url === "string") citations.push(result.url);
    for (const item of payload.output ?? []) {
      if (item?.type !== "search_results") continue;
      for (const result of item.results ?? []) if (typeof result?.url === "string") citations.push(result.url);
    }
    return { ok: true, text: text || "", citations };
  }
  if (typeof payload.output_text !== "string" && !Array.isArray(payload.output)) return fail;
  const parts = [];
  const citations = [];
  if (typeof payload.output_text === "string") parts.push(payload.output_text);
  for (const item of payload.output ?? []) {
    if (item?.type === "message") parts.push(textFromBlocks(item.content));
    for (const block of item?.content ?? []) {
      for (const note of block?.annotations ?? []) if (typeof note?.url === "string") citations.push(note.url);
    }
  }
  for (const cite of payload.citations ?? []) {
    if (typeof cite === "string") citations.push(cite);
    else if (typeof cite?.url === "string") citations.push(cite.url);
  }
  return { ok: true, text: parts.filter(Boolean).join("\n"), citations };
}

export function buildRequest(engineId, engine, prompt, instruction) {
  const temperature = Number.isFinite(engine.temperature) ? engine.temperature : undefined;
  if (engineId === "claude") {
    const tool = { type: engine.tool_type, name: engine.tool_name || "web_search" };
    if (Array.isArray(engine.allowed_callers)) tool.allowed_callers = engine.allowed_callers;
    const body = {
      model: engine.model,
      max_tokens: engine.max_tokens ?? 4096,
      system: instruction,
      messages: [{ role: "user", content: prompt }],
      tools: [tool],
    };
    if (temperature !== undefined) body.temperature = temperature;
    return { url: engine.endpoint, body };
  }
  if (engineId === "perplexity") {
    const body = {
      model: engine.model,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: prompt },
      ],
    };
    if (temperature !== undefined) body.temperature = temperature;
    return { url: engine.endpoint, body };
  }
  const body = {
    model: engine.model,
    instructions: instruction,
    input: engineId === "grok" ? [{ role: "user", content: prompt }] : prompt,
    tools: [{ type: engine.tool || "web_search" }],
  };
  if (temperature !== undefined) body.temperature = temperature;
  return { url: engine.endpoint, body };
}

function headersFor(engineId, engine, credential) {
  if (engineId === "claude") {
    return {
      "x-api-key": credential,
      "anthropic-version": engine.anthropic_version || "2023-06-01",
      "content-type": "application/json",
    };
  }
  return { authorization: `Bearer ${credential}`, "content-type": "application/json" };
}

const blankScore = () => ({ mentioned: null, recommended: null, position: null, cited_urls: [], competitors: [], other_cited_urls: [] });

async function callEngine(engineId, engine, prompt, instruction, credential, { fetchImpl, sleepImpl }) {
  const request = buildRequest(engineId, engine, prompt, instruction);
  const init = { method: "POST", headers: headersFor(engineId, engine, credential), body: JSON.stringify(request.body), signal: AbortSignal.timeout(120_000) };
  let response = await fetchImpl(request.url, init);
  if (response.status === 429 || response.status === 503) {
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    await sleepImpl((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 20) * 1000);
    response = await fetchImpl(request.url, init);
  }
  const text = await response.text();
  return { status: response.status, text, request };
}

export function engineRollup(id, engine, answers) {
  if (answers == null) {
    return { id, model: engine.model, skipped: `${engine.secret} not set` };
  }
  const scored = answers.filter(answer => answer.error == null);
  const mentioned = scored.filter(answer => answer.mentioned === true).length;
  const recommended = scored.filter(answer => answer.recommended === true).length;
  return {
    id,
    model: engine.model,
    skipped: null,
    prompts: answers.length,
    scored: scored.length,
    failed: answers.length - scored.length,
    mentioned,
    recommended,
    mention_rate: scored.length === 0 ? null : mentioned / scored.length,
    answers,
  };
}

export function answerSummaryMarkdown(report) {
  const lines = [`## Answer engines ${report.date}`, "", "| Engine | Result | Mentioned | Recommended | Mention rate |", "| --- | --- | --- | --- | --- |"];
  for (const engine of report.engines) {
    if (engine.skipped) {
      lines.push(`| ${engine.id} | skipped: ${engine.skipped.replace(" not set", "")} not set | | | |`);
      continue;
    }
    const rate = engine.mention_rate == null ? "" : `${engine.mentioned}/${engine.scored}`;
    lines.push(`| ${engine.id} | ${engine.model} | ${engine.mentioned} | ${engine.recommended} | ${rate} |`);
  }
  const misses = [];
  for (const engine of report.engines) {
    for (const answer of engine.answers ?? []) {
      if (answer.mentioned !== false) continue;
      const competitors = answer.competitors.length ? answer.competitors.join(", ") : "(none named)";
      const urls = answer.other_cited_urls.length ? answer.other_cited_urls.join(", ") : "(none)";
      misses.push(`- ${engine.id}: ${answer.prompt} — competitors: ${competitors} — cited: ${urls}`);
    }
  }
  lines.push("", "### Prompts that did not name Room", "");
  lines.push(misses.length ? misses.join("\n") : "No completed answer missed Room, or no engine ran.");
  lines.push("");
  return lines.join("\n");
}

export function answerOpsText(report) {
  const parts = report.engines.map(engine => {
    if (engine.skipped) return `${engine.id} skipped: ${engine.skipped}`;
    const rate = engine.mention_rate == null ? "no scored answers" : `${engine.mentioned}/${engine.scored} mentioned`;
    return `${engine.id} ${rate}, ${engine.recommended} recommended`;
  });
  return `Answer engines ${report.date}: ${parts.join("; ")}.`;
}

function snapshotEvent(report) {
  return {
    type: "answer_engine.snapshot",
    date: report.date,
    engines: report.engines.filter(engine => !engine.skipped).map(engine => ({
      id: engine.id,
      prompts: engine.scored,
      mentioned: engine.mentioned,
      recommended: engine.recommended,
      mention_rate: engine.mention_rate,
    })),
  };
}

export async function runAnswerCheck({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = new Date(),
  outDir = ".",
  configUrl = DEFAULT_PROMPTS,
  ingestPath,
} = {}) {
  const config = loadPromptConfig(configUrl);
  const secrets = Object.values(config.engines).map(engine => String(env[engine.secret] ?? "").trim()).filter(Boolean);
  secrets.push(String(env.ROOM_OPS_POST_TOKEN ?? "").trim(), String(env.ANALYTICS_INGEST_TOKEN ?? "").trim());
  const lines = [];
  const say = line => { lines.push(redact(line, secrets)); };
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const engines = [];
  const raw = [];
  let failed = false;
  for (const [id, engine] of Object.entries(config.engines)) {
    const credential = String(env[engine.secret] ?? "").trim();
    if (!credential) {
      say(`skipped: ${engine.secret} not set`);
      engines.push(engineRollup(id, engine, null));
      continue;
    }
    const answers = [];
    for (const prompt of config.prompts) {
      try {
        const result = await callEngine(id, engine, prompt, config.instruction, credential, { fetchImpl, sleepImpl });
        const redactedBody = redact(result.text, secrets);
        let payload = null;
        try { payload = JSON.parse(redactedBody); }
        catch { payload = redactedBody; }
        raw.push({ engine: id, model: engine.model, prompt, status: result.status, body: payload });
        if (result.status < 200 || result.status >= 300) {
          failed = true;
          answers.push({ prompt, error: `HTTP ${result.status}`, ...blankScore() });
          continue;
        }
        const parsed = parseAnswer(id, payload);
        if (!parsed.ok) {
          failed = true;
          answers.push({ prompt, error: parsed.error, ...blankScore() });
          continue;
        }
        answers.push({ prompt, ...scoreAnswer(parsed.text, parsed.citations, config) });
      } catch (error) {
        failed = true;
        raw.push({ engine: id, model: engine.model, prompt, status: 0, body: redact(error?.message ?? error, secrets) });
        answers.push({ prompt, error: "request failed", ...blankScore() });
      }
    }
    engines.push(engineRollup(id, engine, answers));
  }
  const report = { date, engines };
  const summaryPath = resolve(outDir, `answer-engine-${date}.json`);
  const rawPath = resolve(outDir, `answer-engine-raw-${date}.json`);
  writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(rawPath, `${JSON.stringify({ date, runs: raw }, null, 2)}\n`);
  const markdown = answerSummaryMarkdown(report);
  say(answerOpsText(report));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  const origin = String(env.ROOM_OPS_ORIGIN ?? "https://room.trydemigod.com").trim();
  const ops = await postOpsSummary({
    origin,
    roomId: String(env.ROOM_OPS_ROOM_ID ?? "").trim(),
    credential: String(env.ROOM_OPS_POST_TOKEN ?? "").trim(),
    text: answerOpsText(report),
    fetchImpl,
  });
  if (ops.posted) say(`ops post: ${ops.status}`);
  else if (ops.status) say(`ops post failed: ${ops.status}`);
  const ran = engines.some(engine => !engine.skipped);
  const route = !ran ? null : (ingestPath === undefined ? await resolveIngestPath() : ingestPath);
  const analytics = await postAnalyticsSnapshot({
    origin: String(env.ROOM_ORIGIN ?? origin).trim(),
    ingestPath: route,
    credential: String(env.ANALYTICS_INGEST_TOKEN ?? "").trim(),
    event: snapshotEvent(report),
    fetchImpl,
  });
  if (!analytics.sent) say(`answer_engine.snapshot not sent: ${ran ? (analytics.reason ?? analytics.status) : "no engine ran"}`);
  return { exitCode: failed ? 1 : 0, lines, report, summaryPath, rawPath };
}

function parseArgs(argv) {
  const opts = { outDir: "." };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir") opts.outDir = argv[++i] ?? ".";
    else if (argv[i] === "--date") {
      const day = argv[++i] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--date must be YYYY-MM-DD");
      opts.now = new Date(`${day}T00:00:00Z`);
    }
  }
  return opts;
}

async function main() {
  const result = await runAnswerCheck(parseArgs(process.argv.slice(2)));
  for (const line of result.lines) console.log(line);
  process.exit(result.exitCode);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch(error => {
  const secrets = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY"].map(name => process.env[name]);
  console.error(redact(error?.message ?? error, secrets));
  process.exit(1);
});
