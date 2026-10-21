import { connectRoom } from "./agent-setup.mjs";
import { openCodexStdio, checkCodexCredentials } from "./codex-stdio.mjs";

export function providerLoginURL(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)
    || url.username || url.password || url.port) throw new Error("Unsupported provider sign-in URL");
  return url.href;
}
export async function nativeConnect(input, options = {}) {
  const result = await connectRoom({ target: input.target, directory: input.directory, name: input.name || "Mac agent",
    accept: input.accept === true, expectedPreview: input.expectedPreview, ...options });
  if (result.status === "approval_required") {
    const p = result.preview;
    return { status: result.status, roomId: p.roomId, roomTitle: p.roomTitle, permissions: p.permissions,
      expectedPreview: JSON.stringify({ roomId: p.roomId, permissions: [...p.permissions].sort(), expiresAt: p.expiresAt }) };
  }
  if (result.status === "connected") return { status: result.status, roomId: result.roomId, origin: result.origin,
    memberId: result.memberId, configDirectory: result.configDirectory, execution: "not_tested" };
  // Do not send arbitrary server objects or credential-bearing identity data to UI.
  return { status: result.status === "choose_room" ? "choose_room" : "admission_pending", roomId: result.roomId };
}

export async function nativeLogin(config, { emit = () => {}, signal, timeoutMs = 300000, open = openCodexStdio } = {}) {
  let resolveCompletion, loginId, timer, abort, ending = false, finalStatus;
  const rpc = open(config, { authenticationOnly: true, onDisconnect: () => resolveCompletion?.(false) });
  let early = [];
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const unsubscribe = rpc.subscribe(event => {
    if (event.method !== "account/login/completed") return;
    if (!loginId) { if (early.length < 8) early.push(event.params); }
    else if (event.params?.loginId === loginId) resolveCompletion(event.params.success === true);
  });
  const stopped = new Promise(resolve => {
    const stop = status => { ending = true; resolve({ status }); };
    abort = () => stop("cancelled");
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop("timeout"), timeoutMs);
  });
  const authenticate = async () => {
    if (ending) return { status: "cancelled" };
    await rpc.request("initialize", { clientInfo: { name: "project_room", title: "Project Room", version: "0.1.0" } });
    rpc.notify("initialized", {});
    const before = await checkCodexCredentials(rpc);
    if (["present", "not_required"].includes(before.credentials)) return {
      status: before.credentials === "present" ? "credentials_present" : "authentication_not_required", modelExecution: "not_tested" };
    if (ending) return { status: "cancelled" };
    const result = await rpc.request("account/login/start", { type: "chatgpt" });
    if (typeof result.loginId !== "string" || !result.loginId || result.type !== "chatgpt") throw new Error("Invalid login response");
    loginId = result.loginId;
    const authUrl = providerLoginURL(result.authUrl);
    for (const event of early) if (event?.loginId === loginId) resolveCompletion(event.success === true);
    early = [];
    if (!ending) emit({ status: "open_browser", authUrl });
    if (!await completion) return { status: "login_failed" };
    const after = await checkCodexCredentials(rpc);
    return { status: after.credentials === "present" ? "credentials_present" : "login_unverified", modelExecution: "not_tested" };
  };
  try {
    const result = await Promise.race([authenticate(), stopped]);
    finalStatus = result.status; return result;
  } finally {
    ending = true;
    clearTimeout(timer); signal?.removeEventListener("abort", abort); unsubscribe();
    // Best-effort protocol cancellation, followed by owned process shutdown.
    // Never wait for a stalled request before honoring the user's Cancel.
    if (loginId && finalStatus !== "credentials_present") rpc.request("account/login/cancel", { loginId }).catch(() => {});
    await rpc.close();
  }
}
