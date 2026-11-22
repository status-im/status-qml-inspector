// Reads the object tree from the inspector plugin and turns it into a short list of what is on screen:
// one line per element that a user can see or act on, each with a reference.
import { GENERIC_PROFILE } from "./profile.mjs";

const LABEL_MAX = 80;
const MAX_DRAWER_QUESTIONS = 4; // per read
// The keys of a tree node that hold a text of the app.
const TEXT_KEYS = ["text", "title", "label", "placeholderText", "currentText", "source"];

export const shortType = (type) => String(type || "").split(/_QMLTYPE_|_QML_/)[0];
const inherits = (n, name) => n.type === name || (n.inherits || []).includes(name);
const isWindow = (n) => "active" in n || inherits(n, "QQuickWindow") || inherits(n, "QWindow");
const isPopup = (n) => inherits(n, "QQuickPopup");
const isItem = (n) => !!n.geometry && !isWindow(n);
const isEditor = (n) => inherits(n, "QQuickTextInput") || inherits(n, "QQuickTextEdit");
// The Qt fields that can hide what is typed (echoMode).
export const isEchoField = (n) => inherits(n, "QQuickTextInput") || inherits(n, "QLineEdit");
const isText = (n) => inherits(n, "QQuickText");
const isMouseArea = (n) => inherits(n, "QQuickMouseArea");
// Parts of a control (its background, its indicator) carry the control's word in their type name.
const PART = /Cursor|(Background|Indicator|Icon|Loader|Text|Content|Label|Panel)$/;
// A label can be rich text. Only what is a tag of the rich text Qt knows is taken out: "<b>", "</span>", "<br/>", "<a href=...>".
// Plain text with the two signs in it ("5 < 10 and 7 > 3", "a<b and b>c") is kept as it is.
const TAGS = "a|address|b|big|blockquote|body|br|center|cite|code|dd|dfn|div|dl|dt|em|font|h[1-6]|head|hr|html|i|img|kbd|li|meta|nobr|ol|p|pre|qt|s|samp|" +
             "small|span|strong|sub|sup|table|tbody|td|tfoot|th|thead|title|tr|tt|u|ul|var";
const TAG = new RegExp(`<(?:/(?:${TAGS})\\s*|(?:${TAGS})(?:\\s+[a-z-]+\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'<>]+))*\\s*/?)>`, "gi");
const BREAK = /<(?:(?:br|hr)\s*\/?|\/(?:p|div|li|h[1-6]|tr)\s*)>/gi;
const clean = (s) => String(s ?? "").replace(/<style(?:\s[^<>]*)?>[\s\S]*?<\/style>/gi, "").replace(BREAK, " ").replace(TAG, "").replace(/\s+/g, " ").trim();
const ownLabel = (n) => clean(typeof n.text === "string" ? n.text : "") || clean(typeof n.title === "string" ? n.title : "") || clean(typeof n.label === "string" ? n.label : "");
// Every text of the app goes into a line in quotes, as one JSON string: it cannot end the line or look like another field.
const quote = (s) => JSON.stringify(s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + "…" : s);

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), bottom = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, bottom - y) };
}
const contains = (r, px, py) => r.w > 0 && r.h > 0 && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

async function ids(bridge, property, value) {
  const reply = await bridge.send("findByProperty", { property, value });
  if (reply.error) return new Map();
  return new Map((reply.matches || []).map((m) => [String(m.id), m]));
}

// ---- password fields
//
// What a password field holds must never reach the agent. The new plugin (the one with the password hiding, see the README) leaves these texts out
// itself and says so in its replies (secretsHidden). For an older plugin the server finds the fields
// (one search for echoMode) and removes their text from the reply before anything else looks at it.

export const pluginHidesSecrets = (reply) => reply && reply.secretsHidden === true;

// -> { ids: the fields that hide their text, values: the texts they hold, shown: the fields that show their text }
export async function findSecrets(bridge) {
  const reply = await bridge.send("findByProperty", { property: "echoMode" });
  if (reply.error) {
    throw new Error(`Qt Inspector error: could not look for password fields (${reply.error}). Nothing is shown, so that no password is shown.`);
  }
  const found = { ids: new Set(), values: new Set(), shown: new Set() };
  for (const m of reply.matches || []) {
    // 0 is Normal: the field shows its text
    if (m.value === 0) { found.shown.add(String(m.id)); continue; }
    found.ids.add(String(m.id));
    if (typeof m.text === "string" && m.text) found.values.add(m.text);
  }
  return found;
}

// Removes the hidden texts from a tree node and its children, in place. A wrapper often repeats the text
// of its field in a property of its own, so every text that equals a hidden one is removed too.
// The search for the fields is a second request, made after the tree was read. If the user typed in between, the field
// held another text when the tree was read. That text is in the tree itself (one reply is one moment in the app),
// so the texts of the fields are taken from the tree too.
// A field can also go away between the two requests (Return on a login page closes the page). The search does not
// find it then, and nothing says whether it hid its text. So a field of the tree counts as a password field unless
// the search has confirmed that it shows its text (secrets.shown): what is not known is hidden.
export function hideSecrets(raw, secrets) {
  const values = new Set(secrets.values);
  const ids = new Set(secrets.ids);
  const shown = secrets.shown || new Set();
  const collect = (n) => {
    if (!n || typeof n !== "object") return;
    if (isEchoField(n) && n.id !== undefined && !shown.has(String(n.id))) ids.add(String(n.id));
    if (ids.has(String(n.id))) for (const key of TEXT_KEYS) if (typeof n[key] === "string" && n[key]) values.add(n[key]);
    for (const child of n.children || []) collect(child);
  };
  collect(raw);
  return hideIn(raw, { ids, values });
}

function hideIn(raw, secrets) {
  if (!raw || typeof raw !== "object") return raw;
  if (secrets.ids.has(String(raw.id))) {
    if (!("textLength" in raw)) raw.textLength = typeof raw.text === "string" ? raw.text.length : 0;
    delete raw.text;
    raw.secret = true;
  }
  for (const key of TEXT_KEYS) {
    if (typeof raw[key] === "string" && raw[key] && secrets.values.has(raw[key])) {
      delete raw[key];
      raw.secret = true;
    }
  }
  for (const child of raw.children || []) hideIn(child, secrets);
  return raw;
}

// ---- scrolling

// Position and range of a list along one axis, on a scale that starts at 0. `props` are properties of the
// flickable; its own contentY starts at originY, which is not always 0.
export function scrollAxis(props, axis, viewSize) {
  const [property, size, originName] = axis === "y" ? ["contentY", "contentHeight", "originY"] : ["contentX", "contentWidth", "originX"];
  const origin = Number(props[originName]) || 0;
  const max = Math.max(0, Math.round((Number(props[size]) || 0) - viewSize));
  const at = Math.min(max, Math.max(0, Math.round((Number(props[property]) || 0) - origin)));
  return { property, origin, at, max };
}

// ---- the screen

// -> { window, elements, nodes (id -> record), modal, key, shown, place }
// `known` remembers, per object id, whether an item outside the window is a drawer, so each one is asked once.
// options.light: only { key, finish } is returned, from the tree alone. It is for comparing two reads while the screen
//   settles: no states are asked for, and nothing of it may be shown.
//   `finish({ settled })` then asks for the states of that same tree and returns the whole screen.
export async function readScreen(bridge, known = new Map(), { profile = GENERIC_PROFILE, light = false } = {}) {
  const reply = await bridge.send("getTree", { depth: 200 });
  if (reply.error) throw new Error(`Qt Inspector error: ${reply.error}`);
  if (!light) return interpret(bridge, reply, known, profile, false, false);
  const { key } = await interpret(bridge, reply, known, profile, true, false);
  // settled: two reads in a row were the same. Only then may an item be asked whether it is a drawer.
  return { key, finish: ({ settled = false } = {}) => interpret(bridge, reply, known, profile, false, settled) };
}

async function interpret(bridge, reply, known, profile, light, settled) {

  const isStrong = (n) => !PART.test(shortType(n.type)) && (profile.control.test(shortType(n.type)) || (n.inherits || []).some((t) => profile.control.test(t)));
  const isPartName = (name) => !!name && !!profile.partName && profile.partName.test(name);
  const iconOf = (name) => {
    for (const pattern of profile.iconNames) {
      const m = pattern.exec(name || "");
      if (m) return m[1] ?? m[0];
    }
    return "";
  };

  if (!light && !pluginHidesSecrets(reply)) {
    // An older plugin: its tree holds the text of every field. Look for password fields only when the tree has a field that could be one.
    let hasField = false;
    const look = (n) => { if (isEchoField(n)) hasField = true; else (n.children || []).forEach(look); };
    look(reply.tree || {});
    if (hasField) hideSecrets(reply.tree, await findSecrets(bridge));
  }

  // The states of the elements. The new plugin sends them with the tree. For the old plugin each state
  // is one search of the whole tree. One request at a time: small replies sent back to back wait for each other on the socket.
  const fromTree = reply.states === true;
  let checked = new Map(), focused = new Map(), modal = null;
  if (!light && !fromTree) {
    checked = await ids(bridge, "checked", true);
    focused = await ids(bridge, "activeFocus", true);
    const modalTrue = await ids(bridge, "modal", true);
    const opened = modalTrue.size ? await ids(bridge, "opened", true) : new Map();
    const modalPopups = [...modalTrue.values()].filter((p) => opened.has(String(p.id)));
    modal = modalPopups.length ? modalPopups[modalPopups.length - 1] : null;
  }

  // Pass 1: one record per object, with its place in the window.
  const nodes = new Map();
  let window = null;
  const build = (raw, parent, origin, visible, clip, flick, overlay, win, drawer) => {
    const id = String(raw.id);
    if (raw.id !== "" && nodes.has(id)) return null;
    const rec = { id, raw, parent, type: shortType(raw.type), objectName: raw.objectName || "", children: [], visible, enabled: raw.enabled !== false,
                  rect: null, clip, flick, overlay, win, item: false, drawer };
    if (raw.id !== "") nodes.set(id, rec);
    let children = raw.children || [];
    if (isWindow(raw)) {
      rec.visible = visible = raw.visible !== false;
      win = { w: raw.geometry?.width || 0, h: raw.geometry?.height || 0, title: raw.title || "" };
      rec.win = win;
      if (visible && (!window || win.w * win.h > window.w * window.h)) window = win;
      origin = { x: 0, y: 0 };
      clip = { x: 0, y: 0, w: win.w, h: win.h };
      rec.clip = clip;
      flick = null;
      overlay = false;
    } else if (isPopup(raw) && !isItem(raw)) {
      // A popup object (a dialog, a menu, a drawer). When it is open, its content is a child of the overlay and is
      // read there. When it is closed, the content is not on the screen; only a closed Qt Quick Drawer is read,
      // because a click on one of its elements can open it.
      const popupItem = children.find((c) => inherits(c, "QQuickPopupItem"));
      const open = typeof raw.opened === "boolean" ? raw.opened : !!popupItem && popupItem.visible !== false;
      if (!open && popupItem && inherits(raw, "QQuickDrawer")) {
        rec.rect = { x: 0, y: 0, w: 0, h: 0 };
        rec.stockDrawer = true;
        rec.drawer = drawer = rec;
        origin = { x: 0, y: 0 };
        clip = null;
        flick = null;
        children = [popupItem];
      } else {
        children = [];
      }
    } else if (isItem(raw)) {
      rec.item = true;
      // Inside a closed Qt Quick Drawer every item reports "not visible", because the drawer is. They are read as they will be when it opens.
      rec.visible = visible = drawer && drawer.stockDrawer ? true : visible && raw.visible !== false;
      const g = raw.geometry;
      rec.rect = { x: origin.x + (g.x || 0), y: origin.y + (g.y || 0), w: g.width || 0, h: g.height || 0 };
      origin = { x: rec.rect.x, y: rec.rect.y };
      if (inherits(raw, "QQuickOverlay")) overlay = true;
      rec.overlay = overlay;
      if (inherits(raw, "QQuickFlickable")) {
        clip = intersect(clip || rec.rect, rec.rect);
        flick = rec;
        rec.viewport = clip;
      }
    }
    for (const child of children) {
      const c = build(child, rec, origin, visible, clip, flick, overlay, win, drawer);
      if (c) rec.children.push(c);
    }
    return rec;
  };
  const root = build(reply.tree, null, { x: 0, y: 0 }, true, null, null, false, null, null);

  const shown = (rec) => rec.item && rec.visible && rec.rect.w >= 2 && rec.rect.h >= 2;

  // Open popups (a menu, the list of a combo box, a dialog, a tooltip). The item of each one is a child of the overlay
  // and lies over the page; a later one lies over an earlier one. A click on a place that such an item covers goes to
  // the popup, whether the popup is modal or not. So an element whose middle is under a popup item that it is not
  // a part of cannot be clicked now.
  const popupItems = [...nodes.values()].filter((rec) => rec.item && rec.overlay && inherits(rec.raw, "QQuickPopupItem") && shown(rec));
  const coverOf = (rec, rect) => {
    if (!popupItems.length || !rect) return null;
    let own = -1;
    for (let p = rec; p && own === -1; p = p.parent) own = popupItems.indexOf(p);
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    for (let k = popupItems.length - 1; k > own; k--) if (contains(popupItems[k].rect, cx, cy)) return popupItems[k];
    return null;
  };
  const popupName = (rec) => {
    const popup = rec.raw.popup || {};
    const title = clean(typeof popup.title === "string" ? popup.title : "");
    return `[e${rec.id}] ${shortType(popup.type || rec.raw.type)}${title ? " " + JSON.stringify(title) : ""}`;
  };

  if (!light && fromTree) {
    // Same order as the searches of an older plugin: level by level, and the last open modal popup counts.
    const queue = root ? [root] : [];
    for (let k = 0; k < queue.length; k++) {
      const rec = queue[k];
      if (rec.raw.checked === true) checked.set(rec.id, rec.raw);
      if (rec.raw.activeFocus === true) focused.set(rec.id, rec.raw);
      const popup = rec.raw.popup;
      if (popup && popup.modal === true && popup.opened === true) modal = popup;
      queue.push(...rec.children);
    }
  }

  // A drawer that is a plain item (profile: itemDrawers). When closed it is a visible item that lies outside the window,
  // holds controls, and has `opened` = false and a `position`. Only such items are asked for these two properties, and each one once.
  // An item is asked only when the screen has stopped moving (`settled`): while a page is being replaced, its items lie
  // outside the window too, and reading the properties of such an item has made an app exit.
  // Until an item was asked, it does not count as a drawer. An item that was asked before keeps its answer,
  // also while the screen moves.
  if (profile.itemDrawers) {
    const hasControl = (rec) => rec.children.some((c) => (!c.item || c.visible) && ((c.item && isStrong(c.raw)) || hasControl(c)));
    const outside = [];
    const seek = (rec) => {
      if (rec.item && !rec.visible) return;
      if (rec.drawer) return;
      if (rec.item && rec.win && shown(rec)) {
        const part = intersect({ x: 0, y: 0, w: rec.win.w, h: rec.win.h }, rec.rect);
        if (part.w < 1 || part.h < 1) {
          if (hasControl(rec)) outside.push(rec);
          return;
        }
      }
      rec.children.forEach(seek);
    };
    if (root) seek(root);
    let asked = 0;
    for (const rec of outside) {
      if (!known.has(rec.id)) {
        if (!settled || asked++ >= MAX_DRAWER_QUESTIONS) continue;
        const props = await propertiesOf(bridge, rec.id, ["opened", "position"]);
        known.set(rec.id, !!props && props.get("opened") === false && typeof props.get("position") === "number");
      }
      if (!known.get(rec.id)) continue;
      const mark = (r) => { r.drawer = rec; r.children.forEach(mark); };
      mark(rec);
    }
  }
  // An id that is gone may be given to another object after the app starts again.
  for (const id of [...known.keys()]) if (!nodes.has(id)) known.delete(id);

  const place = (rec) => {
    const cx = rec.rect.x + rec.rect.w / 2, cy = rec.rect.y + rec.rect.h / 2;
    const inView = !!rec.clip && contains(rec.clip, cx, cy);
    // An element outside the visible part of a list can be reached by scrolling, if the list itself is on screen.
    // An element of a closed drawer can be reached too: the drawer is opened for it.
    const reachable = inView || !!rec.drawer || (!!rec.flick && rec.flick.viewport.w > 0 && rec.flick.viewport.h > 0);
    // Only an element in view is checked: one that must be scrolled into view first is checked after the scroll.
    const cover = inView ? coverOf(rec, rec.rect) : null;
    return { inView, reachable, drawerId: !inView && rec.drawer ? rec.drawer.id : null, covered: !!cover, coveredBy: cover ? popupName(cover) : "" };
  };

  // Pass 2: text fields. The editor is the object to click and type into; its wrapper carries the name and the label.
  // A wrapper is an ancestor that holds this editor and no other one: a panel with two fields is not the wrapper of either.
  const editors = [...nodes.values()].filter((rec) => isEditor(rec.raw) && shown(rec));
  const editorsUnder = new Map(); // ancestor id -> number of editors below it
  for (const rec of editors) {
    for (let p = rec.parent, depth = 0; p && p.item && depth < 10; p = p.parent, depth++) editorsUnder.set(p.id, (editorsUnder.get(p.id) || 0) + 1);
  }
  const wrapperOf = new Map(); // wrapper id -> editor record
  for (const rec of editors) {
    let wrapper = rec, best = null;
    for (let p = rec.parent, depth = 0; p && p.item && depth < 10; p = p.parent, depth++) {
      if (editorsUnder.get(p.id) > 1) break;
      if (!profile.inputWrapper.test(p.type)) continue;
      wrapper = p;
      if (p.objectName && !isPartName(p.objectName)) { best = p; break; }
    }
    wrapper = best || wrapper;
    if (!wrapperOf.has(wrapper.id)) wrapperOf.set(wrapper.id, rec);
  }

  // Lists that can be scrolled: where they are and how far they go. The new plugin sends this with the tree.
  // With the old plugin the position is taken from the geometry (see geometryScroll): asking each list for its properties
  // on every read would run every getter of the list.
  for (const rec of nodes.values()) {
    if ("contentY" in rec.raw && rec.item && shown(rec)) rec.scroll = scrollAxis(rec.raw, "y", rec.rect.h);
  }

  // Pass 3: the list.
  const elements = [];
  const textsUnder = (rec, out, stopAt) => {
    for (const c of rec.children) {
      if (!c.visible && c.item) continue;
      if (stopAt(c)) continue;
      if (isText(c.raw) && shown(c)) {
        const t = clean(c.raw.text);
        if (t && !out.includes(t)) out.push(t);
      }
      textsUnder(c, out, stopAt);
    }
    return out;
  };
  const find = (rec, test) => {
    for (const c of rec.children) {
      if (c.item && !c.visible) continue;
      if (test(c)) return c;
      const hit = find(c, test);
      if (hit) return hit;
    }
    return null;
  };
  const nested = (c) => wrapperOf.has(c.id) || (c.item && isStrong(c.raw));
  const emit = (rec, fields) => {
    const el = { id: rec.id, ref: "e" + rec.id, type: rec.type, objectName: isPartName(rec.objectName) ? "" : rec.objectName, texts: [], label: "",
                 enabled: rec.enabled, checked: checked.has(rec.id), rect: rec.rect, flick: rec.flick, behindModal: !!modal && !rec.overlay, ...place(rec), ...fields };
    el.line = formatElement(el);
    elements.push(el);
  };
  const walk = (rec, quiet, owner = null) => {
    if (rec.item && !rec.visible) return;
    let childQuiet = quiet;
    if (rec.drawer === rec) {
      emit(rec, { kind: "drawer", ...(rec.stockDrawer ? { inView: true, reachable: true, drawerId: null } : {}) });
    } else if (wrapperOf.has(rec.id)) {
      const editor = wrapperOf.get(rec.id);
      const placeholderNode = [rec, ...descendants(rec)].find((n) => typeof n.raw.placeholderText === "string" && n.raw.placeholderText);
      const placeholder = placeholderNode ? clean(placeholderNode.raw.placeholderText) : "";
      // A password field: the plugin, or hideSecrets above, took its text out of the tree. Only its length is known.
      const hidden = editor.raw.secret === true;
      const value = !hidden && typeof editor.raw.text === "string" ? editor.raw.text : "";
      const length = hidden ? Number(editor.raw.textLength) || 0 : value.length;
      const texts = textsUnder(rec, [], (c) => c !== editor && nested(c)).filter((t) => t !== placeholder && (hidden || t !== clean(value)));
      // The wrapper's own "text" is the value, not the label.
      const named = rec !== editor ? clean(typeof rec.raw.label === "string" ? rec.raw.label : "") || clean(typeof rec.raw.title === "string" ? rec.raw.title : "") : "";
      const label = named || texts[0] || "";
      const target = shown(rec) ? rec : editor;
      emit(editor, { kind: "input", type: rec.type, objectName: isPartName(rec.objectName) ? "" : rec.objectName, texts: label ? [label] : [], label,
                     value, hidden, length, placeholder, focused: focused.has(editor.id), enabled: editor.enabled && rec.enabled, rect: target.rect, ...place(target) });
      // The click goes to the editor: it is the editor that must not be under a popup.
      // The other texts inside the wrapper (an error under the field, a counter, the texts of a whole page whose type
      // name looks like a wrapper) are lines of their own. Only what the line of the field already shows is left out.
      childQuiet = rec === editor ? true : { editor, used: new Set([label, placeholder, clean(value)].filter(Boolean)) };
    } else if (rec.item && shown(rec) && rec.viewport && rec.viewport.h > 0 && contentHeight(rec)) {
      // A list with more content than fits. Rows far outside the visible part do not exist until the list is scrolled.
      emit(rec, { kind: "scroll", scroll: rec.scroll || geometryScroll(rec) });
    } else if (rec.item && shown(rec) && isStrong(rec.raw)) {
      const texts = textsUnder(rec, [], nested);
      const own = ownLabel(rec.raw);
      if (own && !texts.includes(own)) texts.unshift(own);
      // A control with no text of its own that wraps another control is a shell: the inner one is listed.
      const shell = !texts.length && !!find(rec, nested);
      if (!shell) {
        const iconNode = texts.length ? null : find(rec, (c) => !!iconOf(c.objectName));
        // A switch inside a list row has no text of its own: the row says what it is for.
        const within = !texts.length && owner && owner.label ? owner.label : "";
        emit(rec, { kind: "control", texts, label: texts.join(" | "), within, icon: iconNode ? iconOf(iconNode.objectName) : "" });
        childQuiet = true;
        owner = elements[elements.length - 1];
      }
    } else if (rec.item && shown(rec) && isMouseArea(rec.raw) && !quiet) {
      // A bare mouse area is an element only when it has a name or a text of its own.
      // One that wraps other controls is a container: its children are listed instead.
      const named = rec.objectName && !isPartName(rec.objectName);
      const container = !!find(rec, (c) => nested(c) || isMouseArea(c.raw));
      const texts = container ? [] : textsUnder(rec, [], nested);
      if (named || texts.length) {
        emit(rec, { kind: "control", texts, label: texts.join(" | "), icon: "" });
        childQuiet = !container;
      }
    } else if (rec.item && shown(rec) && isText(rec.raw) && (!quiet || quiet.used)) {
      const t = clean(rec.raw.text);
      if (t && !(quiet && quiet.used.has(t))) emit(rec, { kind: "text", texts: [t], label: t });
    }
    // Inside the editor itself everything belongs to the field (its placeholder, its cursor).
    const below = childQuiet && childQuiet.editor === rec ? true : childQuiet;
    for (const c of rec.children) walk(c, below, owner);
  };
  if (root) walk(root, false);

  const listed = elements.filter((e) => e.reachable && !e.behindModal);
  const key = JSON.stringify([modal ? modal.id : null, listed.map((e) => [e.line, e.rect.x, e.rect.y, e.rect.w, e.rect.h])]);
  if (light) return { key };
  return { window, elements, nodes, modal, key, shown, place };
}

// `names`: the new plugin reads only these properties. The old plugin reads all of them.
async function propertiesOf(bridge, objectId, names) {
  const reply = await bridge.send("getProperties", { objectId, names });
  if (reply.error) return null;
  return new Map((reply.properties || []).map((p) => [p.name, p.value]));
}

const contentItemOf = (rec) => rec.children.find((c) => c.item && !/ScrollBar|ScrollIndicator/.test(c.type));

// Is the content of a scrollable item higher than the item (by more than a few pixels)?
function contentHeight(rec) {
  const content = contentItemOf(rec);
  return !!content && Math.round(content.rect.h - rec.rect.h) >= 20;
}

// Position and range from the geometry alone, for the old plugin. Right when the content starts at 0 (originY = 0).
// For a list whose content starts elsewhere (a chat that grows upwards), the position can be off; qml_scroll is right for it.
function geometryScroll(rec) {
  const content = contentItemOf(rec);
  return { at: Math.max(0, Math.round(rec.rect.y - content.rect.y)), max: Math.round(content.rect.h - rec.rect.h) };
}

function descendants(rec, out = []) {
  for (const c of rec.children) {
    out.push(c);
    descendants(c, out);
  }
  return out;
}

export function formatElement(el) {
  let line = `[${el.ref}] ${el.type}`;
  if (el.label) line += ` ${quote(el.label)}`;
  if (el.within) line += ` in ${quote(el.within)}`;
  if (el.objectName) line += ` objectName=${JSON.stringify(el.objectName)}`;
  if (el.kind === "input") {
    // A password field shows only whether it is empty.
    line += el.hidden && el.length ? " value=(hidden)" : ` value=${quote(el.value)}`;
    if (el.placeholder) line += ` placeholder=${quote(el.placeholder)}`;
  }
  if (el.icon) line += ` icon=${JSON.stringify(el.icon)}`;
  if (el.kind === "drawer") return `${line} drawer: closed. Its elements are listed; a click on one of them opens the drawer first.`;
  if (el.kind === "scroll") {
    const more = [el.scroll.at > 1 ? "above" : "", el.scroll.at < el.scroll.max - 1 ? "below" : ""].filter(Boolean).join(" and ");
    line += ` scrollable: contentY=${el.scroll.at} of 0..${el.scroll.max}${more ? `, more ${more}` : ""}`;
  }
  const flags = [];
  if (el.checked) flags.push("checked");
  if (!el.enabled) flags.push("disabled");
  if (el.focused) flags.push("focused");
  if (!el.inView) flags.push(el.drawerId ? "in closed drawer" : "not in view");
  if (el.covered) flags.push("under a popup");
  if (flags.length) line += ` (${flags.join(", ")})`;
  return line;
}

// A line for an object that is not in the list (a container, a hidden object, a match of a find tool).
export function formatObject(raw, extra = "", marks = []) {
  let line = `[e${raw.id}] ${shortType(raw.type)}`;
  const label = ownLabel(raw) || clean(typeof raw.placeholderText === "string" ? raw.placeholderText : "");
  if (label) line += ` ${quote(label)}`;
  if (raw.objectName) line += ` objectName=${JSON.stringify(raw.objectName)}`;
  if (extra) line += ` ${extra}`;
  const flags = [];
  if (raw.visible === false) flags.push("hidden");
  if (raw.enabled === false) flags.push("disabled");
  flags.push(...marks);
  if (flags.length) line += ` (${flags.join(", ")})`;
  return line;
}

export function modalLine(screen) {
  if (!screen.modal) return "";
  const title = clean(screen.modal.title);
  return `Modal popup is open: ${shortType(screen.modal.type)}${title ? " " + JSON.stringify(title) : ""}. Only its elements are listed.`;
}

// The lines an agent sees: what is in view first, then what a scroll would bring into view.
export function listedElements(screen, { interactiveOnly = false, filter = "" } = {}) {
  let list = screen.elements.filter((e) => e.reachable && !e.behindModal);
  if (interactiveOnly) list = list.filter((e) => e.kind !== "text");
  if (filter) list = list.filter((e) => e.line.toLowerCase().includes(filter.toLowerCase()));
  return [...list.filter((e) => e.inView), ...list.filter((e) => !e.inView)];
}
