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

Unit tests (the rule for the relay address, and the token check of the listening server):

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

With `QML_INSPECTOR_TOKEN=<secret>` the plugin asks every connection for this
secret. The first line of a connection must be
`{"id": 1, "command": "auth", "params": {"token": "<secret>"}}`. A connection
that sends another command first, or a wrong token, gets one error line and is
closed. Without the variable there is no check: every program on the device can
send commands, and the plugin writes a warning to the log. Use a new random
value for each session.

Desktop only: `QML_INSPECTOR_ALLOW=1` starts it without test mode. Use it for
tests of behaviour that test mode turns off, such as automatic login. An
Android build ignores this variable.

## Protocol

One JSON object per line: `{"id": 1, "command": "...", "params": {...}}`. One
JSON line comes back, with the same `id` and either the result or `"error"`.

| Command | What it does |
|---|---|
| `auth` | Sends the token (see Run). Needed first when the app has `QML_INSPECTOR_TOKEN`. |
| `getTree` | The object tree under an object, to a given depth. |
| `getProperties` | All properties of an object. Enums are numbers. An object-valued property is `{"objectRef": <id>, "type": ...}`. |
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
leaves the device, so it can read state and cannot change it.

## Source

`inspectorserver.cpp` and `inspectorserver.h` come from
[logos-qt-mcp](https://github.com/logos-co/logos-qt-mcp) (`qt-plugin/`, MIT,
see `LICENSE-MIT`). Changes: works in an application without widgets, builds
for Android, input through Qt's test input path, the `mouse`, `wheel` and
`geometry` commands, base-type matching, popups in the tree.
`qmlinspectorplugin.cpp` wraps the server as a plugin, so the app's own sources
are untouched. `relayclient.cpp` and `relayclient.h` are the dial-out mode and
are not from logos-qt-mcp.
