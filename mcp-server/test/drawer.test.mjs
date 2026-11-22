// Tests for a phone layout: a navigation drawer that is closed by default, and a list that scrolls sideways.
// They run against the fake inspector: no app is needed.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { FakeInspector, node, add } from "./fake-inspector.mjs";
import { QtBridge } from "../lib/bridge.mjs";
import { createToolset } from "../lib/tools.mjs";
import { loadProfile } from "../lib/profile.mjs";

const ITEM = ["QQuickItem", "QObject"];
const BUTTON = ["QQuickButton", "QQuickAbstractButton", "QQuickControl", ...ITEM];
const FLICK = ["QQuickFlickable", ...ITEM];
const POPUP = ["QQuickDialog", "QQuickPopup", "QObject"];

let fake, bridge, tools, app;

function navButton(name, y, onClick) {
  return node("RegularSectionButton", { inherits: BUTTON, objectName: name, x: 13, y, w: 42, h: 42, props: { pressed: false, checked: name === "Wallet-navbar" }, onClick }, [
    node("StatusIcon_QMLTYPE_2", { inherits: ITEM, objectName: name.split("-")[0].toLowerCase() + "-icon", w: 24, h: 24 }),
  ]);
}

// A phone window: the page fills it, the drawer sits left of the window until it is opened.
function buildPhone() {
  const state = { section: "Wallet" };
  const title = node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], objectName: "title", text: "Wallet", x: 20, y: 20, w: 200, h: 30 });
  const open = (f, n) => { n.x = 0; n.props.opened = true; n.props.position = 1; };
  const close = (f, n) => { n.x = -68; n.props.opened = false; n.props.position = 0; };
  const drawer = node("PrimaryNavSidebar_QMLTYPE_1030", { inherits: ["QQuickControl", ...ITEM], qmlId: "sidebar", x: -68, y: 0, w: 68, h: 800,
                                                           props: { opened: false, position: 0 }, methods: { open, close } });
  const go = (section) => (f) => { title.identifying.text = section; close(f, drawer); };
  add(drawer, navButton("Home Page-navbar", 60, go("Home")));
  add(drawer, navButton("Wallet-navbar", 110, go("Wallet")));
  add(drawer, navButton("Market-navbar", 160, go("Market")));

  const chips = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"].map((t, k) =>
    node("StatusButton_QMLTYPE_42", { inherits: BUTTON, objectName: `chip${t}`, text: t, x: k * 100, y: 0, w: 90, h: 30 }, [
      node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], text: t, w: 90, h: 20 }),
    ]));
  const row = node("QQuickFlickable", { inherits: FLICK, objectName: "chipRow", x: 0, y: 300, w: 400, h: 30,
                                        props: { contentX: 0, contentY: 0, contentWidth: 800, contentHeight: 30, originX: 0, originY: 0 } },
                   [node("QQuickItem", { inherits: ITEM, w: 800, h: 30 }, chips)]);
  const farAway = node("StatusButton_QMLTYPE_42", { inherits: BUTTON, objectName: "otherPageButton", text: "Other page", x: 500, y: 100, w: 90, h: 30 });
  const page = node("QQuickItem", { inherits: ITEM, objectName: "page", w: 400, h: 800 }, [title, row, farAway]);
  const overlay = node("QQuickOverlay", { inherits: ITEM, w: 400, h: 800 });
  const content = node("QQuickRootItem", { inherits: ITEM, w: 400, h: 800 }, [page, drawer, overlay]);
  const win = node("QQuickWindowQmlImpl_QML_186", { inherits: ["QQuickWindowQmlImpl", "QQuickWindow", "QWindow", "QObject"], objectName: "mainWindow", title: "Phone", w: 400, h: 800 }, [content]);
  const root = node("QGuiApplication", { objectName: "Phone" }, [win]);
  return { root, drawer, title, overlay, row, close };
}

beforeEach(async () => {
  app = buildPhone();
  fake = new FakeInspector(app.root);
  const port = await fake.listen();
  bridge = new QtBridge({ host: "127.0.0.1", port, timeoutMs: 2000 });
  // The drawer of these tests is a plain item, as in the Status app: its profile turns the search for such a drawer on.
  tools = createToolset({ bridge, settleIntervalMs: 5, settleTimeoutMs: 300, profile: loadProfile("status") });
});

afterEach(async () => {
  bridge.close();
  await fake.close();
});

const text = (reply) => reply.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const call = async (name, args = {}) => {
  const reply = await tools.call(name, args);
  return { reply, text: text(reply), isError: !!reply.isError };
};

test("snapshot: a closed drawer is one line, and its elements are listed and marked", async () => {
  const snap = await call("qml_snapshot");
  assert.match(snap.text, new RegExp(`\\[e${app.drawer.id}\\] PrimaryNavSidebar drawer: closed`));
  assert.match(snap.text, /RegularSectionButton objectName=\"Market-navbar\" icon=\"market\" \(in closed drawer\)/);
  assert.match(snap.text, /RegularSectionButton objectName=\"Wallet-navbar\" icon=\"wallet\" \(checked, in closed drawer\)/);
  assert.doesNotMatch(snap.text, /navbar.*not in view/);
});

test("snapshot: an open drawer has no drawer line and its elements have no mark", async () => {
  app.drawer.methods.open(fake, app.drawer);
  const snap = await call("qml_snapshot");
  assert.doesNotMatch(snap.text, /drawer/);
  assert.match(snap.text, /objectName=\"Market-navbar\" icon=\"market\"$/m);
});

test("click on an element in a closed drawer opens the drawer first, then clicks", async () => {
  const r = await call("qml_click", { objectName: "Market-navbar" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(fake.commands("callMethod").map((c) => [c.params.objectId, c.params.method]), [[app.drawer.id, "open"]]);
  assert.equal(app.title.identifying.text, "Market");
  assert.match(r.text, /^Clicked \[e\d+\] RegularSectionButton objectName=\"Market-navbar\" icon=\"market\" \(opened the drawer first\)\./);
  assert.match(r.text, /changed: \[e\d+\] StatusBaseText "Market"/);
});

test("click in a closed drawer: when another item takes the press, the server opens the drawer again and retries", async () => {
  fake.stealPresses = 1;
  fake.onStolenClick = (f) => app.close(f, app.drawer);
  const r = await call("qml_click", { objectName: "Market-navbar" });
  assert.equal(r.isError, false, r.text);
  assert.equal(app.title.identifying.text, "Market");
  assert.equal(fake.commands("callMethod").filter((c) => c.params.method === "open").length, 2);
  assert.match(r.text, /2 tries/);
});

test("click in a closed drawer: a press that never reaches the element is an error after 3 tries", async () => {
  fake.stealPresses = 99;
  fake.onStolenClick = (f) => app.close(f, app.drawer);
  const r = await call("qml_click", { objectName: "Market-navbar" });
  assert.equal(r.isError, true);
  assert.match(r.text, /did not reach .*Market-navbar.* 3 tries/);
  assert.equal(app.title.identifying.text, "Wallet");
  assert.equal(fake.commands("mouse").filter((c) => c.params.action === "press").length, 3);
});

test("click in a closed drawer behind a modal popup is an error and the drawer stays closed", async () => {
  const popupItem = node("QQuickPopupItem", { inherits: ["QQuickControl", ...ITEM], x: 50, y: 150, w: 300, h: 300 }, [
    node("StatusBaseText_QMLTYPE_7", { inherits: ["QQuickText", ...ITEM], text: "Back up", x: 16, y: 16 }),
  ]);
  add(app.overlay, popupItem);
  add(popupItem, node("BackupPopup_QMLTYPE_30", { inherits: POPUP, title: "Back up", props: { opened: true, modal: true, visible: true } }));
  const r = await call("qml_click", { objectName: "Market-navbar" });
  assert.equal(r.isError, true);
  assert.match(r.text, /behind a modal popup/);
  assert.equal(fake.commands("callMethod").length, 0);
  assert.equal(fake.commands("mouse").length, 0);
});

test("click on an element in an open drawer is a plain click", async () => {
  app.drawer.methods.open(fake, app.drawer);
  const r = await call("qml_click", { objectName: "Home Page-navbar" });
  assert.equal(r.isError, false, r.text);
  assert.equal(fake.commands("callMethod").length, 0);
  assert.equal(fake.commands("click").length, 1);
  assert.equal(app.title.identifying.text, "Home");
});

test("click on an element scrolled out to the side scrolls the list sideways first", async () => {
  const r = await call("qml_click", { objectName: "chipSeven" });
  assert.equal(r.isError, false, r.text);
  const set = fake.commands("setProperty").map((c) => [c.params.property, c.params.value]);
  assert.deepEqual(set, [["contentX", 400]]);
  assert.match(r.text, /scrolled into view first/);
  assert.equal(fake.commands("click").length, 1);
});

test("click on an element outside the window that no list and no drawer can bring in says how to go on", async () => {
  const r = await call("qml_click", { objectName: "otherPageButton" });
  assert.equal(r.isError, true);
  assert.match(r.text, /outside the window/);
  assert.match(r.text, /page that is not shown/);
  assert.equal(fake.commands("click").length, 0);
});

test("find tools mark an object that is shown but outside the window", async () => {
  const off = await call("qml_find_by_property", { property: "objectName", value: "otherPageButton" });
  assert.match(off.text, /StatusButton "Other page" objectName=\"otherPageButton\" \(not on screen\)/);
  const on = await call("qml_find_by_property", { property: "objectName", value: "title" });
  assert.doesNotMatch(on.text, /not on screen/);
  const byType = await call("qml_find_by_type", { typeName: "RegularSectionButton" });
  assert.match(byType.text, /objectName=\"Market-navbar\" \(not on screen\)/);
});

test("finding a drawer does not ask every object for `opened`: only the item outside the window is asked, and once", async () => {
  await call("qml_snapshot");
  await call("qml_snapshot");
  assert.equal(fake.commands("findByProperty").filter((c) => c.params.property === "opened").length, 0);
  const asked = fake.commands("getProperties").map((c) => c.params.objectId);
  assert.deepEqual(asked, [app.drawer.id]);
});
