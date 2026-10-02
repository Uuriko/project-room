// Recorded vendor request shapes. The builders below are what the bot sends.
// Tests compare those builders to these field names. No request leaves the
// process unless a provider calls its injected fetch.

export const ANTHROPIC_TOOL_TYPE = "computer_toolset_20260801";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_COMPUTER_TYPE = "computer";
export const OPENAI_URL = "https://api.openai.com/v1/responses";
export const DASHA_URL = "https://lobby.getdasha.com/compute/api/v1/chat/completions";
export const OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat";
export const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";

export const LOCAL_TEXT_TOOLS = Object.freeze(["shell_vm", "files_get", "files_put"]);
export const LOCAL_VISION_TOOLS = Object.freeze([...LOCAL_TEXT_TOOLS, "screenshot"]);

export function anthropicBody({ model, messages }) {
  return {
    model,
    max_tokens: 1024,
    tools: [{ type: ANTHROPIC_TOOL_TYPE }],
    messages,
  };
}

export function anthropicHeaders(key) {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": key,
  };
}

export function openaiBody({ model, input, width = 1280, height = 800 }) {
  return {
    model,
    tools: [{
      type: OPENAI_COMPUTER_TYPE,
      display_width: width,
      display_height: height,
      environment: "mac",
    }],
    input,
  };
}

export function openaiHeaders(key) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
}

function tool(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

export function localTools({ vision }) {
  const names = vision ? LOCAL_VISION_TOOLS : LOCAL_TEXT_TOOLS;
  const described = {
    shell_vm: tool("shell_vm", "Run a command in the guest VM.", { command: { type: "string" } }, ["command"]),
    files_get: tool("files_get", "Read a file from the guest scratch directory.", { name: { type: "string" } }, ["name"]),
    files_put: tool("files_put", "Write a file into the guest scratch directory.", {
      name: { type: "string" },
      text: { type: "string" },
    }, ["name", "text"]),
    screenshot: tool("screenshot", "Take a screenshot of the guest desktop.", {}, []),
  };
  return names.map(name => described[name]);
}

export function localBody({ model, messages, vision }) {
  return { model, messages, tools: localTools({ vision }), stream: false };
}

export function dashaBody({ model, messages }) {
  return { model, messages };
}

export function dashaHeaders(key) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
}

export const NONE_MESSAGE = "No model provider is set on this machine. I will not run this. The owner sets one locally with room-machine provider set.";
export const GUI_MESSAGE = "This provider cannot drive a desktop. I can take a shell or file job, or the owner can set anthropic or openai on the machine.";
export const MISSING_KEY_MESSAGE = "The selected provider has no key on this machine. I will not run this. The owner sets the key locally with room-machine provider set.";
