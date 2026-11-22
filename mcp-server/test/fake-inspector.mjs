// A stand-in for the inspector plugin: the same JSON-lines protocol on a local socket,
// served from a small object tree that the test builds. No Qt and no app are needed.
//
// It can stand in for two plugins (fake.plugin):
//   "old": the plugin before version 2.0, as in the test builds of the app so far. Its tree has no states,
//          and it sends the text of password fields.
//          A popup object (a dialog, a menu, a drawer) is not in its tree: that plugin lists the child items of an item only.
//          A search (findByProperty) finds it all the same.
//   "new": the plugin with the token check and the password hiding. Its tree carries the states (checked, activeFocus, popup,
//          scroll position), and it leaves out what password fields hold: a hidden value is null, and the reply
//          says how many were hidden (hiddenCount), see qt-plugin/inspectorserver.cpp.
//
// Like the real plugin:
//   - A click goes to a position, not to an object: when an open popup lies over the middle of the object, the popup gets
//     the click (fake.popupClicks) and the object does not.
//   - Text is typed one key per UTF-16 unit (fake.keyEvents counts them).
//   - The app can change between two requests of one tool call: fake.beforeCommand(command, params) runs before each
//     request and may change the tree; fake.closeAfter(request) closes the connection after the reply to that request;
//     fake.noReply(command, params) leaves a request without a reply.
import net from "node:net";

let nextId = 1;

// node("StatusButton", { objectName: "btnSave", text: "Save", w: 80, h: 30 }, [children])
export function node(type, opts = {}, children = []) {
  const { inherits = [], objectName = "", visible = true, enabled = true, x = 0, y = 0, w = 100, h = 20,
          props = {}, onClick = null, methods = {}, id = null, ...identifying } = opts;
  const n = { id: id === null ? String(nextId++) : String(id), type, inherits, objectName, visible, enabled, x, y, w, h,
              props: { ...props }, onClick, methods, identifying, children: [], parent: null };
  for (const c of children) add(n, c);
  return n;
}

export function add(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

const isWindow = (n) => n.type.includes("Window");
const isPopup = (n) => n.inherits.includes("QQuickPopup");
const isItem = (n) => !isWindow(n) && !isPopup(n) && n.type !== "QGuiApplication";
const isEchoField = (n) => n.inherits.includes("QQuickTextInput") || n.inherits.includes("QLineEdit");
const hidesText = (n) => isEchoField(n) && !!n.props.echoMode;
const TYPED_TEXT = ["text", "displayText", "selectedText", "preeditText"];

export class FakeInspector {
  constructor(root) {
    this.root = root;
    this.log = [];            // every command received: { command, params }
    this.focus = null;        // id of the object that has the keyboard focus
    this.selectedAll = false;
    this.server = null;
    this.sockets = new Set();
    this.delayMs = 0;
    this.stealPresses = 0;    // this many of the next mouse presses go to another item, as when an overlay takes the tap
    this.onStolenClick = null;
    this.plugin = "old";      // "old" or "new", see the top of this file
    this.connections = 0;     // sockets accepted so far
    this.requests = [];       // every request line received, the token check included
    this.splitCharacters = false; // when set, a reply is written in pieces that split its characters of several bytes
    this.failCommands = [];   // commands that are answered with an error
    this.token = "";          // when set, a connection must send the auth command with this token first
    this.oldPlugin = false;   // a plugin from before the token check: it does not know the auth command
    this.auths = 0;           // connections that passed the token check
    this.dialogs = [];        // file dialogs, for listFileDialogs
    this.beforeCommand = null; // (command, params) => {}: runs before each request, may change the tree
    this.closeAfter = null;    // (request) => true: the connection is closed after the reply to this request
    this.noReply = null;       // (command, params) => true: this request gets no reply
    this.popupClicks = [];     // clicks that an open popup took: { popup, wanted }
    this.keyEvents = 0;        // keys sent as text, one per UTF-16 unit
    this.evaluateError = null; // when set, evaluate fails with this text
    this.hiddenCount = 0;      // "new": values hidden in the reply of the command that runs
  }

  // -- tree helpers
  *all(n = this.root) {
    yield n;
    for (const c of n.children) yield* this.all(c);
  }
  get(id) {
    for (const n of this.all()) if (n.id === String(id)) return n;
    return null;
  }
  byName(name) {
    for (const n of this.all()) if (n.objectName === name) return n;
    return null;
  }
  remove(n) {
    n.parent.children = n.parent.children.filter((c) => c !== n);
    n.parent = null;
  }
  effectiveVisible(n) {
    for (let p = n; p; p = p.parent) if (!p.visible) return false;
    return true;
  }
  effectiveEnabled(n) {
    for (let p = n; p; p = p.parent) if (!p.enabled) return false;
    return true;
  }
  scene(n) {
    let x = 0, y = 0;
    for (let p = n; p && !isWindow(p); p = p.parent) { x += p.x; y += p.y; }
    return { x, y };
  }
  commands(name) {
    return this.log.filter((e) => e.command === name);
  }
  // The open popup item that lies over the middle of an object, or null. The real plugin sends a click to a position
  // in the window; the item on top at that position gets it. Popup items are children of the overlay; a later one is on top.
  coveringPopup(n) {
    const inside = (a, b) => { for (let p = a; p; p = p.parent) if (p === b) return true; return false; };
    const at = this.scene(n);
    const cx = at.x + n.w / 2, cy = at.y + n.h / 2;
    let own = -1, cover = null;
    const items = [...this.all()].filter((p) => p.type.includes("PopupItem") && this.effectiveVisible(p) && p.parent && p.parent.type.includes("Overlay"));
    items.forEach((p, k) => { if (inside(n, p)) own = k; });
    items.forEach((p, k) => {
      const s = this.scene(p);
      if (k > own && !inside(n, p) && cx >= s.x && cx <= s.x + p.w && cy >= s.y && cy <= s.y + p.h) cover = p;
    });
    return cover;
  }

  // The texts that password fields hold now.
  secrets() {
    const out = new Set();
    for (const n of this.all()) if (hidesText(n) && n.identifying.text) out.add(n.identifying.text);
    return out;
  }
  // The popup that owns a popup item. In these trees the popup object is a child of its item, or its parent.
  ownerOf(n) {
    if (!n.type.includes("PopupItem")) return null;
    return n.children.find(isPopup) || (n.owner && isPopup(n.owner) ? n.owner : null) || (n.parent && isPopup(n.parent) ? n.parent : null);
  }

  // -- protocol
  serialize(n, maxDepth, depth) {
    const out = { id: n.id, type: n.type, objectName: n.objectName, inherits: n.inherits };
    const fresh = this.plugin === "new";
    const secrets = fresh ? this.secretsNow || this.secrets() : new Set();
    // The plugin before the token check lists the child items of an item only: a popup object is not among them.
    const listed = fresh || !isItem(n) ? n.children : n.children.filter((c) => !isPopup(c));
    if (isWindow(n)) {
      Object.assign(out, { visible: n.visible, active: true, geometry: { x: n.x, y: n.y, width: n.w, height: n.h } });
    } else if (isItem(n)) {
      Object.assign(out, { visible: this.effectiveVisible(n), enabled: this.effectiveEnabled(n), opacity: 1,
                           geometry: { x: n.x, y: n.y, width: n.w, height: n.h } });
    }
    for (const [k, v] of Object.entries(n.identifying)) {
      if (v === "" || v == null) continue;
      if (fresh && ((hidesText(n) && TYPED_TEXT.includes(k)) || secrets.has(v))) { out.secret = true; this.hiddenCount++; }
      else out[k] = v;
    }
    let children = listed;
    if (fresh) {
      if (isEchoField(n)) {
        out.echoMode = n.props.echoMode || 0;
        if (hidesText(n)) Object.assign(out, { secret: true, textLength: (n.identifying.text || "").length });
      }
      if (isItem(n)) {
        if (this.focus === n.id) out.activeFocus = true;
        if (n.props.checked === true && this.effectiveVisible(n)) out.checked = true;
      }
      if (isPopup(n)) Object.assign(out, { modal: !!n.props.modal, opened: !!n.props.opened });
      const owner = this.ownerOf(n);
      if (owner) {
        out.popup = { id: owner.id, type: owner.type, objectName: owner.objectName, modal: !!owner.props.modal, opened: !!owner.props.opened };
        if (owner.identifying.title) out.popup.title = owner.identifying.title;
        children = children.filter((c) => c !== owner);
      }
      if (n.inherits.includes("QQuickFlickable")) {
        for (const k of ["contentX", "contentY", "contentWidth", "contentHeight", "originX", "originY"]) out[k] = n.props[k] || 0;
      }
    }
    if (depth < maxDepth) {
      out.children = children.map((c) => this.serialize(c, maxDepth, depth + 1));
    }
    out.childCount = listed.length;
    return out;
  }
  value(n, property) {
    if (property === "objectName") return n.objectName;
    if (property === "visible") return isItem(n) || isWindow(n) ? this.effectiveVisible(n) : n.props.visible;
    if (property === "enabled") return isItem(n) ? this.effectiveEnabled(n) : undefined;
    if (property === "width") return n.w;
    if (property === "height") return n.h;
    if (property === "x") return n.x;
    if (property === "y") return n.y;
    if (property === "activeFocus") return this.focus === n.id;
    // Every Qt text field has the property; 0 (Normal) shows the text.
    if (property === "echoMode" && isEchoField(n)) return n.props.echoMode || 0;
    if (property in n.identifying) return n.identifying[property];
    return n.props[property];
  }
  handle(command, params) {
    if (this.beforeCommand) this.beforeCommand(command, params);
    this.log.push({ command, params });
    this.hiddenCount = 0;
    if (this.failCommands.includes(command)) throw new Error(`${command} failed`);
    const fresh = this.plugin === "new";
    const secrets = fresh ? this.secrets() : new Set();
    this.secretsNow = secrets; // for serialize(), during this command
    const hidden = (n, property, v) => fresh && ((hidesText(n) && TYPED_TEXT.includes(property)) || (typeof v === "string" && secrets.has(v)));
    // As the plugin does: the text of a password field inside a list or a map is null, and it is counted.
    const count = () => { this.hiddenCount++; return null; };
    const deep = (v) => (typeof v === "string" ? (secrets.has(v) ? count() : v) : Array.isArray(v) ? v.map(deep)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
    const holds = (v) => (typeof v === "string" ? secrets.has(v) : Array.isArray(v) ? v.some(holds) : v && typeof v === "object" ? Object.values(v).some(holds) : false);
    const holdsSecret = holds;
    const target = () => {
      const n = this.get(params.objectId);
      if (!n) throw new Error("Object not found: " + params.objectId);
      return n;
    };
    switch (command) {
      case "getTree": {
        const depth = params.depth ?? 4;
        const tree = this.serialize(params.objectId ? target() : this.root, depth, 0);
        return fresh ? { tree, states: true } : { tree };
      }
      case "findByProperty": {
        const matches = [];
        const seeds = params.objectId ? [target()] : [this.root];
        for (const seed of seeds) for (const n of this.all(seed)) {
          const v = this.value(n, params.property);
          if (v === undefined) continue;
          if (hidden(n, params.property, v)) {
            this.hiddenCount++;
            if (!("value" in params)) matches.push({ ...this.serialize(n, 0, 0), value: null, hidden: true });
            continue;
          }
          // A list that holds a hidden text is never compared either.
          if (fresh && "value" in params && holdsSecret(v)) { this.hiddenCount++; continue; }
          if ("value" in params && v !== params.value && String(v) !== String(params.value)) continue;
          matches.push({ ...this.serialize(n, 0, 0), value: fresh ? deep(v) : v });
        }
        return { matches, count: matches.length };
      }
      case "findByType": {
        const matches = [...this.all()].filter((n) => n.type.split("_QMLTYPE_")[0].endsWith(params.typeName)).map((n) => this.serialize(n, 0, 0));
        return { matches, count: matches.length };
      }
      case "getProperties": {
        const n = target();
        let names = ["objectName", "visible", "enabled", "width", "height", "x", "y", "activeFocus",
                       ...Object.keys(n.identifying), ...Object.keys(n.props)];
        // The plugin from 2.0 on reads only the properties it is asked for.
        if (fresh && Array.isArray(params.names)) names = names.filter((name) => params.names.includes(name));
        this.propertyReads = (this.propertyReads || 0) + new Set(names).size;
        return { id: n.id, type: n.type,
                 properties: [...new Set(names)].map((name) => {
                   const value = this.value(n, name) ?? null;
                   const p = { name, type: typeof value === "boolean" ? "bool" : typeof value === "number" ? "double" : "QString", value, writable: !["width", "height"].includes(name) };
                   if (hidden(n, name, value)) return { ...p, value: count(), hidden: true };
                   if (fresh) p.value = deep(value);
                   return p;
                 }),
                 methods: Object.keys(n.methods).map((name) => ({ name, signature: `${name}()`, returnType: "void", kind: "method" })) };
      }
      case "setProperty": {
        const n = target();
        if (params.property in n.identifying) n.identifying[params.property] = params.value;
        else n.props[params.property] = params.value;
        // A flickable moves its content item.
        if (params.property === "contentY" && n.children[0]) n.children[0].y = -params.value;
        if (params.property === "contentX" && n.children[0]) n.children[0].x = -params.value;
        return { set: true };
      }
      case "geometry": {
        const n = target();
        const s = this.scene(n);
        return { sceneX: s.x, sceneY: s.y, globalX: s.x, globalY: s.y, width: n.w, height: n.h };
      }
      case "click": {
        if (!params.objectId) return { clicked: true, x: params.x, y: params.y };
        const n = target();
        // The click goes to the middle of the object. An open popup that lies there takes it.
        const cover = this.coveringPopup(n);
        if (cover) {
          this.popupClicks.push({ popup: cover.id, wanted: n.id });
          if (cover.onClick) cover.onClick(this, cover);
          return { clicked: true, x: 0, y: 0 };
        }
        if (n.inherits.includes("QQuickTextEdit") || n.inherits.includes("QQuickTextInput")) this.focus = n.id;
        if (n.onClick) n.onClick(this, n);
        return { clicked: true, x: 0, y: 0 };
      }
      case "sendKeys": {
        const n = params.objectId ? target() : this.get(this.focus);
        if (params.objectId) this.focus = n.id;
        if (params.key) {
          if (params.key === "Ctrl+A") this.selectedAll = true;
          else if (params.key === "Backspace" && n) {
            n.identifying.text = this.selectedAll ? "" : (n.identifying.text || "").slice(0, -1);
            this.selectedAll = false;
          }
          return { key: params.key, target: "window" };
        }
        // One key per UTF-16 unit, as the plugin sends them: a character outside the basic plane is two keys.
        this.keyEvents += params.text.length;
        if (n) {
          n.identifying.text = (this.selectedAll ? "" : n.identifying.text || "") + params.text;
          this.selectedAll = false;
        }
        return { sent: params.text, target: "window" };
      }
      case "mouse": {
        const n = target();
        if (params.action === "move") {
          // The mouse is over the object now (a tooltip of another object goes away, for example).
          if (this.onHover) this.onHover(this, n);
        } else if (params.action === "press") {
          const cover = this.coveringPopup(n);
          if (cover) { this.popupClicks.push({ popup: cover.id, wanted: n.id }); this.stolen = true; }
          else if (this.stealPresses > 0) { this.stealPresses--; this.stolen = true; }
          else n.props.pressed = true;
        } else if (params.action === "release") {
          if (this.stolen) { this.stolen = false; if (this.onStolenClick) this.onStolenClick(this, n); }
          else if (n.props.pressed) { n.props.pressed = false; if (n.onClick) n.onClick(this, n); }
        }
        return { action: params.action, x: 0, y: 0 };
      }
      case "callMethod": {
        const n = target();
        const method = n.methods[params.method];
        const result = method ? method(this, n, ...(params.args || [])) ?? null : null;
        return { result: fresh ? deep(result) : result };
      }
      case "evaluate": {
        if (this.evaluateError !== null) {
          // The plugin with the password hiding takes every password text out of the error text.
          let message = String(this.evaluateError);
          if (fresh) for (const secret of secrets) message = message.split(secret).join("(hidden)");
          throw new Error("Evaluation error: " + message);
        }
        const result = this.evaluateResult ?? null;
        return { result: fresh ? deep(result) : result, undefined: false };
      }
      case "screenshot":
        return { image: Buffer.from("fake png bytes").toString("base64"), width: 800, height: 600, format: "png" };
      case "fileDialogAction":
        target();
        return {};
      case "listFileDialogs":
        return { dialogs: this.dialogs.map((d) => this.serialize(d, 50, 0)) };
      default:
        throw new Error("Unknown command: " + command);
    }
  }

  async listen(port = 0, host = "127.0.0.1") {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      this.connections++;
      socket.setNoDelay(true);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = "";
      let authed = false;
      let ended = false;
      socket.on("data", (chunk) => {
        if (ended) return;
        buffer += chunk.toString("utf-8");
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          this.requests.push(request);
          if (!this.oldPlugin && (request.command === "auth" || (this.token && !authed))) {
            // The same rule as the plugin: the token first, and the connection is closed on a miss.
            const good = !this.token || (request.command === "auth" && (request.params || {}).token === this.token);
            if (good) {
              authed = true;
              if (this.token) this.auths++;
              socket.write(JSON.stringify({ id: request.id, ok: true, auth: this.token ? "accepted" : "not required" }) + "\n");
              continue;
            }
            const error = request.command === "auth" ? "Authentication failed: wrong token" : "Authentication required: send the auth command with the token first";
            socket.end(JSON.stringify({ id: request.id, error }) + "\n");
            return;
          }
          if (this.noReply && this.noReply(request.command, request.params || {})) {
            this.log.push({ command: request.command, params: request.params || {}, unanswered: true });
            continue;
          }
          let reply;
          try {
            reply = { ...this.handle(request.command, request.params || {}), ok: true };
          } catch (err) {
            reply = { error: err.message };
          }
          reply.id = request.id;
          if (this.plugin === "new" && reply.ok) reply.secretsHidden = true;
          if (this.plugin === "new" && this.hiddenCount > 0) reply.hiddenCount = this.hiddenCount;
          if (this.closeAfter && this.closeAfter(request)) {
            ended = true;
            socket.end(JSON.stringify(reply) + "\n");
            return;
          }
          const send = async () => {
            const bytes = Buffer.from(JSON.stringify(reply) + "\n", "utf8");
            if (!this.splitCharacters) return socket.write(bytes);
            // In pieces that end in the middle of a character of several bytes, with a pause, so that each piece arrives alone.
            const cuts = [];
            for (let at = 1; at < bytes.length && cuts.length < 12; at++) if ((bytes[at] & 0xc0) === 0x80 && (bytes[at - 1] & 0x80)) cuts.push(at++);
            let from = 0;
            for (const at of [...cuts, bytes.length]) {
              socket.write(bytes.subarray(from, at));
              from = at;
              await new Promise((resolve) => setTimeout(resolve, 4));
            }
          };
          if (this.delayMs) setTimeout(send, this.delayMs); else send();
        }
      });
    });
    await new Promise((resolve) => this.server.listen(port, host, resolve));
    return this.server.address().port;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
