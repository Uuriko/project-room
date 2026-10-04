// QA5-gb-A11Y-1: agent docs code blocks must be keyboard-scrollable (WCAG 2.1.1, axe
// scrollable-region-focusable), and every HowTo step in the page's JSON-LD must carry text.
import test from "node:test";
import assert from "node:assert/strict";
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
    if (file !== "docs/agents/index.html") assert.ok(pres.length >= 2, file + " has command and config blocks");
    assert.match(html, /pre:focus-visible\{outline:/, file + " shows a focus ring on code blocks");
  }
});

test("HowTo steps never have empty text (code-only sections use their code)", () => {
  for (const [file, html] of agentPages()) {
    const json = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
    for (const step of json.step) assert.ok(step.text && step.text.trim(), `${file} step "${step.name}" has text`);
  }
  const claude = agentPages().get("docs/agents/claude-code.html");
  const steps = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(claude)[1]).step;
  assert.match(steps.find(step => step.name === "Command").text, /^room setup /);
});

test("code block labels are plain text and attribute-safe", () => {
  assert.equal(codeBlock("a<b", 'Say "hi" `now`'), '<pre tabindex="0" role="region" aria-label="Say &quot;hi&quot; now"><code>a&lt;b</code></pre>');
  assert.match(renderMarkdown("```\nx\n```"), /aria-label="code example 1"/);
  assert.match(renderMarkdown("## Run it\n```\nx\n```", { labelPrefix: "Codex" }), /aria-label="Codex: Run it"/);
});
