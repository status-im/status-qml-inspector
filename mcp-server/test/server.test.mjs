// End to end: the real server process over stdio, an MCP client, and the fake inspector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeInspector, node } from "./fake-inspector.mjs";

test("index.mjs serves the tools over stdio and talks to the inspector", async () => {
  const win = node("QQuickWindowQmlImpl", { inherits: ["QQuickWindow", "QWindow", "QObject"], objectName: "mainWindow", title: "App", w: 400, h: 300 }, [
    node("QQuickRootItem", { inherits: ["QQuickItem", "QObject"], w: 400, h: 300 }, [
      node("Button", { inherits: ["QQuickButton", "QQuickAbstractButton", "QQuickItem", "QObject"], objectName: "okButton", text: "OK", w: 80, h: 30 }),
    ]),
  ]);
  const fake = new FakeInspector(node("QGuiApplication", {}, [win]));
  const port = await fake.listen();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.mjs", import.meta.url).pathname],
    env: { ...process.env, QML_INSPECTOR_HOST: "127.0.0.1", QML_INSPECTOR_PORT: String(port) },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "qml_snapshot"));
    const snap = await client.callTool({ name: "qml_snapshot", arguments: {} });
    assert.match(snap.content[0].text, /\[e\d+\] Button "OK" objectName=okButton/);
    const miss = await client.callTool({ name: "qml_click", arguments: { text: "Cancel" } });
    assert.equal(miss.isError, true);
    const hit = await client.callTool({ name: "qml_click", arguments: { text: "OK" } });
    assert.notEqual(hit.isError, true);
    assert.equal(fake.commands("click").length, 1);
  } finally {
    await client.close();
    await fake.close();
  }
});
