import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { QtBridge } from "./lib/bridge.mjs";
import { createToolset, INSTRUCTIONS } from "./lib/tools.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const bridge = new QtBridge({
  host: process.env.QML_INSPECTOR_HOST || "localhost",
  port: parseInt(process.env.QML_INSPECTOR_PORT || "3768", 10),
  timeoutMs: parseInt(process.env.QML_INSPECTOR_TIMEOUT || "15000", 10),
});
const tools = createToolset({ bridge });

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
