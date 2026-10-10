// Service worker behavior under a stubbed worker global. The script under
// test is the classic push-sw.js a browser would install.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { notificationFromPush } from "../src/human-push-display.js";

const source = readFileSync(new URL("../push-sw.js", import.meta.url), "utf8");
const SECRET = "the seahorse password is coral-99";
const ALLOW = [
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon-180.png"
];

function load({ actions = false, failFetch = false, clients = [] } = {}) {
  const notifications = [];
  const badges = [];
  const cleared = [];
  const opened = [];
  const puts = [];
  const added = [];
  const listeners = {};
  const cacheLists = new Map();
  const caches = {
    async open(name) {
      return {
        addAll: async (urls) => { added.push(...urls); cacheLists.set(name, [...urls]); },
        match: async (url) => (cacheLists.get(name) || []).includes(url) ? { url, offline: true } : undefined,
        put: async (request) => { puts.push(String(request?.url || request)); }
      };
    },
    keys: async () => [...cacheLists.keys()],
    delete: async (name) => { cacheLists.delete(name); }
  };
  function Notification() {}
  if (actions) Notification.prototype.actions = [];
  const navigator = {
    setAppBadge: async (count) => { badges.push(count); },
    clearAppBadge: async () => { cleared.push(true); }
  };
  const self = {
    addEventListener(type, fn) { listeners[type] = fn; },
    registration: {
      scope: "https://room.example/",
      showNotification: async (title, options) => { notifications.push({ title, options }); }
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => { opened.push(url); return { url }; },
      claim: async () => {}
    },
    skipWaiting: async () => {},
    caches
  };
  const fetch = async (request) => {
    if (failFetch) throw new Error("offline");
    return { ok: true, url: request.url, network: true };
  };
  vm.runInContext(source, vm.createContext({
    self, caches, navigator, Notification, fetch, URL, Response, Promise
  }), { filename: "push-sw.js" });
  return { listeners, notifications, badges, cleared, opened, puts, added, clients };
}

async function fire(listeners, type, event) {
  const waits = [];
  let response;
  listeners[type]({
    ...event,
    waitUntil(promise) { waits.push(promise); },
    respondWith(promise) { response = promise; waits.push(promise); }
  });
  await Promise.all(waits);
  return response ? response : null;
}

test("install caches only the offline page and icons", async () => {
  const worker = load();
  await fire(worker.listeners, "install", {});
  assert.deepEqual(worker.added, ALLOW);
  assert.deepEqual(worker.puts, []);
});

test("fetch never caches app code, and a failed navigation uses the offline page", async () => {
  const online = load();
  await fire(online.listeners, "install", {});
  const app = await fire(online.listeners, "fetch", { request: { url: "https://room.example/src/app.js", mode: "cors" } });
  assert.equal(app.network, true);
  assert.deepEqual(online.puts, []);
  const api = await fire(online.listeners, "fetch", { request: { url: "https://room.example/api/rooms", mode: "cors" } });
  assert.equal(api.network, true);
  assert.deepEqual(online.puts, []);

  const offline = load({ failFetch: true });
  await fire(offline.listeners, "install", {});
  const page = await fire(offline.listeners, "fetch", { request: { url: "https://room.example/", mode: "navigate" } });
  assert.equal(page.offline, true);
  assert.equal(page.url, "/offline.html");
  assert.deepEqual(offline.puts, []);
});

test("a push shows a count, actions only when the platform has them, and a badge", async () => {
  const payload = {
    roomId: "commons", counts: { mention: 1 }, body: SECRET, title: "Codex needs your approval",
    actions: [{ action: "approve", title: "Ignore me" }, { action: "reject" }],
    needsMeCount: 3
  };
  const expected = notificationFromPush(payload);
  const withActions = load({ actions: true });
  await fire(withActions.listeners, "push", { data: { json: () => payload } });
  assert.equal(withActions.notifications[0].title, expected.title);
  assert.equal(withActions.notifications[0].options.body, expected.body);
  assert.equal(withActions.notifications[0].options.tag, "room:commons");
  assert.equal(withActions.notifications[0].options.renotify, false);
  assert.equal(JSON.stringify(withActions.notifications[0].options.actions), JSON.stringify([
    { action: "approve", title: "Approve" },
    { action: "reject", title: "Reject" }
  ]));
  assert.deepEqual(withActions.badges, [3]);
  assert.equal(JSON.stringify(withActions.notifications[0]).includes(SECRET), false);

  const plain = load({ actions: false });
  await fire(plain.listeners, "push", { data: { json: () => ({ ...payload, needsMeCount: 0 }) } });
  assert.equal(plain.notifications[0].options.actions, undefined);
  assert.deepEqual(plain.cleared, [true]);
  assert.deepEqual(plain.badges, []);
});

test("a click focuses an existing Room window, and opens one when none is open", async () => {
  const client = {
    url: "https://room.example/?room=commons",
    focused: false,
    navigated: null,
    async focus() { this.focused = true; },
    async navigate(url) { this.navigated = url; }
  };
  const worker = load({ clients: [client] });
  await fire(worker.listeners, "notificationclick", {
    action: "approve",
    notification: { data: { roomId: "commons", url: "/?room=commons&item=deploy" }, close() {} }
  });
  assert.equal(client.focused, true);
  assert.equal(client.navigated, "/?room=commons&item=deploy");
  assert.deepEqual(worker.opened, []);

  const empty = load();
  await fire(empty.listeners, "notificationclick", {
    notification: { data: { url: "/m/needs-you" }, close() {} }
  });
  assert.deepEqual(empty.opened, ["/m/needs-you"]);
});

// Every push payload stamps the newest event sequence the counts were
// evaluated through (server/push-subscriptions.mjs). A push that arrives
// after a newer one for the same room is stale — showing it would re-badge
// a room the member has already overtaken. Payloads without an integer
// sequence are never dropped; rooms are tracked independently.
test("a stale push (older sequence than one already shown) is dropped", async () => {
  const worker = load();
  const base = { roomId: "commons", counts: { mention: 1 } };
  await fire(worker.listeners, "push", { data: { json: () => ({ ...base, sequence: 10 }) } });
  await fire(worker.listeners, "push", { data: { json: () => ({ ...base, sequence: 5 }) } });
  await fire(worker.listeners, "push", { data: { json: () => ({ ...base, sequence: 10 }) } });
  await fire(worker.listeners, "push", { data: { json: () => ({ ...base, sequence: 12 }) } });
  await fire(worker.listeners, "push", { data: { json: () => ({ ...base }) } });
  await fire(worker.listeners, "push", { data: { json: () => ({ ...base, roomId: "other", sequence: 1 }) } });
  assert.equal(worker.notifications.length, 4);
});
