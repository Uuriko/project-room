// Connect-your-AI door contract (browser journey 2026-10-06):
// a non-technical human must be able to connect their agent without
// reading agent docs and without already holding an invitation.
//
// The contracts, in priority order:
//
// 1. Visible human nav never points at raw agent docs. The logged-out
//    auth-hero's agent-connect link goes to the human walkthrough
//    (#join-agent), not /llms.txt. (Issue #1597 fixed this for the
//    static hero's "Join guide"; the auth-hero's "Connect your agent"
//    regressed the same bug class on 2026-10-06.)
// 2. The paste flow is a visible first-class section — <section
//    id="join-agent"> on the logged-out door — not nested inside a
//    <details> disclosure and not inside the hidden agent sign-in step.
// 3. The walkthrough says how to GET an invitation: the no-invitation
//    path names sign-in + "Request access to a room". The 2026-10-06
//    journey dead-ended on "join using the original shared invitation
//    I gave you" — the UI assumed an invitation the stranger never had.
// 4. The human door (/about) never links raw /llms.txt either.
//
// These read index.html and about.html directly because the server
// serves those files verbatim — the bytes ARE the contract (same
// retention bar as tests/static-hero-nojs.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexHtml = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const aboutHtml = readFileSync(fileURLToPath(new URL("../about.html", import.meta.url)), "utf8");
const appJs = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");

const AGENT_ONLY_DOCS = [
  "/llms.txt", "/llms-full.txt", "/join.txt", "/kits.txt",
  "/agents.json", "/.well-known/agent.json", "/SKILL.md", "/skill.md",
  "/agents.md", "/AGENTS.md",
];

function authHeroNav() {
  const m = indexHtml.match(/<nav class="auth-hero-links"[\s\S]*?<\/nav>/);
  assert.ok(m, "auth-hero nav exists");
  return m[0];
}

function joinAgentSection() {
  const m = indexHtml.match(/<section id="join-agent"[\s\S]*?<\/section>/);
  assert.ok(m, "#join-agent is a plain section, not a disclosure");
  return m[0];
}

test("auth-hero: the human agent-connect link targets the walkthrough, not raw /llms.txt", () => {
  const nav = authHeroNav();
  for (const [, href, label] of nav.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)) {
    if (/connect/i.test(label)) {
      assert.ok(
        !AGENT_ONLY_DOCS.includes(href),
        `human-labeled "${label}" must not target agent doc ${href}`
      );
    }
  }
  assert.match(nav, /<a href="#join-agent">Connect your AI<\/a>/, "nav carries the visible walkthrough link");
});

test("the paste flow is a visible first-class section, not a buried disclosure", () => {
  assert.ok(!/<details[^>]*id="join-agent"/.test(indexHtml), "#join-agent is not a disclosure");
  const body = joinAgentSection();
  assert.match(body, /<h2[^>]*>Connect your AI<\/h2>/, "walkthrough heading");
  assert.match(body, /id="join-agent-prompt"/, "prompt field present");
  assert.match(body, /id="join-agent-copy"/, "copy button present");
});

test("the paste flow does not hide inside the agent sign-in step", () => {
  const step = indexHtml.match(/<section id="agent-auth-step"[\s\S]*?<\/section>/);
  assert.ok(step, "agent sign-in step still exists for credential auth");
  assert.ok(!step[0].includes('id="join-agent-prompt"'), "paste flow is not inside the hidden agent sign-in step");
});

test("the walkthrough says how to get an invitation", () => {
  const body = joinAgentSection();
  assert.match(body, /[Nn]o invit/, "names the no-invitation case");
  assert.match(body, /Request access to a room/, "names the request-access path");
  assert.match(body, /invite link/, "tells the human to paste the invite link with the prompt");
});

test("about.html: the human door never links raw agent docs", () => {
  // 2026-10-06: "Bring your team" linked "agent setup instructions" at
  // /llms.txt on the human /about door.
  for (const doc of AGENT_ONLY_DOCS) {
    assert.ok(!aboutHtml.includes(`href="${doc}"`), `about.html has no raw ${doc} link`);
  }
  assert.match(aboutHtml, /href="\/#join-agent"/, "about.html points humans at the door walkthrough");
});

test("the setup prompt keeps the llms.txt paste-prompt contract", () => {
  // The bytes the human pastes into their AI are the llms.txt
  // "paste-prompt" contract ("one prompt on the HTML door (#join-agent)").
  // The walkthrough may reword its own copy, but the prompt bytes stay
  // stable so agents keep parsing them.
  assert.match(appJs, /join using the original shared invitation I gave you/, "prompt still names the shared invitation for the AI");
});
