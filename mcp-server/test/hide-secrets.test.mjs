// The server asks the plugin to hide what password fields hold, on every connection, before it reads anything.
// A plain client of the plugin (test-framework/framework.mjs, a test suite) does not ask, and reads these texts.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";

import { FakeInspector, node } from "./fake-inspector.mjs";
import { QtBridge } from "../lib/bridge.mjs";
import { createToolset } from "../lib/tools.mjs";

const ITEM = ["QQuickItem", "QObject"];
const TEXT_INPUT = ["QQuickTextField", "QQuickTextInput", "QQuickImplicitSizeItem", ...ITEM];
const WINDOW = ["QQuickWindowQmlImpl", "QQuickWindow", "QWindow", "QObject"];
const SECRET = "hunter2-Secret!";
const TOKEN = "s3cret-of-16-chars";
const FRAMEWORK = new URL("../../test-framework/framework.mjs", import.meta.url).href;

let fake, bridge;
const open = [];
afterEach(async () => {
  if (bridge) bridge.close();
  bridge = null;
  for (const f of open.splice(0)) await f.close();
});

function passwordApp() {
  const editor = node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "passwordEdit", text: SECRET, x: 20, y: 100, w: 300, h: 40, props: { echoMode: 2 } });
  const content = node("QQuickRootItem", { inherits: ITEM, w: 800, h: 600 }, [editor]);
  const win = node("QQuickWindowQmlImpl_QML_1", { inherits: WINDOW, objectName: "mainWindow", title: "App", w: 800, h: 600 }, [content]);
  return { root: node("QGuiApplication", {}, [win]), editor };
}

async function start({ plugin = "new", token = "", toolset = {} } = {}) {
  const app = passwordApp();
  fake = new FakeInspector(app.root);
  fake.plugin = plugin;
  fake.token = token;
  open.push(fake);
  const port = await fake.listen(0);
  bridge = new QtBridge({ host: "127.0.0.1", port, timeoutMs: 1000, token });
  return { app, tools: createToolset({ bridge, settleIntervalMs: 2, settleTimeoutMs: 60, ...toolset }) };
}
const text = (reply) => reply.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const echoSearches = () => fake.commands("findByProperty").filter((c) => c.params.property === "echoMode").length;

test("the request to hide password text is the first line of a connection, before any read", async () => {
  const { tools } = await start();
  const reply = await tools.call("qml_snapshot", {});
  assert.ok(!reply.isError, text(reply));
  assert.equal(fake.requests[0].command, "hideSecrets");
  assert.equal(fake.hideRequests, 1);
  assert.match(text(reply), /value=\(hidden\)/);
  assert.ok(!JSON.stringify(reply).includes(SECRET));
  // The plugin hides the text, so the server makes no search of its own for password fields.
  assert.equal(echoSearches(), 0);
  // One request per connection, not one per tool call.
  await tools.call("qml_snapshot", {});
  assert.equal(fake.hideRequests, 1);
});

test("with a token, the request to hide password text comes right after the token check", async () => {
  const { tools } = await start({ token: TOKEN });
  const reply = await tools.call("qml_snapshot", {});
  assert.ok(!reply.isError, text(reply));
  assert.deepEqual(fake.requests.slice(0, 2).map((r) => r.command), ["auth", "hideSecrets"]);
  assert.ok(!JSON.stringify(fake.requests[1]).includes(TOKEN));
});

test("after the connection was lost, the request is sent again on the new connection, before any read", async () => {
  const { tools } = await start();
  await tools.call("qml_snapshot", {});
  for (const socket of fake.sockets) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = fake.requests.length;
  const reply = await tools.call("qml_snapshot", {});
  assert.ok(!JSON.stringify(reply).includes(SECRET));
  assert.equal(fake.connections, 2);
  assert.equal(fake.requests[before].command, "hideSecrets");
  assert.equal(fake.hideRequests, 2);
  assert.match(text(await tools.call("qml_snapshot", {})), /value=\(hidden\)/);
});

test("the request is sent with the unlimited tools too", async () => {
  const { tools, app } = await start({ toolset: { unlimitedTools: true } });
  const reply = await tools.call("qml_get_properties", { objectId: app.editor.id });
  assert.equal(fake.requests[0].command, "hideSecrets");
  assert.ok(!JSON.stringify(reply).includes(SECRET));
});

test("an older plugin does not know the request: the server hides password text itself, as before", async () => {
  const { tools, app } = await start({ plugin: "old" });
  const reply = await tools.call("qml_snapshot", {});
  assert.ok(!reply.isError, text(reply));
  assert.equal(fake.requests[0].command, "hideSecrets");
  assert.match(text(reply), /value=\(hidden\)/);
  assert.ok(!JSON.stringify(reply).includes(SECRET));
  assert.equal(echoSearches(), 1);
  const properties = await tools.call("qml_get_properties", { objectId: app.editor.id });
  assert.ok(!JSON.stringify(properties).includes(SECRET));
  assert.equal(fake.hideRequests, 1);
});

test("any other error to the request stops the call: nothing is read, and the reply says why", async () => {
  const { tools, app } = await start();
  fake.hideSecretsError = "Internal error 42";
  for (const [name, args] of [["qml_snapshot", {}], ["qml_get_properties", { objectId: app.editor.id }], ["qml_get_tree", { depth: 30 }]]) {
    const reply = await tools.call(name, args);
    assert.equal(reply.isError, true, name);
    assert.match(text(reply), /hide password/i, name);
    assert.match(text(reply), /Internal error 42/, name);
    assert.ok(!JSON.stringify(reply).includes(SECRET), name);
  }
  // No request reached the app besides the refused one.
  assert.equal(fake.log.length, 0);
  assert.ok(fake.requests.every((r) => r.command === "hideSecrets"));
  assert.equal(bridge.socket, null);
  // When the plugin accepts it again, the next call works.
  fake.hideSecretsError = null;
  assert.match(text(await tools.call("qml_snapshot", {})), /value=\(hidden\)/);
});

test("no answer to the request stops the call too: nothing is read", async () => {
  const { tools } = await start();
  fake.noReply = (command) => command === "hideSecrets";
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(reply.isError, true);
  assert.match(text(reply), /hide password/i);
  assert.equal(fake.commands("getTree").length, 0);
  assert.ok(!JSON.stringify(reply).includes(SECRET));
});

test("a plain client of the same plugin still reads the password text, while the server's connection hides it", async () => {
  const { tools } = await start();
  await tools.call("qml_snapshot", {});
  // A client that does not ask: the raw protocol, as a test suite speaks it.
  const net = await import("node:net");
  const lines = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: bridge.port }, () => socket.write(JSON.stringify({ id: 1, command: "getTree", params: { depth: 10 } }) + "\n"));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) { socket.destroy(); resolve(data); } });
    socket.on("error", reject);
  });
  const reply = JSON.parse(lines.split("\n")[0]);
  assert.ok(JSON.stringify(reply).includes(SECRET));
  assert.ok(!("secretsHidden" in reply));
  // And the server's own connection still hides it.
  assert.ok(!JSON.stringify(await tools.call("qml_get_tree", { depth: 30 })).includes(SECRET));
});

test("framework.mjs does not send the request, and reads the text of a password field", async () => {
  const app = passwordApp();
  const plugin = new FakeInspector(app.root);
  plugin.plugin = "new";
  const port = await plugin.listen();
  const script = `const { Inspector } = await import(${JSON.stringify(FRAMEWORK)});
    const inspector = new Inspector();
    const reply = await inspector.send("getProperties", { objectId: ${JSON.stringify(app.editor.id)} });
    console.log(JSON.stringify(reply));
    inspector.disconnect();`;
  try {
    const out = await new Promise((resolve) => execFile(process.execPath, ["--input-type=module", "-e", script],
      { env: { PATH: process.env.PATH, QML_INSPECTOR_PORT: String(port) }, timeout: 10000 }, (err, stdout, stderr) => resolve(stdout.trim() || String(err || stderr))));
    assert.equal(plugin.hideRequests, 0);
    assert.ok(out.includes(SECRET), out.slice(0, 300));
    assert.ok(!out.includes("secretsHidden"));
  } finally {
    await plugin.close();
  }
});
