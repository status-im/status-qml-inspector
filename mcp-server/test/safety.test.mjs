// Tests for the safety rules: the unlimited tools are off by default, every tool says whether it only reads,
// and the connection to the plugin can be protected with a token.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { FakeInspector, node } from "./fake-inspector.mjs";
import { QtBridge } from "../lib/bridge.mjs";
import { createToolset, UNLIMITED_TOOLS } from "../lib/tools.mjs";

const ITEM = ["QQuickItem", "QObject"];
const BUTTON = ["QQuickButton", "QQuickAbstractButton", "QQuickControl", ...ITEM];
const LIST = ["QQuickListView", "QQuickItemView", "QQuickFlickable", ...ITEM];
const CHANGING = ["setProperty", "callMethod", "evaluate", "click", "mouse", "sendKeys", "wheel", "findAndClick", "fileDialogAction"];

let fake, bridge;

function buildApp() {
  const rows = Array.from({ length: 12 }, (_, k) =>
    node("Row_QMLTYPE_1", { inherits: BUTTON, objectName: `row${k}`, text: `Row ${k}`, y: k * 50, w: 200, h: 50 }));
  const list = node("SettingsList_QMLTYPE_5", { inherits: LIST, objectName: "settingsList", y: 100, w: 200, h: 200,
    props: { contentY: 0, contentX: 0, contentHeight: 600, contentWidth: 200, originY: 0, originX: 0 } },
    [node("QQuickItem", { inherits: ITEM, w: 200, h: 600 }, rows)]);
  const save = node("Button", { inherits: BUTTON, objectName: "btnSave", text: "Save", x: 300, w: 80, h: 30,
    methods: { doIt: () => "done" } });
  const root = node("QQuickRootItem", { inherits: ITEM, w: 800, h: 600 }, [list, save]);
  const win = node("QQuickWindowQmlImpl", { inherits: ["QQuickWindow", "QWindow", "QObject"], objectName: "mainWindow", title: "App", w: 800, h: 600 }, [root]);
  return node("QGuiApplication", {}, [win]);
}

async function start(options = {}, fakeOptions = {}) {
  fake = new FakeInspector(buildApp());
  Object.assign(fake, fakeOptions);
  const port = await fake.listen();
  bridge = new QtBridge({ host: "127.0.0.1", port, timeoutMs: 2000, ...(options.bridge || {}) });
  return createToolset({ bridge, settleIntervalMs: 1, settleTimeoutMs: 50, ...(options.toolset || {}) });
}

beforeEach(() => { fake = null; bridge = null; });
afterEach(async () => {
  if (bridge) bridge.close();
  if (fake) await fake.close();
});

const text = (reply) => reply.content.map((c) => c.text || "").join("\n");
const names = (tools) => tools.definitions.map((t) => t.name);

// ---- the switch

test("by default the unlimited tools are not listed", async () => {
  const tools = await start();
  assert.deepEqual([...UNLIMITED_TOOLS].sort(), ["qml_call_method", "qml_evaluate", "qml_set_property"]);
  for (const name of UNLIMITED_TOOLS) assert.ok(!names(tools).includes(name), `${name} is listed`);
  assert.ok(names(tools).includes("qml_snapshot"));
  assert.ok(names(tools).includes("qml_click"));
});

test("by default a call to an unlimited tool is refused, and nothing is sent to the app", async () => {
  const tools = await start();
  const save = fake.byName("btnSave");
  const calls = {
    qml_evaluate: { expression: "Qt.quit()" },
    qml_call_method: { objectId: save.id, method: "doIt" },
    qml_set_property: { objectId: save.id, property: "text", value: "x" },
  };
  for (const [name, args] of Object.entries(calls)) {
    const reply = await tools.call(name, args);
    assert.equal(reply.isError, true, name);
    assert.match(text(reply), /QML_INSPECTOR_UNLIMITED_TOOLS=1/, name);
  }
  assert.equal(fake.log.length, 0);
});

test("with the switch on, the unlimited tools are listed and work", async () => {
  const tools = await start({ toolset: { unlimitedTools: true } });
  for (const name of UNLIMITED_TOOLS) assert.ok(names(tools).includes(name), `${name} is not listed`);
  const save = fake.byName("btnSave");
  fake.evaluateResult = 42;
  assert.match(text(await tools.call("qml_evaluate", { expression: "6*7" })), /42/);
  assert.match(text(await tools.call("qml_call_method", { objectId: save.id, method: "doIt" })), /"done"/);
  const set = await tools.call("qml_set_property", { objectId: save.id, property: "text", value: "Store" });
  assert.notEqual(set.isError, true);
  assert.equal(save.identifying.text, "Store");
});

async function overStdio(env, check) {
  fake = new FakeInspector(buildApp());
  Object.assign(fake, env.fake || {});
  const port = await fake.listen();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.mjs", import.meta.url).pathname],
    env: { PATH: process.env.PATH, QML_INSPECTOR_HOST: "127.0.0.1", QML_INSPECTOR_PORT: String(port), ...(env.vars || {}) },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await check(client);
  } finally {
    await client.close();
  }
}

test("index.mjs: the unlimited tools are listed only with QML_INSPECTOR_UNLIMITED_TOOLS=1", async () => {
  await overStdio({}, async (client) => {
    const listed = (await client.listTools()).tools.map((t) => t.name);
    for (const name of UNLIMITED_TOOLS) assert.ok(!listed.includes(name), `${name} is listed`);
    const reply = await client.callTool({ name: "qml_evaluate", arguments: { expression: "1" } });
    assert.equal(reply.isError, true);
  });
  await fake.close();
  for (const off of ["0", "false", ""]) {
    await overStdio({ vars: { QML_INSPECTOR_UNLIMITED_TOOLS: off } }, async (client) => {
      const listed = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(!listed.includes("qml_evaluate"), `listed with the value "${off}"`);
    });
    await fake.close();
  }
  await overStdio({ vars: { QML_INSPECTOR_UNLIMITED_TOOLS: "1" } }, async (client) => {
    const listed = (await client.listTools()).tools.map((t) => t.name);
    for (const name of UNLIMITED_TOOLS) assert.ok(listed.includes(name), `${name} is not listed`);
  });
});

// ---- scrolling without qml_set_property

test("qml_scroll moves a list and replies with what changed", async () => {
  const tools = await start();
  assert.ok(names(tools).includes("qml_scroll"));
  const reply = await tools.call("qml_scroll", { objectName: "settingsList", y: 300 });
  assert.notEqual(reply.isError, true, text(reply));
  assert.equal(fake.byName("settingsList").props.contentY, 300);
  assert.match(text(reply), /contentY=300 of 0\.\.400/);
  assert.match(text(reply), /Row 8/);
});

test("qml_scroll keeps the position inside the range of the list", async () => {
  const tools = await start();
  const reply = await tools.call("qml_scroll", { objectName: "settingsList", y: 5000 });
  assert.notEqual(reply.isError, true, text(reply));
  assert.equal(fake.byName("settingsList").props.contentY, 400);
  assert.match(text(reply), /400/);
  await tools.call("qml_scroll", { objectName: "settingsList", y: -20 });
  assert.equal(fake.byName("settingsList").props.contentY, 0);
});

test("qml_scroll changes nothing on an object that is not a list", async () => {
  const tools = await start();
  const reply = await tools.call("qml_scroll", { objectName: "btnSave", y: 10 });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /cannot be scrolled/);
  assert.equal(fake.commands("setProperty").length, 0);
  const none = await tools.call("qml_scroll", { objectName: "settingsList" });
  assert.equal(none.isError, true);
  assert.equal(fake.commands("setProperty").length, 0);
});

test("qml_scroll sets only contentY and contentX", async () => {
  const tools = await start();
  await tools.call("qml_scroll", { objectName: "settingsList", y: 100, x: 0, property: "visible", value: false });
  for (const c of fake.commands("setProperty")) assert.ok(["contentY", "contentX"].includes(c.params.property), c.params.property);
});

test("no tool text points an agent to a tool that is off", async () => {
  const tools = await start();
  for (const t of tools.definitions) {
    for (const name of UNLIMITED_TOOLS) assert.ok(!t.description.includes(name), `${t.name} names ${name}`);
  }
  const miss = await tools.call("qml_click", { text: "Row 11 is not here" });
  for (const name of UNLIMITED_TOOLS) assert.ok(!text(miss).includes(name), text(miss));
});

// ---- annotations

const READ_ONLY = ["qml_snapshot", "qml_list_interactive", "qml_screenshot", "qml_wait_for", "qml_find_by_type",
                   "qml_find_by_property", "qml_get_properties", "qml_get_tree", "qml_list_file_dialogs"];

test("every tool has annotations, and the read-only tools are exactly the expected ones", async () => {
  const tools = await start({ toolset: { unlimitedTools: true } });
  const readOnly = [];
  for (const t of tools.definitions) {
    const a = t.annotations;
    assert.ok(a, `${t.name} has no annotations`);
    assert.equal(typeof a.title, "string", t.name);
    assert.equal(typeof a.readOnlyHint, "boolean", t.name);
    assert.equal(a.openWorldHint, false, t.name);
    if (a.readOnlyHint) readOnly.push(t.name);
    else {
      assert.equal(typeof a.destructiveHint, "boolean", t.name);
      assert.equal(typeof a.idempotentHint, "boolean", t.name);
    }
  }
  assert.deepEqual(readOnly.sort(), [...READ_ONLY].sort());
  const by = Object.fromEntries(tools.definitions.map((t) => [t.name, t.annotations]));
  for (const name of ["qml_click", "qml_find_and_click", "qml_send_keys", "qml_file_dialog_action", ...UNLIMITED_TOOLS]) {
    assert.equal(by[name].destructiveHint, true, name);
  }
  assert.equal(by.qml_scroll.destructiveHint, false);
  assert.equal(by.qml_scroll.idempotentHint, true);
});

test("a tool marked read-only sends no command that changes the app", async () => {
  const tools = await start({ toolset: { unlimitedTools: true } });
  const save = fake.byName("btnSave");
  const args = {
    qml_snapshot: {}, qml_list_interactive: {}, qml_screenshot: {}, qml_wait_for: { text: "Save", timeoutMs: 200 },
    qml_find_by_type: { typeName: "Button" }, qml_find_by_property: { property: "text", value: "Save" },
    qml_get_properties: { objectId: save.id }, qml_get_tree: { depth: 2 }, qml_list_file_dialogs: {},
  };
  for (const name of READ_ONLY) {
    const reply = await tools.call(name, args[name]);
    assert.notEqual(reply.isError, true, `${name}: ${text(reply)}`);
  }
  const changing = fake.log.filter((e) => CHANGING.includes(e.command));
  assert.deepEqual(changing, []);
});

test("index.mjs sends the annotations to the client", async () => {
  await overStdio({}, async (client) => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    assert.equal(by.qml_snapshot.readOnlyHint, true);
    assert.equal(by.qml_click.readOnlyHint, false);
    assert.equal(by.qml_click.destructiveHint, true);
  });
});

// ---- token

test("a plugin with a token refuses a client that sends none, and closes the connection", async () => {
  const tools = await start({}, { token: "s3cret" });
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(reply.isError, true);
  assert.match(text(reply), /token/i);
  assert.match(text(reply), /QML_INSPECTOR_TOKEN/);
  assert.equal(fake.log.length, 0, "a command was run without the token");
});

test("a plugin with a token refuses a wrong token", async () => {
  const tools = await start({ bridge: { token: "wrong" } }, { token: "s3cret" });
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(reply.isError, true);
  assert.match(text(reply), /QML_INSPECTOR_TOKEN/);
  assert.ok(!text(reply).includes("s3cret"));
  assert.ok(!text(reply).includes("wrong"), "the reply shows the token");
  assert.equal(fake.log.length, 0);
});

test("with the right token the tools work, also after the connection was lost", async () => {
  const tools = await start({ bridge: { token: "s3cret" } }, { token: "s3cret" });
  assert.match(text(await tools.call("qml_snapshot", {})), /btnSave/);
  for (const s of fake.sockets) s.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(text(await tools.call("qml_snapshot", {})), /btnSave/);
  assert.equal(fake.auths, 2);
});

test("a client with a token works with a plugin that asks for none", async () => {
  const tools = await start({ bridge: { token: "s3cret" } });
  assert.match(text(await tools.call("qml_snapshot", {})), /btnSave/);
});

test("a client with a token says so when the plugin is too old to check it", async () => {
  const tools = await start({ bridge: { token: "s3cret" } }, { oldPlugin: true });
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(reply.isError, true);
  assert.match(text(reply), /does not know the token check/);
  assert.equal(fake.commands("getTree").length, 0);
});

test("index.mjs takes the token from QML_INSPECTOR_TOKEN", async () => {
  await overStdio({ fake: { token: "s3cret" }, vars: { QML_INSPECTOR_TOKEN: "s3cret" } }, async (client) => {
    const snap = await client.callTool({ name: "qml_snapshot", arguments: {} });
    assert.match(snap.content[0].text, /btnSave/);
  });
  await fake.close();
  await overStdio({ fake: { token: "s3cret" } }, async (client) => {
    const snap = await client.callTool({ name: "qml_snapshot", arguments: {} });
    assert.equal(snap.isError, true);
    assert.match(snap.content[0].text, /QML_INSPECTOR_TOKEN/);
  });
});
