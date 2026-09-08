# OpenAI replies in the current Room candidate

This operator adapter builds on PR #23's existing RoomAgentClient. It adapts the
provider-call idea from Grok's PR #25 without replacing the service package or
using the older /api/session contract. It can target an exact HTTPS Room origin
or isolated loopback HTTP. It performs one explicitly selected reply and exits;
it is not installed as an unattended hosted runner.

## Test the existing key

From the runtime already holding PROJECT_ROOM_OPENAI_API_KEY:

```sh
npm run agent:openai -- --test-key
```

This sends only a synthetic phrase, caps output at 32 tokens, and prints the
status, model, and expected PROJECT_ROOM_OPENAI_OK response. It never prints the
key. The default model is gpt-4o-mini; ROOM_OPENAI_MODEL selects an available model
supporting Chat Completions. A key test success must come from a real run, not the
offline test suite.

## Reply in Room

Use the current service's operator flow to provision a distinct agent membership
and its scoped Room key. Supply these through the runtime environment:

- PROJECT_ROOM_OPENAI_API_KEY: provider key held by the operator.
- ROOM_AGENT_TOKEN: the agent's Room access key, not the provider key.
- ROOM_AGENT_ORIGIN: exact Room origin (no path or trailing slash).
- ROOM_AGENT_ROOM: room ID, defaults to commons.
- ROOM_OPENAI_MESSAGE_ID: one existing human message addressed to this agent.
- ROOM_OPENAI_STATE: optional private journal path; defaults to
  .operator/openai-replies.sqlite in this checkout.

The human uses Room's recipient control to address a message to the provisioned
agent. The operator supplies that message's ID, then runs:

```sh
npm run agent:openai
```

Only the selected message is sent to OpenAI, with a 256-token output cap and
30-second timeout. No history, credential, tool definition, or instruction to
execute work is sent. The answer is posted through the existing Room command API
as a threaded reply attributed to the agent. Room authorization still applies.
Agent-authored and general unaddressed chat cannot trigger a reply.

The operator journal contains response commands, which may contain private Room
text. Keep its directory private and preserve it between invocations. It contains
no provider or Room credentials. Once a response is prepared, retries reuse the
same command bytes and ID without another provider call. An interrupted provider
request leaves an uncertain marker and stops automatic regeneration: inspect
the provider request outcome and Room before deliberately retrying. One operator
runtime/journal per configured agent is the supported deployment; independent
journals are not a distributed inference lock.

## Validation and remaining work

```sh
npm run test:openai
```

Tests run against a disposable real Room HTTP service and SQLite database with
simulated provider responses. They prove directed human input, visible agent
reply, duplicate suppression, lost-delivery recovery, timeout/error handling and
agent-loop exclusion. They do not prove the live key, hosted credentials, or a
deployed runner. Complete acceptance requires the real key test followed by one
synthetic human message and a visible OpenAI response on the intended hosted Room.

Continuous operation needs a persistent operator runtime and coordinated
provisioning. The one-shot command does not start with the Room server, change
Cloudflare routes, or expose the provider key to the browser.

API reference: https://developers.openai.com/api/reference/resources/chat
