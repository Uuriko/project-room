#!/usr/bin/env node
// Dasha bridge (reference implementation). Round-2 task #116.
//
// Lets a Project Room delegate language-model work to Dasha Compute:
// work items titled "[dasha] <prompt>" get their prompt sent to Dasha's
// OpenAI-shaped API, and the model's answer is posted back to the room
// as a message referencing the work item.
//
// This is a reference, not a daemon: `run-once` handles one work item and
// exits. Polling/claiming is left to the operator because work-item claims
// carry real accountability in this protocol.
//
//   DASHA_API_KEY=... ROOM_TOKEN=... node scripts/dasha-bridge.mjs run-once
//   DASHA_API_KEY=... ROOM_TOKEN=... node scripts/dasha-bridge.mjs prompt "Explain Raft in 3 sentences"
//
// Env:
//   DASHA_API_KEY        Developer key from the Dasha Compute Build tab (required)
//   DASHA_BASE_URL       Default https://lobby.getdasha.com/compute/api/v1
//   DASHA_MODEL          Default qwen3-8b (a common community-hosted model)
//   ROOM_ORIGIN          e.g. http://127.0.0.1:8787 (required for run-once)
//   ROOM_ID              Default "commons"
//   ROOM_TOKEN           Room access key (required for run-once)
//   AGENT_MEMBER_ID      Member id the bridge acts as (optional)

import { RoomAgentClient } from "../client/room-agent.mjs";
import { randomUUID } from "node:crypto";

const DASHA_BASE_URL = process.env.DASHA_BASE_URL ?? "https://lobby.getdasha.com/compute/api/v1";
const DASHA_MODEL = process.env.DASHA_MODEL ?? "qwen3-8b";

async function dashaChat(prompt) {
  const apiKey = process.env.DASHA_API_KEY;
  if (!apiKey) throw new Error("Set DASHA_API_KEY (a Dasha Compute developer key)");
  const response = await fetch(`${DASHA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: DASHA_MODEL, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`Dasha request failed: ${response.status}`);
  const value = await response.json();
  const text = value?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Dasha returned no content");
  return text.trim();
}

function roomClient() {
  const origin = process.env.ROOM_ORIGIN, token = process.env.ROOM_TOKEN;
  if (!origin || !token) throw new Error("Set ROOM_ORIGIN and ROOM_TOKEN");
  return new RoomAgentClient({ origin, roomId: process.env.ROOM_ID ?? "commons", token,
    ...(process.env.AGENT_MEMBER_ID ? { memberId: process.env.AGENT_MEMBER_ID } : {}) });
}

// Find the oldest proposed work item titled "[dasha] ...".
async function nextDashaWorkItem(client) {
  const snapshot = await client.snapshot();
  const items = Object.values(snapshot.state?.workItems ?? {});
  const pending = items.filter(w => w.state === "proposed" && typeof w.title === "string"
    && w.title.toLowerCase().startsWith("[dasha]"));
  pending.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return pending[0] ?? null;
}

async function runOnce() {
  const client = roomClient();
  const item = await nextDashaWorkItem(client);
  if (!item) { console.log(JSON.stringify({ ran: false, reason: "no proposed [dasha] work item" })); return; }
  const prompt = item.title.replace(/^\[dasha\]\s*/i, "") + "\n\nDefinition of done: " + (item.definitionOfDone ?? "Answer the prompt.");
  const answer = await dashaChat(prompt);
  await client.command({ id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body: answer, workItemId: item.id } });
  console.log(JSON.stringify({ ran: true, workItemId: item.id, model: DASHA_MODEL, answerChars: answer.length }));
}

const [action, ...rest] = process.argv.slice(2);
if (action === "prompt") {
  const prompt = rest.join(" ");
  if (!prompt) { console.error("Usage: dasha-bridge.mjs prompt \"<text>\""); process.exit(1); }
  console.log(await dashaChat(prompt));
} else if (action === "run-once") {
  await runOnce();
} else {
  console.error("Usage: dasha-bridge.mjs (prompt \"<text>\" | run-once)");
  process.exit(1);
}
