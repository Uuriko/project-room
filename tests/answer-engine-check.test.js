import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPromptConfig, runAnswerCheck, scoreAnswer } from "../scripts/answer-engine-check.mjs";

const script = fileURLToPath(new URL("../scripts/answer-engine-check.mjs", import.meta.url));
const lexicon = {
  room: {
    names: ["Uuriko Project Room", "Project Room"],
    hosts: ["room.trydemigod.com"],
    paths: [
      { host: "www.getdasha.com", prefix: "/room" },
      { host: "github.com", prefix: "/Uuriko/project-room" },
    ],
  },
  competitors: ["Claude Code", "Cursor", "Aider", "Codex", "Continue"],
};

function workdir() {
  return mkdtempSync(join(tmpdir(), "answers-"));
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

test("scores mention, recommendation, position, and competitors from the answer text", () => {
  const cases = [
    {
      name: "named first and linked",
      text: "Use Project Room (https://room.trydemigod.com) so Claude Code and Codex claim files before editing.",
      citations: [],
      expect: {
        mentioned: true,
        recommended: true,
        position: 1,
        cited_urls: ["https://room.trydemigod.com"],
        competitors: ["Claude Code", "Codex"],
      },
    },
    {
      name: "named and rejected",
      text: "Some people mention Project Room, but I would not recommend it. Use Aider instead.",
      citations: [],
      expect: { mentioned: true, recommended: false, position: 1, cited_urls: [], competitors: ["Aider"] },
    },
    {
      name: "other tools only",
      text: "Cursor and Aider can share a repo. See https://cursor.com/docs and https://aider.chat.",
      citations: ["https://cursor.com/docs"],
      expect: {
        mentioned: false,
        recommended: false,
        position: null,
        cited_urls: [],
        competitors: ["Cursor", "Aider"],
        other_cited_urls: ["https://cursor.com/docs", "https://aider.chat"],
      },
    },
    {
      name: "second in the answer",
      text: "Start with Cursor. Project Room is another option: https://www.getdasha.com/room.",
      citations: [],
      expect: {
        mentioned: true,
        recommended: true,
        position: 2,
        cited_urls: ["https://www.getdasha.com/room"],
        competitors: ["Cursor"],
      },
    },
    {
      name: "url only",
      text: "See https://room.trydemigod.com/docs/agents for a coordination server.",
      citations: [],
      expect: {
        mentioned: true,
        recommended: false,
        position: 1,
        cited_urls: ["https://room.trydemigod.com/docs/agents"],
        competitors: [],
      },
    },
    {
      name: "listed as an option",
      text: "1. Project Room\n2. Cursor",
      citations: [],
      expect: { mentioned: true, recommended: true, position: 1, competitors: ["Cursor"] },
    },
  ];
  for (const item of cases) {
    const score = scoreAnswer(item.text, item.citations, lexicon);
    for (const [key, value] of Object.entries(item.expect)) {
      assert.deepEqual(score[key], value, `${item.name} ${key}`);
    }
  }
});

test("the prompt file names eight questions and the four engine secrets", () => {
  const config = loadPromptConfig();
  assert.equal(config.prompts.length, 8);
  assert.deepEqual(config.prompts.map(prompt => prompt.trim()).filter(Boolean).length, 8);
  assert.deepEqual(Object.values(config.engines).map(engine => engine.secret), [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY",
  ]);
  assert.equal(config.engines.chatgpt.temperature, null);
  assert.equal(config.engines.claude.temperature, null);
  assert.equal(config.engines.perplexity.temperature, 0);
  assert.equal(config.engines.grok.temperature, 0);
  assert.equal(config.engines.chatgpt.tool, "web_search");
  assert.equal(config.engines.claude.tool_type, "web_search_20260318");
  assert.equal(config.engines.perplexity.model, "sonar");
  assert.equal(config.engines.grok.tool, "web_search");
});

test("each configured engine sends its own request, and a missing key is skipped", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://api.openai.com/v1/responses") {
      return jsonResponse({
        output_text: "Use Project Room at https://room.trydemigod.com.",
        output: [{ type: "message", content: [{ type: "output_text", text: "Use Project Room at https://room.trydemigod.com.", annotations: [{ type: "url_citation", url: "https://room.trydemigod.com" }] }] }],
      });
    }
    if (url === "https://api.perplexity.ai/v1/sonar") {
      return jsonResponse({
        choices: [{ message: { content: "Cursor is the usual suggestion. https://cursor.com/docs" } }],
        citations: ["https://cursor.com/docs"],
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const dir = workdir();
  const result = await runAnswerCheck({
    env: {
      OPENAI_API_KEY: "openai-test-key",
      PERPLEXITY_API_KEY: "perplexity-test-key",
    },
    fetchImpl,
    sleepImpl: async () => {},
    now: new Date("2026-10-05T15:00:00Z"),
    outDir: dir,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.lines.join("\n"), /skipped: ANTHROPIC_API_KEY not set/);
  assert.match(result.lines.join("\n"), /skipped: XAI_API_KEY not set/);
  const openai = calls.filter(call => call.url === "https://api.openai.com/v1/responses");
  const perplexity = calls.filter(call => call.url === "https://api.perplexity.ai/v1/sonar");
  assert.equal(openai.length, 8);
  assert.equal(perplexity.length, 8);
  assert.equal(calls.some(call => call.url.includes("anthropic.com") || call.url.includes("x.ai")), false);
  const openaiBody = JSON.parse(openai[0].init.body);
  assert.equal(openaiBody.model, "gpt-5.5");
  assert.equal(openaiBody.tools[0].type, "web_search");
  assert.equal("temperature" in openaiBody, false);
  assert.equal(typeof openaiBody.input, "string");
  assert.equal(openai[0].init.headers.authorization, "Bearer openai-test-key");
  const perplexityBody = JSON.parse(perplexity[0].init.body);
  assert.equal(perplexityBody.model, "sonar");
  assert.equal(perplexityBody.temperature, 0);
  assert.equal(perplexityBody.messages.at(-1).role, "user");
  assert.equal(perplexity[0].init.headers.authorization, "Bearer perplexity-test-key");
  const prompts = new Set(openai.map(call => JSON.parse(call.init.body).input));
  assert.equal(prompts.size, 8);
  const chatgpt = result.report.engines.find(engine => engine.id === "chatgpt");
  assert.equal(chatgpt.mentioned, 8);
  assert.equal(chatgpt.mention_rate, 1);
  assert.equal(chatgpt.answers[0].position, 1);
  assert.deepEqual(chatgpt.answers[0].cited_urls, ["https://room.trydemigod.com"]);
  const sonar = result.report.engines.find(engine => engine.id === "perplexity");
  assert.equal(sonar.mentioned, 0);
  assert.equal(sonar.mention_rate, 0);
  assert.deepEqual(sonar.answers[0].competitors, ["Cursor"]);
  assert.deepEqual(sonar.answers[0].other_cited_urls, ["https://cursor.com/docs"]);
  const summary = readFileSync(result.summaryPath, "utf8");
  const raw = readFileSync(result.rawPath, "utf8");
  assert.equal(summary.includes("openai-test-key"), false);
  assert.equal(raw.includes("openai-test-key"), false);
  assert.equal(summary.includes("perplexity-test-key"), false);
});

test("Claude and Grok requests use their web-search tools and omit temperature when the model rejects it", async () => {
  const calls = [];
  const dir = workdir();
  const configPath = join(dir, "prompts.json");
  const config = loadPromptConfig();
  config.prompts = ["How do agents share a repo?"];
  writeFileSync(configPath, JSON.stringify(config));
  const result = await runAnswerCheck({
    env: { ANTHROPIC_API_KEY: "anthropic-test-key", XAI_API_KEY: "xai-test-key" },
    configUrl: configPath,
    outDir: dir,
    now: new Date("2026-10-05T15:00:00Z"),
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("anthropic.com")) {
        return jsonResponse({
          content: [{
            type: "text",
            text: "1. Aider",
            citations: [{ type: "web_search_result_location", url: "https://aider.chat" }],
          }],
        });
      }
      return jsonResponse({
        output: [{ type: "message", content: [{ type: "output_text", text: "Try Cursor.", annotations: [] }] }],
        citations: ["https://cursor.com"],
      });
    },
  });
  assert.equal(result.exitCode, 0);
  const claude = JSON.parse(calls.find(call => call.url.includes("anthropic.com")).init.body);
  const grok = JSON.parse(calls.find(call => call.url.includes("api.x.ai")).init.body);
  assert.equal(claude.model, "claude-sonnet-5");
  assert.equal(claude.tools[0].type, "web_search_20260318");
  assert.equal(claude.tools[0].name, "web_search");
  assert.equal("temperature" in claude, false);
  assert.equal(calls.find(call => call.url.includes("anthropic.com")).init.headers["x-api-key"], "anthropic-test-key");
  assert.equal(grok.model, "grok-4.5");
  assert.equal(grok.temperature, 0);
  assert.equal(grok.tools[0].type, "web_search");
  assert.deepEqual(grok.input, [{ role: "user", content: "How do agents share a repo?" }]);
  const claudeScore = result.report.engines.find(engine => engine.id === "claude").answers[0];
  assert.equal(claudeScore.mentioned, false);
  assert.deepEqual(claudeScore.competitors, ["Aider"]);
  assert.deepEqual(claudeScore.other_cited_urls, ["https://aider.chat"]);
  const grokScore = result.report.engines.find(engine => engine.id === "grok").answers[0];
  assert.equal(grokScore.mentioned, false);
  assert.equal(grokScore.recommended, false);
  assert.deepEqual(grokScore.competitors, ["Cursor"]);
  assert.deepEqual(grokScore.other_cited_urls, ["https://cursor.com"]);
});

test("an unrecognized provider payload is not scored as a miss, and a leaked key is redacted", async () => {
  const dir = workdir();
  const configPath = join(dir, "prompts.json");
  const config = loadPromptConfig();
  config.prompts = ["How do agents share a repo?"];
  config.engines = { chatgpt: config.engines.chatgpt };
  writeFileSync(configPath, JSON.stringify(config));
  const leaked = await runAnswerCheck({
    env: { OPENAI_API_KEY: "openai-test-key" },
    configUrl: configPath,
    outDir: dir,
    now: new Date("2026-10-05T15:00:00Z"),
    sleepImpl: async () => {},
    fetchImpl: async () => jsonResponse({ output_text: "key was openai-test-key", unexpected_note: "openai-test-key" }),
  });
  assert.equal(leaked.exitCode, 0);
  const raw = readFileSync(leaked.rawPath, "utf8");
  const summary = readFileSync(leaked.summaryPath, "utf8");
  assert.equal(raw.includes("openai-test-key"), false);
  assert.equal(summary.includes("openai-test-key"), false);
  assert.match(raw, /\[redacted\]/);
  assert.equal(leaked.lines.join("\n").includes("openai-test-key"), false);

  const broken = await runAnswerCheck({
    env: { OPENAI_API_KEY: "openai-test-key" },
    configUrl: configPath,
    outDir: dir,
    now: new Date("2026-10-05T15:00:00Z"),
    sleepImpl: async () => {},
    fetchImpl: async () => jsonResponse({ unexpected: true }),
  });
  assert.equal(broken.exitCode, 1);
  const answer = broken.report.engines[0].answers[0];
  assert.equal(answer.error, "unrecognized response");
  assert.equal(answer.mentioned, null);
  assert.equal(broken.report.engines[0].mention_rate, null);
});

test("missing answer-engine keys exit 0 with a skip line and no mention rate", () => {
  const dir = workdir();
  const skipped = spawnSync(process.execPath, [script, "--out-dir", dir], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(skipped.status, 0);
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "XAI_API_KEY"]) {
    assert.match(skipped.stdout, new RegExp(`skipped: ${name} not set`));
  }
  const files = spawnSync("ls", [dir], { encoding: "utf8" }).stdout;
  const summaryName = files.split("\n").find(name => name.startsWith("answer-engine-") && !name.includes("raw"));
  assert.ok(summaryName);
  const summary = readFileSync(join(dir, summaryName), "utf8");
  assert.equal(summary.includes('"mention_rate"'), false);
  assert.match(summary, /OPENAI_API_KEY not set/);
});
