import test from "node:test";
import assert from "node:assert/strict";
import { markdownHtml, mentionHtml } from "../src/conversation.js";

// Same escaper the web client passes into mentionHtml (src/app.js).
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const md = raw => markdownHtml(esc(raw));
const members = [{ id: "maya", displayName: "Maya", kind: "human" }];

test("bold: **text** renders strong", () => {
  assert.match(md("say **hello** now"), /<strong>hello<\/strong>/);
});

test("italic: *text* renders em", () => {
  assert.match(md("say *hello* now"), /<em>hello<\/em>/);
});

test("inline code: `x` renders code", () => {
  assert.match(md("run `npm test` now"), /<code>npm test<\/code>/);
});

test("inline code does not parse inner markdown", () => {
  assert.match(md("run `**not bold**` now"), /<code>\*\*not bold\*\*<\/code>/);
});

test("fenced code block renders as a block", () => {
  const out = md("before\n```js\nconst a = 1;\n```\nafter");
  assert.match(out, /<code class="md-fence"/);
  assert.match(out, /const a = 1;/);
  assert.ok(!out.includes("```"), "fence markers removed");
});

test("fenced code does not parse inner markdown", () => {
  const out = md("```\n**nope**\n```");
  assert.match(out, /\*\*nope\*\*/);
});

test("quote lines render as quotes", () => {
  assert.match(md("> hello world"), /class="md-quote"/);
});

test("spoiler renders a native click-to-reveal block", () => {
  const out = md("the ||secret|| is out");
  assert.match(out, /<details class="md-spoiler">/);
  assert.match(out, /secret<\/details>/);
});

test("strikethrough renders del", () => {
  assert.match(md("that is ~~gone~~ now"), /<del>gone<\/del>/);
});

test("HTML injection stays escaped", () => {
  const out = md('**<script>alert(1)</script>**');
  assert.ok(!out.includes("<script>"), "no raw script tag");
  assert.match(out, /<strong>&lt;script&gt;/);
});

test("underscores inside words are not italic", () => {
  assert.equal(md("some_variable_name"), esc("some_variable_name"));
});

test("unmatched markers are left alone", () => {
  assert.equal(md("a **oops and `dangling"), esc("a **oops and `dangling"));
});

test("mentionHtml keeps mention chips and renders markdown around them", () => {
  const out = mentionHtml("**hey** @Maya run `x`", members, esc);
  assert.match(out, /<strong>hey<\/strong>/);
  assert.match(out, /data-mention-id="maya"/);
  assert.match(out, /<code>x<\/code>/);
});

test("bare URLs become safe links", () => {
  const out = md("see https://example.com/a?b=1 for details");
  assert.match(out, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">/);
});

test("autolink trims trailing punctuation", () => {
  const out = md("see https://example.com.");
  assert.match(out, /<\/a>\./);
});

test("autolink does not fire inside code spans", () => {
  const out = md("run `curl https://example.com` now");
  assert.ok(!out.includes("<a href"), "no link inside code");
});

test("plain text without markdown is unchanged", () => {
  assert.equal(md("just a normal message"), esc("just a normal message"));
});

test("unordered lines render as a list", () => {
  const out = md("line1\nline2\n\n- item\n- item2");
  assert.match(out, /<ul class="md-list"><li>item<\/li><li>item2<\/li><\/ul>/);
  assert.match(out, /line1\nline2/);
  assert.ok(!out.includes("- item"), "markers are not left as literal text");
});

test("star markers and ordered lines render as lists", () => {
  assert.match(md("* one\n* two"), /<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(md("1. one\n2. two"), /<ol class="md-list"><li>one<\/li><li>two<\/li><\/ol>/);
});

test("bold inside a list item still renders", () => {
  assert.match(md("- say **hello**"), /<ul class="md-list"><li>say <strong>hello<\/strong><\/li><\/ul>/);
});

test("a list marker inside a fence stays literal", () => {
  const out = md("```\n- item\n- item2\n```");
  assert.ok(!out.includes("<ul"), "fence is not a list");
  assert.match(out, /- item/);
});

test("italic and plain dashes are not lists", () => {
  assert.match(md("*hello*"), /<em>hello<\/em>/);
  assert.ok(!md("*hello*").includes("<ul"));
  assert.equal(md("score - item"), esc("score - item"));
});

test("list items stay escaped", () => {
  const out = md("- <script>alert(1)</script>");
  assert.ok(!out.includes("<script>"), "no raw script tag in a list");
  assert.match(out, /<li>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>/);
});
