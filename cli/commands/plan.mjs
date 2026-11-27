import { RoomAgentClient } from "../../client/room-agent.mjs";
import { buildWorkCommand, confirmsAgentCommand, recordedWorkAction } from "../../client/work-actions.mjs";
import { planRead, planSteps, submitPlan } from "../../client/work-plan.mjs";
import { loadSecret } from "../auth.mjs";
import { loadConnection } from "../paths.mjs";
import { readInput } from "../selected-basis.mjs";

const help = `room plan --preview|--submit < plan.json
Queue up to 20 Work Threads through the saved Room connection. Submitting requires steer permission.
Use {"planId":"qa","items":[{"key":"onboarding","title":"Review onboarding","definitionOfDone":"Return the first confusing step with a screenshot or exact link.","accountableMemberId":"MEMBER_ID","mode":"read","independentVerificationRequired":false,"ownerDecisionRequired":false}]}.
Preview validates the file locally. After an uncertain submission, retry with the same file and connection.`;

export async function recordWorkPlan(args, client, identity) {
  return submitPlan(args, async step => {
    const command = buildWorkCommand(step.name, step.args);
    const receipt = await client.command(command);
    if (!confirmsAgentCommand(receipt, command, identity)) {
      throw new Error("The Room did not confirm this proposal.");
    }
    return recordedWorkAction(step.name, command, receipt);
  }, { memberId: identity.memberId, read: planRead(id => client.workContext(id)) });
}

export async function planCommand(argv, { cwd = process.cwd(), env = process.env,
  stdin = process.stdin, fetchImpl = fetch, out = console.log } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { out(help); return 0; }
  if (argv.length !== 1 || !["--preview", "--submit"].includes(argv[0])) throw new Error(help);

  const args = JSON.parse(await readInput(stdin));
  if (Object.keys(args ?? {}).some(key => !["planId", "items"].includes(key))) throw new Error("Use only planId and items.");
  const steps = planSteps(args);
  for (const step of steps) buildWorkCommand(step.name, step.args);
  const print = value => out(JSON.stringify(value, null, 2));
  if (argv[0] === "--preview") {
    print({ status: "preview", planId: args.planId, proposals: steps.map(step => step.args) });
    return 0;
  }

  const { config, name } = loadConnection({ project: cwd, env });
  const token = await loadSecret(name, config.token, env);
  const client = new RoomAgentClient({ ...config, token, fetchImpl });
  const result = await recordWorkPlan(args, client, config);
  print({ roomId: config.roomId, ...result });
  return result.status === "recorded" ? 0 : 1;
}
