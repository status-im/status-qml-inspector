# MCP server for the QML inspector

This server lets an AI agent drive a Qt app. It talks to the inspector plugin inside the app.

## The rule: act by object

Act by object. Take a screenshot only to check what the screen looks like.

- `qml_snapshot` lists the screen as text. One line per element, with a reference like `[e12]`.
- `qml_click` and `qml_send_keys` take that reference, an `objectName`, or the visible text.
- Each action replies with the lines that changed on the screen. That reply is the check of the step.
- A click by `x`, `y` and `qml_screenshot` still work. They are not checked, and they cost more.

Example of a snapshot:

```
Window "Status Desktop" 1200x680, 42 elements.
[e2192] StatusNavigationListItem "Profile" objectName=0-MenuItem
[e2658] StatusTabButton "Identity" objectName=identityTabButton (checked)
[e2788] StatusInput "Bio" objectName=bioInput value="" placeholder="Tell us about yourself"
[e2145] SettingsList scrollable: contentY=0 of 0..591, more below
[e3442] StatusNavigationListItem "Communities" objectName=13-MenuItem (not in view)
```

What the server checks before a click by object:

- No match: error, nothing is clicked.
- More than one match: error with the candidates, nothing is clicked.
- Hidden, disabled, or behind a modal popup: error, nothing is clicked.
- Scrolled out of view: the list is scrolled first (up, down or sideways), then the element is clicked.
- In a closed drawer: the drawer is opened first, then the element is clicked.

No reply is longer than 8,000 characters. A longer result is cut, with a note on how to narrow the query.

## Connect an agent on desktop

1. Start the app with the inspector plugin. The plugin listens on `127.0.0.1:3768`.
2. Add the server to `.mcp.json`:

```json
{
  "mcpServers": {
    "qml": {
      "command": "node",
      "args": ["/path/to/mcp-server/index.mjs"],
      "env": { "QML_INSPECTOR_HOST": "localhost", "QML_INSPECTOR_PORT": "3768" }
    }
  }
}
```

Node 18 or newer is needed. Run `npm install` in this folder once.

## Connect an agent on Android

The plugin listens on port 3768 on the device, on loopback only. Bring that port to your machine, then connect as on desktop.

1. Start the app on the device with the inspector plugin.
2. Forward the port: `adb forward tcp:3768 tcp:3768`.
3. Use the same `.mcp.json` as on desktop.

If the adb server runs on another machine, `adb forward` opens the port there, not on yours.
In that case run a small relay on your machine that pipes a local port to `adb shell nc 127.0.0.1 3768`,
and set `QML_INSPECTOR_PORT` to the local port.

## Tools

| Tool | What it does |
|---|---|
| `qml_snapshot` | Lists what is on the screen, one line per element. Start here. `filter` narrows the list. |
| `qml_click` | Clicks one element by `ref`, `objectName` or `text`. Also by `x`, `y`. |
| `qml_send_keys` | Types `text` or presses a `key`. With a target it focuses the field first. `clear` empties the field. |
| `qml_wait_for` | Waits until a text or an `objectName` is on the screen, or is gone. |
| `qml_find_and_click` | Clicks the one element whose text contains the given text. |
| `qml_list_interactive` | Same list as `qml_snapshot`, without plain texts. |
| `qml_screenshot` | Returns a PNG of the window. |
| `qml_find_by_type`, `qml_find_by_property` | Find objects in the whole tree, hidden ones too. |
| `qml_get_properties` | Reads properties of one object. Pass `names` to get only some. |
| `qml_set_property`, `qml_call_method`, `qml_evaluate` | Change or query the app directly. |
| `qml_get_tree` | Raw object tree as JSON. Large. |
| `qml_list_file_dialogs`, `qml_file_dialog_action` | File dialogs. |

A long list shows only the rows near its visible part. To reach other rows, scroll the list:
`qml_set_property {ref, property: "contentY", value}`. The `scrollable` line of the list gives the range.

## Drawers on a phone layout

On a phone the navigation is often a drawer that is closed. A user opens it with a swipe.

- A snapshot lists a closed drawer as one line, and its elements with the mark `(in closed drawer)`.
- Click such an element like any other. The server calls `open` on the drawer, waits, then clicks.
- The swipe itself is not done. In the Status app the swipe is handled by a native Android view, outside Qt. The plugin cannot send input there.
- After opening, the server presses, checks that the element is `pressed`, then releases. If another item took the press, it opens the drawer again and retries, 3 times at most. The reply says how many tries it took.
- A drawer is found like this: a visible item with `opened = false` that lies outside the window. A drawer built as a Qt Quick `Popup` is not found this way.

## Tests

```
npm test
```

The tests use a stand-in for the plugin (`test/fake-inspector.mjs`). No app is needed.
