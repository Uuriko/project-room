// Offline synthetic trial inputs. Never executes a task or includes the scoring key.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createWorkBrief} from '../client/work-brief.mjs';
import {createWorkContinuation, workContinuationMarkdown} from '../src/work-continuation.js';

export async function prepareContinuationTrial(scenario, condition) {
  if (!['repo', 'handoff', 'generated'].includes(condition)) throw Error('Choose repo, handoff or generated');
  if (!scenario?.id || !scenario.selectedContext || !scenario.repositoryFiles) throw Error('Missing synthetic scenario');
  const initialView = condition === 'repo' ? null : condition === 'handoff' ? scenario.currentHandoff
    : workContinuationMarkdown(createWorkContinuation(await createWorkBrief(scenario.selectedContext)));
  return {
    scenarioId: scenario.id, condition, synthetic: true, task: scenario.task,
    instruction: 'You are a fresh agent resuming this synthetic task. Inspect the supplied repository evidence. State the next action, what is verified, what remains unknown, and the smallest safe completion plan. Do not claim tools ran or writes happened. Do not use network access or other task history.',
    // Same accessible evidence in all conditions; only initial presentation changes.
    repositoryFiles: {...structuredClone(scenario.repositoryFiles), 'selected-context.json': JSON.stringify(scenario.selectedContext, null, 2)},
    initialView,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [id, condition, ...extra] = process.argv.slice(2);
    if (extra.length) throw Error('Too many arguments');
    const fixtures = JSON.parse(readFileSync(new URL('../tests/fixtures/continuation-trials.json', import.meta.url), 'utf8'));
    const scenario = fixtures.scenarios.find(value => value.id === id);
    console.log(JSON.stringify(await prepareContinuationTrial(scenario, condition), null, 2));
  } catch (error) {
    console.error(`${error.message}. Usage: node scripts/prepare-continuation-trial.mjs <scenario-id> <repo|handoff|generated>`);
    process.exitCode = 1;
  }
}
