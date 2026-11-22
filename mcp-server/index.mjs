import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { QtBridge } from "./lib/bridge.mjs";
import { createToolset, INSTRUCTIONS, UNLIMITED_SWITCH } from "./lib/tools.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// QML_INSPECTOR_UNLIMITED_TOOLS=1 adds qml_evaluate, qml_call_method and qml_set_property. Any other value leaves them off.
// QML_INSPECTOR_TOKEN is the secret the plugin was started with, if it was started with one.
const isOn = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const bridge = new QtBridge({
  host: process.env.QML_INSPECTOR_HOST || "localhost",
  port: parseInt(process.env.QML_INSPECTOR_PORT || "3768", 10),
  timeoutMs: parseInt(process.env.QML_INSPECTOR_TIMEOUT || "15000", 10),
  token: (process.env.QML_INSPECTOR_TOKEN || "").trim(),
});
const tools = createToolset({ bridge, unlimitedTools: isOn(process.env[UNLIMITED_SWITCH]) });

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "qml-inspector", version: "1.1.0" },
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
