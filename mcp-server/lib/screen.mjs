// Reads the object tree from the inspector plugin and turns it into a short list of what is on screen:
// one line per element that a user can see or act on, each with a reference.

const STRONG = /Button|Delegate|ComboBox|Slider|Switch|CheckBox|Radio|SpinBox|MenuItem|ListItem/i;
const INPUT_WRAPPER = /Input|TextField|TextArea|SearchBox/i;
// Names that parts of controls carry in every instance. They do not identify an element.
const GENERIC_NAME = /^(buttonText|buttonBackground|buttonIcon|rightTextLoader|leftTextLoader|statusBaseInput|statusRoundIcon|statusRoundImage|textContent|.*_sensor)$/;
const LABEL_MAX = 80;

export const shortType = (type) => String(type || "").split(/_QMLTYPE_|_QML_/)[0];
const inherits = (n, name) => n.type === name || (n.inherits || []).includes(name);
const isWindow = (n) => "active" in n || inherits(n, "QQuickWindow") || inherits(n, "QWindow");
const isItem = (n) => !!n.geometry && !isWindow(n);
const isEditor = (n) => inherits(n, "QQuickTextInput") || inherits(n, "QQuickTextEdit");
const isText = (n) => inherits(n, "QQuickText");
const isMouseArea = (n) => inherits(n, "QQuickMouseArea");
// Parts of a control (its background, its indicator) carry the control's word in their type name.
const PART = /Cursor|(Background|Indicator|Icon|Loader|Text|Content|Label)$/;
const isStrong = (n) => !PART.test(shortType(n.type)) && (STRONG.test(shortType(n.type)) || (n.inherits || []).some((t) => STRONG.test(t)));
const clean = (s) => String(s ?? "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const ownLabel = (n) => clean(typeof n.text === "string" ? n.text : "") || clean(typeof n.title === "string" ? n.title : "") || clean(typeof n.label === "string" ? n.label : "");
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

// -> { window, elements, nodes (id -> record), modal, key }
export async function readScreen(bridge) {
  const reply = await bridge.send("getTree", { depth: 200 });
  if (reply.error) throw new Error(`Qt Inspector error: ${reply.error}`);
  // One request at a time: small replies sent back to back wait for each other on the socket.
  const checked = await ids(bridge, "checked", true);
  const focused = await ids(bridge, "activeFocus", true);
  const modalTrue = await ids(bridge, "modal", true);
  const opened = modalTrue.size ? await ids(bridge, "opened", true) : new Map();
  const modalPopups = [...modalTrue.values()].filter((p) => opened.has(String(p.id)));
  const modal = modalPopups.length ? modalPopups[modalPopups.length - 1] : null;

  // Pass 1: one record per object, with its place in the window.
  const nodes = new Map();
  let window = null;
  const build = (raw, parent, origin, visible, clip, flick, overlay, win) => {
    const id = String(raw.id);
    if (raw.id !== "" && nodes.has(id)) return null;
    const rec = { id, raw, parent, type: shortType(raw.type), objectName: raw.objectName || "", children: [], visible, enabled: raw.enabled !== false,
                  rect: null, clip, flick, overlay, win, item: false };
    if (raw.id !== "") nodes.set(id, rec);
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
    } else if (isItem(raw)) {
      rec.item = true;
      rec.visible = visible = visible && raw.visible !== false;
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
    for (const child of raw.children || []) {
      const c = build(child, rec, origin, visible, clip, flick, overlay, win);
      if (c) rec.children.push(c);
    }
    return rec;
  };
  const root = build(reply.tree, null, { x: 0, y: 0 }, true, null, null, false, null);

  const shown = (rec) => rec.item && rec.visible && rec.rect.w >= 2 && rec.rect.h >= 2;
  const place = (rec) => {
    const cx = rec.rect.x + rec.rect.w / 2, cy = rec.rect.y + rec.rect.h / 2;
    const inView = !!rec.clip && contains(rec.clip, cx, cy);
    // An element outside the visible part of a list can be reached by scrolling, if the list itself is on screen.
    const reachable = inView || (!!rec.flick && rec.flick.viewport.w > 0 && rec.flick.viewport.h > 0);
    return { inView, reachable };
  };

  // Pass 2: text fields. The editor is the object to click and type into; its wrapper carries the name and the label.
  const wrapperOf = new Map(); // wrapper id -> editor record
  for (const rec of nodes.values()) {
    if (!isEditor(rec.raw) || !shown(rec)) continue;
    let wrapper = rec, best = null;
    for (let p = rec.parent, depth = 0; p && p.item && depth < 10; p = p.parent, depth++) {
      if (!INPUT_WRAPPER.test(p.type)) continue;
      wrapper = p;
      if (p.objectName && !GENERIC_NAME.test(p.objectName)) { best = p; break; }
    }
    wrapper = best || wrapper;
    if (!wrapperOf.has(wrapper.id)) wrapperOf.set(wrapper.id, rec);
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
    const el = { id: rec.id, ref: "e" + rec.id, type: rec.type, objectName: GENERIC_NAME.test(rec.objectName) ? "" : rec.objectName, texts: [], label: "",
                 enabled: rec.enabled, checked: checked.has(rec.id), rect: rec.rect, flick: rec.flick, behindModal: !!modal && !rec.overlay, ...place(rec), ...fields };
    el.line = formatElement(el);
    elements.push(el);
  };
  const walk = (rec, quiet, owner = null) => {
    if (rec.item && !rec.visible) return;
    let childQuiet = quiet;
    if (wrapperOf.has(rec.id)) {
      const editor = wrapperOf.get(rec.id);
      const placeholderNode = [rec, ...descendants(rec)].find((n) => typeof n.raw.placeholderText === "string" && n.raw.placeholderText);
      const placeholder = placeholderNode ? clean(placeholderNode.raw.placeholderText) : "";
      const value = typeof editor.raw.text === "string" ? editor.raw.text : "";
      const texts = textsUnder(rec, [], (c) => c !== editor && nested(c)).filter((t) => t !== placeholder && t !== clean(value));
      // The wrapper's own "text" is the value, not the label.
      const named = rec !== editor ? clean(typeof rec.raw.label === "string" ? rec.raw.label : "") || clean(typeof rec.raw.title === "string" ? rec.raw.title : "") : "";
      const label = named || texts[0] || "";
      const target = shown(rec) ? rec : editor;
      emit(editor, { kind: "input", type: rec.type, objectName: GENERIC_NAME.test(rec.objectName) ? "" : rec.objectName, texts: label ? [label] : [], label,
                     value, placeholder, focused: focused.has(editor.id), enabled: editor.enabled && rec.enabled, rect: target.rect, ...place(target) });
      childQuiet = true;
    } else if (rec.item && shown(rec) && rec.viewport && rec.viewport.h > 0 && scrollRange(rec)) {
      // A list with more content than fits. Rows far outside the visible part do not exist until the list is scrolled.
      const range = scrollRange(rec);
      emit(rec, { kind: "scroll", scroll: range });
    } else if (rec.item && shown(rec) && isStrong(rec.raw)) {
      const texts = textsUnder(rec, [], nested);
      const own = ownLabel(rec.raw);
      if (own && !texts.includes(own)) texts.unshift(own);
      // A control with no text of its own that wraps another control is a shell: the inner one is listed.
      const shell = !texts.length && !!find(rec, nested);
      if (!shell) {
        const iconNode = texts.length ? null : find(rec, (c) => /-icon$/.test(c.objectName));
        // A switch inside a list row has no text of its own: the row says what it is for.
        const within = !texts.length && owner && owner.label ? owner.label : "";
        emit(rec, { kind: "control", texts, label: texts.join(" | "), within, icon: iconNode ? iconNode.objectName.replace(/-icon$/, "") : "" });
        childQuiet = true;
        owner = elements[elements.length - 1];
      }
    } else if (rec.item && shown(rec) && isMouseArea(rec.raw) && !quiet) {
      // A bare mouse area is an element only when it has a name or a text of its own.
      // One that wraps other controls is a container: its children are listed instead.
      const named = rec.objectName && !GENERIC_NAME.test(rec.objectName);
      const container = !!find(rec, (c) => nested(c) || isMouseArea(c.raw));
      const texts = container ? [] : textsUnder(rec, [], nested);
      if (named || texts.length) {
        emit(rec, { kind: "control", texts, label: texts.join(" | "), icon: "" });
        childQuiet = !container;
      }
    } else if (rec.item && shown(rec) && isText(rec.raw) && !quiet) {
      const t = clean(rec.raw.text);
      if (t) emit(rec, { kind: "text", texts: [t], label: t });
    }
    for (const c of rec.children) walk(c, childQuiet, owner);
  };
  if (root) walk(root, false);

  const listed = elements.filter((e) => e.reachable && !e.behindModal);
  const key = JSON.stringify([modal ? modal.id : null, listed.map((e) => [e.line, e.rect.x, e.rect.y, e.rect.w, e.rect.h])]);
  return { window, elements, nodes, modal, key, shown, place };
}

// -> { at, max } when the content of a scrollable item is higher than the item, else null.
function scrollRange(rec) {
  const content = rec.children.find((c) => c.item && !/ScrollBar|ScrollIndicator/.test(c.type));
  if (!content) return null;
  const max = Math.round(content.rect.h - rec.rect.h);
  if (max < 20) return null;
  return { at: Math.max(0, Math.round(rec.rect.y - content.rect.y)), max };
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
  if (el.objectName) line += ` objectName=${/\s/.test(el.objectName) ? JSON.stringify(el.objectName) : el.objectName}`;
  if (el.kind === "input") {
    line += ` value=${quote(el.value)}`;
    if (el.placeholder) line += ` placeholder=${quote(el.placeholder)}`;
  }
  if (el.icon) line += ` icon=${el.icon}`;
  if (el.kind === "scroll") {
    const more = [el.scroll.at > 1 ? "above" : "", el.scroll.at < el.scroll.max - 1 ? "below" : ""].filter(Boolean).join(" and ");
    line += ` scrollable: contentY=${el.scroll.at} of 0..${el.scroll.max}, more ${more}`;
  }
  const flags = [];
  if (el.checked) flags.push("checked");
  if (!el.enabled) flags.push("disabled");
  if (el.focused) flags.push("focused");
  if (!el.inView) flags.push("not in view");
  if (flags.length) line += ` (${flags.join(", ")})`;
  return line;
}

// A line for an object that is not in the list (a container, a hidden object, a match of a find tool).
export function formatObject(raw, extra = "") {
  let line = `[e${raw.id}] ${shortType(raw.type)}`;
  const label = ownLabel(raw) || clean(typeof raw.placeholderText === "string" ? raw.placeholderText : "");
  if (label) line += ` ${quote(label)}`;
  if (raw.objectName) line += ` objectName=${/\s/.test(raw.objectName) ? JSON.stringify(raw.objectName) : raw.objectName}`;
  if (extra) line += ` ${extra}`;
  const flags = [];
  if (raw.visible === false) flags.push("hidden");
  if (raw.enabled === false) flags.push("disabled");
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
