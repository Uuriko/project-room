// Fail-closed gate for provider sign-in doors (#3548).
//
// A provider door (today: GitHub) stays hidden until the deployment proves
// the door works: the sign-in options feed must report the provider both
// configured AND verified — verified meaning the deployment's secrets have
// completed a real sign-in (see server/routes/signin-options.mjs). Anything
// else — feed unreachable, older server, configured-but-never-used — keeps
// the door hidden: a dead door on the wall is worse than no door. This is
// deliberately the opposite default from the mail capability in
// auth-signin-ui.js, where a missing answer leaves historical behavior in
// place; here the historical behavior WAS the dead door.
//
// The auth UI sets the gate from the feed it already loads; the sign-in
// navigation controller reads it on every view sync and re-applies live
// when the answer lands, so the button appears the moment verification is
// known — no reload needed.

let githubVerified = false;
const listeners = new Set();

export function githubSigninVerified() {
  return githubVerified;
}

export function setGithubSigninVerified(value) {
  const next = value === true;
  if (next === githubVerified) return;
  githubVerified = next;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* one bad listener must not break the wall */ }
  }
}

export function onGithubSigninGateChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
