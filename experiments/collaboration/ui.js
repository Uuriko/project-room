const $ = selector => document.querySelector(selector);
const catalog = await fetch('/api/catalog').then(r => r.json());
const params = new URLSearchParams(location.search);
const labels = { conversation: 'A · Conversation', split: 'B · Conversation + result', work: 'C · Work first' };
function options(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
}
options($('#variant'), catalog.variants.map(id => [id, labels[id]]));
options($('#scenario'), catalog.scenarios.map(s => [s.id, s.title]));
for (const key of ['variant', 'scenario', 'task']) if ([...$(`#${key}`).options].some(o => o.value === params.get(key))) $(`#${key}`).value = params.get(key);
let data, trial, generation = 0;
const log = (kind, detail = {}) => { if (trial) trial.events.push({ kind, atMs: Math.round(performance.now() - trial.started), ...detail }); };
function showVersion(id, focus = false) {
  const result = data.versions.find(v => v.id === id);
  $('#version').value = id; $('#result-label').textContent = result.label; $('#result-body').textContent = result.body;
  $('#result').hidden = false;
  if (focus) { $('#version').focus(); $('#result').scrollIntoView({ block: 'nearest' }); }
  log('view-version', { id });
}
async function start() {
  const mine = ++generation;
  trial = null;
  $('#answer').reset(); $('#status').textContent = ''; $('#start').disabled = true;
  const config = Object.fromEntries(['variant', 'scenario', 'task'].map(key => [key, $(`#${key}`).value]));
  try {
    const loaded = await fetch(`/api/scenario/${config.scenario}`).then(r => { if (!r.ok) throw new Error('Could not load scenario'); return r.json(); });
    if (mine !== generation) return;
    data = loaded;
    $('#workspace').className = config.variant;
    $('#title').textContent = data.title; $('#brief').textContent = data.brief;
    $('#trial-label').textContent = `${labels[config.variant]} · ${config.task === 'resume' ? 'Resume work' : 'Review and revise'}`;
    $('#messages').replaceChildren();
    const add = (who, text, version) => {
      const li = document.createElement('li'), name = document.createElement('strong'), body = document.createElement('p');
      name.textContent = who; body.textContent = text; li.append(name, body);
      if (version) { const button = document.createElement('button'); button.type = 'button'; button.textContent = `View ${version.id}`; button.addEventListener('click', () => showVersion(version.id, true)); li.append(button); }
      $('#messages').append(li);
    };
    add('Agent A', `${data.versions[0].label}: ${data.versions[0].body}`, data.versions[0]);
    for (const [index, [who, text]] of data.messages.entries()) {
      add(who, text);
      if (index === 2) add('Agent A', `${data.versions[1].label}: ${data.versions[1].body}`, data.versions[1]);
    }
    const versions = data.versions.map(v => [v.id, `${v.id} · ${v.label}`]);
    options($('#version'), versions);
    for (const name of ['current', 'accepted', 'basedOn']) options($(`[name="${name}"]`), [['', 'Choose a version'], ...versions]);
    $('#resume-fields').hidden = config.task !== 'resume'; $('#review-fields').hidden = config.task !== 'review';
    $('#task-title').textContent = config.task === 'resume' ? 'Continue the work' : 'Correct the proposal';
    $('#instructions').textContent = config.task === 'resume'
      ? 'Identify the latest proposal, earlier accepted version, owner and confirmation still needed. Use the confirmation wording in the conversation.'
      : 'Submit a corrected result based on the latest proposal and the discussion. Select its exact version. This does not publish anything.';
    showVersion(data.versions[1].id); $('#result').hidden = config.variant === 'conversation';
    trial = { id: crypto.randomUUID(), ...config, started: performance.now(), events: [], attempts: [], scope: 'local synthetic concept trial', viewport: { width: innerWidth, height: innerHeight } };
    history.replaceState(null, '', `/?${new URLSearchParams(config)}`);
  } catch (error) { if (mine === generation) $('#status').textContent = error.message; }
  finally { if (mine === generation) $('#start').disabled = false; }
}
$('#version').addEventListener('change', e => showVersion(e.target.value));
$('#start').addEventListener('click', start);
for (const key of ['variant', 'scenario', 'task']) $(`#${key}`).addEventListener('change', start);
document.addEventListener('click', e => { if (e.target.closest('main')) log('click', { control: e.target.closest('button,input,select,textarea')?.tagName ?? 'content' }); });
$('#answer').addEventListener('submit', async e => {
  e.preventDefault(); if (!trial) return;
  const own = trial, answer = Object.fromEntries(new FormData(e.target)), elapsedMs = Math.round(performance.now() - own.started);
  const button = $('#answer button'); button.disabled = true;
  try {
    const response = await fetch('/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: own.scenario, task: own.task, answer }) });
    if (!response.ok) throw new Error('Scoring failed; your answer is preserved.');
    const result = await response.json();
    own.attempts.push({ answer, elapsedMs, result });
    if (trial !== own) return;
    $('#status').textContent = result.passed ? 'Recorded: fixture requirements met.' : 'Recorded: one or more fixture requirements were not met.';
    log('submit', { passed: result.passed });
  } catch (error) { if (trial === own) $('#status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#export').addEventListener('click', () => {
  if (!trial) return;
  const { started, ...record } = trial;
  const blob = new Blob([JSON.stringify({ ...record, elapsedMs: Math.round(performance.now() - started), limitations: 'Self-administered synthetic trial; wall time is not active human effort. No general usability conclusion.' }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `trial-${trial.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
await start();
