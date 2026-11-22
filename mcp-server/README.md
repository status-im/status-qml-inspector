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

## Safety

The server controls a running app. Three rules limit what an agent can do with it.

### 1. The unlimited tools are off

Three tools can change anything in the app, with no check:

- `qml_evaluate` runs any JavaScript in the app.
- `qml_call_method` calls any method of any object.
- `qml_set_property` sets any property of any object.

By default they are not in the tool list, and a call to one of them is refused.
To turn them on, start the server with `QML_INSPECTOR_UNLIMITED_TOOLS=1`. Turn them on only for an app with test data.

The other tools do what a user can do: click, type, scroll, read.
`qml_scroll` replaces the common use of `qml_set_property`. It sets only the scroll position of a list, inside its range.

### 2. The plugin port can ask for a token

The plugin listens on `127.0.0.1` only, on desktop and on Android. No other machine can connect.
But every program on the same machine or phone can. A token closes this gap.

- Start the app with `QML_INSPECTOR_TOKEN=<secret>`. The plugin then takes commands only from a connection that sent this token first. Any other connection gets one error line and is closed.
- Start the server with the same `QML_INSPECTOR_TOKEN`. It sends the token on every new connection.
- Without the variable the plugin works as before, with no check, and writes a warning to the app log.
- Use a new random value for each test session, for example `openssl rand -hex 16`. Do not put it in a repository.
- The token is sent as plain text. This is safe only because the connection stays on the device (loopback, or `adb forward`).
- A plugin built before this change does not know the token. The server then stops with an error and sends no command.

On Android the app gets environment variables through `extraenvvars` at launch (see the status-app mobile README). Add `QML_INSPECTOR_TOKEN=<secret>` there, separated by a tab.

### 3. Every tool says whether it only reads

Each tool has MCP annotations. A client can use them to allow the reading tools without a question and to ask before the others.

| Tools | `readOnlyHint` | `destructiveHint` |
|---|---|---|
| `qml_snapshot`, `qml_list_interactive`, `qml_screenshot`, `qml_wait_for`, `qml_find_by_type`, `qml_find_by_property`, `qml_get_properties`, `qml_get_tree`, `qml_list_file_dialogs` | true | |
| `qml_scroll` | false | false |
| `qml_click`, `qml_find_and_click`, `qml_send_keys`, `qml_file_dialog_action` | false | true |
| `qml_evaluate`, `qml_call_method`, `qml_set_property` | false | true |

A click is marked destructive because it does what the app does on that click. That can be a delete.
`openWorldHint` is false for every tool: no tool reaches the internet.
The annotations are hints. The server does not enforce them; rules 1 and 2 are enforced.

## Connect an agent on desktop

1. Start the app with the inspector plugin. The plugin listens on `127.0.0.1:3768`.
2. Add the server to `.mcp.json`:

```json
{
  "mcpServers": {
    "qml": {
      "command": "node",
      "args": ["/path/to/mcp-server/index.mjs"],
      "env": { "QML_INSPECTOR_HOST": "localhost", "QML_INSPECTOR_PORT": "3768", "QML_INSPECTOR_TOKEN": "<secret>" }
    }
  }
}
```

Node 18 or newer is needed. Run `npm install` in this folder once.

Environment variables of the server:

| Variable | Default | Meaning |
|---|---|---|
| `QML_INSPECTOR_HOST` | `localhost` | Where the plugin listens. |
| `QML_INSPECTOR_PORT` | `3768` | Port of the plugin. |
| `QML_INSPECTOR_TOKEN` | not set | The token the app was started with. Leave it out if the app has none. |
| `QML_INSPECTOR_UNLIMITED_TOOLS` | off | `1` adds `qml_evaluate`, `qml_call_method` and `qml_set_property`. |
| `QML_INSPECTOR_TIMEOUT` | `15000` | Milliseconds to wait for one reply of the plugin. |

## Connect an agent on Android

The plugin listens on port 3768 on the device, on loopback only. Bring that port to your machine, then connect as on desktop.

1. Start the app on the device with the inspector plugin (and with a token, see Safety).
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
| `qml_scroll` | Scrolls a list to a position `y` (or `x`), inside the range of the list. |
| `qml_list_interactive` | Same list as `qml_snapshot`, without plain texts. |
| `qml_screenshot` | Returns a PNG of the window. |
| `qml_find_by_type`, `qml_find_by_property` | Find objects in the whole tree, hidden ones too. |
| `qml_get_properties` | Reads properties of one object. Pass `names` to get only some. |
| `qml_set_property`, `qml_call_method`, `qml_evaluate` | Change or query the app directly, with no check. Off by default, see Safety. |
| `qml_get_tree` | Raw object tree as JSON. Large. |
| `qml_list_file_dialogs`, `qml_file_dialog_action` | File dialogs. |

A long list shows only the rows near its visible part. To reach other rows, scroll the list:
`qml_scroll {ref, y}`. The `scrollable` line of the list gives the range.

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
