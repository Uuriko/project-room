import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml as serverEscape } from "../server/html-escape.mjs";
import { escapeHtml as clientEscape } from "../src/html-escape.js";

test("escapeHtml escapes the HTML metacharacters, including apostrophe and backtick", () => {
  assert.equal(serverEscape, clientEscape);
  assert.equal(serverEscape(`<script>alert("x&y")</script>`), "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;");
  assert.equal(serverEscape("it's"), "it&#39;s");
  assert.equal(serverEscape("a>b"), "a&gt;b");
  assert.equal(serverEscape("back`tick"), "back&#96;tick");
  assert.equal(serverEscape(`"'&<>\``), "&quot;&#39;&amp;&lt;&gt;&#96;");
});

test("escapeHtml renders nullish input as empty and stringifies other values", () => {
  assert.equal(serverEscape(null), "");
  assert.equal(serverEscape(undefined), "");
  assert.equal(serverEscape(42), "42");
  assert.equal(serverEscape("plain"), "plain");
});
