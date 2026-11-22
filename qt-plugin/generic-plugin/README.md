# Generic plugin: the inspector in an unmodified app

A Qt generic plugin (`qmlinspector`). Loaded into the Status app, it serves the
app's QML object tree to tests over a local socket. Tests can find objects,
read properties and send mouse and key input.

It has two users in [status-app](https://github.com/status-im/status-app):

- **Desktop** (`test/e2e_squish_stand_in/`): finds objects and sends input in
  place of Squish. The plugin is loaded into an unmodified desktop build
  through `QT_PLUGIN_PATH`.
- **Mobile** (`test/e2e_appium/core/qt_inspector.py`): reads state that the
  accessibility tree does not carry, beside an Appium session. Read-only.

## Build

Needs Qt 6 (Core, Gui, Network, Qml, Quick, Widgets) and CMake 3.16 or newer.
Build against the same Qt version as the app (6.11.0 for current status-app).

```bash
cmake -S qt-plugin/generic-plugin -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH=/path/to/Qt/6.11.0/gcc_64 -DQMLINSPECTOR_QUICKWIDGETS=OFF
cmake --build build
```

Result: `build/plugins/generic/libqmlinspector.so`.

Unit tests (the rule for the relay address, the values of a switch, the token
check of the listening server, and the hiding of password fields). The last two
need the Qt GUI modules. Without them the configure step fails, so that a test
run cannot pass without the two security tests. To build only the small tests
on a machine with Qt Core alone, pass `-DQMLINSPECTOR_TESTS_WITHOUT_GUI=ON`; a
warning then says what is left out:

```bash
cmake -S qt-plugin/generic-plugin/tests -B build-tests -G Ninja \
  -DCMAKE_PREFIX_PATH=/path/to/Qt/6.11.0/gcc_64
cmake --build build-tests && ctest --test-dir build-tests
```

## Run

The plugin never starts on its own. Start the app with:

```bash
STATUS_RUNTIME_TEST_MODE=1 \
QT_PLUGIN_PATH=/path/to/build/plugins \
QT_QPA_GENERIC_PLUGINS=qmlinspector:<port> \
  ./Status
```

It then listens on `127.0.0.1:<port>` (default 3768). Without
`STATUS_RUNTIME_TEST_MODE=1` it does nothing.

A switch such as `STATUS_RUNTIME_TEST_MODE` or `QML_INSPECTOR_ALLOW` is on with
`1`, `true`, `yes` or `on` (any case). Every other value is off. Before 2.0
every value except `0`, `false`, `no` and `off` was on. The MCP server reads its
switches by the same rule.

With `QML_INSPECTOR_TOKEN=<secret>` the plugin asks every connection for this
secret. The first line of a connection must be
`{"id": 1, "command": "auth", "params": {"token": "<secret>"}}`. A connection
that sends another command first, or a wrong token, gets one error line and is
closed. Without the variable there is no check: every program on the device can
send commands, and the plugin writes a warning to the log. Use a new random
value for each session.

- The token must have at least 16 characters. When the variable is set but
  empty or shorter, the plugin does not start. It never takes such a value as
  "no token".
- A connection that has not sent the token waits. At most 8 wait at a time,
  each for at most 5 seconds. When one more comes, the one that waits the
  longest is closed. A token that has arrived already is checked first.
- The connections that sent the token have 8 places of their own. When one more
  passes the check, the one that was idle the longest is closed. A connection
  without the token never takes one of these places.
- Without a token there are 8 places. When one more connection comes, the one
  that was idle the longest is closed.
- A connection that is closed to make room gets one line first,
  `{"ok": false, "error": "Connection closed: ..."}`. The line has no `id`: it
  answers no request. A client should show it. The same holds for
  `Authentication required: no token was sent in time`.
- So nobody can lock a client out by holding connections open. What stays
  possible: without a token, any program on the device can send commands and can
  push other clients out. With a token, a program without it can only push out
  connections that still wait for the check.
- A client that sends the token to a plugin without one gets
  `"auth": "not required"`. The MCP server and the test framework treat this as
  an error: their user set a token and the app is open to every program.
- On Android another app cannot read the token, so it cannot use the port. On
  desktop a program of the same user can read the environment of the app, and
  with it the token: there the token keeps out other users and programs that
  only try the port.

The variable has a second use, see Dial-out mode: there the plugin does not
listen, and the token is what the plugin sends to the relay. It is never both.

## Password fields

What a text field with a hidden echo holds (`echoMode` is not `Normal`:
`TextInput`, `TextField`, `QLineEdit`) is not sent to a client:

- In the tree, such a field has `"secret": true`, `"textLength": <n>` and no
  `text`. Every text field has `"echoMode": <number>`.
- `getProperties` gives `"value": null, "hidden": true` for `text`,
  `displayText`, `selectedText` and `preeditText` of such a field.
- A property of any other object that holds the same text (a wrapper that
  repeats the text of its field) is hidden in the same way.
- `findByProperty` with a value never matches a hidden value. `findAndClick`
  does not match it either.
- A result of `evaluate` that is exactly such a text is replaced by
  `"(hidden)"`. This command can still learn the text in other ways.
  (`callMethod` sends no result of the method back.)
- Inside a list or a map, an entry that is such a text is replaced by
  `"(hidden)"`. `findByProperty` with a value does not match a list that holds
  one.
- The title of a window or a dialog that is such a text is left out.
- Every successful reply carries `"secretsHidden": true`.

Only a text that is exactly equal to what a password field holds is hidden. A
text that contains it or is made from it is not. And every text of the app that
is equal to it is hidden, also one that has nothing to do with the field.

The texts are looked up for each command, when the first text of its reply is
checked. A command that sends no text back (a read of `pressed`, a click) does
not walk the tree for it.

The tree of a window holds the content of a closed popup only for a `Drawer`.
For a closed dialog or menu, ask for the tree of the popup itself.

A test that needs to check a typed password compares `textLength`. This is a
change for clients that read the text of a password field before.

Desktop only: `QML_INSPECTOR_ALLOW=1` starts it without test mode. Use it for
tests of behaviour that test mode turns off, such as automatic login. An
Android build ignores this variable.

## Protocol

One JSON object per line: `{"id": 1, "command": "...", "params": {...}}`. One
JSON line comes back, with the same `id` and either the result or `"error"`.

| Command | What it does |
|---|---|
| `auth` | Sends the token (see Run). Needed first when the app has `QML_INSPECTOR_TOKEN`. |
| `getTree` | The object tree under an object, to a given depth. A node carries `checked` and `activeFocus` when true, `popup` (the popup an item belongs to, with `modal` and `opened`), and the scroll position of a list. A popup that is declared inside an item is listed under that item. The reply has `"states": true`. |
| `getProperties` | All properties of an object. Enums are numbers. An object-valued property is `{"objectRef": <id>, "type": ...}`. With `"names": [...]` only these properties are read, and no method list is sent. Prefer this: reading all properties runs every getter of the object. |
| `findByType` | Objects whose type or any base type contains a name. |
| `findByProperty` | Objects with a property, or with a property value. |
| `setProperty`, `callMethod`, `evaluate` | Change or query an object through the QML engine. |
| `mouse` | `move`, `press`, `release`, `click` or `doubleClick` on an item. `x`, `y` are in the item's coordinates; default is its centre. |
| `wheel` | Wheel rotation on an item, `dx`/`dy` in eighths of a degree. |
| `sendKeys` | `text` or `key`. With `objectId`, focus is kept on that item. |
| `geometry` | An item's position in the scene and on the screen, and its size. |
| `screenshot` | The window or an item as a PNG, base64. |

Mouse, wheel and key input enter Qt where the platform plugin delivers real
input, as QTest does. Hover, grabs, focus and shortcuts behave as for a user.

## Dial-out mode

For a device nothing can connect to, such as a BrowserStack phone. The plugin
opens no port. It polls a relay on the test machine over HTTP:

```
QML_INSPECTOR_RELAY=http://localhost:<port>
QML_INSPECTOR_TOKEN=<the session's secret>
```

The relay address must be `http` on `localhost` or a loopback address. The
token is sent in clear text, so the plugin refuses any other host. A tunnel on
the device, such as BrowserStack Local, carries the request to the test machine.

In this mode the plugin answers only `getTree`, `getProperties`, `findByType`
and `findByProperty`, and returns an error for every other command: the channel
leaves the device, so it can read state and cannot change it. Password fields
are hidden in this mode too.

## Source

`inspectorserver.cpp` and `inspectorserver.h` come from
[logos-qt-mcp](https://github.com/logos-co/logos-qt-mcp) (`qt-plugin/`, MIT,
see `LICENSE-MIT`). Changes: works in an application without widgets, builds
for Android, input through Qt's test input path, the `mouse`, `wheel` and
`geometry` commands, base-type matching, popups in the tree, the token check,
hidden password fields, states in the tree.
`qmlinspectorplugin.cpp` wraps the server as a plugin, so the app's own sources
are untouched. `relayclient.cpp` and `relayclient.h` are the dial-out mode and
are not from logos-qt-mcp.
