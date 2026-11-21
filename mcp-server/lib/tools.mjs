// The MCP tools. Each tool call becomes one or more commands to the inspector plugin.
// The tools that act on an object check the object first and reply with what changed on the screen.
import { readScreen, listedElements, modalLine, formatObject, shortType } from "./screen.mjs";

export const MAX_REPLY_CHARS = 8000;
const NOTE_ROOM = 400; // kept free for the note that says what was cut

export const INSTRUCTIONS =
  "Act by object, not by picture. " +
  "qml_snapshot lists what is on the screen as text: one line per element, with a reference such as [e12]. " +
  "Use the reference (or an objectName, or the visible text) with qml_click and qml_send_keys. " +
  "Each of these actions replies with the lines that changed on the screen, so the reply already tells you whether the step worked. " +
  "Take a screenshot only when you must judge how something looks (layout, colour, an image); it costs more than a snapshot and gives no references.";

const TARGET = {
  ref: { type: "string", description: "Reference of the element from qml_snapshot, for example 'e12'" },
  objectName: { type: "string", description: "objectName of the element, as shown in qml_snapshot" },
  objectId: { type: "string", description: "Object ID (the reference without the 'e')" },
};

export const TOOLS = [
  {
    name: "qml_snapshot",
    description:
      "START HERE. Lists what is on the screen now as short text: one line per button, input field, switch, list row and text, " +
      "with a reference like [e12], the visible label, the objectName, the value of text fields, and marks such as (checked), (disabled), (not in view). " +
      "Cheaper and more exact than a screenshot. Use the reference with qml_click and qml_send_keys. " +
      "If a modal popup is open, only the popup is listed. " +
      "Lines marked (in closed drawer) are in a navigation drawer that is closed now: click them like any other line, the drawer is opened first. " +
      "A line marked 'scrollable' is a list with more rows than fit: rows far outside its visible part are not listed until you scroll it " +
      "with qml_set_property {ref, property: \"contentY\", value}.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional: list only the lines that contain this text (case-insensitive)" },
      },
    },
  },
  {
    name: "qml_click",
    description:
      "Click one element. Name it with ONE of: ref (from qml_snapshot), objectName, or text (the exact visible label). " +
      "The element is checked first: no match, more than one match, a hidden or disabled element, or one behind a popup is an error and nothing is clicked. " +
      "An element that is scrolled out of view is scrolled into view first, and a closed drawer is opened first. " +
      "The reply lists what changed on the screen after the click, so no screenshot is needed to check it. " +
      "Clicking by (x, y) pixel coordinates relative to the main window is also possible, but it is not checked and reports no changes.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
        text: { type: "string", description: "Exact visible label of the element to click" },
        x: { type: "number", description: "X coordinate (pixels)" },
        y: { type: "number", description: "Y coordinate (pixels)" },
      },
    },
  },
  {
    name: "qml_send_keys",
    description:
      "Type text or press a key. With ref or objectName of a text field: the field gets the focus first and the reply gives the value of the field afterwards. " +
      "clear: true empties the field before typing (use it alone to clear a field). " +
      "key sends one named key such as 'Return', 'Escape', 'Tab', 'Backspace', 'Ctrl+A'. " +
      "Without a target the keys go to the element that has the focus. The reply lists what changed on the screen.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        key: { type: "string", description: "One named key or shortcut, for example 'Return' or 'Ctrl+A'" },
        clear: { type: "boolean", description: "Empty the field first (needs a target)" },
        ...TARGET,
      },
    },
  },
  {
    name: "qml_wait_for",
    description:
      "Wait until an element with this text or objectName is on the screen (or, with state 'gone', until it is not). " +
      "Use it after an action that takes time, instead of repeated snapshots or screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text to wait for (case-insensitive, may be a part of the label)" },
        objectName: { type: "string", description: "objectName to wait for" },
        state: { type: "string", enum: ["present", "gone"], description: "Default 'present'" },
        timeout_ms: { type: "number", description: "Default 5000, at most 30000" },
      },
    },
  },
  {
    name: "qml_find_and_click",
    description:
      "Find an element by its text label and click it. Partial, case-insensitive match by default. " +
      "Exactly one element must match: no match or several matches is an error and nothing is clicked. " +
      "The reply lists what changed on the screen. Same checks as qml_click.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to search for (case-insensitive partial match by default)" },
        type: { type: "string", description: "Optional type filter (e.g. 'Button', 'Delegate'). Matches a part of the type name." },
        exact: { type: "boolean", description: "If true, require exact text match instead of partial (default false)" },
      },
      required: ["text"],
    },
  },
  {
    name: "qml_list_interactive",
    description:
      "List the interactive elements on the screen (buttons, inputs, list rows and so on), one short line each, with references. " +
      "Same format as qml_snapshot, without the plain texts. Prefer qml_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional: list only the lines that contain this text" },
      },
    },
  },
  {
    name: "qml_screenshot",
    description:
      "Take a screenshot of the Qt application window (or a specific widget). Returns a PNG image. " +
      "Use it only to check how the screen looks. To find elements or to check the result of an action, use qml_snapshot: it is cheaper and gives references.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "Optional widget ID to screenshot (defaults to main window)" },
      },
    },
  },
  {
    name: "qml_find_by_type",
    description:
      "Find all QML/Qt objects matching a type name (exact or suffix match, e.g. 'Button' matches 'QQuickButton'), hidden ones too. " +
      "One line per object. Marks: (hidden), (not on screen) for an object outside the window. No match is an error.",
    inputSchema: {
      type: "object",
      properties: { typeName: { type: "string", description: "Class/type name to search for" } },
      required: ["typeName"],
    },
  },
  {
    name: "qml_find_by_property",
    description:
      "Find all objects that have a given property, optionally matching a specific value, hidden ones too. " +
      "One line per object. Marks: (hidden), (not on screen) for an object outside the window. No match is an error.",
    inputSchema: {
      type: "object",
      properties: {
        property: { type: "string", description: "Property name" },
        value: { description: "Optional value to match" },
      },
      required: ["property"],
    },
  },
  {
    name: "qml_get_properties",
    description:
      "Get properties of one object, as 'name = value' lines. Pass names to get only those properties; without names the list is long and may be cut.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
        names: { type: "array", items: { type: "string" }, description: "Property names to return, for example ['checked', 'text']" },
      },
    },
  },
  {
    name: "qml_set_property",
    description: "Set a property value on a Qt/QML object. The reply lists what changed on the screen.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
        property: { type: "string", description: "Property name" },
        value: { description: "New value (JSON-compatible)" },
      },
      required: ["property", "value"],
    },
  },
  {
    name: "qml_call_method",
    description: "Call a Q_INVOKABLE method or slot on a Qt/QML object. The reply lists what changed on the screen.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
        method: { type: "string", description: "Method name" },
        args: { type: "array", description: "Arguments to pass", items: {} },
      },
      required: ["method"],
    },
  },
  {
    name: "qml_evaluate",
    description:
      "Evaluate a JavaScript expression in the QML engine context. " +
      "Useful for reading computed values, calling JS functions, or debugging QML logic.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate" },
        objectId: { type: "string", description: "Optional: evaluate in context of this object" },
      },
      required: ["expression"],
    },
  },
  {
    name: "qml_get_tree",
    description:
      "Get the raw QML/Qt object tree as JSON: type, id, objectName, geometry, visibility and children. " +
      "It is large and is cut at the size limit: pass an objectId and a small depth. For what is on the screen, use qml_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "ID of the root object to start from (omit for full tree)" },
        depth: { type: "number", description: "Maximum depth to traverse (default 4)" },
      },
    },
  },
  {
    name: "qml_list_file_dialogs",
    description:
      "Lists file dialogs currently present in the application. For each dialog returns its " +
      "type, id, objectName, visibility, and children. Note that some dialog types may be " +
      "listed even while they are not visible/active. " +
      "Workflow note: due to Qt limitations, the file selection often cannot be changed once a " +
      "dialog is active. To select a file, call `file_dialog_actions` with action `select` BEFORE " +
      "performing the step that opens the dialog (e.g. clicking the button that triggers it), not after.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "qml_file_dialog_action",
    description: "Interacts with an existing file dialog.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "ID of the dialog object to interact with." },
        action: {
          type: "string",
          enum: ["accept", "cancel", "select"],
          description:
            "Action to perform on the dialog. 'accept' confirms the selection, 'cancel' dismisses the dialog, " +
            "'select' selects a file/directory (requires a path to be provided).",
        },
        path: { type: "string", description: "Path to select (for 'select' action)." },
      },
      required: ["objectId", "action"],
    },
  },
];

class ToolError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: cut(text, "") }], isError: true });

// Keeps a reply under the limit. Whole lines are dropped from the end and a note says how many and what to do.
export function cut(text, hint) {
  if (text.length <= MAX_REPLY_CHARS) return text;
  const lines = text.split("\n");
  const kept = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_REPLY_CHARS - NOTE_ROOM) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (kept.length < 2) {
    const head = text.slice(0, MAX_REPLY_CHARS - NOTE_ROOM);
    return `${head}\n… cut: ${text.length - head.length} more characters not shown. ${hint}`.slice(0, MAX_REPLY_CHARS);
  }
  const more = lines.length - kept.length;
  return `${kept.join("\n")}\n… ${more} more line${more === 1 ? "" : "s"} not shown. ${hint}`.slice(0, MAX_REPLY_CHARS);
}

export function createToolset({ bridge, settleIntervalMs = 150, settleTimeoutMs = 3000 } = {}) {
  const drawers = new Map(); // object id -> is it a drawer; see readScreen
  const send = async (command, params = {}) => {
    const reply = await bridge.send(command, params);
    if (reply.error) throw new ToolError(`Qt Inspector error: ${reply.error}`);
    return reply;
  };

  // Reads the screen until two reads in a row are the same, so that an animation or a page change is over.
  async function settled() {
    const end = Date.now() + settleTimeoutMs;
    let screen = await readScreen(bridge, drawers);
    for (;;) {
      await sleep(settleIntervalMs);
      const next = await readScreen(bridge, drawers);
      const same = next.key === screen.key;
      screen = next;
      if (same || Date.now() >= end) return screen;
    }
  }

  function snapshotText(screen, options = {}) {
    const list = listedElements(screen, options);
    const head = [];
    if (screen.window) head.push(`Window ${JSON.stringify(screen.window.title)} ${screen.window.w}x${screen.window.h}, ${list.length} element${list.length === 1 ? "" : "s"}${options.filter ? ` with ${JSON.stringify(options.filter)}` : ""}.`);
    if (screen.modal) head.push(modalLine(screen));
    return cut([...head, ...list.map((e) => e.line)].join("\n"),
               'Narrow it: qml_snapshot {filter: "word"} lists only the lines that contain the word.');
  }

  // What an agent needs to know after an action: the lines that are new, gone or different.
  function changes(before, after) {
    const old = new Map(listedElements(before).map((e) => [e.ref, e.line]));
    const now = listedElements(after);
    const lines = [];
    if (modalLine(before) !== modalLine(after)) lines.push(modalLine(after) || "The modal popup is closed.");
    for (const e of now) {
      if (!old.has(e.ref)) lines.push(`new: ${e.line}`);
      else if (old.get(e.ref) !== e.line) lines.push(`changed: ${e.line}`);
    }
    const nowRefs = new Set(now.map((e) => e.ref));
    const gone = [...old].filter(([ref]) => !nowRefs.has(ref)).map(([, line]) => `gone: ${line}`);
    if (!lines.length && !gone.length) return "Nothing on the screen changed.";
    if (lines.length + gone.length > 30) return `The screen changed. It now shows:\n${snapshotText(after)}`;
    // When a page is replaced, the old lines are of no use: the count is enough.
    const left = gone.length > 5 ? [`gone: ${gone.length} elements that were on the screen before`] : gone;
    return ["Changed on the screen:", ...lines, ...left].join("\n");
  }

  const idOf = (args) => {
    const raw = args.ref ?? args.objectId;
    return raw === undefined || raw === null || raw === "" ? null : String(raw).replace(/^\[?e?(\d+)\]?$/, "$1");
  };

  // A tree object that is not a line of the list (a container, an inner part), as an element.
  function pseudo(screen, rec) {
    const base = { id: rec.id, ref: "e" + rec.id, type: rec.type, objectName: rec.objectName, kind: "object", texts: [], label: "", enabled: rec.enabled,
                   rect: rec.rect, flick: rec.flick, behindModal: !!screen.modal && !rec.overlay, visible: screen.shown(rec),
                   ...(rec.rect ? screen.place(rec) : { inView: false, reachable: false, drawerId: null }) };
    base.line = formatObject(rec.raw);
    return base;
  }

  // -> the one element the arguments name. Throws a ToolError that says what is wrong.
  function resolve(screen, args, { partial = false, type = "" } = {}) {
    const id = idOf(args);
    const ways = [id !== null, !!args.objectName, typeof args.text === "string" && args.text !== ""].filter(Boolean).length;
    if (ways !== 1) throw new ToolError("Name the target with exactly one of: ref, objectName, text.");
    if (id !== null) {
      const el = screen.elements.find((e) => e.id === id);
      if (el) return el;
      const rec = screen.nodes.get(id);
      if (!rec) throw new ToolError(`[e${id}] no longer exists: the screen has changed. Call qml_snapshot for the current references.`);
      if (!rec.item) throw new ToolError(`[e${id}] ${rec.type} is not a visual element.`);
      if (!screen.shown(rec)) throw new ToolError(`[e${id}] ${rec.type} is not visible now. Call qml_snapshot for the current references.`);
      return pseudo(screen, rec);
    }
    if (args.objectName) {
      const name = args.objectName;
      let found = screen.elements.filter((e) => e.objectName === name);
      if (!found.length) {
        const recs = [...screen.nodes.values()].filter((r) => r.objectName === name && r.item);
        found = recs.filter((r) => screen.shown(r)).map((r) => pseudo(screen, r));
        if (!found.length && recs.length) throw new ToolError(`The object with objectName "${name}" exists but is not visible.`);
      }
      if (!found.length) throw new ToolError(`No visible object with objectName "${name}". Call qml_snapshot to see what is on the screen.`);
      if (found.length > 1 && found.some((e) => e.inView)) found = found.filter((e) => e.inView);
      if (found.length > 1) throw new ToolError(`${found.length} visible objects have the objectName "${name}". Nothing was done. Use the ref of one:\n${found.slice(0, 8).map((e) => e.line).join("\n")}`);
      return found[0];
    }
    const wanted = args.text.trim().toLowerCase();
    let pool = screen.elements.filter((e) => e.reachable && !e.behindModal);
    if (type) pool = pool.filter((e) => e.type.toLowerCase().includes(type.toLowerCase()));
    const labels = (e) => [e.label, ...e.texts].map((t) => t.toLowerCase());
    let found = pool.filter((e) => labels(e).includes(wanted));
    const containing = pool.filter((e) => labels(e).some((t) => t.includes(wanted)));
    if (!found.length && partial) found = containing;
    if (!found.length) {
      if (containing.length) throw new ToolError(`No element has exactly the text "${args.text}". Nothing was done. These contain it:\n${containing.slice(0, 8).map((e) => e.line).join("\n")}${scrollHint(screen)}`);
      throw new ToolError(`No element with the text "${args.text}" is on the screen. Nothing was done.${scrollHint(screen)}`);
    }
    // A button and the plain text of the same words: the button is meant.
    const controls = found.filter((e) => e.kind !== "text");
    if (found.length > 1 && controls.length >= 1) found = controls;
    if (found.length > 1) {
      throw new ToolError(`${found.length} elements have the text "${args.text}". Nothing was done. Use the ref of one:\n${found.slice(0, 8).map((e) => e.line).join("\n")}` +
                          (found.length > 8 ? `\n… ${found.length - 8} more` : ""));
    }
    return found[0];
  }

  // Rows of a long list exist only near its visible part. The hint says how to bring more of them up.
  function scrollHint(screen) {
    const lists = screen.elements.filter((e) => e.kind === "scroll" && e.reachable && !e.behindModal);
    if (!lists.length) return "";
    return `\nIt may be in a list that must be scrolled first. Scroll with qml_set_property {ref, property: "contentY", value}, then look again:\n${lists.slice(0, 4).map((e) => e.line).join("\n")}`;
  }

  // Makes sure the element can take a click, scrolling its list when needed. -> { screen, el, note }
  async function ready(screen, el) {
    if (el.behindModal) throw new ToolError(`${el.line} is behind a modal popup and cannot be used. ${modalLine(screen)}`);
    if (el.visible === false) throw new ToolError(`${el.line} is not visible.`);
    if (!el.enabled) throw new ToolError(`${el.line} is disabled. Nothing was done.`);
    if (el.inView) return { screen, el, note: "" };
    const fresh = (after) => after.elements.find((e) => e.id === el.id) || (after.nodes.get(el.id) && after.nodes.get(el.id).item ? pseudo(after, after.nodes.get(el.id)) : null);
    if (el.drawerId) {
      await send("callMethod", { objectId: el.drawerId, method: "open", args: [] });
      const after = await settled();
      const again = fresh(after);
      if (!again || !again.inView) throw new ToolError(`${el.line}: the drawer [e${el.drawerId}] did not open. Nothing was clicked.`);
      return { screen: after, el: again, note: " (opened the drawer first)", drawer: true };
    }
    if (!el.flick || !el.reachable) {
      throw new ToolError(`${el.line} is outside the window. Nothing was done. It is on a page that is not shown now: open that page first.`);
    }
    // Scroll the list along each axis on which the element is outside the visible part.
    const props = await properties(el.flick.id, ["contentX", "contentY", "contentWidth", "contentHeight", "originX", "originY"]);
    const view = el.flick.rect;
    const axes = [["contentY", "y", "h", "contentHeight", "originY"], ["contentX", "x", "w", "contentWidth", "originX"]];
    for (const [property, at, size, contentSize, originName] of axes) {
      const centre = el.rect[at] + el.rect[size] / 2;
      if (centre >= view[at] && centre <= view[at] + view[size]) continue;
      const delta = centre - (view[at] + view[size] / 2);
      const origin = Number(props[originName]) || 0;
      const max = Math.max(origin, origin + (Number(props[contentSize]) || 0) - view[size]);
      const target = Math.round(Math.min(max, Math.max(origin, (Number(props[property]) || 0) + delta)));
      await send("setProperty", { objectId: el.flick.id, property, value: target });
    }
    const after = await settled();
    const again = fresh(after);
    if (!again || !again.inView) throw new ToolError(`${el.line} could not be scrolled into view. Nothing was clicked.`);
    return { screen: after, el: again, note: " (scrolled into view first)" };
  }

  // Press and release as two steps, and look in between whether the element took the press.
  // -> false when another item took it (the release then goes to that item).
  async function pressChecked(id) {
    await send("mouse", { objectId: id, action: "press" });
    const props = await properties(id, ["pressed"]);
    await send("mouse", { objectId: id, action: "release" });
    return props.pressed !== false;
  }

  async function properties(objectId, names) {
    const reply = await send("getProperties", { objectId });
    const out = {};
    for (const p of reply.properties || []) if (!names || names.includes(p.name)) out[p.name] = p.value;
    return out;
  }

  // For the tools that take an object but do not need it on the screen.
  async function objectId(args) {
    const id = idOf(args);
    if (id !== null) return id;
    if (!args.objectName) throw new ToolError("Name the object with ref, objectId or objectName.");
    const reply = await send("findByProperty", { property: "objectName", value: args.objectName });
    const matches = reply.matches || [];
    const visible = matches.filter((m) => m.visible !== false);
    const pick = visible.length ? visible : matches;
    if (!pick.length) throw new ToolError(`No object with objectName "${args.objectName}".`);
    if (pick.length > 1) throw new ToolError(`${pick.length} objects have the objectName "${args.objectName}". Use the ref of one:\n${pick.slice(0, 8).map((m) => formatObject(m)).join("\n")}`);
    return String(pick[0].id);
  }

  async function click(args, options = {}) {
    const first = await settled();
    let screen = first, state, tries = "";
    for (let attempt = 1; ; attempt++) {
      const found = resolve(screen, args, options);
      state = await ready(screen, found);
      if (!state.drawer) {
        await send("click", { objectId: state.el.id });
        break;
      }
      // In a drawer that was just opened, another item sometimes takes the press and the drawer only closes.
      if (await pressChecked(state.el.id)) {
        if (attempt > 1) tries = ` It took ${attempt} tries: before, another item took the press and the drawer closed.`;
        break;
      }
      if (attempt >= 3) throw new ToolError(`The press did not reach ${state.el.line} in 3 tries: another item took it each time. The element was not clicked.`);
      screen = await settled();
    }
    const after = await settled();
    return ok(cut(`Clicked ${state.el.line}${state.note}.${tries}\n${changes(state.drawer ? first : state.screen, after)}`, "Call qml_snapshot with a filter for the rest."));
  }

  const handlers = {
    async qml_snapshot(args) {
      return ok(snapshotText(await settled(), { filter: args.filter || "" }));
    },
    async qml_list_interactive(args) {
      return ok(snapshotText(await settled(), { filter: args.filter || "", interactiveOnly: true }));
    },
    async qml_click(args) {
      if (args.x !== undefined || args.y !== undefined) {
        // By position: passed on as it is.
        return ok(JSON.stringify(await send("click", args), null, 2));
      }
      return click(args);
    },
    async qml_find_and_click(args) {
      return click({ text: args.text }, { partial: !args.exact, type: args.type || "" });
    },
    async qml_send_keys(args) {
      const hasTarget = idOf(args) !== null || !!args.objectName;
      if (!args.text && !args.key && !(args.clear && hasTarget)) throw new ToolError("Give text, key, or clear with a target.");
      if (!hasTarget) {
        if (args.clear) throw new ToolError("clear needs a target: pass ref or objectName of the text field.");
        const before = await settled();
        if (args.text) await send("sendKeys", { text: args.text });
        if (args.key) await send("sendKeys", { key: args.key });
        return ok(cut(`Sent ${args.text ? JSON.stringify(args.text) : ""}${args.text && args.key ? " and " : ""}${args.key ? "the key " + args.key : ""} to the element that has the focus.\n${changes(before, await settled())}`, ""));
      }
      const first = await settled();
      let el = resolve(first, { ref: args.ref, objectId: args.objectId, objectName: args.objectName });
      if (el.kind !== "input") {
        // A reference to a wrapper or a label: the one text field inside it is meant.
        const rec = first.nodes.get(el.id);
        const inside = first.elements.filter((e) => e.kind === "input" && isInside(first.nodes.get(e.id), rec));
        if (inside.length !== 1) throw new ToolError(`${el.line} is not a text field. Nothing was typed.`);
        el = inside[0];
      }
      const state = await ready(first, el);
      const before = state.el.value ?? "";
      await send("click", { objectId: el.id });
      if (args.clear) {
        await send("sendKeys", { key: "Ctrl+A", objectId: el.id });
        await send("sendKeys", { key: "Backspace", objectId: el.id });
      }
      if (args.text) await send("sendKeys", { text: args.text, objectId: el.id });
      if (args.key) await send("sendKeys", { key: args.key, objectId: el.id });
      const after = await settled();
      const now = after.elements.find((e) => e.id === el.id);
      const report = changes(state.screen, after);
      if (now) {
        const expected = args.clear ? args.text || "" : before + (args.text || "");
        const holds = args.text ? now.value.includes(args.text) : !args.clear || now.value === "";
        if (!holds && !args.key) {
          return fail(`The field holds ${JSON.stringify(now.value)} after typing, not ${JSON.stringify(expected)}.\n${now.line}`);
        }
        return ok(cut(`Typed into ${el.line.replace(/ value=.*$/, "")}. Its value is now ${JSON.stringify(now.value)}.\n${report}`, ""));
      }
      return ok(cut(`Typed into ${el.line.replace(/ value=.*$/, "")}. The field is no longer on the screen.\n${report}`, ""));
    },
    async qml_wait_for(args) {
      if (!args.text && !args.objectName) throw new ToolError("Give text or objectName.");
      const gone = args.state === "gone";
      const timeout = Math.min(30000, Math.max(0, Number(args.timeout_ms ?? 5000)));
      const what = args.objectName ? `objectName "${args.objectName}"` : `text "${args.text}"`;
      const end = Date.now() + timeout;
      for (;;) {
        const screen = await readScreen(bridge, drawers);
        const pool = screen.elements.filter((e) => e.reachable && !e.behindModal);
        const found = pool.filter((e) => (args.objectName ? e.objectName === args.objectName
          : [e.label, ...e.texts, e.value || ""].some((t) => t.toLowerCase().includes(args.text.toLowerCase()))));
        if (gone && !found.length) return ok(`No element with ${what} is on the screen now.`);
        if (!gone && found.length) return ok(cut(`On the screen:\n${found.slice(0, 5).map((e) => e.line).join("\n")}`, ""));
        if (Date.now() >= end) {
          throw new ToolError(gone ? `An element with ${what} is still on the screen after ${timeout} ms:\n${found.slice(0, 3).map((e) => e.line).join("\n")}`
            : `No element with ${what} appeared after ${timeout} ms. Call qml_snapshot to see what is on the screen.`);
        }
        await sleep(settleIntervalMs);
      }
    },
    async qml_screenshot(args) {
      const result = await send("screenshot", args);
      if (result.image) {
        return { content: [{ type: "image", data: result.image, mimeType: "image/png" },
                           { type: "text", text: `Screenshot: ${result.width}x${result.height} pixels` }] };
      }
      return ok(JSON.stringify(result, null, 2));
    },
    async qml_find_by_type(args) {
      const reply = await send("findByType", { typeName: args.typeName });
      return matchLines(reply, `No object of the type "${args.typeName}".`, "Narrow the query with a longer type name.");
    },
    async qml_find_by_property(args) {
      const params = { property: args.property };
      if ("value" in args) params.value = args.value;
      const reply = await send("findByProperty", params);
      const showValue = !("value" in args) && !["text", "title", "objectName", "visible", "enabled"].includes(args.property);
      return matchLines(reply, `No object with the property "${args.property}"${"value" in args ? ` = ${JSON.stringify(args.value)}` : ""}.`,
                        "Narrow the query: pass a value.", showValue ? args.property : "");
    },
    async qml_get_properties(args) {
      const id = await objectId(args);
      const reply = await send("getProperties", { objectId: id });
      const all = reply.properties || [];
      const wanted = Array.isArray(args.names) && args.names.length ? args.names : null;
      const list = wanted ? all.filter((p) => wanted.includes(p.name)) : all;
      const lines = list.map((p) => {
        const value = JSON.stringify(p.value) ?? "null";
        return `${p.name} = ${value.length > 200 ? value.slice(0, 200) + "…" : value}`;
      });
      const missing = wanted ? wanted.filter((n) => !all.some((p) => p.name === n)) : [];
      if (missing.length) lines.push(`No such property: ${missing.join(", ")}`);
      return ok(cut([`[e${id}] ${shortType(reply.type || "")}${wanted ? "" : `: ${all.length} properties`}`, ...lines].join("\n"),
                    "Pass names: [...] to get only the properties you need."));
    },
    async qml_set_property(args) {
      const id = await objectId(args);
      const before = await settled();
      await send("setProperty", { objectId: id, property: args.property, value: args.value });
      return ok(cut(`Set ${args.property} = ${JSON.stringify(args.value)} on [e${id}].\n${changes(before, await settled())}`, ""));
    },
    async qml_call_method(args) {
      const id = await objectId(args);
      const before = await settled();
      const reply = await send("callMethod", { objectId: id, method: args.method, args: args.args || [] });
      return ok(cut(`Called ${args.method} on [e${id}]. Result: ${JSON.stringify(reply.result ?? null)}\n${changes(before, await settled())}`, ""));
    },
    async qml_evaluate(args) {
      return passthrough("evaluate", args, "The value is long: evaluate a narrower expression.");
    },
    async qml_get_tree(args) {
      return passthrough("getTree", args, "The tree is cut and is not complete JSON. Pass an objectId and a smaller depth, or use qml_snapshot.");
    },
    async qml_list_file_dialogs(args) {
      return passthrough("listFileDialogs", args, "");
    },
    async qml_file_dialog_action(args) {
      return passthrough("fileDialogAction", args, "");
    },
  };

  function isInside(rec, ancestor) {
    for (let p = rec; p; p = p.parent) if (p === ancestor) return true;
    return false;
  }

  // The find tools search the whole tree. A match that is shown but lies outside the window gets a mark,
  // so that it is not taken for something a user can see.
  async function matchLines(reply, none, hint, valueOf = "") {
    const matches = reply.matches || [];
    if (!matches.length) throw new ToolError(none);
    const screen = await readScreen(bridge, drawers);
    const offScreen = (m) => {
      const rec = screen.nodes.get(String(m.id));
      return !!rec && screen.shown(rec) && !screen.place(rec).inView;
    };
    const lines = matches.map((m) => formatObject(m, valueOf ? `${valueOf}=${String(JSON.stringify(m.value) ?? "").slice(0, 60)}` : "", offScreen(m) ? ["not on screen"] : []));
    return ok(cut([`${matches.length} object${matches.length === 1 ? "" : "s"}:`, ...lines].join("\n"), hint));
  }

  async function passthrough(command, args, hint) {
    const text = JSON.stringify(await send(command, args || {}), null, 2);
    if (text.length <= MAX_REPLY_CHARS) return ok(text);
    const head = text.slice(0, MAX_REPLY_CHARS - NOTE_ROOM);
    return ok(`${head}\n… cut: ${text.length - head.length} more characters not shown. ${hint}`);
  }

  return {
    definitions: TOOLS,
    async call(name, args) {
      const handler = handlers[name];
      if (!handler) return fail(`Unknown tool: ${name}`);
      try {
        return await handler(args || {});
      } catch (err) {
        if (err instanceof ToolError) return fail(err.message);
        return fail(/^Cannot connect|^Qt Inspector error/.test(err.message) ? err.message : `Connection error: ${err.message}`);
      }
    },
  };
}
