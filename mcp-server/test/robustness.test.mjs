// Tests for the second review: drawers while the screen moves, texts next to a text field, reasons the plugin gives
// when it closes a connection, arguments with special names, password fields in lists and while the user types,
// and what happens when the client goes away in the middle of a call.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, execFile } from "node:child_process";

import { FakeInspector, node, add } from "./fake-inspector.mjs";
import { QtBridge } from "../lib/bridge.mjs";
import { createToolset, validateArguments, TOOLS, MAX_REPLY_CHARS } from "../lib/tools.mjs";
import { loadProfile } from "../lib/profile.mjs";

const ITEM = ["QQuickItem", "QObject"];
const BUTTON = ["QQuickButton", "QQuickAbstractButton", "QQuickControl", ...ITEM];
const TEXT = ["QQuickText", ...ITEM];
const TEXT_INPUT = ["QQuickTextField", "QQuickTextInput", "QQuickImplicitSizeItem", ...ITEM];
const WINDOW = ["QQuickWindowQmlImpl", "QQuickWindow", "QWindow", "QObject"];
const INDEX = new URL("../index.mjs", import.meta.url).pathname;
const FRAMEWORK = new URL("../../test-framework/framework.mjs", import.meta.url).href;
const SECRET = "hunter2-Secret!";
const TOKEN = "a-token-of-16-chars";
const STATUS = loadProfile("status");
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

async function start(root, { plugin = "old", toolset = {}, bridgeOptions = {} } = {}) {
  fake = new FakeInspector(root);
  fake.plugin = plugin;
  open.push(fake);
  const port = await fake.listen();
  bridge = new QtBridge({ host: "127.0.0.1", port, timeoutMs: 2000, ...bridgeOptions });
  return createToolset({ bridge, settleIntervalMs: 2, settleTimeoutMs: 60, ...toolset });
}

// A plain TCP server that plays one part of the plugin. onLine(socket, request) answers each request line.
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
const lineWith = (reply, needle) => text(reply).split("\n").find((l) => l.includes(needle));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs one command through the Inspector of test-framework/framework.mjs, in a process of its own.
function framework(vars) {
  const script = `const { Inspector } = await import(${JSON.stringify(FRAMEWORK)});
    const inspector = new Inspector();
    try { const reply = await inspector.send("getTree", { depth: 1 }); console.log(JSON.stringify({ ok: reply.ok === true, error: reply.error || null })); }
    catch (err) { console.log(JSON.stringify({ ok: false, error: err.message })); }
    inspector.disconnect();`;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, QML_INSPECTOR_HOST: "127.0.0.1", ...vars }, timeout: 10000 },
             (err, stdout, stderr) => resolve(stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()) : { ok: false, error: String(err || stderr) }));
  });
}

// ---------------------------------------------------------------- P1: a drawer while the screen moves

// A drawer that is a plain item, closed: it lies left of the window.
function sidebarApp() {
  const openIt = (f, n) => { n.x = 0; n.props.opened = true; n.props.position = 1; };
  const clicked = [];
  const side = node("Sidebar", { inherits: ITEM, objectName: "side", x: -68, w: 68, h: 600, props: { opened: false, position: 0 }, methods: { open: openIt } },
    [node("QQuickButton", { inherits: BUTTON, objectName: "navWallet", text: "Wallet", y: 60, w: 42, h: 42, props: { pressed: false }, onClick: () => clicked.push("navWallet") })]);
  return { ...windowOf([side]), side, clicked };
}
// A text that changes on every read of the tree: the screen never settles.
function addCounter(app) {
  const ticker = add(app.content, node("QQuickText", { inherits: TEXT, objectName: "ticker", text: "0", x: 300, w: 50, h: 20 }));
  let n = 0;
  const handle = fake.handle.bind(fake);
  fake.handle = (command, params) => {
    if (command === "getTree") ticker.identifying.text = String(++n);
    return handle(command, params);
  };
}

for (const plugin of PLUGINS) {
  test(`qml_wait_for finds an element of a closed drawer, also as the first call (${plugin} plugin)`, async () => {
    const app = sidebarApp();
    const tools = await start(app.root, { plugin, toolset: { profile: STATUS } });
    const byName = await tools.call("qml_wait_for", { objectName: "navWallet", timeout_ms: 1000 });
    assert.notEqual(byName.isError, true, text(byName));
    assert.match(text(byName), /objectName="navWallet" \(in closed drawer\)/);
    const byText = await tools.call("qml_wait_for", { text: "Wallet", timeout_ms: 1000 });
    assert.match(text(byText), /objectName="navWallet" \(in closed drawer\)/);
  });

  test(`a drawer that is known stays a drawer while something else on the screen keeps changing (${plugin} plugin)`, async () => {
    const app = sidebarApp();
    const tools = await start(app.root, { plugin, toolset: { profile: STATUS } });
    assert.match(text(await tools.call("qml_snapshot", {})), /navWallet/);
    addCounter(app);
    const asked = fake.commands("getProperties").length;
    const snap = await tools.call("qml_snapshot", {});
    assert.match(text(snap), /Sidebar objectName="side" drawer: closed/);
    assert.match(lineWith(snap, "navWallet") || "", /\(in closed drawer\)$/);
    assert.equal(fake.commands("getProperties").length, asked, "an item was asked for its properties while the screen moved");
    const click = await tools.call("qml_click", { objectName: "navWallet" });
    assert.notEqual(click.isError, true, text(click));
    assert.match(text(click), /opened the drawer first/);
    assert.deepEqual(app.clicked, ["navWallet"]);
  });
}

test("a press is followed by a release also when the check between them fails", async () => {
  const app = sidebarApp();
  const tools = await start(app.root, { plugin: "new", toolset: { profile: STATUS } });
  await tools.call("qml_snapshot", {});
  fake.failCommands = ["getProperties"];
  const reply = await tools.call("qml_click", { objectName: "navWallet" });
  assert.equal(reply.isError, true);
  assert.deepEqual(fake.commands("mouse").map((c) => c.params.action), ["press", "release"]);
});

test("while the screen keeps changing, an item that was never asked is still not asked whether it is a drawer", async () => {
  const app = sidebarApp();
  const tools = await start(app.root, { plugin: "new", toolset: { profile: STATUS } });
  addCounter(app);
  await tools.call("qml_snapshot", {});
  await tools.call("qml_wait_for", { objectName: "nothing", timeout_ms: 30 });
  assert.equal(fake.commands("getProperties").length, 0);
});

// ---------------------------------------------------------------- P2: texts next to a text field

for (const plugin of PLUGINS) {
  test(`a page whose type name holds "Input" does not hide its texts (${plugin} plugin)`, async () => {
    const page = node("PinInputPage_QMLTYPE_3", { inherits: ITEM, w: 800, h: 600 }, [
      node("QQuickText", { inherits: TEXT, text: "Enter your PIN", y: 10, w: 200, h: 20 }),
      node("QQuickText", { inherits: TEXT, text: "3 attempts left", y: 40, w: 200, h: 20 }),
      node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "pin", text: "", y: 80, w: 200, h: 30 }),
      node("QQuickText", { inherits: TEXT, text: "Wrong PIN, try again", y: 120, w: 200, h: 20 }),
      node("QQuickButton", { inherits: BUTTON, text: "OK", y: 160, w: 60, h: 30 }),
    ]);
    const tools = await start(windowOf([page]).root, { plugin });
    const snap = text(await tools.call("qml_snapshot", {}));
    assert.match(snap, /^\[e\d+\] QQuickText "3 attempts left"$/m);
    assert.match(snap, /^\[e\d+\] QQuickText "Wrong PIN, try again"$/m);
    assert.equal(snap.split("\n").filter((l) => l.includes("Enter your PIN")).length, 1, snap);
    const waited = await tools.call("qml_wait_for", { text: "Wrong PIN", timeout_ms: 200 });
    assert.notEqual(waited.isError, true, text(waited));
  });

  test(`a text field with a label shows its other texts as lines, and its label, placeholder and value only once (${plugin} plugin)`, async () => {
    const field = node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "edit", text: "Bob", placeholderText: "Your name", y: 20, w: 300, h: 30 },
      [node("QQuickText", { inherits: TEXT, text: "Your name", w: 200, h: 20 })]);
    const wrapper = node("StatusInput_QMLTYPE_5", { inherits: ITEM, objectName: "nameInput", label: "Name", w: 300, h: 90 }, [
      node("QQuickText", { inherits: TEXT, text: "Name", w: 100, h: 20 }),
      field,
      node("QQuickText", { inherits: TEXT, text: "Bob", y: 20, w: 100, h: 20 }),
      node("QQuickText", { inherits: TEXT, text: "Name is too short", y: 60, w: 200, h: 20 }),
      node("QQuickText", { inherits: TEXT, text: "3/24", x: 250, y: 60, w: 40, h: 20 }),
    ]);
    const tools = await start(windowOf([wrapper]).root, { plugin });
    const snap = text(await tools.call("qml_snapshot", {}));
    assert.match(snap, /^\[e\d+\] StatusInput "Name" objectName="nameInput" value="Bob" placeholder="Your name"$/m);
    assert.match(snap, /^\[e\d+\] QQuickText "Name is too short"$/m);
    assert.match(snap, /^\[e\d+\] QQuickText "3\/24"$/m);
    assert.doesNotMatch(snap, /QQuickText "(Name|Bob|Your name)"/);
    assert.match(snap, /^Window "App" 800x600, 3 elements\.$/m);
  });
}

// ---------------------------------------------------------------- P3: the reason the plugin gives when it closes a connection

test("when the plugin closes the connection with a reason, the user sees the reason", async () => {
  const server = await rawServer((socket) => socket.end(JSON.stringify({ ok: false, error: "Too many connections: at most 8 at a time" }) + "\n"));
  for (const token of ["", TOKEN]) {
    bridge = new QtBridge({ port: server.port, timeoutMs: 1500, token });
    const tools = createToolset({ bridge, settleIntervalMs: 2, settleTimeoutMs: 60 });
    const reply = await tools.call("qml_snapshot", {});
    assert.equal(reply.isError, true);
    assert.match(text(reply), /Too many connections: at most 8 at a time/, `token: ${!!token}`);
    bridge.close();
  }
});

test("a reason that arrives while a request waits is shown too (no token was sent in time)", async () => {
  const server = await rawServer((socket) => lines(socket, () => socket.end(JSON.stringify({ ok: false, error: "Authentication required: no token was sent in time" }) + "\n")));
  bridge = new QtBridge({ port: server.port, timeoutMs: 1500 });
  await assert.rejects(bridge.send("getTree", {}), /no token was sent in time/);
});

test("framework.mjs shows the reason the plugin gives when it closes the connection", async () => {
  const server = await rawServer((socket) => socket.end(JSON.stringify({ ok: false, error: "Too many connections: at most 8 at a time" }) + "\n"));
  const reply = await framework({ QML_INSPECTOR_PORT: String(server.port) });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Too many connections: at most 8 at a time/);
  const withToken = await framework({ QML_INSPECTOR_PORT: String(server.port), QML_INSPECTOR_TOKEN: TOKEN });
  assert.match(withToken.error, /Too many connections: at most 8 at a time/);
});

// ---------------------------------------------------------------- the connection: tests that were missing

test("a request that waits fails at once when the connection closes, not after the timeout", async () => {
  const server = await rawServer((socket) => lines(socket, () => socket.destroy()));
  bridge = new QtBridge({ port: server.port, timeoutMs: 5000 });
  const started = Date.now();
  await assert.rejects(bridge.send("getTree", {}), /Connection closed/);
  assert.ok(Date.now() - started < 1500, `it took ${Date.now() - started} ms`);
});

test("after a refused token the client closes its connection, also when the plugin leaves it open", async () => {
  const server = await rawServer((socket) => lines(socket, (request) => socket.write(JSON.stringify({ id: request.id, error: "Authentication failed: wrong token" }) + "\n")));
  bridge = new QtBridge({ port: server.port, timeoutMs: 1500, token: TOKEN });
  await assert.rejects(bridge.send("getTree", {}), /did not accept the token/);
  await sleep(100);
  assert.equal(server.sockets.size, 0, "the connection stayed open");
});

// ---------------------------------------------------------------- P7: a token here, none in the app

test("a client with a token refuses an app that was started without one, and sends it no command", async () => {
  const tools = await start(windowOf([node("QQuickButton", { inherits: BUTTON, text: "OK" })]).root, { plugin: "new", bridgeOptions: { token: TOKEN } });
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(reply.isError, true);
  assert.match(text(reply), /the app was started without a token/);
  assert.match(text(reply), /QML_INSPECTOR_TOKEN/);
  assert.ok(!text(reply).includes(TOKEN));
  assert.equal(fake.log.length, 0);
  await sleep(50);
  assert.equal(fake.sockets.size, 0);
});

test("framework.mjs refuses an app that was started without a token when a token is set", async () => {
  await start(windowOf([]).root, { plugin: "new" });
  const reply = await framework({ QML_INSPECTOR_PORT: String(fake.server.address().port), QML_INSPECTOR_TOKEN: TOKEN });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /the app was started without a token/);
  assert.equal(fake.log.length, 0);
});

// ---------------------------------------------------------------- P6: argument names that every object has

test("argument names that every JavaScript object has are refused like any unknown argument", async () => {
  const tools = await start(windowOf([node("QQuickText", { inherits: TEXT, text: "Hello", w: 50, h: 20 })]).root);
  const snapshot = TOOLS.find((t) => t.name === "qml_snapshot");
  for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
    const args = JSON.parse(`{${JSON.stringify(name)}: "x"}`);
    assert.throws(() => validateArguments(snapshot, args), new RegExp(`has no argument "${name}"`), name);
    const reply = await tools.call("qml_screenshot", args);
    assert.equal(reply.isError, true, name);
  }
  assert.equal(fake.commands("screenshot").length, 0);
  const args = JSON.parse('{"text":"nope","__proto__":{"timeout_ms":"abc"}}');
  const reply = await Promise.race([tools.call("qml_wait_for", args), sleep(2000).then(() => "still running")]);
  assert.notEqual(reply, "still running");
  assert.equal(reply.isError, true);
  assert.match(text(reply), /has no argument "__proto__"/);
});

test("qml_wait_for keeps its timeout inside 0 and the upper limit", async () => {
  const tools = await start(windowOf([node("QQuickText", { inherits: TEXT, text: "Hello", w: 50, h: 20 })]).root, { toolset: { maxWaitMs: 40 } });
  const low = await tools.call("qml_wait_for", { text: "nope", timeout_ms: -500 });
  assert.match(text(low), /after 0 ms/);
  const started = Date.now();
  const high = await Promise.race([tools.call("qml_wait_for", { text: "nope", timeout_ms: 600000 }), sleep(3000).then(() => null)]);
  assert.ok(high, "the wait did not end");
  assert.match(text(high), /after 40 ms/);
  assert.ok(Date.now() - started < 2000);
});

// ---------------------------------------------------------------- password fields: tests that were missing, lists, typing

function passwordApp() {
  const field = node("QQuickTextField", { inherits: TEXT_INPUT, objectName: "pw", text: SECRET, y: 80, w: 200, h: 30,
    props: { echoMode: 2, displayText: "•••••", selectedText: "hunter2", preeditText: "Secr", list: [SECRET, "plain"], obj: { a: SECRET, b: ["x", SECRET] } } });
  const wrapper = node("PasswordInput_QMLTYPE_9", { inherits: ITEM, objectName: "pwWrap", text: SECRET, label: "Password", w: 300, h: 120 }, [field]);
  const button = node("QQuickButton", { inherits: BUTTON, objectName: "ok", text: "OK", y: 400, w: 60, h: 30 });
  return { ...windowOf([wrapper, button]), field, wrapper };
}
const noSecret = (reply, what) => assert.ok(!/hunter2|Secret!|"Secr"/.test(JSON.stringify(reply.content)), `${what} shows the password: ${text(reply).slice(0, 300)}`);

for (const plugin of PLUGINS) {
  test(`qml_get_properties of a password field hides every property that holds typed text (${plugin} plugin)`, async () => {
    const app = passwordApp();
    const tools = await start(app.root, { plugin });
    for (const args of [{ ref: "e" + app.field.id }, { ref: "e" + app.field.id, names: ["text", "displayText", "selectedText", "preeditText"] }, { objectName: "pw", details: true }]) {
      const reply = await tools.call("qml_get_properties", args);
      noSecret(reply, JSON.stringify(args));
      for (const name of ["text", "displayText", "selectedText", "preeditText"]) assert.match(text(reply), new RegExp(`^${name}(: \\w+)? = \\(hidden\\)`, "m"), name);
    }
  });

  test(`a password inside a list or a map is hidden in qml_find_by_property and qml_get_properties, and is not found by value (${plugin} plugin)`, async () => {
    const app = passwordApp();
    const tools = await start(app.root, { plugin });
    for (const property of ["list", "obj"]) {
      const found = await tools.call("qml_find_by_property", { property });
      noSecret(found, `find ${property}`);
      // Inside a list or a map a hidden value is null, and a line says that values are hidden.
      assert.match(text(found), /null/);
      assert.match(text(found), /values? (is|are) hidden/);
    }
    noSecret(await tools.call("qml_get_properties", { ref: "e" + app.field.id, names: ["list", "obj"] }), "get_properties");
    const byValue = await tools.call("qml_find_by_property", { property: "list", value: [SECRET, "plain"] });
    // The reply repeats only what the caller sent; it does not say that the value is right.
    assert.equal(byValue.isError, true, text(byValue));
    assert.match(text(byValue), /^No object with the property "list"/);
  });

  test(`qml_list_file_dialogs hides a text that equals what a password field holds (${plugin} plugin)`, async () => {
    const app = passwordApp();
    const tools = await start(app.root, { plugin });
    fake.dialogs = [node("QQuickFileDialog", { inherits: ["QQuickAbstractDialog", "QObject"], objectName: "openDialog", title: "Open" },
      [node("QQuickText", { inherits: TEXT, objectName: "lastTyped", text: SECRET })])];
    const reply = await tools.call("qml_list_file_dialogs", {});
    assert.match(text(reply), /openDialog/);
    assert.match(text(reply), /lastTyped/);
    noSecret(reply, "the list of dialogs");
  });
}

test("qml_send_keys without a target does not repeat what was typed", async () => {
  const app = passwordApp();
  const tools = await start(app.root);
  fake.focus = app.field.id;
  const reply = await tools.call("qml_send_keys", { text: "typed-Words" });
  assert.notEqual(reply.isError, true, text(reply));
  assert.match(text(reply), /Sent 11 characters to the element that has the focus/);
  assert.ok(!text(reply).includes("typed-Words"));
});

// With a plugin before 2.0 the tree and the search for password fields are two requests. The user can type between them:
// the copy of the text in the wrapper is then older than the text the search finds.
test("old plugin: a wrapper's copy of the password is hidden also when the user types between the two requests", async () => {
  const app = passwordApp();
  // A text elsewhere on the screen that repeats what is typed.
  const mirror = add(app.content, node("QQuickText", { inherits: TEXT, objectName: "mirror", text: SECRET, y: 300, w: 200, h: 20 }));
  const tools = await start(app.root, { toolset: { unlimitedTools: true } });
  const copies = [app.field, app.wrapper, mirror];
  const type = () => { for (const n of copies) n.identifying.text += "X"; };
  const handle = fake.handle.bind(fake);
  let typeOn = () => false;
  fake.handle = (command, params) => {
    if (typeOn(command, params)) type();
    return handle(command, params);
  };
  const reset = () => { for (const n of copies) n.identifying.text = SECRET; };

  // The user types after the tree was read and before the search.
  typeOn = (command, params) => command === "findByProperty" && params.property === "echoMode";
  for (const [name, args] of [["qml_snapshot", {}], ["qml_get_tree", { depth: 30 }], ["qml_wait_for", { objectName: "pwWrap", timeout_ms: 100 }]]) {
    reset();
    noSecret(await tools.call(name, args), name);
  }
  // The user types on every read of the wrapper: nothing may be shown.
  typeOn = (command) => command === "getProperties";
  reset();
  const never = await tools.call("qml_get_properties", { objectName: "pwWrap" });
  noSecret(never, "qml_get_properties while typing");
  assert.equal(never.isError, true);
  assert.match(text(never), /password field is changing/);
  // The user types once: the read is made again and the copy is hidden.
  let reads = 0;
  typeOn = (command) => command === "getProperties" && ++reads === 2;
  reset();
  const once = await tools.call("qml_get_properties", { objectName: "pwWrap", names: ["text", "label"] });
  noSecret(once, "qml_get_properties after one key");
  assert.notEqual(once.isError, true, text(once));
  assert.match(text(once), /^text = \(hidden\)$/m);
  assert.match(text(once), /^label = "Password"$/m);
});

test("old plugin: a method that returns the password and empties the field does not show it, also as the first call", async () => {
  const app = passwordApp();
  app.field.methods.takeText = (f, n) => { const had = n.identifying.text; n.identifying.text = ""; app.wrapper.identifying.text = ""; return had; };
  const tools = await start(app.root, { toolset: { unlimitedTools: true } });
  const reply = await tools.call("qml_call_method", { ref: "e" + app.field.id, method: "takeText" });
  assert.notEqual(reply.isError, true, text(reply));
  assert.match(text(reply), /Result: null\n1 value is hidden/);
  noSecret(reply, "the result of the method");
});

// ---------------------------------------------------------------- P5: a closed Qt Quick Drawer and items the app hides

test("an element that the app hides inside a Qt Quick Drawer is not clicked after the drawer was opened", async () => {
  const app = windowOf([], 400, 800);
  const drawer = node("QQuickDrawer", { inherits: ["QQuickDrawer", "QQuickPopup", "QObject"], objectName: "menu", props: { opened: false, modal: false, visible: false } });
  const clicked = [];
  const item = (name, label, y) => node("QQuickItemDelegate", { inherits: BUTTON, objectName: name, text: label, y, w: 240, h: 48, visible: false, props: { pressed: false }, onClick: () => clicked.push(name) });
  const shownItem = item("navHome", "Home", 0), hiddenItem = item("navAdmin", "Admin", 48);
  const popupItem = node("QQuickPopupItem", { inherits: ["QQuickPage", "QQuickControl", ...ITEM], x: -240, w: 240, h: 800, visible: false }, [shownItem, hiddenItem]);
  // When the drawer opens, the items the app shows become visible. navAdmin stays hidden (visible: false in the app).
  drawer.methods.open = (f) => { f.remove(popupItem); add(app.overlay, popupItem); popupItem.owner = drawer; popupItem.x = 0; popupItem.visible = true; shownItem.visible = true; drawer.props.opened = true; };
  add(drawer, popupItem);
  add(app.win, drawer);
  const tools = await start(app.root, { plugin: "new" });
  const reply = await tools.call("qml_click", { objectName: "navAdmin" });
  assert.equal(reply.isError, true, text(reply));
  assert.match(text(reply), /not visible in the open drawer/);
  assert.match(text(reply), /Nothing was clicked/);
  assert.deepEqual(clicked, []);
  assert.equal(fake.commands("mouse").length + fake.commands("click").length, 0);
});

// ---------------------------------------------------------------- P10: a tree near the size limit

test("qml_get_tree returns the whole tree when it fits without the line breaks, and says nothing was cut", async () => {
  const rows = Array.from({ length: 12 }, (_, k) => node("QQuickItem", { inherits: ITEM, objectName: `row${k}`, y: k * 20 }, [node("QQuickText", { inherits: TEXT, objectName: `leaf${k}`, text: `Leaf ${k}` })]));
  const tools = await start(windowOf([node("QQuickItem", { inherits: ITEM, objectName: "list" }, rows)]).root);
  const raw = await bridge.send("getTree", { depth: 30 });
  delete raw.id;
  assert.ok(JSON.stringify(raw, null, 2).length > MAX_REPLY_CHARS, "the test tree is too small");
  assert.ok(JSON.stringify(raw).length <= MAX_REPLY_CHARS, "the test tree is too large");
  const reply = await tools.call("qml_get_tree", { depth: 30 });
  assert.notEqual(reply.isError, true);
  assert.equal(reply.content.length, 1, "a note says the tree was cut");
  assert.ok(reply.content[0].text.length <= MAX_REPLY_CHARS);
  assert.match(reply.content[0].text, /leaf11/);
  JSON.parse(reply.content[0].text);
});

// ---------------------------------------------------------------- index.mjs: settings and the end of the process

async function serverChild(vars = {}) {
  const child = spawn(process.execPath, [INDEX], { env: { PATH: process.env.PATH, QML_INSPECTOR_HOST: "127.0.0.1", ...vars }, stdio: ["pipe", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => { state.stdout += d; });
  child.stderr.on("data", (d) => { state.stderr += d; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const say = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const until = async (test, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (test()) return true; return false; };
  const exit = (ms = 4000) => Promise.race([exited, sleep(ms).then(() => "still running")]).finally(() => child.kill("SIGKILL"));
  const hello = () => {
    say({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    say({ method: "notifications/initialized" });
  };
  return { child, state, say, until, exit, hello };
}

test("index.mjs: a timeout or a port that is not a number stops the server with a message", async () => {
  for (const [name, value] of [["QML_INSPECTOR_TIMEOUT", "abc"], ["QML_INSPECTOR_TIMEOUT", "0"], ["QML_INSPECTOR_TIMEOUT", "-5"], ["QML_INSPECTOR_PORT", "abc"], ["QML_INSPECTOR_PORT", "70000"]]) {
    const server = await serverChild({ QML_INSPECTOR_PORT: "3768", [name]: value });
    const end = await server.exit(3000);
    assert.equal(end.code, 1, `${name}=${value}: ${JSON.stringify(end)}`);
    assert.match(server.state.stderr, new RegExp(`${name} `));
  }
});

test("index.mjs: SIGTERM, SIGINT and SIGHUP end the server with exit code 0 and close the connection to the app", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    await start(windowOf([node("QQuickButton", { inherits: BUTTON, objectName: "ok", text: "OK" })]).root);
    const server = await serverChild({ QML_INSPECTOR_PORT: String(fake.server.address().port) });
    server.hello();
    server.say({ id: 2, method: "tools/call", params: { name: "qml_snapshot", arguments: {} } });
    assert.ok(await server.until(() => server.state.stdout.includes('"id":2')), "no answer");
    assert.equal(fake.sockets.size, 1);
    server.child.kill(signal);
    const end = await server.exit();
    assert.deepEqual(end, { code: 0, signal: null }, signal);
    await sleep(50);
    assert.equal(fake.sockets.size, 0, signal);
  }
});

test("index.mjs: when the client goes away between press and release, the release is still sent", async () => {
  for (const how of ["stdin closed", "SIGTERM"]) {
    const app = sidebarApp();
    await start(app.root, { plugin: "new" });
    const server = await serverChild({ QML_INSPECTOR_PORT: String(fake.server.address().port), QML_INSPECTOR_PROFILE: "status" });
    // The client goes away at the moment the press arrives in the app.
    const handle = fake.handle.bind(fake);
    fake.handle = (command, params) => {
      if (command === "mouse" && params.action === "press") { if (how === "SIGTERM") server.child.kill("SIGTERM"); else server.child.stdin.end(); }
      return handle(command, params);
    };
    fake.delayMs = 15;
    server.hello();
    server.say({ id: 2, method: "tools/call", params: { name: "qml_click", arguments: { objectName: "navWallet" } } });
    const end = await server.exit(8000);
    assert.deepEqual(end, { code: 0, signal: null }, how);
    assert.deepEqual(fake.commands("mouse").map((c) => c.params.action), ["press", "release"], how);
    await sleep(50);
    assert.equal(fake.sockets.size, 0, how);
  }
});

test("index.mjs: a wait that is running ends when the client goes away", async () => {
  await start(windowOf([node("QQuickButton", { inherits: BUTTON, objectName: "ok", text: "OK" })]).root);
  const server = await serverChild({ QML_INSPECTOR_PORT: String(fake.server.address().port) });
  server.hello();
  server.say({ id: 2, method: "tools/call", params: { name: "qml_wait_for", arguments: { text: "never", timeout_ms: 30000 } } });
  assert.ok(await server.until(() => fake.commands("getTree").length >= 2), "the wait did not start");
  server.child.stdin.end();
  const end = await server.exit(4000);
  assert.deepEqual(end, { code: 0, signal: null });
});
