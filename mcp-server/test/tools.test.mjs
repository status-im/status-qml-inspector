// Tests for the MCP tools. They run against a fake inspector on a local socket: no app is needed.
// Run: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { FakeInspector, node, add } from "./fake-inspector.mjs";
import { QtBridge } from "../lib/bridge.mjs";
import { createToolset, MAX_REPLY_CHARS } from "../lib/tools.mjs";

const BUTTON = ["QQuickButton", "QQuickAbstractButton", "QQuickControl", "QQuickItem", "QObject"];
const ITEM = ["QQuickItem", "QObject"];
const LIST = ["QQuickListView", "QQuickItemView", "QQuickFlickable", "QQuickItem", "QObject"];
const POPUP = ["QQuickDialog", "QQuickPopup", "QObject"];

let fake, bridge, tools, app;

function button(name, text, opts = {}) {
  return node("StatusButton_QMLTYPE_42", { inherits: BUTTON, objectName: name, text, w: 80, h: 30, ...opts }, [
    node("QQuickLoader", { inherits: ITEM, objectName: "rightTextLoader" }, [
      node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], objectName: "buttonText", text }),
    ]),
    node("QQuickRectangle", { inherits: ITEM, objectName: "buttonBackground", w: 80, h: 30 }),
  ]);
}

function menuItem(key, title, y) {
  return node("StatusNavigationListItem_QMLTYPE_9", { inherits: ITEM, objectName: `${key}-MenuItem`, title, y, w: 200, h: 50 }, [
    node("StatusMouseArea_QMLTYPE_3", { inherits: ["QQuickMouseArea", ...ITEM], objectName: `${key}-MenuItem_sensor`, w: 200, h: 50 }),
    node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], text: title, x: 40, y: 15 }),
  ]);
}

// A window with a page of typical controls, a scrollable menu and an empty overlay for popups.
function buildApp() {
  const titles = ["Profile", "Password", "Messaging", "Wallet", "Browser", "Communities", "Privacy", "Appearance", "Notifications", "Language", "Advanced", "About"];
  const listContent = node("QQuickItem", { inherits: ITEM, w: 200, h: 600 }, titles.map((t, k) => menuItem(k, t, k * 50)));
  const list = node("SettingsList_QMLTYPE_5", { inherits: LIST, objectName: "settingsList", x: 0, y: 100, w: 200, h: 200,
                                                 props: { contentY: 0, contentX: 0, contentHeight: 600, contentWidth: 200, originY: 0, originX: 0 } }, [listContent]);
  const editor = node("QQuickTextEdit", { inherits: ["QQuickTextEdit", ...ITEM], text: "", w: 300, h: 40 });
  const nameInput = node("StatusInput_QMLTYPE_11", { inherits: ITEM, objectName: "displayNameInput", x: 300, y: 100, w: 300, h: 70 }, [
    node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], text: "Display name" }),
    node("StatusBaseInput_QMLTYPE_12", { inherits: ITEM, objectName: "statusBaseInput", placeholderText: "Your name", y: 30, w: 300, h: 40 }, [
      editor,
      node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], text: "Your name", w: 300, h: 40 }),
    ]),
  ]);
  const page = node("QQuickItem", { inherits: ITEM, objectName: "page", w: 800, h: 600 }, [
    node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], objectName: "sectionTitle", text: "Profile", x: 300, y: 20, w: 200, h: 30 }),
    button("btnSave", "Save", { x: 650, y: 20 }),
    node("StatusRoundButton_QMLTYPE_13", { inherits: BUTTON, objectName: "addAccountButton", x: 250, y: 20, w: 40, h: 40 }, [
      node("StatusIcon_QMLTYPE_2", { inherits: ITEM, objectName: "add-circle-icon", w: 24, h: 24 }),
    ]),
    nameInput,
    button("btnHidden", "Hidden", { x: 300, y: 300, visible: false }),
    button("btnDisabled", "Disabled thing", { x: 300, y: 340, enabled: false }),
    node("StatusTabButton_QMLTYPE_14", { inherits: ["QQuickTabButton", ...BUTTON], objectName: "communitiesTabButton", text: "Communities", x: 300, y: 60, w: 90, h: 30,
                                         props: { checked: true } }, [
      node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], text: "Communities", w: 90, h: 20 }),
    ]),
    node("StatusSwitch_QMLTYPE_15", { inherits: ["QQuickSwitch", ...BUTTON], objectName: "mySwitch", x: 300, y: 400, w: 60, h: 36, props: { checked: false } }),
    list,
  ]);
  const overlay = node("QQuickOverlay", { inherits: ITEM, w: 800, h: 600 });
  const content = node("QQuickRootItem", { inherits: ITEM, w: 800, h: 600 }, [page, overlay]);
  const win = node("QQuickWindowQmlImpl_QML_186", { inherits: ["QQuickWindowQmlImpl", "QQuickWindow", "QWindow", "QObject"], objectName: "mainWindow", title: "Test App", w: 800, h: 600 }, [content]);
  const root = node("QGuiApplication", { objectName: "Test App" }, [win]);
  return { root, win, page, overlay, list, listContent, editor, nameInput };
}

// Opens a modal popup the way Qt Quick does: the popup item is a child of the overlay, the popup object owns it.
function openModal(title = "Add a new account") {
  const closeButton = node("StatusFlatRoundButton_QMLTYPE_20", { inherits: BUTTON, objectName: "headerCloseButton", x: 350, y: 10, w: 32, h: 32 }, [
    node("StatusIcon_QMLTYPE_2", { inherits: ITEM, objectName: "close-icon", w: 24, h: 24 }),
  ]);
  const contentItem = node("QQuickItem", { inherits: ITEM, w: 400, h: 300 }, [
    node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], objectName: "headerTitle", text: title, x: 16, y: 16 }),
    closeButton,
    button("popupPrimaryButton", "Add account", { x: 250, y: 250 }),
  ]);
  const popupItem = node("QQuickPopupItem", { inherits: ["QQuickPage", "QQuickPane", "QQuickControl", ...ITEM], x: 200, y: 150, w: 400, h: 300 }, [contentItem]);
  const popup = node("AddAccountPopup_QMLTYPE_30", { inherits: POPUP, objectName: "", title, props: { opened: true, modal: true, visible: true, contentItem: { objectRef: contentItem.id, type: "QQuickItem" } } });
  add(app.overlay, popupItem);
  add(popupItem, popup);
  return { popup, popupItem, closeButton };
}

beforeEach(async () => {
  app = buildApp();
  fake = new FakeInspector(app.root);
  const port = await fake.listen();
  bridge = new QtBridge({ host: "127.0.0.1", port, timeoutMs: 2000 });
  tools = createToolset({ bridge, settleIntervalMs: 5, settleTimeoutMs: 80, unlimitedTools: true });
});

afterEach(async () => {
  bridge.close();
  await fake.close();
});

const text = (reply) => reply.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const lineWith = (reply, needle) => text(reply).split("\n").find((l) => l.includes(needle));
const refOf = (reply, needle) => {
  const line = lineWith(reply, needle);
  assert.ok(line, `no line with ${needle} in:\n${text(reply)}`);
  return line.match(/\[(e\d+)\]/)[1];
};

// ---------------------------------------------------------------- snapshot

test("snapshot: one line and one reference per element, with label and objectName", async () => {
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(reply.isError, undefined);
  const save = lineWith(reply, "objectName=btnSave");
  assert.match(save, /^\[e\d+\] StatusButton "Save" objectName=btnSave$/);
  // The label inside the button is part of the button's line, not a line of its own.
  assert.equal(text(reply).split("\n").filter((l) => l.includes('"Save"')).length, 1);
  assert.ok(!text(reply).includes("buttonBackground"));
});

test("snapshot: the reference is the plugin's object id, so the old objectId tools take it too", async () => {
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(refOf(reply, "objectName=btnSave"), "e" + fake.byName("btnSave").id);
});

test("snapshot: plain texts are listed", async () => {
  const reply = await tools.call("qml_snapshot", {});
  assert.match(lineWith(reply, "objectName=sectionTitle"), /^\[e\d+\] StatusBaseText "Profile" objectName=sectionTitle$/);
});

test("snapshot: text fields are listed with value and placeholder", async () => {
  app.editor.identifying.text = "alice";
  const reply = await tools.call("qml_snapshot", {});
  const line = lineWith(reply, "objectName=displayNameInput");
  assert.match(line, /StatusInput "Display name" objectName=displayNameInput value="alice" placeholder="Your name"/);
  // One line for the field, not one per wrapper, and its reference is the editor itself.
  assert.ok(!text(reply).includes("statusBaseInput"));
  assert.equal(refOf(reply, "objectName=displayNameInput"), "e" + app.editor.id);
});

test("snapshot: hidden elements are left out, disabled and checked ones are marked", async () => {
  const reply = await tools.call("qml_snapshot", {});
  assert.ok(!text(reply).includes("btnHidden"));
  assert.match(lineWith(reply, "btnDisabled"), /disabled/);
  assert.match(lineWith(reply, "communitiesTabButton"), /checked/);
  assert.doesNotMatch(lineWith(reply, "mySwitch"), /checked/);
});

test("snapshot: a button without text shows its objectName and icon", async () => {
  const reply = await tools.call("qml_snapshot", {});
  assert.match(lineWith(reply, "addAccountButton"), /StatusRoundButton objectName=addAccountButton icon=add-circle/);
});

test("snapshot: a control without text inside a row is named after the row", async () => {
  add(app.page, node("StatusListItem_QMLTYPE_40", { inherits: ITEM, objectName: "gifRow", title: "Allow show GIF previews", x: 300, y: 450, w: 400, h: 60 }, [
    node("StatusSwitch_QMLTYPE_15", { inherits: ["QQuickSwitch", ...BUTTON], x: 330, y: 12, w: 60, h: 36 }),
  ]));
  const reply = await tools.call("qml_snapshot", {});
  assert.match(lineWith(reply, "StatusSwitch in"), /^\[e\d+\] StatusSwitch in "Allow show GIF previews"$/);
});

test("snapshot: a list with more rows than fit is marked scrollable, with its position", async () => {
  const reply = await tools.call("qml_snapshot", {});
  assert.match(lineWith(reply, "objectName=settingsList"), /SettingsList objectName=settingsList scrollable: contentY=0 of 0\.\.400, more below$/);
  const miss = await tools.call("qml_click", { text: "Export gizmo" });
  assert.match(text(miss), /qml_scroll/);
  assert.ok(lineWith(miss, "objectName=settingsList"));
});

test("snapshot: a list row with a mouse area is one line; rows scrolled out of view are marked", async () => {
  const reply = await tools.call("qml_snapshot", {});
  assert.match(lineWith(reply, "0-MenuItem"), /StatusNavigationListItem "Profile" objectName=0-MenuItem$/);
  assert.ok(!text(reply).includes("_sensor"));
  assert.match(lineWith(reply, "11-MenuItem"), /"About" objectName=11-MenuItem \(not in view\)/);
});

test("snapshot: with a modal popup open, only the popup is listed", async () => {
  openModal();
  const reply = await tools.call("qml_snapshot", {});
  assert.match(text(reply), /Modal popup is open: AddAccountPopup "Add a new account"/);
  assert.match(lineWith(reply, "headerCloseButton"), /icon=close/);
  assert.ok(!text(reply).includes("btnSave"));
});

test("snapshot: a large screen is cut at the limit, with a note on how to narrow it", async () => {
  for (let k = 0; k < 600; k++) add(app.page, button(`bulk${k}`, `Bulk button number ${k}`, { x: 10, y: 10 }));
  const reply = await tools.call("qml_snapshot", {});
  assert.ok(text(reply).length <= MAX_REPLY_CHARS, `reply has ${text(reply).length} characters`);
  assert.match(text(reply), /more lines? not shown/);
  assert.match(text(reply), /filter/);
  const narrowed = await tools.call("qml_snapshot", { filter: "number 599" });
  assert.ok(lineWith(narrowed, "bulk599"));
  assert.ok(!text(narrowed).includes("not shown"));
});

test("list_interactive keeps its name and gives the compact list without plain texts", async () => {
  const reply = await tools.call("qml_list_interactive", {});
  assert.match(lineWith(reply, "objectName=btnSave"), /^\[e\d+\] StatusButton "Save" objectName=btnSave$/);
  assert.ok(!text(reply).includes("sectionTitle"));
});

// ---------------------------------------------------------------- click

test("click by reference clicks that object and returns what changed", async () => {
  const snap = await tools.call("qml_snapshot", {});
  const ref = refOf(snap, "objectName=btnSave");
  fake.byName("btnSave").onClick = (f) => { f.byName("sectionTitle").identifying.text = "Saved!"; };
  const reply = await tools.call("qml_click", { ref });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("click").map((c) => c.params.objectId), [fake.byName("btnSave").id]);
  assert.match(text(reply), /Clicked \[e\d+\] StatusButton "Save"/);
  assert.match(lineWith(reply, "sectionTitle"), /^changed: \[e\d+\] StatusBaseText "Saved!"/);
  // Only the changed line comes back, not the whole screen.
  assert.ok(!text(reply).includes("addAccountButton"));
});

test("click that changes nothing says so", async () => {
  const reply = await tools.call("qml_click", { objectName: "btnSave" });
  assert.match(text(reply), /Nothing on the screen changed/);
});

test("click by objectId still works and is checked the same way", async () => {
  const reply = await tools.call("qml_click", { objectId: fake.byName("btnSave").id });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("click").map((c) => c.params.objectId), [fake.byName("btnSave").id]);
  const gone = await tools.call("qml_click", { objectId: "99999" });
  assert.equal(gone.isError, true);
});

test("click by x,y is passed to the plugin unchanged", async () => {
  const reply = await tools.call("qml_click", { x: 10, y: 20 });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("click").map((c) => c.params), [{ x: 10, y: 20 }]);
  assert.equal(JSON.parse(text(reply)).clicked, true);
});

test("click by objectName: one match is clicked", async () => {
  const reply = await tools.call("qml_click", { objectName: "addAccountButton" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("click").map((c) => c.params.objectId), [fake.byName("addAccountButton").id]);
});

test("click by objectName: no match is an error and nothing is clicked", async () => {
  const reply = await tools.call("qml_click", { objectName: "noSuchThing" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /No visible object with objectName "noSuchThing"/);
  assert.equal(fake.commands("click").length, 0);
});

test("click by objectName: an object that exists but is hidden is reported as hidden", async () => {
  const reply = await tools.call("qml_click", { objectName: "btnHidden" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /not visible/);
  assert.equal(fake.commands("click").length, 0);
});

test("click by objectName: two matches are an error that lists both, and nothing is clicked", async () => {
  add(app.page, button("btnSave", "Save as", { x: 650, y: 60 }));
  const reply = await tools.call("qml_click", { objectName: "btnSave" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /2 visible objects/);
  assert.equal(text(reply).split("\n").filter((l) => /^\[e\d+\]/.test(l)).length, 2);
  assert.equal(fake.commands("click").length, 0);
});

test("click by text: a unique text is clicked; the label inside a button does not count twice", async () => {
  const reply = await tools.call("qml_click", { text: "Save" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("click").map((c) => c.params.objectId), [fake.byName("btnSave").id]);
});

test("click by text: a text on two clickable elements is an error and nothing is clicked", async () => {
  // "Communities" is a tab button and a row of the menu.
  const reply = await tools.call("qml_click", { text: "Communities" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /2 elements have the text/);
  assert.ok(lineWith(reply, "communitiesTabButton"));
  assert.ok(lineWith(reply, "5-MenuItem"));
  assert.equal(fake.commands("click").length, 0);
});

test("click by text: no match is an error and nothing is clicked", async () => {
  const reply = await tools.call("qml_click", { text: "Export gizmo" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /No element with the text "Export gizmo"/);
  assert.equal(fake.commands("click").length, 0);
});

test("click by text: the match is exact; a partial match is offered but not clicked", async () => {
  const reply = await tools.call("qml_click", { text: "Sav" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /contain/i);
  assert.ok(lineWith(reply, "btnSave"));
  assert.equal(fake.commands("click").length, 0);
});

test("click by text: one clickable element wins over a plain text with the same words", async () => {
  // "Profile" is the page title (plain text) and a row of the menu.
  const reply = await tools.call("qml_click", { text: "Profile" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("click").map((c) => c.params.objectId), [fake.byName("0-MenuItem").id]);
});

test("click needs exactly one way to name the target", async () => {
  assert.equal((await tools.call("qml_click", {})).isError, true);
  assert.equal((await tools.call("qml_click", { ref: "e1", text: "Save" })).isError, true);
  assert.equal(fake.commands("click").length, 0);
});

test("click with a stale reference is an error and nothing is clicked", async () => {
  const snap = await tools.call("qml_snapshot", {});
  const ref = refOf(snap, "objectName=btnSave");
  fake.remove(fake.byName("btnSave"));
  const reply = await tools.call("qml_click", { ref });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /no longer exists/);
  assert.match(text(reply), /qml_snapshot/);
  assert.equal(fake.commands("click").length, 0);
});

test("click with a reference to an element that got hidden is an error", async () => {
  const snap = await tools.call("qml_snapshot", {});
  const ref = refOf(snap, "objectName=btnSave");
  fake.byName("btnSave").visible = false;
  const reply = await tools.call("qml_click", { ref });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /not visible/);
  assert.equal(fake.commands("click").length, 0);
});

test("click on a disabled element is an error", async () => {
  const reply = await tools.call("qml_click", { objectName: "btnDisabled" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /disabled/);
  assert.equal(fake.commands("click").length, 0);
});

test("click on an element behind a modal popup is an error", async () => {
  openModal();
  const reply = await tools.call("qml_click", { objectName: "btnSave" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /popup/);
  assert.equal(fake.commands("click").length, 0);
});

test("click inside a modal popup works, and the reply shows the page again after it closes", async () => {
  const { popupItem, closeButton } = openModal();
  closeButton.onClick = (f) => f.remove(popupItem);
  const reply = await tools.call("qml_click", { objectName: "headerCloseButton" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.ok(!text(reply).includes("Modal popup is open"));
  assert.ok(lineWith(reply, "btnSave"));
});

test("click on a row that is scrolled out of view scrolls the list first", async () => {
  const reply = await tools.call("qml_click", { text: "About" });
  assert.equal(reply.isError, undefined, text(reply));
  const set = fake.commands("setProperty").find((c) => c.params.property === "contentY");
  assert.ok(set, "the list was not scrolled");
  assert.equal(set.params.objectId, app.list.id);
  assert.equal(set.params.value, 400);
  const order = fake.log.map((e) => e.command).filter((c) => c === "setProperty" || c === "click");
  assert.deepEqual(order, ["setProperty", "click"]);
  assert.equal(fake.commands("click")[0].params.objectId, fake.byName("11-MenuItem").id);
  assert.match(text(reply), /scrolled/i);
});

test("click waits until the screen stops moving", async () => {
  const save = fake.byName("btnSave");
  let reads = 0;
  const original = fake.handle.bind(fake);
  fake.handle = (command, params) => {
    if (command === "getTree" && reads++ < 3) save.x += 10;
    return original(command, params);
  };
  const before = save.x;
  await tools.call("qml_click", { objectName: "btnSave" });
  const clickAt = fake.log.findIndex((e) => e.command === "click");
  const treeReads = fake.log.slice(0, clickAt).filter((e) => e.command === "getTree").length;
  assert.equal(save.x, before + 30);
  assert.ok(treeReads >= 4, `only ${treeReads} reads of the tree before the click`);
});

test("find_and_click keeps its name: one match is clicked, none and several are errors", async () => {
  let reply = await tools.call("qml_find_and_click", { text: "save" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("click").map((c) => c.params.objectId), [fake.byName("btnSave").id]);
  reply = await tools.call("qml_find_and_click", { text: "Communities" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /2 elements/);
  reply = await tools.call("qml_find_and_click", { text: "Export gizmo" });
  assert.equal(reply.isError, true);
  assert.equal(fake.commands("click").length, 1);
});

// ---------------------------------------------------------------- keys

test("send_keys with a target puts the focus in the field, types, and reports the value", async () => {
  const reply = await tools.call("qml_send_keys", { objectName: "displayNameInput", text: "Bob" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.equal(app.editor.identifying.text, "Bob");
  assert.equal(fake.commands("click")[0].params.objectId, app.editor.id);
  assert.match(text(reply), /value is now "Bob"/);
});

test("send_keys appends by default and replaces with clear", async () => {
  app.editor.identifying.text = "old";
  await tools.call("qml_send_keys", { objectName: "displayNameInput", text: "er" });
  assert.equal(app.editor.identifying.text, "older");
  await tools.call("qml_send_keys", { objectName: "displayNameInput", text: "new", clear: true });
  assert.equal(app.editor.identifying.text, "new");
});

test("send_keys with clear and no text empties the field", async () => {
  app.editor.identifying.text = "hello agent 42";
  const reply = await tools.call("qml_send_keys", { objectName: "displayNameInput", clear: true });
  assert.equal(reply.isError, undefined, text(reply));
  assert.equal(app.editor.identifying.text, "");
  assert.match(text(reply), /value is now ""/);
});

test("send_keys is an error when the field does not hold the typed text afterwards", async () => {
  const original = fake.handle.bind(fake);
  fake.handle = (command, params) => (command === "sendKeys" && params.text ? { sent: params.text } : original(command, params));
  const reply = await tools.call("qml_send_keys", { objectName: "displayNameInput", text: "Bob" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /holds ""/);
});

test("send_keys with a target that is not a text field is an error", async () => {
  const reply = await tools.call("qml_send_keys", { objectName: "btnSave", text: "x" });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /not a text field/);
  assert.equal(fake.commands("sendKeys").length, 0);
});

test("send_keys without a target types into the focused element, as before", async () => {
  const reply = await tools.call("qml_send_keys", { text: "abc" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("sendKeys").map((c) => c.params), [{ text: "abc" }]);
});

test("send_keys sends a named key", async () => {
  const reply = await tools.call("qml_send_keys", { key: "Escape" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.deepEqual(fake.commands("sendKeys").map((c) => c.params.key), ["Escape"]);
});

// ---------------------------------------------------------------- wait

test("wait_for returns when the text appears", async () => {
  setTimeout(() => add(app.page, button("btnLate", "Late button", { x: 10, y: 500 })), 40);
  const reply = await tools.call("qml_wait_for", { text: "Late button", timeout_ms: 2000 });
  assert.equal(reply.isError, undefined, text(reply));
  assert.ok(lineWith(reply, "btnLate"));
});

test("wait_for with state gone returns when the object is gone", async () => {
  const { popupItem } = openModal();
  setTimeout(() => fake.remove(popupItem), 40);
  const reply = await tools.call("qml_wait_for", { objectName: "headerCloseButton", state: "gone", timeout_ms: 2000 });
  assert.equal(reply.isError, undefined, text(reply));
});

test("wait_for is an error after the timeout", async () => {
  const reply = await tools.call("qml_wait_for", { text: "Never there", timeout_ms: 80 });
  assert.equal(reply.isError, true);
  assert.match(text(reply), /after 80 ms/);
});

// ---------------------------------------------------------------- properties, find, evaluate, screenshot

test("get_properties returns the asked properties as short lines", async () => {
  const reply = await tools.call("qml_get_properties", { objectName: "mySwitch", names: ["checked", "enabled"] });
  assert.equal(reply.isError, undefined, text(reply));
  assert.match(text(reply), /checked = false/);
  assert.match(text(reply), /enabled = true/);
  assert.ok(!text(reply).includes("objectName ="));
});

test("get_properties without names is cut at the limit", async () => {
  const sw = fake.byName("mySwitch");
  for (let k = 0; k < 500; k++) sw.props[`property${k}`] = "x".repeat(40);
  const reply = await tools.call("qml_get_properties", { objectId: sw.id });
  assert.ok(text(reply).length <= MAX_REPLY_CHARS);
  assert.match(text(reply), /names/);
});

test("set_property and call_method take a reference, an objectId or an objectName", async () => {
  let reply = await tools.call("qml_set_property", { objectName: "mySwitch", property: "checked", value: true });
  assert.equal(reply.isError, undefined, text(reply));
  assert.equal(fake.byName("mySwitch").props.checked, true);
  reply = await tools.call("qml_call_method", { ref: "e" + fake.byName("mySwitch").id, method: "toggle" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.equal(fake.commands("callMethod")[0].params.objectId, fake.byName("mySwitch").id);
  reply = await tools.call("qml_set_property", { objectId: fake.byName("mySwitch").id, property: "checked", value: false });
  assert.equal(fake.byName("mySwitch").props.checked, false);
});

test("find_by_property lists matches as short lines, hidden ones too, and no match is an error", async () => {
  let reply = await tools.call("qml_find_by_property", { property: "objectName", value: "btnHidden" });
  assert.equal(reply.isError, undefined, text(reply));
  assert.match(text(reply), /\[e\d+\] StatusButton "Hidden" objectName=btnHidden \(hidden\)/);
  reply = await tools.call("qml_find_by_property", { property: "objectName", value: "noSuchThing" });
  assert.equal(reply.isError, true);
});

test("find_by_type is cut at the limit with a note", async () => {
  for (let k = 0; k < 600; k++) add(app.page, button(`bulk${k}`, `Bulk button number ${k}`, { x: 10, y: 10 }));
  fake.handle = ((original) => (command, params) => {
    if (command !== "findByType") return original(command, params);
    const matches = [...fake.all()].filter((n) => n.type.includes(params.typeName)).map((n) => fake.serialize(n, 0, 0));
    return { matches, count: matches.length };
  })(fake.handle.bind(fake));
  const reply = await tools.call("qml_find_by_type", { typeName: "StatusButton" });
  assert.ok(text(reply).length <= MAX_REPLY_CHARS);
  assert.match(text(reply), /not shown/);
});

test("evaluate and get_tree are cut at the limit", async () => {
  fake.evaluateResult = "y".repeat(50000);
  let reply = await tools.call("qml_evaluate", { expression: "big" });
  assert.ok(text(reply).length <= MAX_REPLY_CHARS);
  assert.match(text(reply), /cut/);
  reply = await tools.call("qml_get_tree", { depth: 50 });
  assert.ok(text(reply).length <= MAX_REPLY_CHARS);
});

test("screenshot is unchanged: it returns the image", async () => {
  const reply = await tools.call("qml_screenshot", {});
  assert.equal(reply.isError, undefined, text(reply));
  assert.equal(reply.content[0].type, "image");
  assert.equal(reply.content[0].data, Buffer.from("fake png bytes").toString("base64"));
  assert.equal(text(reply), "Screenshot: 800x600 pixels");
});

// ---------------------------------------------------------------- limits and failures

test("no text reply of any tool is longer than the limit", async () => {
  for (let k = 0; k < 600; k++) add(app.page, button(`bulk${k}`, `Bulk button number ${k}`, { x: 10, y: 10 }));
  fake.evaluateResult = "y".repeat(50000);
  const calls = [
    ["qml_snapshot", {}], ["qml_list_interactive", {}], ["qml_click", { objectName: "addAccountButton" }], ["qml_click", { text: "Bulk button" }],
    ["qml_find_and_click", { text: "Bulk button" }], ["qml_send_keys", { objectName: "displayNameInput", text: "x" }],
    ["qml_wait_for", { text: "Save" }], ["qml_find_by_property", { property: "visible" }], ["qml_get_properties", { objectName: "page" }],
    ["qml_evaluate", { expression: "x" }], ["qml_get_tree", { depth: 30 }], ["qml_wait_for", { text: "nothing", timeout_ms: 30 }],
  ];
  for (const [name, args] of calls) {
    const reply = await tools.call(name, args);
    assert.ok(text(reply).length <= MAX_REPLY_CHARS, `${name}: ${text(reply).length} characters`);
  }
});

test("an unknown tool and a missing app are errors with a plain message", async () => {
  assert.equal((await tools.call("qml_nope", {})).isError, true);
  await fake.close();
  bridge.close();
  const reply = await tools.call("qml_snapshot", {});
  assert.equal(reply.isError, true);
  assert.match(text(reply), /Cannot connect to the inspector/);
  // afterEach closes the server again; give it one to close.
  await fake.listen();
});

test("the tool list keeps every old tool name, adds three, and each has a description and a schema", () => {
  const names = tools.definitions.map((t) => t.name);
  for (const name of ["qml_find_and_click", "qml_list_interactive", "qml_screenshot", "qml_find_by_type", "qml_find_by_property", "qml_click",
                      "qml_send_keys", "qml_get_properties", "qml_set_property", "qml_call_method", "qml_evaluate", "qml_get_tree",
                      "qml_list_file_dialogs", "qml_file_dialog_action", "qml_snapshot", "qml_wait_for", "qml_scroll"]) {
    assert.ok(names.includes(name), `${name} is missing`);
  }
  assert.equal(names.length, 17);
  for (const t of tools.definitions) {
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
  }
  const click = tools.definitions.find((t) => t.name === "qml_click");
  for (const p of ["x", "y", "objectId", "ref", "objectName", "text"]) assert.ok(p in click.inputSchema.properties, p);
});
