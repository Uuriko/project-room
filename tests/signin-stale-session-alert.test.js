// Sign-in outcomes may dismiss only their own unchanged panel notice.
// Exercise real AccountClient restoration/generation; all transport is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";
import { AccountClient } from "../src/client.js";

const STALE_NOTICE = "Session ended; private drafts were cleared.";
const NEW_NOTICE = "The browser account changed; private Room state and drafts were cleared.";
const INVALID = "Invalid email or password";
const response = (body, status = 200) => ({ ok: status < 400, status, async json() { return body; } });
const rejectedLogin = () => response({ error: { code: "invalid_credentials", message: INVALID } }, 401);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeContainer() {
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  return {
    status, listeners, innerHTML: "",
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    querySelector(selector) { return selector === "[data-signin-status]" ? status : null; },
    setAttribute() {}, querySelectorAll() { return []; }, contains() { return true; }
  };
}
const submitForm = (password = "synthetic-password", kind = "password", fields = { email: "person@example.invalid", password }) => ({
  preventDefault() {},
  target: { closest: selector => selector === "[data-signin-form]" ? {
    dataset: { signinForm: kind },
    querySelectorAll: () => Object.entries(fields).map(([name, value]) => ({ name, value }))
  } : null }
});
async function mount(t, { login = rejectedLogin, onSignInUncertain, onMagicLinkFailure,
  routes = {}, initialSession, onSignedIn, onPasswordResetComplete, resetLink = false } = {}) {
  let panel = { textContent: STALE_NOTICE };
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  if (resetLink) globalThis.window = { location: { search: "?reset=synthetic-code&email=person%40example.invalid", pathname: "/", hash: "" }, history: { replaceState() {} } };
  globalThis.document = { getElementById(id) { return id === "auth-error" ? panel : null; } };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (resetLink) {
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    }
  });
  const requests = [];
  const replacement = { authenticated: true, account: { id: "replacement-B" }, csrf: "synthetic-csrf-B", sessionBinding: "synthetic-binding-B", sessionRevision: 2 };
  const client = new AccountClient({ fetcher: async (path, options) => {
    requests.push({ path, method: options.method });
    const key = `${options.method} ${path}`;
    if (Object.hasOwn(routes, key)) return typeof routes[key] === "function" ? routes[key]() : routes[key];
    if (path === "/api/auth/password/login" && options.method === "POST") return login();
    if (path === "/api/account-session" && options.method === "GET") return response(replacement);
    throw new Error(`Unexpected synthetic transport: ${options.method} ${path}`);
  } });
  const original = { authenticated: false, account: null, csrf: "synthetic-csrf", sessionBinding: "synthetic-binding", sessionRevision: 1 };
  client.session = initialSession === undefined ? original : initialSession;
  let signedIn = 0, uncertain = 0;
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => client.session || client.restore(),
    onSignedIn() { signedIn++; return onSignedIn?.({ client, panel }); },
    onPasswordResetComplete() { return onPasswordResetComplete?.({ client, panel }); }, onSignInUncertain() { uncertain++; onSignInUncertain?.(); },
    onMagicLinkFailure() { onMagicLinkFailure?.(panel); } });
  const container = fakeContainer();
  await ui.mount(container);
  return { ui, client, container, requests, original, replacement,
    submit: password => container.listeners.submit[0](submitForm(password)),
    submitReset: () => container.listeners.submit[0](submitForm(undefined, "reset-consume", { newPassword: "synthetic-password", confirmPassword: "synthetic-password" })),
    submitTerms: () => container.listeners.submit[0](submitForm(undefined, "terms", {})),
    get panel() { return panel; }, set panel(value) { panel = value; },
    get signedIn() { return signedIn; }, get uncertain() { return uncertain; } };
}

test("wrong-password login clears the stale session-ended panel notice", async t => {
  const state = await mount(t);
  await state.submit();
  assert.equal(state.container.status.textContent, INVALID);
  assert.equal(state.panel.textContent, "");
  assert.equal(state.client.session, state.original);
  assert.equal(state.uncertain, 0);
});
test("empty sign-in status does not clear the panel notice", async t => {
  const state = await mount(t);
  assert.equal(state.panel.textContent, STALE_NOTICE);
  assert.deepEqual(state.requests, []);
});
for (const outcome of ["success", "http401"]) {
  for (const notice of [NEW_NOTICE, STALE_NOTICE]) {
    test(`late ${outcome} preserves the replacement account's ${notice === NEW_NOTICE ? "new" : "identical-text"} notice`, async t => {
      const reply = deferred(), started = deferred();
      const state = await mount(t, { login() { started.resolve(); return reply.promise; } });
      const oldGeneration = state.client.generation;
      const submission = state.submit();
      await started.promise;
      assert.equal(state.ui.canLeave(), false);
      assert.equal(await state.client.restore(), state.replacement);
      assert.equal(state.client.generation, oldGeneration + 1);
      assert.equal(state.client.owns(oldGeneration, state.original), false);
      state.panel.textContent = notice;
      reply.resolve(outcome === "success" ? response({ authenticated: true, account: { id: "obsolete-A" } }) : rejectedLogin());
      await submission;
      assert.equal(state.panel.textContent, notice);
      assert.equal(state.client.session, state.replacement);
      assert.equal(state.signedIn, 0);
      assert.equal(state.uncertain, 0);
      assert.equal(state.ui.canLeave(), true);
      // Pre-existing stale form status is outside this banner-ownership fix.
      assert.ok(state.container.status.textContent);
      assert.deepEqual(state.requests, [{ path: "/api/auth/password/login", method: "POST" }, { path: "/api/account-session", method: "GET" }]);
    });
  }
}
for (const replacement of ["text", "element"]) {
  test(`fresh login does not dismiss a newer host ${replacement} in the same account view`, async t => {
    const reply = deferred(), started = deferred();
    const state = await mount(t, { login() { started.resolve(); return reply.promise; } });
    const submission = state.submit();
    await started.promise;
    if (replacement === "element") state.panel = { textContent: STALE_NOTICE };
    else state.panel.textContent = NEW_NOTICE;
    reply.resolve(rejectedLogin()); await submission;
    assert.equal(state.panel.textContent, replacement === "element" ? STALE_NOTICE : NEW_NOTICE);
    assert.equal(state.container.status.textContent, INVALID);
  });
}
test("repainting an existing form error preserves a newer host notice", async t => {
  const state = await mount(t);
  await state.submit();
  assert.equal(state.panel.textContent, "");
  state.panel.textContent = NEW_NOTICE;
  assert.equal(state.ui.openEmail("password"), true);
  assert.equal(state.panel.textContent, NEW_NOTICE);
  assert.equal(state.container.status.textContent, INVALID);
  assert.equal(state.ui.showMagic(), true);
  assert.equal(state.panel.textContent, NEW_NOTICE);
});
test("a fresh retry owned by the replacement account can clear its existing notice", async t => {
  const state = await mount(t);
  await state.client.restore();
  state.panel.textContent = NEW_NOTICE;
  await state.submit();
  assert.equal(state.panel.textContent, "");
  assert.equal(state.container.status.textContent, INVALID);
  assert.equal(state.client.session, state.replacement);
});
test("fresh synchronous signup validation still clears the stale notice", async t => {
  const state = await mount(t);
  assert.equal(state.ui.showPassword("signup"), true);
  await state.submit("short");
  assert.ok(state.container.status.textContent);
  assert.equal(state.panel.textContent, "");
  assert.deepEqual(state.requests, []);
});
test("an uncertain login preserves the host notice posted during reconciliation", async t => {
  const state = await mount(t, { login() { throw new Error("Synthetic transport failure"); },
    onSignInUncertain() { state.panel.textContent = NEW_NOTICE; } });
  await state.submit();
  assert.equal(state.uncertain, 1);
  assert.equal(state.client.session, null);
  assert.equal(state.panel.textContent, NEW_NOTICE);
});

for (const changed of [false, true]) {
  test(`invalid-link outcome ${changed ? "preserves the host callback's newer" : "clears the unchanged stale"} notice`, async t => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { search: "?magic=incomplete", pathname: "/", hash: "" }, history: { replaceState() {} } };
    t.after(() => {
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    });
    const state = await mount(t, { onMagicLinkFailure(panel) { if (changed) panel.textContent = NEW_NOTICE; } });
    assert.equal(state.panel.textContent, changed ? NEW_NOTICE : "");
    assert.ok(state.container.status.textContent);
    assert.deepEqual(state.requests, []);
  });
}

const signupReply = () => response({ status: "check_email", mailConfigured: false }, 202);
const resetReply = () => response({ status: "password_reset", signInRequired: true });
for (const authenticated of [true, false]) {
  test(`fresh signup clears its unchanged notice after its own ${authenticated ? "authenticated" : "anonymous"} restore`, async t => {
    const restored = { authenticated, account: authenticated ? { id: "signup-A" } : null,
      csrf: "synthetic-csrf", sessionBinding: "synthetic-binding", sessionRevision: 2 };
    const state = await mount(t, { routes: { "POST /api/auth/password/signup": signupReply, "GET /api/account-session": () => response(restored) } });
    state.ui.showPassword("signup"); await state.submit();
    assert.equal(state.client.session, restored);
    assert.equal(state.client.generation, 1);
    assert.equal(state.signedIn, authenticated ? 1 : 0);
    assert.ok(state.container.status.textContent);
    assert.equal(state.panel.textContent, "");
  });
}
test("fresh password reset clears its unchanged notice after its own invalidation", async t => {
  let completed = 0;
  const state = await mount(t, { resetLink: true, routes: { "POST /api/auth/password/reset/consume": resetReply }, onPasswordResetComplete() { completed++; } });
  await state.submitReset();
  assert.equal(state.client.generation, 1);
  assert.equal(state.client.session, null);
  assert.equal(completed, 1);
  assert.equal(state.panel.textContent, "");
  assert.match(state.container.status.textContent, /Password reset/);
});
test("fresh login can dismiss its unchanged notice after preparing its initial session", async t => {
  const state = await mount(t, { initialSession: null });
  await state.submit();
  assert.equal(state.client.generation, 1);
  assert.equal(state.client.session, state.replacement);
  assert.equal(state.container.status.textContent, INVALID);
  assert.equal(state.panel.textContent, "");
});
for (const change of ["notice", "owner"]) {
  test(`signup's own restore cannot adopt a newer ${change}`, async t => {
    const started = deferred(), reply = deferred(); let restores = 0;
    const restored = { authenticated: true, account: { id: "signup-A" } };
    const replacement = { authenticated: true, account: { id: "replacement-B" } };
    const state = await mount(t, { routes: { "POST /api/auth/password/signup": signupReply,
      "GET /api/account-session": () => { if (++restores === 1) { started.resolve(); return reply.promise; } return response(replacement); } } });
    state.ui.showPassword("signup"); const submission = state.submit();
    await started.promise;
    if (change === "owner") await state.client.restore();
    state.panel.textContent = change === "owner" ? STALE_NOTICE : NEW_NOTICE;
    reply.resolve(response(restored)); await submission;
    assert.equal(state.panel.textContent, change === "owner" ? STALE_NOTICE : NEW_NOTICE);
    assert.equal(state.client.session, change === "owner" ? replacement : restored);
    assert.equal(state.signedIn, change === "owner" ? 0 : 1);
  });
}
for (const operation of ["signup", "reset"]) {
  for (const external of [false, true]) {
    test(`${operation} ${external ? "preserves identical-text replacement notice during" : "clears the old notice before"} its awaited host callback`, async t => {
      const started = deferred(), release = deferred(); let noticeAtCallback;
      const callback = async ({ client, panel }) => {
        noticeAtCallback = panel.textContent;
        if (!external) await client.restore();
        started.resolve(); await release.promise;
      };
      const state = await mount(t, { resetLink: operation === "reset",
        routes: { "POST /api/auth/password/signup": signupReply, "POST /api/auth/password/reset/consume": resetReply },
        onSignedIn: callback, onPasswordResetComplete: callback });
      if (operation === "signup") state.ui.showPassword("signup");
      const submission = operation === "signup" ? state.submit() : state.submitReset();
      await started.promise;
      if (external) { await state.client.restore(); state.panel.textContent = STALE_NOTICE; }
      release.resolve(); await submission;
      assert.equal(noticeAtCallback, "", "owned outcome clears the old notice before yielding to the host");
      assert.equal(state.panel.textContent, external ? STALE_NOTICE : "");
      assert.equal(state.client.session, state.replacement);
      assert.equal(state.client.generation, 2);
    });
  }
}
for (const change of ["notice", "owner"]) {
  test(`initial session preparation does not adopt a newer ${change}`, async t => {
    const started = deferred(), reply = deferred(); let restores = 0;
    const prepared = { authenticated: false, account: null, csrf: "synthetic-csrf", sessionBinding: "synthetic-binding", sessionRevision: 1 };
    const replacement = { ...prepared, authenticated: true, account: { id: "replacement-B" }, sessionRevision: 2 };
    const state = await mount(t, { initialSession: null, routes: {
      "GET /api/account-session": () => { if (++restores === 1) { started.resolve(); return reply.promise; } return response(replacement); } } });
    const submission = state.submit(); await started.promise;
    if (change === "owner") await state.client.restore();
    state.panel.textContent = change === "owner" ? STALE_NOTICE : NEW_NOTICE;
    reply.resolve(response(prepared)); await submission;
    assert.equal(state.panel.textContent, change === "owner" ? STALE_NOTICE : NEW_NOTICE);
    assert.equal(state.client.session, change === "owner" ? replacement : prepared);
    assert.equal(state.container.status.textContent, INVALID);
  });
}

test("a fresh transport failure clears its unchanged stale notice after owned invalidation", async t => {
  const state = await mount(t, { login() { throw new Error("Synthetic transport failure"); } });
  await state.submit();
  assert.equal(state.uncertain, 1);
  assert.equal(state.client.session, null);
  assert.equal(state.panel.textContent, "");
  assert.equal(state.container.status.textContent, "Synthetic transport failure");
});

for (const hostNotice of [null, NEW_NOTICE, STALE_NOTICE]) {
  for (const restore of [false, true]) {
  test(`fresh login confirmation failure ${restore ? "with" : "without"} host restoration ${hostNotice === null ? "clears its old notice" : "preserves the host's " + (hostNotice === STALE_NOTICE ? "identical-text" : "new") + " notice"}`, async t => {
    const signed = { authenticated: true, account: { id: "login-A" } };
    const anonymous = { authenticated: false, account: null, sessionRevision: 2 };
    const state = await mount(t, { login: () => response(signed),
      routes: { "GET /api/account-session": () => response(anonymous) },
      onSignedIn: async ({ client, panel }) => {
        if (restore) await client.restore();
        if (hostNotice !== null) panel.textContent = hostNotice;
        throw new Error("Sign-in could not be confirmed. Try again.");
      } });
    await state.submit();
    assert.equal(state.client.generation, restore ? 1 : 0);
    assert.equal(state.client.session, restore ? anonymous : state.original);
    assert.equal(state.container.status.textContent, "Sign-in could not be confirmed. Try again.");
    assert.equal(state.panel.textContent, hostNotice ?? "");
  });
  }
}
test("verified login dismisses its unchanged entry notice before successful host restoration", async t => {
  const state = await mount(t, { login: () => response({ authenticated: true, account: { id: "login-A" } }),
    onSignedIn: async ({ client, panel }) => {
      assert.equal(panel.textContent, "");
      await client.restore();
    } });
  await state.submit();
  assert.equal(state.signedIn, 1);
  assert.equal(state.client.session, state.replacement);
  assert.equal(state.panel.textContent, "");
  assert.equal(state.container.status.textContent, "");
});
test("pending terms retain the notice until an accepted owned outcome reaches the host", async t => {
  let noticeAtCallback;
  const account = { id: "login-A" };
  const state = await mount(t, { login: () => response({ authenticated: true, account, terms: { required: true, version: "synthetic-v1" } }),
    routes: { "POST /api/account/terms": () => response({ authenticated: true, account, terms: { required: false } }) },
    onSignedIn({ panel }) { noticeAtCallback = panel.textContent; panel.textContent = STALE_NOTICE; } });
  await state.submit();
  assert.equal(state.signedIn, 0);
  assert.equal(state.ui.canLeave(), false);
  assert.equal(state.panel.textContent, STALE_NOTICE);
  await state.submitTerms();
  assert.equal(state.signedIn, 1);
  assert.equal(state.ui.canLeave(), true);
  assert.equal(noticeAtCallback, "", "assert outside the callback so withBusy cannot swallow a failure");
  assert.equal(state.panel.textContent, STALE_NOTICE, "accepted terms must not consume an identical-text notice created by the host");
});
