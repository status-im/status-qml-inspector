import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { QtBridge } from "./lib/bridge.mjs";
import { createToolset, INSTRUCTIONS, UNLIMITED_SWITCH } from "./lib/tools.mjs";
import { loadProfile } from "./lib/profile.mjs";

// ---------------------------------------------------------------------------
// Configuration (all of it comes from environment variables, see the README)
// ---------------------------------------------------------------------------
const MIN_TOKEN_LENGTH = 16; // the plugin takes no shorter token

// A switch is on with 1, true, yes or on (any case). Every other value, and no value, is off.
const isOn = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

function stop(message) {
  console.error(`qml-inspector: ${message}`);
  process.exit(1);
}

// QML_INSPECTOR_TOKEN is the secret the app was started with. A value that is set but empty, or too short,
// is a mistake in the setup. It must not turn the token check off without a word, so the server does not start.
let token = "";
if (process.env.QML_INSPECTOR_TOKEN !== undefined) {
  token = process.env.QML_INSPECTOR_TOKEN.trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    stop(`QML_INSPECTOR_TOKEN is set but ${token ? `has fewer than ${MIN_TOKEN_LENGTH} characters` : "is empty"}. ` +
         "Give it the value the app was started with, or remove the variable if the app has no token.");
  }
}

// A number from the environment. A value that is not a whole number in the range is a mistake in the setup:
// the server does not start with it (a timeout that is not a number would end every request at once).
function numberFrom(name, fallback, min, max) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) stop(`${name} must be a whole number from ${min} to ${max}, not "${raw.slice(0, 40)}".`);
  return value;
}

let profile;
try {
  profile = loadProfile(process.env.QML_INSPECTOR_PROFILE);
} catch (err) {
  stop(`QML_INSPECTOR_PROFILE: ${err.message}`);
}

const bridge = new QtBridge({
  host: process.env.QML_INSPECTOR_HOST || "127.0.0.1",
  port: numberFrom("QML_INSPECTOR_PORT", 3768, 1, 65535),
  timeoutMs: numberFrom("QML_INSPECTOR_TIMEOUT", 15000, 1, 600000),
  token,
});
const tools = createToolset({ bridge, profile, unlimitedTools: isOn(process.env[UNLIMITED_SWITCH]) });

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const server = new Server(
  { name: "qml-inspector", version },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.definitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  tools.call(request.params.name, request.params.arguments)
);

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);

// When the client goes away, close the connection to the app and stop. Without this the open socket keeps the
// process alive, and its connection keeps one of the few places the plugin has.
// A call that is running is finished first (for at most 10 seconds): a click must not stop between press and release,
// with the mouse button down in the app.
const SHUTDOWN_WAIT_MS = 10000;
let ending = false;
const shutdown = async () => {
  if (ending) return;
  ending = true;
  await Promise.race([tools.stop(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
  bridge.close();
  process.exit(0);
};
// The reply of a call that is finished after the client went away has nowhere to go.
process.stdout.on("error", () => {});
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
