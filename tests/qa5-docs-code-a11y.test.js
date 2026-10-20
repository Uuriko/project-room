// QA5-gb-A11Y-1: agent docs code blocks must be keyboard-scrollable (WCAG 2.1.1, axe
// scrollable-region-focusable), and every HowTo step in the page's JSON-LD must carry text.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPages, codeBlock, renderMarkdown } from "../scripts/build-agent-docs.mjs";

test("every <pre> on every agent docs page is a focusable, named region", () => {
  const pages = agentPages();
  assert.ok(pages.size >= 10);
  for (const [file, html] of pages) {
    const pres = html.match(/<pre\b[^>]*>/g) || [];
    for (const pre of pres) {
      assert.match(pre, /tabindex="0"/, file + " " + pre);
      assert.match(pre, /role="region"/, file + " " + pre);
      assert.match(pre, /aria-label="[^"]+"/, file + " " + pre);
    }
    if (file === "docs/agents/paste.html") assert.equal(pres.length, 1, "paste onboarding has one reusable block");
    else if (file !== "docs/agents/index.html") assert.ok(pres.length >= 2, file + " has command and config blocks");
    assert.match(html, /pre:focus-visible\{outline:/, file + " shows a focus ring on code blocks");
  }
});

test("HowTo steps never have empty text (code-only sections use their code)", () => {
  for (const [file, html] of agentPages()) {
    const json = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
    for (const step of json.step) assert.ok(step.text && step.text.trim(), `${file} step "${step.name}" has text`);
  }
  // Exercise a code-only section explicitly: live guides may add useful prose.
  const dir = mkdtempSync(join(tmpdir(), "room-howto-"));
  try {
    cpSync(new URL("../docs/agents/", import.meta.url), dir, { recursive: true });
    const file = join(dir, "claude-code.md");
    const markdown = readFileSync(file, "utf8");
    writeFileSync(file, markdown.replace(/## Command\n[\s\S]*?(?=\n## )/,
      "## Command\n\n```sh\nroom setup claude-code\n```\n"));
    const claude = agentPages(dir).get("docs/agents/claude-code.html");
    const steps = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(claude)[1]).step;
    assert.equal(steps.find(step => step.name === "Command").text, "room setup claude-code");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("code block labels are plain text and attribute-safe", () => {
  assert.equal(codeBlock("a<b", 'Say "hi" `now`'), '<pre tabindex="0" role="region" aria-label="Say &quot;hi&quot; now"><code>a&lt;b</code></pre>');
  assert.match(renderMarkdown("```\nx\n```"), /aria-label="code example 1"/);
  assert.match(renderMarkdown("## Run it\n```\nx\n```", { labelPrefix: "Codex" }), /aria-label="Codex: Run it"/);
});
