# QML Inspector — MCP Server & Test Framework

A toolkit for inspecting, interacting with, and testing Qt/QML applications. It consists of:

1. **Qt Plugin** (`qt-plugin/`) — a C++ inspector server that embeds in the Qt app and exposes a TCP API
2. **MCP Server** (`mcp-server/`) — a bridge that exposes the inspector as [Model Context Protocol](https://modelcontextprotocol.io) tools for AI assistants (Claude, etc.)
3. **Test Framework** (`test-framework/`) — a reusable library for writing UI tests against any Qt app using the inspector

## Architecture

```
┌─────────────┐     TCP/JSON      ┌──────────────┐     stdio/MCP      ┌─────────────┐
│  Qt App +    │◄────────────────►│  MCP Server  │◄──────────────────►│  Claude /    │
│  Inspector   │   port 3768      │  (index.mjs) │                    │  AI Agent    │
│  Plugin      │                  └──────────────┘                    └─────────────┘
│              │     TCP/JSON      ┌──────────────┐
│              │◄────────────────►│  Test Runner  │
│              │   port 3768      │  (your tests) │
└─────────────┘                   └──────────────┘
```

## Directory Structure

```
logos-qt-mcp/                    # This repo
  qt-plugin/                     # C++ inspector that embeds in Qt apps
    inspectorserver.h
    inspectorserver.cpp
    CMakeLists.txt
    generic-plugin/              # The same inspector as a Qt plugin, for an app that is not changed (README.md)
  mcp-server/                    # MCP bridge for AI agents (README.md)
    index.mjs                    # Start: reads the settings, serves the tools over stdio
    lib/
      bridge.mjs                 # Connection to the plugin, with the token check
      screen.mjs                 # Turns the object tree into the list of what is on screen
      tools.mjs                  # The tools: schemas, checks, replies
      profile.mjs                # Loads an app profile
    profiles/
      status.json                # Profile of the Status app
    test/                        # Unit tests, with a stand-in for the plugin
    package.json
  test-framework/                # Reusable test library
    framework.mjs
```

App-specific tests stay in the app repo (e.g. `logos-basecamp/tests/ui-tests.mjs`) and import the framework from this repo.

## Qt Plugin

### Setup

Add the inspector to your Qt app:

```cpp
#include "inspectorserver.h"

// In your main window setup:
InspectorServer::attach(mainWindow);  // listens on 127.0.0.1, port 3768
```

The port can be configured via the `QML_INSPECTOR_PORT` environment variable.

The server listens on `127.0.0.1` only. Every program on the same machine can connect. To ask each connection for a secret first, set a token before the start:

```cpp
auto *inspector = new InspectorServer(mainWindow);
inspector->setRootObject(mainWindow);
inspector->setAuthToken(token);   // see generic-plugin/README.md
inspector->start(3768);
```

The generic plugin (`qt-plugin/generic-plugin/`) reads the token from `QML_INSPECTOR_TOKEN`. What else holds for the token (its shortest length, what `attach()` does with the variable, how many connections may wait) depends on the plugin: see `qt-plugin/generic-plugin/README.md` of the plugin you build.

### What it provides

The inspector exposes the full Qt object tree over TCP using a newline-delimited JSON protocol. It can:

- Traverse the widget/QML object tree
- Read/write properties on any object
- Call methods and slots
- Simulate mouse clicks and keyboard input
- Take screenshots
- Evaluate QML/JavaScript expressions
- Find elements by type, property, or text

### Tree enrichment

The object tree includes common identifying properties (`text`, `title`, `source`, `label`, etc.) directly in each node, so consumers don't need extra round-trips to identify elements.

The plugin with the password hiding (a separate change, with its own PR; not in this branch until that PR is merged) adds two things to a node. Its README, `qt-plugin/generic-plugin/README.md`, describes them:

- The states a client needs to list a screen: `checked`, `activeFocus`, the popup an item belongs to (`popup`, with `modal` and `opened`), and the scroll position of a list (`contentY`, `contentHeight`, `originY`, ...).
- A password field (a text field whose `echoMode` is not `Normal`) is marked: its node has `"secret": true` and `textLength`. For a client that has sent the command `hideSecrets` on its connection, what the field holds is also left out of what the reading commands send (no `text`). Every other client gets the text.

The MCP server works with both plugins. With the plugin of this branch it asks for the states itself and hides the text of password fields itself. With the other plugin it sends `hideSecrets` on every connection, and the plugin hides the text.

## MCP Server

The MCP server lets AI assistants interact with the running Qt app. Its full description is in [mcp-server/README.md](mcp-server/README.md): the safety rules, app profiles, and what changed in version 2.0.0 for existing users.

### Configuration

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "qml-inspector": {
      "command": "node",
      "args": ["/path/to/logos-qt-mcp/mcp-server/index.mjs"],
      "env": {
        "QML_INSPECTOR_PORT": "3768"
      }
    }
  }
}
```

| Variable | Default | Description |
|----------|---------|-------------|
| `QML_INSPECTOR_HOST` | `127.0.0.1` | Where the plugin listens |
| `QML_INSPECTOR_PORT` | `3768` | Port of the plugin |
| `QML_INSPECTOR_TOKEN` | not set | The token the app was started with, if it has one |
| `QML_INSPECTOR_UNLIMITED_TOOLS` | off | `1` adds `qml_evaluate`, `qml_call_method`, `qml_set_property` |
| `QML_INSPECTOR_FILE_DIALOGS` | off | `1` allows `select` and `accept` of `qml_file_dialog_action` |
| `QML_INSPECTOR_PROFILE` | not set | App profile, for example `status` |
| `QML_INSPECTOR_TIMEOUT` | `15000` | Milliseconds to wait for one reply |

### Available tools

The agent acts by object: it lists the screen as text, then clicks and types by reference. Each action replies with what changed on the screen.

| Tool | Description |
|------|-------------|
| `qml_snapshot` | List what is on the screen, one line per element, with references. Start here |
| `qml_click` | Click one element by `ref`, `objectName` or `text` (checked first), or at coordinates |
| `qml_send_keys` | Type text or press a key, into a named field or the focused element |
| `qml_wait_for` | Wait until a text or an `objectName` is on the screen, or gone |
| `qml_find_and_click` | Click the one element whose text contains the given text |
| `qml_scroll` | Scroll a list to a position inside its range |
| `qml_list_interactive` | The list of `qml_snapshot` without plain texts |
| `qml_screenshot` | Take a PNG screenshot |
| `qml_find_by_type` | Find objects by class name, hidden ones too |
| `qml_find_by_property` | Find objects by property name/value, hidden ones too |
| `qml_get_properties` | Read properties of an object (`details: true` adds types and methods) |
| `qml_get_tree` | Get the raw object tree as JSON |
| `qml_list_file_dialogs`, `qml_file_dialog_action` | File dialogs |

Off by default, because they can change anything in the app with no check (`QML_INSPECTOR_UNLIMITED_TOOLS=1` turns them on):

| Tool | Description |
|------|-------------|
| `qml_set_property` | Set a property value on an object |
| `qml_call_method` | Call a method or slot on an object |
| `qml_evaluate` | Evaluate JavaScript in the QML engine |

### Usage examples

```
# See what is on the screen:
qml_snapshot()

# Click by the reference, the objectName or the text of a line:
qml_click({ref: "e12"})
qml_click({objectName: "saveButton"})
qml_click({text: "Save"})

# Type into a field and read back what changed:
qml_send_keys({objectName: "nameField", text: "alice", clear: true})
```

## Test Framework

A reusable Node.js library for writing UI tests. Tests connect directly to the Qt Inspector (no MCP server needed).

### Writing tests

Create a test file that imports from the framework:

```javascript
import { test, run } from "/path/to/logos-qt-mcp/test-framework/framework.mjs";

test("my app: verify buttons", async (app) => {
  await app.click("my_app");
  await app.expectTexts(["Save", "Cancel"]);
});

test("my app: click save", async (app) => {
  await app.click("my_app");
  await app.click("Save");
  await app.expectTexts(["Saved successfully"]);
});

run();
```

### Running tests

```bash
# Run all tests (app must already be running):
node tests/ui-tests.mjs

# Run tests matching a filter:
node tests/ui-tests.mjs counter

# CI mode — launches the app, runs tests, kills the app:
node tests/ui-tests.mjs --ci /path/to/logos-basecamp
node tests/ui-tests.mjs --ci /path/to/logos-basecamp counter
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QML_INSPECTOR_HOST` | `127.0.0.1` | Inspector host |
| `QML_INSPECTOR_PORT` | `3768` | Inspector port |
| `QML_INSPECTOR_TOKEN` | not set | The token the app was started with. Needed when the app was started with one; the framework sends it first on every connection |

### Test API

#### Actions

| Method | Description |
|--------|-------------|
| `app.click(text, opts?)` | Find element by text and click it. Options: `type` (filter by class name), `exact` (require exact match) |
| `app.screenshot()` | Take a screenshot (returns base64 PNG) |

#### Assertions

| Method | Description |
|--------|-------------|
| `app.expectTexts(["a", "b"])` | Assert elements with these text values exist in the UI |
| `app.expectStatus(text)` | Assert a status label contains the given text |
| `app.expectProperty(type, prop, value)` | Assert a property value on an object found by type |

#### Queries

| Method | Description |
|--------|-------------|
| `app.getTree(opts?)` | Get the object tree |
| `app.listInteractive()` | List all interactive elements |
| `app.findByProperty(prop, value?)` | Find objects by property |
| `app.getProperties(objectId)` | Get all properties of an object |
| `app.getPropertyByType(type, prop)` | Read a property from the first object matching a type |

#### Utilities

| Method | Description |
|--------|-------------|
| `app.waitFor(fn, opts?)` | Poll until a condition passes. Options: `timeout` (ms, default 5000), `interval` (ms, default 300) |

### Running in CI with Nix

The integration tests are available as a Nix derivation:

```bash
# Build and run:
nix build .#integration-test -L

# macOS app bundle variant:
nix build .#integration-test-bundle -L

# View the log:
cat result/integration-test.log
```

Add to GitHub Actions:

```yaml
- name: Integration test
  run: |
    nix build .#integration-test --out-link result-integration -L
    cat result-integration/integration-test.log
```

The CI mode launches the app with `-platform offscreen` (no display needed), waits for the inspector to become available, runs all tests, and exits with a non-zero code if any test fails.

## Using in your Qt app

### Nix flake

Add as a flake input:

```nix
inputs = {
  logos-qt-mcp.url = "github:logos-co/logos-qt-mcp";
};
```

The default package exposes `qt-plugin/`, `mcp-server/`, and `test-framework/` directories. Use it in your build:

```nix
logosQtMcp = logos-qt-mcp.packages.${system}.default;

# In your app's nix build, copy the qt-plugin source and pass to CMake:
cp -r ${logosQtMcp}/qt-plugin ./logos-qt-mcp/qt-plugin
cmake ... -DLOGOS_QT_MCP_ROOT=$(pwd)/logos-qt-mcp
```

### CMake

Point `LOGOS_QT_MCP_ROOT` at this repo (or the nix package) and the consumer's `CMakeLists.txt` uses:

```cmake
add_subdirectory(${LOGOS_QT_MCP_ROOT}/qt-plugin ${CMAKE_CURRENT_BINARY_DIR}/qml-inspector)
target_link_libraries(MyApp PRIVATE qml-inspector)
```

### MCP server

Reference in `.mcp.json` for AI agent interaction:

```json
{
  "mcpServers": {
    "qml-inspector": {
      "command": "node",
      "args": ["/path/to/logos-qt-mcp/mcp-server/index.mjs"]
    }
  }
}
```

### Test framework

Import in your test files:

```javascript
import { test, run } from "/path/to/logos-qt-mcp/test-framework/framework.mjs";
```
