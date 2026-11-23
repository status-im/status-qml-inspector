// What the server must know about one app to list its screen well: naming habits of its controls.
// The defaults fit plain Qt Quick Controls. A profile is a JSON file that adds to them (see profiles/status.json
// and the README). It is chosen with QML_INSPECTOR_PROFILE: the name of a file in profiles/, or a path.
import { readFileSync } from "node:fs";

// Type names that mean "a control a user can act on". A part of the type name is enough.
const CONTROL_TYPES = ["Button", "Delegate", "ComboBox", "Slider", "Switch", "CheckBox", "Radio", "SpinBox", "MenuItem"];
// Type names of the item that wraps a text editor and carries its name and label.
const INPUT_WRAPPER_TYPES = ["Input", "TextField", "TextArea"];

const KEYS = {
  name: "string",
  description: "string",
  partNames: "list",          // objectNames that parts of controls carry in every instance; they do not identify an element
  iconNames: "list",          // objectName of the icon inside a control; the first group is shown as icon="..."
  controlTypes: "list",       // more type names that are controls
  inputWrapperTypes: "list",  // more type names that wrap a text editor
  textTypes: "list",          // type names of items that draw a text themselves (not a Qt Quick Text); the whole name
  itemDrawers: "boolean",     // the app has a drawer that is a plain item (not Qt Quick Drawer), see the README
};

function regex(parts, flags, what) {
  try {
    return new RegExp(parts, flags);
  } catch (err) {
    throw new Error(`Profile: ${what} is not a valid pattern (${err.message})`);
  }
}

// -> the profile in the form the code uses. Throws an Error that says what is wrong with the data.
export function compileProfile(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Profile: the file must hold one JSON object");
  for (const [key, value] of Object.entries(data)) {
    const kind = KEYS[key];
    if (!kind) throw new Error(`Profile: unknown key "${key}". Known keys: ${Object.keys(KEYS).join(", ")}`);
    const ok = kind === "list" ? Array.isArray(value) && value.every((v) => typeof v === "string" && v) : typeof value === kind;
    if (!ok) throw new Error(`Profile: "${key}" must be ${kind === "list" ? "a list of texts" : "a " + kind}`);
  }
  const anyOf = (list) => list.map((p) => `(?:${p})`).join("|");
  const partNames = data.partNames || [];
  return {
    name: data.name || "generic",
    partName: partNames.length ? regex(`^(?:${anyOf(partNames)})$`, "", "partNames") : null,
    iconNames: (data.iconNames || []).map((p) => regex(`^(?:${p})$`, "", `iconNames "${p}"`)),
    control: regex(anyOf([...CONTROL_TYPES, ...(data.controlTypes || [])]), "i", "controlTypes"),
    inputWrapper: regex(anyOf([...INPUT_WRAPPER_TYPES, ...(data.inputWrapperTypes || [])]), "i", "inputWrapperTypes"),
    text: (data.textTypes || []).length ? regex(`^(?:${anyOf(data.textTypes)})$`, "", "textTypes") : null,
    itemDrawers: data.itemDrawers === true,
  };
}

export const GENERIC_PROFILE = compileProfile();

// spec: "" (the defaults), a name ("status" -> profiles/status.json), or a path to a JSON file.
export function loadProfile(spec) {
  const wanted = String(spec || "").trim();
  if (!wanted || wanted === "generic") return GENERIC_PROFILE;
  const isName = /^[A-Za-z0-9_-]+$/.test(wanted);
  const file = isName ? new URL(`../profiles/${wanted}.json`, import.meta.url) : wanted;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Profile: cannot read ${isName ? `profiles/${wanted}.json` : wanted} (${err.code || err.message})`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Profile: ${wanted} is not valid JSON (${err.message})`);
  }
  return compileProfile(data);
}
