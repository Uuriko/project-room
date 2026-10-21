// In-memory GitHub for the merge train: refs, merges, commits, workflow
// dispatch and runs. Used by tests/merge-train.test.js and the rollback drill.

// ---------- in-memory GitHub ----------

export function fakeGitHub({ files, bad = [], smokeOk = true, flakyFirst = false }) {
  let n = 0;
  const sha = () => (++n).toString(16).padStart(40, "0");
  const base = sha();
  const commits = new Map([[base, { prs: [], tree: `t${base}` }]]);
  const refs = new Map([["main", base]]);
  const runs = [];
  const state = { refs, commits, runs, dispatches: [], base, smokeOk, deployed: false };
  const reply = (status, data) => ({ status, json: async () => data });
  const now = () => new Date(state.clock()).toISOString();
  state.fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    if ((m = /\/pulls\/(\d+)$/.exec(path))) return reply(200, { state: "open", head: { sha: `head${m[1]}`.padEnd(40, "x") } });
    if ((m = /\/pulls\/(\d+)\/files$/.exec(path))) return reply(200, (files[m[1]] ?? []).map(filename => ({ filename })));
    if ((m = /\/git\/ref\/heads\/(.+)$/.exec(path))) return reply(200, { object: { sha: refs.get(m[1]) } });
    if (path.endsWith("/git/refs") && method === "POST") { refs.set(body.ref.replace("refs/heads/", ""), body.sha); return reply(201, {}); }
    if ((m = /\/git\/refs\/heads\/(.+)$/.exec(path))) {
      if (method === "DELETE") { refs.delete(m[1]); return reply(204, null); }
      const current = refs.get(m[1]);
      const ancestor = (s, target) => s === target || (commits.get(s)?.parents ?? []).some(p => ancestor(p, target));
      if (!body.force && !ancestor(body.sha, current)) return reply(422, {});
      refs.set(m[1], body.sha);
      return reply(200, {});
    }
    if (path.endsWith("/merges")) {
      const pr = Number(/^head(\d+)/.exec(body.head)[1]);
      const parent = refs.get(body.base);
      const next = sha();
      commits.set(next, { prs: [...commits.get(parent).prs, pr], parents: [parent], tree: `t${next}`, message: body.commit_message });
      refs.set(body.base, next);
      return reply(201, { sha: next });
    }
    if ((m = /\/git\/commits\/(.+)$/.exec(path))) return reply(200, { tree: { sha: commits.get(m[1]).tree } });
    if (path.endsWith("/git/commits")) {
      const next = sha();
      const source = [...commits.entries()].find(([, c]) => c.tree === body.tree)[1];
      commits.set(next, { prs: source.prs, parents: body.parents, tree: body.tree, message: body.message });
      return reply(201, { sha: next });
    }
    if ((m = /\/actions\/workflows\/([^/]+)\/dispatches$/.exec(path))) {
      state.dispatches.push({ workflow: m[1], ref: body.ref });
      const prs = commits.get(refs.get(body.ref))?.prs ?? [];
      const flake = flakyFirst && m[1] === "test.yml" && !state.flaked;
      if (flake) state.flaked = true;
      const conclusion = m[1] === "live-smoke.yml" ? (state.smokeOk ? "success" : "failure")
        : flake || prs.some(p => bad.includes(p)) ? "failure" : "success";
      const id = runs.length + 1;
      runs.push({ id, html_url: `https://github.com/o/r/actions/runs/${id}`, workflow: m[1], branch: body.ref, event: "workflow_dispatch", status: "completed", conclusion, created_at: now() });
      return reply(204, null);
    }
    if ((m = /\/actions\/runs\/(\d+)\/jobs$/.exec(path))) {
      const run = runs.find(x => String(x.id) === m[1]);
      return reply(200, { jobs: [{ name: "unit (shard 3)", conclusion: run?.conclusion === "failure" ? "failure" : "success" }] });
    }
    if ((m = /\/actions\/workflows\/([^/]+)\/runs$/.exec(path))) {
      const q = new URL(url).searchParams;
      const list = runs.filter(r => r.workflow === m[1] && (!q.get("branch") || r.branch === q.get("branch")) && (!q.get("event") || r.event === q.get("event")));
      return reply(200, { workflow_runs: list });
    }
    return reply(404, {});
  };
  return state;
}

