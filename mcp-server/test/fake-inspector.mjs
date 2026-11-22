// A stand-in for the inspector plugin: the same JSON-lines protocol on a local socket,
// served from a small object tree that the test builds. No Qt and no app are needed.
import net from "node:net";

let nextId = 1;

// node("StatusButton", { objectName: "btnSave", text: "Save", w: 80, h: 30 }, [children])
export function node(type, opts = {}, children = []) {
  const { inherits = [], objectName = "", visible = true, enabled = true, x = 0, y = 0, w = 100, h = 20,
          props = {}, onClick = null, methods = {}, ...identifying } = opts;
  const n = { id: String(nextId++), type, inherits, objectName, visible, enabled, x, y, w, h,
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
const isItem = (n) => !isWindow(n) && !n.inherits.includes("QQuickPopup") && n.type !== "QGuiApplication";

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
    this.token = "";          // when set, a connection must send the auth command with this token first
    this.oldPlugin = false;   // a plugin from before the token check: it does not know the auth command
    this.auths = 0;           // connections that passed the token check
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

  // -- protocol
  serialize(n, maxDepth, depth) {
    const out = { id: n.id, type: n.type, objectName: n.objectName, inherits: n.inherits };
    if (isWindow(n)) {
      Object.assign(out, { visible: n.visible, active: true, geometry: { x: n.x, y: n.y, width: n.w, height: n.h } });
    } else if (isItem(n)) {
      Object.assign(out, { visible: this.effectiveVisible(n), enabled: this.effectiveEnabled(n), opacity: 1,
                           geometry: { x: n.x, y: n.y, width: n.w, height: n.h } });
    }
    for (const [k, v] of Object.entries(n.identifying)) if (v !== "" && v != null) out[k] = v;
    if (depth < maxDepth) {
      out.children = n.children.map((c) => this.serialize(c, maxDepth, depth + 1));
    }
    out.childCount = n.children.length;
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
    if (property in n.identifying) return n.identifying[property];
    return n.props[property];
  }
  handle(command, params) {
    this.log.push({ command, params });
    const target = () => {
      const n = this.get(params.objectId);
      if (!n) throw new Error("Object not found: " + params.objectId);
      return n;
    };
    switch (command) {
      case "getTree": {
        const depth = params.depth ?? 4;
        if (params.objectId) return { tree: this.serialize(target(), depth, 0) };
        return { tree: this.serialize(this.root, depth, 0) };
      }
      case "findByProperty": {
        const matches = [];
        const seeds = params.objectId ? [target()] : [this.root];
        for (const seed of seeds) for (const n of this.all(seed)) {
          const v = this.value(n, params.property);
          if (v === undefined) continue;
          if ("value" in params && v !== params.value && String(v) !== String(params.value)) continue;
          matches.push({ ...this.serialize(n, 0, 0), value: v });
        }
        return { matches, count: matches.length };
      }
      case "findByType": {
        const matches = [...this.all()].filter((n) => n.type.split("_QMLTYPE_")[0].endsWith(params.typeName)).map((n) => this.serialize(n, 0, 0));
        return { matches, count: matches.length };
      }
      case "getProperties": {
        const n = target();
        const names = ["objectName", "visible", "enabled", "width", "height", "x", "y", "activeFocus",
                       ...Object.keys(n.identifying), ...Object.keys(n.props)];
        return { id: n.id, type: n.type,
                 properties: [...new Set(names)].map((name) => ({ name, type: "QVariant", value: this.value(n, name) ?? null, writable: true })),
                 methods: [] };
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
        if (n) {
          n.identifying.text = (this.selectedAll ? "" : n.identifying.text || "") + params.text;
          this.selectedAll = false;
        }
        return { sent: params.text, target: "window" };
      }
      case "mouse": {
        const n = target();
        if (params.action === "press") {
          if (this.stealPresses > 0) { this.stealPresses--; this.stolen = true; }
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
        return { result: method ? method(this, n, ...(params.args || [])) ?? null : null };
      }
      case "evaluate":
        return { result: this.evaluateResult ?? null, undefined: false };
      case "screenshot":
        return { image: Buffer.from("fake png bytes").toString("base64"), width: 800, height: 600, format: "png" };
      case "listFileDialogs":
        return { dialogs: [], count: 0 };
      default:
        throw new Error("Unknown command: " + command);
    }
  }

  async listen() {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.setNoDelay(true);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = "";
      let authed = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const request = JSON.parse(line);
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
          let reply;
          try {
            reply = { ...this.handle(request.command, request.params || {}), ok: true };
          } catch (err) {
            reply = { error: err.message };
          }
          reply.id = request.id;
          const send = () => socket.write(JSON.stringify(reply) + "\n");
          if (this.delayMs) setTimeout(send, this.delayMs); else send();
        }
      });
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return this.server.address().port;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
