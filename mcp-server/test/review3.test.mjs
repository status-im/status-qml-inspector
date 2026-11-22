// Tests for the third review: a password field that goes away between two requests, password text in error texts,
// references from before a new connection, popups that are not modal, file dialogs, the size of every reply,
// lines of the plugin that are no reply, and the smaller points of the bridge.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, execFile } from "node:child_process";

import { FakeInspector, node, add } from "./fake-inspector.mjs";
import { QtBridge } from "../lib/bridge.mjs";
import { createToolset, TOOLS, ANNOTATIONS, MAX_REPLY_CHARS } from "../lib/tools.mjs";

const ITEM = ["QQuickItem", "QObject"];
const BUTTON = ["QQuickButton", "QQuickAbstractButton", "QQuickControl", ...ITEM];
const TEXT = ["QQuickText", ...ITEM];
const TEXT_INPUT = ["QQuickTextField", "QQuickTextInput", "QQuickImplicitSizeItem", ...ITEM];
const WINDOW = ["QQuickWindowQmlImpl", "QQuickWindow", "QWindow", "QObject"];
const INDEX = new URL("../index.mjs", import.meta.url).pathname;
const FRAMEWORK = new URL("../../test-framework/framework.mjs", import.meta.url).href;
const SECRET = "hunter2-Secret!";
const PLUGINS = ["old", "new"];

let fake, bridge;
const open = [];
afterEach(async () => {
  if (bridge) bridge.close();
  bridge = null;
  for (const f of open.splice(0)) await (f.close.length ? new Promise((resolve) => f.close(resolve)) : f.close());
});

function windowOf(children, w = 800, h = 600) {
  const overlay = node("QQuickOverlay", { inherits: ITEM, objectName: "overlay", w, h });
  const content = node("QQuickRootItem", { inherits: ITEM, w, h }, [...children, overlay]);
  const win = node("QQuickWindowQmlImpl_QML_1", { inherits: WINDOW, objectName: "mainWindow", title: "App", w, h }, [content]);
  return { root: node("QGuiApplication", {}, [win]), win, content, overlay };
}

async function start(root, { plugin = "old", toolset = {}, bridgeOptions = {}, port = 0 } = {}) {
  fake = new FakeInspector(root);
  fake.plugin = plugin;
  open.push(fake);
  const at = await fake.listen(port);
  bridge = new QtBridge({ host: "127.0.0.1", port: at, timeoutMs: 2000, ...bridgeOptions });
  return createToolset({ bridge, settleIntervalMs: 2, settleTimeoutMs: 60, ...toolset });
}

async function rawServer(onConnection) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: (done) => { for (const s of sockets) s.destroy(); server.close(done); } });
  return { port: server.address().port, sockets };
}
const lines = (socket, onRequest) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim()) onRequest(JSON.parse(line));
    }
  });
};

const text = (reply) => reply.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noSecret = (reply, what, secret = SECRET) => assert.ok(!JSON.stringify(reply).includes(secret), `${what}: the reply holds the password:\n${text(reply)}`);
const passwordField = (opts = {}) => node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "pw", text: SECRET, props: { echoMode: 2 }, w: 200, h: 30, ...opts });
const button = (label, opts = {}) => node("QQuickButton", { inherits: BUTTON, text: label, w: 80, h: 30, props: { pressed: false }, ...opts });

// ---------------------------------------------------------------- B1: a password field that goes away between two requests

// The plugin without the password hiding: the tree holds the text of every field, and the search for the password
// fields is a second request. The field is removed from the app right before that search.
function removeBeforeTheSearch(field, armed = () => true) {
  fake.beforeCommand = (command, params) => {
    if (armed(command, params) && command === "findByProperty" && params.property === "echoMode" && field.parent) fake.remove(field);
  };
}

test("old plugin: a password field that goes away before the search for password fields does not show its text in the snapshot", async () => {
  const field = passwordField();
  const app = windowOf([field, node("QQuickText", { inherits: TEXT, text: "Welcome", y: 40 })]);
  const tools = await start(app.root);
  removeBeforeTheSearch(field);
  const snap = await tools.call("qml_snapshot", {});
  noSecret(snap, "snapshot");
  assert.match(text(snap), /Welcome/);
  // The field was in the tree that was read: it is listed, without its text.
  assert.match(text(snap), /objectName="pw" value=\(hidden\)/);
});

test("old plugin: the same in the changes after a key press (Return on a login page), and in a wait", async () => {
  const field = passwordField();
  const app = windowOf([field]);
  const tools = await start(app.root);
  let armed = false;
  fake.beforeCommand = (command, params) => {
    if (command === "sendKeys" && params.key) armed = true;
    if (armed && command === "findByProperty" && params.property === "echoMode" && field.parent) fake.remove(field);
  };
  const typed = await tools.call("qml_send_keys", { objectName: "pw", key: "Return" });
  noSecret(typed, "send_keys");

  const second = passwordField();
  add(app.content, second);
  removeBeforeTheSearch(second);
  noSecret(await tools.call("qml_wait_for", { objectName: "pw", timeout_ms: 0 }), "wait_for");
});

test("old plugin: a wrapper's copy of the text is hidden too when its field goes away before the search", async () => {
  const field = passwordField({ objectName: "" });
  const wrapper = node("PasswordInput", { inherits: ITEM, objectName: "passwordInput", text: SECRET, label: "Password", w: 220, h: 60 }, [field]);
  const app = windowOf([wrapper, node("QQuickText", { inherits: TEXT, objectName: "mirror", text: SECRET, y: 80 })]);
  const mirror = app.content.children.find((c) => c.objectName === "mirror");
  const tools = await start(app.root);
  // When the field goes, the texts that were bound to it go with it. The tree that was read before still holds them.
  const goAway = (when) => {
    let searches = 0;
    fake.beforeCommand = (command, params) => {
      if (command !== "findByProperty" || params.property !== "echoMode" || !field.parent || ++searches < when) return;
      fake.remove(field);
      wrapper.identifying.text = "";
      mirror.identifying.text = "";
    };
  };
  goAway(1);
  noSecret(await tools.call("qml_snapshot", {}), "snapshot");
  // The raw tree and the find tools use the same rule. Their read lies between two searches: the field goes before the second.
  for (const [name, args] of [["qml_get_tree", { depth: 20 }], ["qml_find_by_property", { property: "text" }], ["qml_find_by_type", { typeName: "PasswordInput" }]]) {
    add(wrapper, field);
    wrapper.identifying.text = SECRET;
    mirror.identifying.text = SECRET;
    goAway(2);
    noSecret(await tools.call(name, args), name);
  }
});

test("old plugin: a field that shows its text is still shown, and the snapshot costs no more requests than before", async () => {
  const shown = node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "name", text: "Alice", props: { echoMode: 0 }, w: 200, h: 30 });
  const app = windowOf([shown, passwordField({ y: 40 })]);
  const tools = await start(app.root);
  const snap = await tools.call("qml_snapshot", {});
  assert.match(text(snap), /objectName="name" value="Alice"/);
  assert.match(text(snap), /objectName="pw" value=\(hidden\)/);
  noSecret(snap, "snapshot");
  // One search for the password fields per snapshot, as before: the fix adds no request.
  assert.equal(fake.commands("findByProperty").filter((c) => c.params.property === "echoMode").length, 1);
});

// ---------------------------------------------------------------- B2: password text in error texts

test("old plugin: an error that lists several objects with one objectName does not show what password fields hold", async () => {
  const first = passwordField(), second = passwordField({ y: 50, text: SECRET + "-confirm" });
  const app = windowOf([first, second]);
  const tools = await start(app.root, { toolset: { unlimitedTools: true } });
  for (const [name, args] of [["qml_get_properties", { objectName: "pw", names: ["length"] }], ["qml_scroll", { objectName: "pw", y: 0 }],
                              ["qml_set_property", { objectName: "pw", property: "width", value: 10 }], ["qml_call_method", { objectName: "pw", method: "selectAll" }]]) {
    const reply = await tools.call(name, args);
    assert.equal(reply.isError, true, name);
    noSecret(reply, name);
    // The references are still there: the user needs them to choose one.
    assert.match(text(reply), new RegExp(`\\[e${first.id}\\] QQuickTextField objectName="pw"`), name);
    assert.match(text(reply), new RegExp(`\\[e${second.id}\\] QQuickTextField objectName="pw"`), name);
  }
});

test("old plugin: the error text of a script does not show what a password field holds", async () => {
  const app = windowOf([passwordField()]);
  const tools = await start(app.root, { toolset: { unlimitedTools: true } });
  fake.evaluateError = `Error: got ${SECRET} here`;
  const reply = await tools.call("qml_evaluate", { expression: "throw new Error(pw.text)" });
  assert.equal(reply.isError, true);
  noSecret(reply, "evaluate");
  assert.match(text(reply), /got \(hidden\) here/);
});

// ---------------------------------------------------------------- B3: references from before a new connection

const cancelApp = (label, clicked) => windowOf([button(label, { id: 9050, onClick: () => clicked.push(label) })]);
// The app ends and starts again on the same port. -> the new stand-in, after the server has seen that its connection is gone.
async function restart(root, port) {
  await fake.close();
  open.length = 0;
  for (let k = 0; k < 200 && bridge.socket; k++) await sleep(5);
  const second = new FakeInspector(root);
  open.push(second);
  await second.listen(port);
  return second;
}

test("after the app started again, a reference from before is refused, and works again after a new snapshot", async () => {
  const clicked = [];
  const tools = await start(cancelApp("Cancel", clicked).root);
  const port = fake.server.address().port;
  assert.match(text(await tools.call("qml_snapshot", {})), /\[e9050\] QQuickButton "Cancel"/);
  // The app starts again: the same object id now names another button.
  const second = await restart(cancelApp("Delete account", clicked).root, port);
  for (const [name, args] of [["qml_click", { ref: "e9050" }], ["qml_click", { objectId: 9050 }], ["qml_send_keys", { ref: "e9050", text: "x" }],
                              ["qml_get_properties", { ref: "e9050", names: ["text"] }], ["qml_get_tree", { objectId: "9050" }], ["qml_screenshot", { objectId: 9050 }]]) {
    const reply = await tools.call(name, args);
    assert.equal(reply.isError, true, name);
    assert.match(text(reply), /new connection.*qml_snapshot/s, name);
  }
  assert.deepEqual(clicked, []);
  assert.equal(second.commands("click").length + second.commands("mouse").length + second.commands("sendKeys").length, 0);
  // A new snapshot gives the references of the app as it is now.
  assert.match(text(await tools.call("qml_snapshot", {})), /\[e9050\] QQuickButton "Delete account"/);
  assert.notEqual((await tools.call("qml_click", { ref: "e9050" })).isError, true);
  assert.deepEqual(clicked, ["Delete account"]);
});

test("after the app started again, a call that names its target by text or objectName works at once", async () => {
  const clicked = [];
  const tools = await start(cancelApp("Cancel", clicked).root);
  const port = fake.server.address().port;
  await tools.call("qml_snapshot", {});
  await restart(cancelApp("Cancel", clicked).root, port);
  const byText = await tools.call("qml_click", { text: "Cancel" });
  assert.notEqual(byText.isError, true, text(byText));
  assert.deepEqual(clicked, ["Cancel"]);
  // That reply listed the screen of the new connection: a reference is good again.
  assert.notEqual((await tools.call("qml_click", { ref: "e9050" })).isError, true);
});

test("the first call of a server may use a reference: nothing was listed before any connection", async () => {
  const clicked = [];
  const tools = await start(cancelApp("Cancel", clicked).root);
  assert.notEqual((await tools.call("qml_click", { ref: "e9050" })).isError, true);
  assert.deepEqual(clicked, ["Cancel"]);
});

test("a connection that is lost and opened again in the middle of a call stops the call before it acts", async () => {
  const clicked = [];
  const tools = await start(cancelApp("Cancel", clicked).root, { toolset: { settleIntervalMs: 40 } });
  await tools.call("qml_snapshot", {});
  // The connection closes after the first read of the screen for the click. The server waits a moment before it reads
  // again; that read opens a new connection, and the click would go over it.
  let trees = 0;
  fake.closeAfter = (request) => request.command === "getTree" && ++trees === 1;
  const reply = await tools.call("qml_click", { ref: "e9050" });
  assert.equal(reply.isError, true, text(reply));
  assert.match(text(reply), /^The connection to the app was lost and opened again during this call/);
  assert.deepEqual(clicked, []);
  assert.equal(fake.commands("click").length, 0);
  assert.equal(fake.connections, 2);
  // The next call starts on the new connection; its reference is refused until the screen was listed again.
  assert.match(text(await tools.call("qml_click", { ref: "e9050" })), /new connection/);
  assert.notEqual((await tools.call("qml_click", { text: "Cancel" })).isError, true);
});

test("the bridge refuses a request when the connection is not the one a call was pinned to", async () => {
  await start(cancelApp("Cancel", []).root);
  assert.equal((await bridge.send("getTree", {})).ok, true);
  assert.equal(bridge.generation, 1);
  bridge.pinned = 1;
  for (const s of fake.sockets) s.destroy();
  for (let k = 0; k < 200 && bridge.socket; k++) await sleep(5);
  await assert.rejects(bridge.send("click", { objectId: "9050" }), /lost and opened again during this call/);
  assert.equal(fake.commands("click").length, 0);
  // Without a pin (between two calls) a new connection is used as before.
  bridge.pinned = null;
  assert.equal((await bridge.send("getTree", {})).ok, true);
  assert.equal(bridge.generation, 2);
});

test("a reference whose element shows another label than when it was listed is refused once, with both lines", async () => {
  const clicked = [];
  const row = button("Alice", { id: 9050, onClick: () => clicked.push(row.identifying.text) });
  const tools = await start(windowOf([row]).root);
  assert.match(text(await tools.call("qml_snapshot", {})), /\[e9050\] QQuickButton "Alice"/);
  // A list reuses the row for another entry: same object, other content.
  row.identifying.text = "Bob";
  const refused = await tools.call("qml_click", { ref: "e9050" });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /was listed as.*"Alice".*"Bob"/s);
  assert.deepEqual(clicked, []);
  // The user has seen the new line now: the same reference is taken.
  assert.notEqual((await tools.call("qml_click", { ref: "e9050" })).isError, true);
  assert.deepEqual(clicked, ["Bob"]);
});

test("a reference whose element is unchanged, or whose field only has another value, is taken as before", async () => {
  const clicked = [];
  const field = node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "name", text: "", props: { echoMode: 0 }, y: 40, w: 200, h: 30 });
  const tools = await start(windowOf([button("OK", { id: 9060, onClick: () => clicked.push("OK") }), field]).root);
  await tools.call("qml_snapshot", {});
  field.identifying.text = "typed by the user";
  assert.notEqual((await tools.call("qml_send_keys", { ref: "e" + field.id, text: "!" })).isError, true);
  assert.notEqual((await tools.call("qml_click", { ref: "e9060" })).isError, true);
  assert.deepEqual(clicked, ["OK"]);
});

test("a line that a reply showed as changed is the line the reference is checked against", async () => {
  const clicked = [];
  const save = button("Save", { id: 9070, onClick: () => clicked.push(save.identifying.text) });
  const start_ = button("Start", { id: 9071, y: 40, onClick: () => { save.identifying.text = "Saved"; } });
  const tools = await start(windowOf([save, start_]).root);
  await tools.call("qml_snapshot", {});
  // The click changes the label of the other button, and its reply shows the new line.
  assert.match(text(await tools.call("qml_click", { ref: "e9071" })), /changed: \[e9070\] QQuickButton "Saved"/);
  assert.notEqual((await tools.call("qml_click", { ref: "e9070" })).isError, true);
  assert.deepEqual(clicked, ["Saved"]);
});

test("only a limited number of listed lines is remembered; a reference whose line was forgotten is taken without the check", async () => {
  const clicked = [];
  const make = (label, id, y) => button(label, { id, y, onClick: (f, n) => clicked.push(n.identifying.text) });
  const first = make("One", 9080, 0), last = make("Three", 9082, 80);
  const tools = await start(windowOf([first, make("Two", 9081, 40), last]).root, { toolset: { listedMax: 2 } });
  await tools.call("qml_snapshot", {});
  first.identifying.text = "Uno";
  last.identifying.text = "Tres";
  // The line of the last button is still remembered: the other label is noticed.
  assert.equal((await tools.call("qml_click", { ref: "e9082" })).isError, true);
  // The line of the first one was dropped to keep the memory small: its reference is taken as it is.
  assert.notEqual((await tools.call("qml_click", { ref: "e9080" })).isError, true);
  assert.deepEqual(clicked, ["Uno"]);
});

test("old plugin: a field that is in the matches of a search, but in neither search for password fields, is taken as a password field", async () => {
  const field = passwordField({ displayText: SECRET });
  const app = windowOf([node("QQuickText", { inherits: TEXT, text: "Welcome", y: 40 })]);
  const tools = await start(app.root);
  // The field is in the app only while the search of the tool itself runs.
  fake.beforeCommand = (command, params) => {
    if (command !== "findByProperty") return;
    if (params.property === "echoMode" && field.parent) fake.remove(field);
    if (params.property === "displayText" && !field.parent) add(app.content, field);
  };
  const reply = await tools.call("qml_find_by_property", { property: "displayText" });
  noSecret(reply, "find_by_property");
  assert.match(text(reply), /objectName="pw" displayText=\(hidden\)/);
});

// ---------------------------------------------------------------- B5: popups that are not modal

// A menu that is open and not modal: its popup item lies in the overlay, over the "Pay" button. "Help" is beside it.
function menuApp(clicked) {
  const pay = button("Pay", { objectName: "pay", x: 20, y: 20, onClick: () => clicked.push("Pay") });
  const help = button("Help", { objectName: "help", x: 500, y: 20, onClick: () => clicked.push("Help") });
  const field = node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "amount", text: "", props: { echoMode: 0 }, x: 20, y: 100, w: 150, h: 30 });
  const app = windowOf([pay, help, field]);
  const copy = node("QQuickMenuItem", { inherits: ["QQuickMenuItem", ...BUTTON], text: "Copy", y: 0, w: 200, h: 30, props: { pressed: false }, onClick: () => clicked.push("Copy") });
  const menu = node("QQuickMenu", { inherits: ["QQuickMenu", "QQuickPopup", "QObject"], objectName: "menu", props: { modal: false, opened: true, visible: true } });
  const item = node("QQuickPopupItem", { inherits: ["QQuickPopupItem", ...ITEM], x: 0, y: 0, w: 200, h: 200, onClick: () => clicked.push("the menu") }, [copy, menu]);
  add(app.overlay, item);
  return { ...app, pay, help, field, copy, item };
}

for (const plugin of PLUGINS) {
  test(`an element under an open popup that is not modal is marked, and a click on it is refused (${plugin} plugin)`, async () => {
    const clicked = [];
    const app = menuApp(clicked);
    const tools = await start(app.root, { plugin });
    const snap = text(await tools.call("qml_snapshot", {}));
    assert.match(snap, /QQuickButton "Pay" objectName="pay" \(under a popup\)/);
    assert.match(snap, /QQuickButton "Help" objectName="help"$/m);
    assert.match(snap, /QQuickMenuItem "Copy"$/m);
    for (const args of [{ objectName: "pay" }, { ref: "e" + app.pay.id }, { text: "Pay" }]) {
      const reply = await tools.call("qml_click", args);
      assert.equal(reply.isError, true, JSON.stringify(args));
      assert.match(text(reply), /under.*popup.*Nothing was clicked/s);
    }
    const typed = await tools.call("qml_send_keys", { objectName: "amount", text: "5" });
    assert.equal(typed.isError, true);
    // Nothing reached the app: no click went to the popup in place of the button.
    assert.deepEqual(clicked, []);
    assert.deepEqual(fake.popupClicks, []);
    assert.equal(fake.commands("click").length, 0);
    assert.equal(app.field.identifying.text, "");
    // What is in the popup, and what is beside it, is clicked as before.
    assert.notEqual((await tools.call("qml_click", { text: "Copy" })).isError, true);
    assert.notEqual((await tools.call("qml_click", { objectName: "help" })).isError, true);
    assert.deepEqual(clicked, ["Copy", "Help"]);
  });

  test(`a popup that goes away when the mouse moves to the element (a tooltip) does not block the click (${plugin} plugin)`, async () => {
    const clicked = [];
    const app = menuApp(clicked);
    const tools = await start(app.root, { plugin });
    // The popup is the tooltip of another control: it closes when the mouse leaves that control.
    fake.onHover = (f, n) => { if (n === app.pay && app.item.parent) f.remove(app.item); };
    const reply = await tools.call("qml_click", { objectName: "pay" });
    assert.notEqual(reply.isError, true, text(reply));
    assert.deepEqual(clicked, ["Pay"]);
    assert.deepEqual(fake.popupClicks, []);
  });

  test(`when the popup is closed, the element under it is listed and clicked as before (${plugin} plugin)`, async () => {
    const clicked = [];
    const app = menuApp(clicked);
    fakeless(app);
    const tools = await start(app.root, { plugin });
    assert.match(text(await tools.call("qml_snapshot", {})), /QQuickButton "Pay" objectName="pay"$/m);
    assert.notEqual((await tools.call("qml_click", { objectName: "pay" })).isError, true);
    assert.deepEqual(clicked, ["Pay"]);
  });
}
// Closes the menu of menuApp: the popup item leaves the overlay.
function fakeless(app) {
  app.overlay.children = [];
  app.item.parent = null;
}

// ---------------------------------------------------------------- B6: file dialogs

test("qml_file_dialog_action: choosing or accepting a path is off by default; cancel and the list are not", async () => {
  const app = windowOf([]);
  const tools = await start(app.root);
  const id = Number(app.content.id);
  for (const args of [{ objectId: id, action: "select", path: "/home/user/.ssh/id_rsa" }, { objectId: id, action: "accept" }]) {
    const reply = await tools.call("qml_file_dialog_action", args);
    assert.equal(reply.isError, true, args.action);
    assert.match(text(reply), /QML_INSPECTOR_FILE_DIALOGS=1/);
    assert.match(text(reply), /Nothing was done/);
  }
  assert.equal(fake.commands("fileDialogAction").length, 0);
  assert.notEqual((await tools.call("qml_file_dialog_action", { objectId: id, action: "cancel" })).isError, true);
  assert.equal(fake.commands("fileDialogAction").length, 1);
  assert.notEqual((await tools.call("qml_list_file_dialogs", {})).isError, true);
});

test("qml_file_dialog_action: with the switch on, a path can be chosen and accepted", async () => {
  const app = windowOf([]);
  const tools = await start(app.root, { toolset: { fileDialogs: true } });
  const id = Number(app.content.id);
  assert.notEqual((await tools.call("qml_file_dialog_action", { objectId: id, action: "select", path: "/tmp/picture.png" })).isError, true);
  assert.notEqual((await tools.call("qml_file_dialog_action", { objectId: id, action: "accept" })).isError, true);
  assert.deepEqual(fake.commands("fileDialogAction").map((c) => c.params.action), ["select", "accept"]);
});

test("the file dialog tools are marked open-world, and their descriptions name the switch", () => {
  assert.equal(ANNOTATIONS.qml_file_dialog_action.openWorldHint, true);
  assert.equal(ANNOTATIONS.qml_list_file_dialogs.openWorldHint, true);
  assert.match(TOOLS.find((t) => t.name === "qml_file_dialog_action").description, /QML_INSPECTOR_FILE_DIALOGS=1/);
});

// ---------------------------------------------------------------- B7: lines that are no reply, the size of a reply, plain text, emoji

test("a line of the plugin that is JSON but no object (null, a number, a list) is skipped, and the reply that follows is taken", async () => {
  const server = await rawServer((socket) => lines(socket, (request) => {
    socket.write("null\n5\n[1]\n\"text\"\n" + JSON.stringify({ id: request.id, ok: true, tree: {} }) + "\n");
  }));
  bridge = new QtBridge({ port: server.port, timeoutMs: 1000 });
  const reply = await bridge.send("getTree", {});
  assert.equal(reply.ok, true);
});

test("framework.mjs skips such a line too", async () => {
  const server = await rawServer((socket) => lines(socket, (request) => {
    socket.write("null\n" + JSON.stringify({ id: request.id, ok: true, tree: {} }) + "\n");
  }));
  const script = `const { Inspector } = await import(${JSON.stringify(FRAMEWORK)});
    const inspector = new Inspector();
    try { const reply = await inspector.send("getTree", { depth: 1 }); console.log(JSON.stringify({ ok: reply.ok === true })); }
    catch (err) { console.log(JSON.stringify({ ok: false, error: err.message })); }
    inspector.disconnect();`;
  const out = await new Promise((resolve) => execFile(process.execPath, ["--input-type=module", "-e", script],
    { env: { PATH: process.env.PATH, QML_INSPECTOR_HOST: "127.0.0.1", QML_INSPECTOR_PORT: String(server.port) }, timeout: 10000 },
    (err, stdout, stderr) => resolve(stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()) : { ok: false, error: String(err || stderr) })));
  assert.deepEqual(out, { ok: true });
});

test("no reply of any tool is longer than the limit, whatever the arguments are", async () => {
  const long = "x".repeat(20000);
  const app = windowOf([button("OK", { objectName: "ok" }), node("QQuickText", { inherits: TEXT, text: long, y: 50, w: 300 })]);
  const tools = await start(app.root, { toolset: { unlimitedTools: true, fileDialogs: true } });
  const calls = [
    ["qml_wait_for", { text: long, state: "gone", timeout_ms: 0 }], ["qml_wait_for", { objectName: long, state: "gone", timeout_ms: 0 }],
    ["qml_wait_for", { text: long, timeout_ms: 0 }], ["qml_wait_for", { objectName: long, timeout_ms: 0 }],
    ["qml_click", { text: long }], ["qml_click", { objectName: long }], ["qml_click", { ref: long }], ["qml_find_and_click", { text: long }],
    ["qml_send_keys", { objectName: long, text: "a" }], ["qml_send_keys", { text: long }], ["qml_send_keys", { key: long }],
    ["qml_find_by_type", { typeName: long }], ["qml_find_by_property", { property: long }], ["qml_find_by_property", { property: "text", value: long }],
    ["qml_find_by_property", { property: "text" }], ["qml_get_properties", { objectName: long }], ["qml_get_properties", { objectName: "ok", names: [long] }],
    ["qml_scroll", { objectName: long, y: 1 }], ["qml_set_property", { objectName: "ok", property: long, value: long }],
    ["qml_call_method", { objectName: "ok", method: long }], ["qml_evaluate", { expression: long }], ["qml_snapshot", { filter: long }],
    ["qml_list_interactive", { filter: long }], ["qml_get_tree", { objectId: long }], ["qml_file_dialog_action", { objectId: long, action: "cancel" }],
    [long, {}], ["qml_click", { [long]: 1 }],
  ];
  for (const [name, args] of calls) {
    const reply = await tools.call(name, args);
    const size = reply.content.filter((c) => c.type === "text").reduce((sum, c) => sum + c.text.length, 0);
    assert.ok(size <= MAX_REPLY_CHARS, `${name.slice(0, 30)} ${JSON.stringify(args).slice(0, 60)}: ${size} characters`);
    assert.ok(size > 0, name.slice(0, 30));
  }
});

test("plain text with < and > is kept; only tags of rich text are taken out of a label", async () => {
  const label = (t, y) => node("QQuickText", { inherits: TEXT, text: t, y, w: 300 });
  const app = windowOf([
    label("pay 5 < 10 to bob > alice now", 0), label("a<b and b>c", 30), label("x <- y -> z", 60), label("<3 you", 90),
    label("<b>Bold</b> and <i>plain</i>", 120), label('<a href="https://example.org">a link</a>', 150),
    label("<style>p { color: red }</style><p>styled</p>", 180), label("line one<br/>line two", 210), label('<font color="#ff0000">red</font> <span style="x">span</span>', 240),
  ]);
  const tools = await start(app.root);
  const snap = text(await tools.call("qml_snapshot", {}));
  for (const kept of ['"pay 5 < 10 to bob > alice now"', '"a<b and b>c"', '"x <- y -> z"', '"<3 you"', '"Bold and plain"', '"a link"', '"styled"', '"line one line two"', '"red span"']) {
    assert.ok(snap.includes(kept), `${kept} is not in:\n${snap}`);
  }
});

for (const plugin of PLUGINS) {
  test(`typing a character outside the basic plane into a password field is no error (${plugin} plugin)`, async () => {
    const field = passwordField({ text: "" });
    const tools = await start(windowOf([field]).root, { plugin });
    const reply = await tools.call("qml_send_keys", { objectName: "pw", text: "a🙂" });
    assert.notEqual(reply.isError, true, text(reply));
    assert.equal(field.identifying.text, "a🙂");
    // The plugin counts as Qt does: the emoji is two units.
    assert.match(text(reply), /it now holds 3 characters/);
    assert.equal(fake.keyEvents, 3);
    // A wrong length is still an error.
    fake.handle = ((handle) => (command, params) => (command === "sendKeys" && params.text ? { sent: "" } : handle(command, params)))(fake.handle.bind(fake));
    assert.equal((await tools.call("qml_send_keys", { objectName: "pw", text: "b" })).isError, true);
  });

  test(`a value inside a list that is hidden shows as null, and the reply says that values are hidden (${plugin} plugin)`, async () => {
    const field = passwordField({ props: { echoMode: 2, list: ["plain", SECRET], empty: null } });
    const tools = await start(windowOf([field]).root, { plugin });
    const reply = await tools.call("qml_get_properties", { ref: "e" + field.id, names: ["list", "empty", "text"] });
    noSecret(reply, "get_properties");
    assert.match(text(reply), /^list = \["plain",null\]$/m);
    assert.match(text(reply), /^text = \(hidden\)$/m);
    assert.match(text(reply), /2 values are hidden/);
    // Nothing hidden: no such line.
    assert.doesNotMatch(text(await tools.call("qml_get_properties", { ref: "e" + field.id, names: ["width"] })), /hidden/);
  });
}

// ---------------------------------------------------------------- B8: the bridge and the smaller points

test("when the press request gets no reply, the release is still sent", async () => {
  // A drawer that is a plain item: a click on an element of it is a press, a check and a release.
  const openIt = (f, n) => { n.x = 0; n.props.opened = true; n.props.position = 1; };
  const side = node("Sidebar", { inherits: ITEM, objectName: "side", x: -68, w: 68, h: 600, props: { opened: false, position: 0 }, methods: { open: openIt } },
    [button("Wallet", { objectName: "navWallet", y: 60, w: 42, h: 42 })]);
  const { loadProfile } = await import("../lib/profile.mjs");
  const tools = await start(windowOf([side]).root, { toolset: { profile: loadProfile("status") }, bridgeOptions: { timeoutMs: 300 } });
  fake.noReply = (command, params) => command === "mouse" && params.action === "press";
  const reply = await tools.call("qml_click", { objectName: "navWallet" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /timed out/);
  assert.deepEqual(fake.commands("mouse").map((c) => c.params.action), ["press", "release"]);
});

test("a connection attempt that gets no answer ends after the connect timeout, with a message", async () => {
  const real = net.createConnection;
  const made = [];
  net.createConnection = () => {
    // A socket that never connects, as to a host that drops the packets.
    const socket = new net.Socket();
    socket.destroy = ((destroy) => (...args) => { made.push("destroyed"); return destroy(...args); })(socket.destroy.bind(socket));
    return socket;
  };
  try {
    const slow = new QtBridge({ port: 1, timeoutMs: 5000, connectTimeoutMs: 80 });
    const started = Date.now();
    await assert.rejects(slow.send("getTree", {}), /Cannot connect to the inspector at 127\.0\.0\.1:1 \(no answer in 80 ms\)/);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(made, ["destroyed"]);
  } finally {
    net.createConnection = real;
  }
});

test("a line of the plugin that never ends closes the connection when it passes the limit, and the request fails with the reason", async () => {
  const server = await rawServer((socket) => lines(socket, () => {
    const timer = setInterval(() => socket.write("y".repeat(4000)), 2);
    socket.on("close", () => clearInterval(timer));
  }));
  bridge = new QtBridge({ port: server.port, timeoutMs: 5000, maxLineChars: 50000 });
  const started = Date.now();
  await assert.rejects(bridge.send("getTree", {}), /line of more than 50000 characters/);
  assert.ok(Date.now() - started < 3000);
  assert.equal(bridge.socket, null);
});

test("qml_find_by_property shows a long value cut with its closing quote, and a short one whole", async () => {
  const long = "v".repeat(200);
  const app = windowOf([node("QQuickText", { inherits: TEXT, text: "a", props: { note: long } }), node("QQuickText", { inherits: TEXT, text: "b", y: 30, props: { note: "short" } })]);
  const tools = await start(app.root);
  const reply = text(await tools.call("qml_find_by_property", { property: "note" }));
  assert.match(reply, /note="v{50,60}…"( |$)/m);
  assert.match(reply, /note="short"( |$)/m);
});

test("qml_get_properties with names gives the whole text; without names a long value is cut", async () => {
  const long = "word ".repeat(100).trim(); // 499 characters
  const item = node("QQuickText", { inherits: TEXT, objectName: "message", text: long });
  const tools = await start(windowOf([item]).root);
  const whole = text(await tools.call("qml_get_properties", { objectName: "message", names: ["text"] }));
  assert.ok(whole.includes(JSON.stringify(long)), whole);
  const all = text(await tools.call("qml_get_properties", { objectName: "message" }));
  assert.ok(!all.includes(JSON.stringify(long)));
  assert.match(all, /^text = "word .{150,200}…$/m);
});

// ---------------------------------------------------------------- index.mjs

async function serverChild(vars = {}) {
  const child = spawn(process.execPath, [INDEX], { env: { PATH: process.env.PATH, ...vars }, stdio: ["pipe", "pipe", "pipe"] });
  const state = { stdout: "" };
  child.stdout.on("data", (d) => { state.stdout += d; });
  child.stderr.on("data", () => {});
  const say = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const reply = async (id, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
      const line = state.stdout.split("\n").find((l) => l.includes(`"id":${id}`));
      if (line) return JSON.parse(line);
    }
    return null;
  };
  say({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  say({ method: "notifications/initialized" });
  open.push({ close: () => child.kill("SIGKILL") });
  return { say, reply };
}
const resultText = (message) => (message && message.result ? message.result.content.map((c) => c.text).join("\n") : JSON.stringify(message));

test("index.mjs: QML_INSPECTOR_HOST chooses the address; without it the server connects to 127.0.0.1 only", async () => {
  // The app listens on another loopback address.
  fake = new FakeInspector(windowOf([button("OK")]).root);
  open.push(fake);
  const port = await fake.listen(0, "127.0.0.2");
  const withHost = await serverChild({ QML_INSPECTOR_HOST: "127.0.0.2", QML_INSPECTOR_PORT: String(port) });
  withHost.say({ id: 2, method: "tools/call", params: { name: "qml_snapshot", arguments: {} } });
  assert.match(resultText(await withHost.reply(2)), /QQuickButton "OK"/);
  const without = await serverChild({ QML_INSPECTOR_PORT: String(port) });
  without.say({ id: 2, method: "tools/call", params: { name: "qml_snapshot", arguments: {} } });
  assert.match(resultText(await without.reply(2)), /Cannot connect to the inspector at 127\.0\.0\.1:/);
});

test("index.mjs: QML_INSPECTOR_FILE_DIALOGS=1 turns the choice of a path on; any other value does not", async () => {
  const app = windowOf([]);
  fake = new FakeInspector(app.root);
  open.push(fake);
  const port = await fake.listen();
  const call = { id: 2, method: "tools/call", params: { name: "qml_file_dialog_action", arguments: { objectId: Number(app.content.id), action: "select", path: "/tmp/a.png" } } };
  for (const [value, allowed] of [[undefined, false], ["0", false], ["enabled", false], ["1", true], ["true", true]]) {
    const server = await serverChild({ QML_INSPECTOR_PORT: String(port), ...(value === undefined ? {} : { QML_INSPECTOR_FILE_DIALOGS: value }) });
    server.say(call);
    const message = await server.reply(2);
    assert.equal(message.result.isError === true, !allowed, `value ${value}: ${resultText(message)}`);
  }
});
