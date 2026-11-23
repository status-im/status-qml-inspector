# MCP server for the QML inspector

This server lets an AI agent drive a Qt app. It talks to the inspector plugin inside the app.

Version 2.0.0. If you used the server before, read [Changes for existing users](#changes-for-existing-users) first.

## Which plugin

The server works with two plugins, and finds out by itself which one the app has:

- **The old plugin**: the plugin in `qt-plugin/` of this branch. It can ask for a token. It sends the text of password fields, so the server hides that text itself. Its tree has no states.
- **The new plugin**: the plugin with the password hiding. It is a separate change (its own PR) and is not in this branch. It sends the states with the tree and has the stricter token rules. It hides the text of password fields itself for a client that asks for it (the command `hideSecrets`). The server asks on every connection, so with this plugin the plugin hides the text. No setting is needed.

A part of this page that is marked **(new plugin)** describes that plugin. Until its PR is merged, such a part is not true for the plugin of this branch. Everything else holds for both.

## The rule: act by object

Act by object. Take a screenshot only to check what the screen looks like.

- `qml_snapshot` lists the screen as text. One line per element, with a reference like `[e12]`.
- `qml_click` and `qml_send_keys` take that reference, an `objectName`, or the visible text.
- Each action replies with the lines that changed on the screen. That reply is the check of the step.
- A click by `x`, `y` and `qml_screenshot` still work. They are not checked, and they cost more.

Example of a snapshot (a small Qt Quick Controls app):

```
Window "Mini app" 480x640, 9 elements.
[e6] Label "Home" objectName="title"
[e8] PasswordInput "Password" objectName="passwordInput" value=(hidden)
[e13] TextField objectName="nameField" value="alice"
[e29] Switch "Wi-Fi" objectName="wifi" (checked)
[e36] Button "Ask" objectName="askButton"
[e58] QQuickListView objectName="rows" scrollable: contentY=0 of 0..660, more below
[e60] ItemDelegate "Row 0" objectName="row0"
[e129] Drawer objectName="menuDrawer" drawer: closed. Its elements are listed; a click on one of them opens the drawer first.
[e137] ItemDelegate "Settings" objectName="navSettings" (in closed drawer)
```

The last two lines need the new plugin: the old plugin does not have a closed Qt Quick `Drawer` in its tree.

Every text that comes from the app is in quotes: labels, values, `objectName`, icon names.
A label or a value in a line is cut at 80 characters and then ends in `…`. To read the whole text, ask for it by name: `qml_get_properties {ref, names: ["text"]}` returns each named property in full. Without `names`, a value over 200 characters is cut, and `qml_find_by_property` shows 60 characters of a value.

What the server checks before a click by object:

- No match: error, nothing is clicked.
- More than one match: error with the candidates, nothing is clicked.
- Hidden, disabled, or behind a modal popup: error, nothing is clicked.
- Under an open popup that is not modal (a menu, the list of a combo box, a dialog, a tooltip): the line has the mark `(under a popup)`. For a click, the server first moves the mouse to the element, as a user does; a tooltip of another control goes away then. If a popup still lies over the middle of the element, the click is an error and nothing is clicked: the click would go to the popup.
- A reference after a new connection to the app: error, nothing is done. The app may have started again, and the same reference can mean another object. Call `qml_snapshot` first. (A call that names its target by `objectName` or `text` works at once. The first call of a server may use a reference.)
- A reference whose element has another type, name or label than in the line the agent saw last (a list reuses a row for another entry): error with both lines, nothing is done. The same reference is taken on the next call.
- The connection is lost and opened again in the middle of a call: the call stops before it acts.
- Scrolled out of view: the list is scrolled first (up, down or sideways), then the element is clicked.
- In a closed drawer: the drawer is opened first, then the element is clicked.

A text field is one line: its label, its value and its placeholder. Every other text inside the same control (an error under the field, a counter such as `3/24`) is a line of its own.

The arguments of every call are checked against the schema of the tool. A wrong type, an unknown argument or a missing one is an error, and nothing is sent to the app. Names that every JavaScript object has (`constructor`, `toString`, `__proto__`) are unknown arguments like any other.

The text of a reply is never longer than 8,000 characters. This is enforced in one place, for every tool and every error (a screenshot is an image and is not counted). A longer list is cut at a line, with a note on how to narrow the query. JSON is never cut in the middle, see `qml_get_tree` below.

What the checks do not see:

- An element that is fully transparent (`opacity: 0`) is listed like a visible one.
- Which of two overlapping items of a page is on top (`z`). Only popups are taken as lying over the page, and a later popup over an earlier one.
- An item that cuts off its children (`clip: true`) and is not a list (`Flickable`). A child outside it is listed as in view.

What is out of reach of these tools:

- Drag, swipe and the mouse wheel. So a `Slider`, a `SwipeView`, a `Dial` or a drag-and-drop cannot be operated (a slider can be moved with the arrow keys after a click, if the app allows it).
- Several windows: the elements of all visible windows are in one list, and the head line names the largest window.
- A Qt Widgets app (`QWidget`): the snapshot is empty. Only Qt Quick items are listed.
- A native dialog of the system (a native file dialog, a permission question) is not in the object tree.

## Safety

The server controls a running app. Read this part before you give the server to an agent.

### 1. The unlimited tools are off

Three tools can change anything in the app, with no check:

- `qml_evaluate` runs any JavaScript in the app.
- `qml_call_method` calls any method of any object.
- `qml_set_property` sets any property of any object.

By default they are not in the tool list, and a call to one of them is refused.
To turn them on, start the server with `QML_INSPECTOR_UNLIMITED_TOOLS=1` (`true`, `yes` and `on` work too). Turn them on only for an app with test data.

The other tools read, and send the input a user can send: a click and keys. Three things they do are not input of a user:

- `qml_scroll`, and a click on an element that is scrolled out of view, set the scroll position of a list (`contentX`, `contentY`), inside its range. A user would drag or use the wheel. `qml_scroll` replaces the common use of `qml_set_property`.
- A click on an element of a closed drawer calls the method `open` of the drawer first. A user would swipe or press a button.
- `qml_file_dialog_action`, see rule 6.

### 2. The plugin port can ask for a token

The plugin listens on `127.0.0.1` only, on desktop and on Android. No other machine can connect.
But every program on the same machine or phone can. A token closes this gap.

- Start the app with `QML_INSPECTOR_TOKEN=<secret>`. The plugin then takes commands only from a connection that sent this token first. Any other connection gets one error line and is closed.
- Start the server with the same `QML_INSPECTOR_TOKEN`. It sends the token on every new connection.
- Without the variable the plugin works as before, with no check. The new plugin also writes a warning to the app log.
- For the server the token must have at least 16 characters: a value that is set but empty or shorter is a mistake, and the server does not start. It never treats such a value as "no token". Use a new random value for each test session, for example `openssl rand -hex 16`. Do not put it in a repository.
- **(new plugin)** The plugin has the same rule: with a value that is set but empty or shorter than 16 characters it does not start. The old plugin takes any value that is not empty, and takes an empty one as "no token".
- A plugin built before the token check does not know the token. The server then replies with an error and sends no command.
- The same when the server has a token and the app was started without one. The app then takes commands from every program on the device, and a user who set a token does not expect that. The error says so. To use the app as it is, unset `QML_INSPECTOR_TOKEN` for the server.

**(new plugin)** How the plugin shares its places, so that nobody can lock a client out by holding connections open. The old plugin has no limit and no time limit for a connection that sends no token.

- Without a token, 8 connections can be open. When one more comes, the one that was idle the longest is closed.
- With a token, a connection that has not sent the token waits: at most 8 at a time, each for at most 5 seconds. When one more comes, the one that waits the longest is closed. Such a connection never takes a place from one that sent the token.
- The connections that sent the token have 8 places of their own. When one more passes the check, the one of them that was idle the longest is closed.
- A connection that is closed for one of these reasons gets one line that says why. The server shows this reason in its error. On the next call it connects again.
- What stays possible: without a token, any program on the device can send commands and can push other clients out. With a token, a program without it can only push out connections that still wait; the server sends its token right after it connects, so it waits for one round trip only.

What the token protects against, and what not:

- **On Android** each app has its own user ID. Another app cannot read the environment of the Status process, so it cannot learn the token. With a token, another app on the phone cannot use the port. This is the case the token is for.
- **On desktop** a program that runs as the same user can read the environment of the app (`/proc/<pid>/environ` on Linux) and so the token. Against such a program the token does not help. It helps against programs of other users on the machine, and against a web page or a tool that tries the port without knowing the secret.
- The token is sent as plain text. This is safe only because the connection stays on the device (loopback, or `adb forward`).
- The plugin does not prove to the server that it is the app. A program that listens on the port before the app starts gets the token from the server. Start the app first.
- The server connects to `127.0.0.1`, not to the name `localhost`. The name can also mean `::1`, where the plugin never listens and another program may: the token would go to that program. If you set `QML_INSPECTOR_HOST` yourself, use an address you trust.

`QML_INSPECTOR_TOKEN` has a second use in the plugin. With `QML_INSPECTOR_RELAY` set, the plugin does not listen. It calls out to a relay and sends the token in a header, so that the relay knows the plugin (see `qt-plugin/generic-plugin/README.md`). The server here does not use that mode.

On Android the app gets environment variables through `extraenvvars` at launch (see the status-app mobile README). Add `QML_INSPECTOR_TOKEN=<secret>` there, separated by a tab.

### 3. The default tools do not return passwords

A text field that hides what is typed (its `echoMode` is not `Normal`) is a password field. With the default tools, what it holds is not in a reply:

- `qml_snapshot` shows `value=(hidden)`, or `value=""` when the field is empty.
- `qml_send_keys` checks the number of characters after typing and does not repeat the text. (The number counts as Qt counts: a character outside the basic plane, such as most emoji, is two.)
- `qml_get_properties`, `qml_get_tree`, `qml_list_file_dialogs` and the find tools show `(hidden)` or leave the text out. This also holds for a wrapper that repeats the text of its field in a property of its own. Inside a list or a map the text is `null`, and a line of the reply says how many values are hidden.
- A search by value does not find the text of a password field.
- An error text does not show it either (a list of several objects with one `objectName`).

The rule is: **a text that is exactly equal to what a password field holds is hidden, wherever it is in the app.** So while a password field holds `abc`, every other `abc` in the app is hidden too (a label, a title, a list entry).

This rule has a price. A reply shows whether some text of the app is hidden, so a reader can learn that the password is equal to a text that the app already holds (a label "Password", say). It cannot test a guess of its own with the default tools: they put no text into the app except by typing.

**The unlimited tools are not covered.** `qml_evaluate`, `qml_set_property` and `qml_call_method` run code of the app. With them an agent can get a password: `qml_evaluate` can return one character of it or the text with a space added, and a property or a method of the app can switch "show password" on. Only the exact text as a result, and the text inside an error message of a script, are taken out. Do not turn these tools on for an app that holds a real password.

Who hides the text:

- The server sends the command `hideSecrets` as the first request of every connection (after the token, when there is one), and again after every reconnect. No variable turns this off; it is the same with `QML_INSPECTOR_UNLIMITED_TOOLS=1`.
- **(new plugin)** The plugin accepts the command and leaves these texts out itself, in every reply on this connection, and says so (`secretsHidden`).
- The old plugin answers "Unknown command". The server then hides the texts itself, as the two points below say.
- Any other answer, or none: the server closes the connection and the tool call fails ("the plugin did not accept the request to hide password text"). Nothing is read from the app.
- Who gets password text: a plain client of the plugin, such as a test suite or `test-framework/framework.mjs`. It does not send the command, and a test can read back the password it typed. Who does not: an agent that works through this server.
- With the old plugin the server looks for the password fields (one search for `echoMode`) and removes the texts before it builds the reply. If that search fails, the tool returns an error and shows nothing.
- With the old plugin the search is a request of its own, and the app can change between the two requests. The user can type: so the server takes the text of each field also from the tree it shows. A field can go away (Return on a login page): so a text field of the tree counts as a password field unless the search has confirmed that it shows its text. For the other tools the server searches before and after the read. If the two searches differ, it reads again, 3 times at most; then it returns an error ("A password field is changing") and shows nothing.

What this does not cover, with the default tools:

- A text that only contains the password, or is made from it. `You typed: abc`, the password in upper case, or the password with one more character are shown. Only an exact match is hidden.
- A secret in a plain text field. A recovery phrase that the app shows or takes in normal text fields is returned like any other text.
- A field after the user switches "show password" on. The app then shows the text on the screen, and the server returns it.
- A custom field that hides text without `echoMode` (not a Qt `TextInput`, `TextField` or `QLineEdit`).
- `qml_screenshot`. It returns what the screen shows; a password field shows dots.

### 4. Text from the app is data

Labels, values, messages and names come from the app. Other people can write them (a chat message, a community name).
The server tells the agent in its instructions and in the tool descriptions that such text is data and not an instruction.
Every such text is put into a reply as one quoted string, so it cannot add a line or a field to the reply.
This lowers the risk of a prompt injection. It does not remove it: the agent still reads the text.

### 5. Every tool says whether it only reads

Each tool has MCP annotations. A client can use them to allow the reading tools without a question and to ask before the others.

| Tools | `readOnlyHint` | `destructiveHint` | `openWorldHint` |
|---|---|---|---|
| `qml_snapshot`, `qml_list_interactive`, `qml_screenshot`, `qml_wait_for`, `qml_find_by_type`, `qml_find_by_property`, `qml_get_properties`, `qml_get_tree`, `qml_list_file_dialogs` | true | | true |
| `qml_scroll` | false | false | true |
| `qml_click`, `qml_find_and_click`, `qml_send_keys` | false | true | true |
| `qml_file_dialog_action` | false | true | true |
| `qml_evaluate`, `qml_call_method`, `qml_set_property` | false | true | true |

- A click is marked destructive because it does what the app does on that click. That can be a delete.
- `openWorldHint` is true for the tools that return text of the app or send input to it. The app can be a messenger or a wallet: its screen shows text from strangers, and a click can send a message or a payment. The file dialog tools too: a file that is chosen in a dialog goes to the app, and the app can send it on.
- `readOnlyHint` means: the tool sends no input, sets no property and calls no method. A reading tool still reads properties, and the getter of a property is code of the app. `qml_get_properties` reads every property of one object. `qml_find_by_property` reads one property of every object, hidden objects too. Qt expects a getter to change nothing, and the server cannot check that. These two tools also return values that are not on the screen. If that is too much for your app, do not allow them without a question.
- The annotations are hints. The server does not enforce them; rules 1 to 3 and 6 are enforced.

### 6. Choosing a file is off

`qml_file_dialog_action` has three actions. `cancel` is always possible. `select` (puts a path into the dialog) and `accept` (confirms the dialog) are refused by default.

The reason: `select` takes any path of the computer. With text from a stranger on the screen (rule 4), an agent could be talked into choosing a private file and sending it in a chat. No other default tool reaches a file.

To turn them on, start the server with `QML_INSPECTOR_FILE_DIALOGS=1`. This switch is separate from the unlimited tools: a test that attaches a picture needs it, and should not have to turn on `qml_evaluate` for it.

## Connect an agent on desktop

1. Start the app with the inspector plugin. The plugin listens on `127.0.0.1:3768`.
2. Add the server to `.mcp.json`:

```json
{
  "mcpServers": {
    "qml": {
      "command": "node",
      "args": ["/path/to/mcp-server/index.mjs"],
      "env": { "QML_INSPECTOR_PORT": "3768", "QML_INSPECTOR_TOKEN": "<secret>", "QML_INSPECTOR_PROFILE": "status" }
    }
  }
}
```

Node 18 or newer is needed. Run `npm install` in this folder once.

Environment variables of the server:

| Variable | Default | Meaning |
|---|---|---|
| `QML_INSPECTOR_HOST` | `127.0.0.1` | Where the plugin listens. |
| `QML_INSPECTOR_PORT` | `3768` | Port of the plugin. |
| `QML_INSPECTOR_TOKEN` | not set | The token the app was started with. Leave it out if the app has none. |
| `QML_INSPECTOR_UNLIMITED_TOOLS` | off | `1`, `true`, `yes` or `on` adds `qml_evaluate`, `qml_call_method` and `qml_set_property`. |
| `QML_INSPECTOR_FILE_DIALOGS` | off | `1`, `true`, `yes` or `on` allows `select` and `accept` of `qml_file_dialog_action`. |
| `QML_INSPECTOR_PROFILE` | not set | The app profile: a name from `profiles/` (for example `status`) or a path to a JSON file. |
| `QML_INSPECTOR_TIMEOUT` | `15000` | Milliseconds to wait for one reply of the plugin, 1 to 600000. |

A port or a timeout that is not a whole number in its range stops the server at start, with a message.
An attempt to connect ends after the timeout, at most after 10 seconds. A line of the plugin of more than 64 million characters is not taken as a reply: the server closes the connection.

## Connect an agent on Android

The plugin listens on port 3768 on the device, on loopback only. Bring that port to your machine, then connect as on desktop.

1. Start the app on the device with the inspector plugin (and with a token, see Safety).
2. Forward the port: `adb forward tcp:3768 tcp:3768`.
3. Use the same `.mcp.json` as on desktop.

If the adb server runs on another machine, `adb forward` opens the port there, not on yours.
In that case run a small relay on your machine that pipes a local port to `adb shell nc 127.0.0.1 3768`,
and set `QML_INSPECTOR_PORT` to the local port.

## App profiles

The server works with any Qt Quick app. Without a profile it knows plain Qt Quick Controls: `Button`, `Switch`, `TextField`, `ItemDelegate`, `Drawer` and so on.

An app with its own controls often has naming habits that the server cannot guess. A profile is a small JSON file that tells them to the server.
Choose it with `QML_INSPECTOR_PROFILE`. The profile for the Status app is `profiles/status.json`.

| Key | Meaning |
|---|---|
| `name`, `description` | For people. Not used by the code. |
| `partNames` | `objectName`s that parts of controls carry in every instance (for example the text inside every button). They do not identify an element, so they are not shown. |
| `iconNames` | `objectName` pattern of the icon inside a control. The first group is shown as `icon="..."` for a control without text. |
| `controlTypes` | More type names that are controls. A part of the type name is enough. |
| `inputWrapperTypes` | More type names of the item that wraps a text editor and carries its name and label. |
| `itemDrawers` | `true` when the app has a drawer that is a plain item and not a Qt Quick `Drawer`, see below. |

The values of the first four keys are regular expressions. An unknown key or a wrong value stops the server at start, with a message.

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
| `qml_get_properties` | Reads properties of one object. Pass `names` to get only some, each value in full; the new plugin then reads only those. `details: true` adds types, writability and the methods. |
| `qml_set_property`, `qml_call_method`, `qml_evaluate` | Change or query the app directly, with no check. Off by default, see Safety. |
| `qml_get_tree` | Raw object tree as JSON. Large. |
| `qml_list_file_dialogs`, `qml_file_dialog_action` | File dialogs. Choosing a file is off by default, see Safety, 6. |

A long list shows only the rows near its visible part. To reach other rows, scroll the list:
`qml_scroll {ref, y}`. The `scrollable` line of the list gives the range. The range starts at 0 for every list.
With the old plugin the position in that line is taken from the geometry. For a list whose content does not start at 0 (a chat that grows upwards) it can be off. The position that `qml_scroll` sets is right for every list.

`qml_get_tree` and `qml_list_file_dialogs` return JSON. When the JSON is over the size limit, the tree is returned to a smaller depth. The first text block is then complete JSON, and a second text block says what was cut. An object that lost its children keeps their number in `childCount`.

## Drawers

A drawer is navigation that is closed most of the time. A user opens it with a swipe or a button.

- A snapshot lists a closed drawer as one line, and its elements with the mark `(in closed drawer)`.
- Click such an element like any other. The server calls `open` on the drawer, waits, then clicks.
- After opening, the server presses, checks that the element is `pressed`, then releases. If another item took the press, it opens the drawer again and retries, 3 times at most. The reply says how many tries it took.

Two kinds of drawer are found:

- **A Qt Quick `Drawer`. (new plugin)** The old plugin does not have the closed drawer in its tree, so with it a closed Qt Quick `Drawer` is not listed. While the drawer is closed, Qt reports every item in it as not visible, so all of its elements are listed, also one that the app hides. A click on such an element opens the drawer, sees that the element is not visible, and returns an error; nothing is clicked.
- **A drawer that is a plain item** (profile key `itemDrawers`). The Status app on a phone has one. It is found like this: a visible item that lies outside the window, holds controls, and has `opened = false` and a number `position`. To open it, the server calls its method `open`. The server asks only such items, each one once, and only when the screen has stopped moving (two reads in a row are the same; `qml_wait_for` follows the same rule). An item that was asked keeps its answer, also while something else on the screen moves. On a screen that never stops moving (a running counter), a drawer that was never asked is not found. The swipe itself is not done: in the Status app the swipe is handled by a native Android view, outside Qt.

## How many requests an action costs

One read of the screen is one `getTree` request. The server reads until two reads in a row are the same, so a snapshot is at least 2 reads and a click at least 4 (2 before, 2 after).

- **(new plugin)** That is all. The tree carries the states (checked, focus, open popups, scroll positions).
- One more request per connection (not per call): the command `hideSecrets`, with both plugins.
- With the old plugin, the server asks for the states once per snapshot, for the last tree: 3 searches of the whole tree (`checked`, `activeFocus`, `modal`), 1 more when a modal popup is open, and 1 more for password fields when the screen has a text input. A click costs twice that.

While the screen moves, the server sends nothing but `getTree`. It asks no single object for anything.
The reason: a request that addresses an object of a page that is being replaced has made the Status app exit (a click on a main section, then a request to an item of the old page about 200 ms later).
So the question "is this item a drawer?" is asked only after the screen has stopped moving, and only for the two properties it needs.
A call of your own that names an object of the old page right after a page change can still hit this. Take the reference from the reply of the click, not from an older snapshot.

**(new plugin)** The new plugin sends the content of a closed popup only for a `Drawer`. The content of closed dialogs and menus is not in the tree of the window; `qml_get_tree` with the id of the popup returns it.

The server stops when its client goes away (standard input closed, or SIGTERM, SIGINT, SIGHUP). A call that is running is finished first, for at most 10 seconds, so that a click does not stop between press and release. A running `qml_wait_for` ends at once. Then the server closes its connection to the app.

## Changes for existing users

Version 2.0.0 keeps the tool names of 1.x and changes what some of them do. Scripts and prompts written for 1.x need a look.

**Off by default**

- `qml_evaluate`, `qml_call_method` and `qml_set_property` are not listed and are refused. Set `QML_INSPECTOR_UNLIMITED_TOOLS=1` to get them back.

**Same name, other behaviour**

- `qml_click` with `objectId` (or the new `ref`, `objectName`, `text`) checks the element first. A hidden or disabled element, one behind a modal popup, or an id that no longer exists is an error. Before, the click was sent as it was. The reply is text with the changes on the screen, not the JSON of the plugin. A click by `x`, `y` is unchanged.
- `qml_find_and_click` no longer uses the plugin command `findAndClick`. Exactly one element must match: several matches are an error, and nothing is clicked. Before, the first match was clicked. Only elements on the screen are searched. `type` matches a part of the type name, without regard to case.
- `qml_send_keys` with a target focuses the field with a click first and checks the value afterwards. The reply is text. It no longer repeats typed text that goes to the focused element.
- `qml_list_interactive`, `qml_find_by_type` and `qml_find_by_property` reply with text lines, not JSON. `qml_find_by_type` and `qml_find_by_property` return an error when nothing matches. Before, they returned an empty list.
- `qml_get_properties` replies with `name = value` lines, not JSON. Types, writability and methods come back with `details: true`.
- `qml_set_property` and `qml_call_method` reply with text that includes the changes on the screen.
- `qml_get_tree` and `qml_list_file_dialogs` still reply with the JSON of the plugin. Over 8,000 characters the tree is returned to a smaller depth, as complete JSON, with a note in a second text block. Before, the whole JSON was returned, whatever its size. A tree that fits only without line breaks is returned whole, on one line.
- `qml_evaluate` with a result over 8,000 characters returns an error. The expression has run then.
- No reply is longer than 8,000 characters.
- `qml_file_dialog_action` with `select` or `accept` is refused. Set `QML_INSPECTOR_FILE_DIALOGS=1` to get them back. `cancel` is unchanged.

**Stricter**

- A reference (`ref`, `objectId`) is refused after a new connection to the app, until the screen was listed again; and once when its element shows another label than in the line the agent saw last.
- An element under an open popup is not clicked.

- Arguments are checked against the schema. An unknown argument, a wrong type or a missing required argument is an error. Before, they were passed to the plugin.
- What a password field holds is not returned any more (see Safety, 3).

**Settings**

- The server connects to `127.0.0.1` by default, not to `localhost`.
- `QML_INSPECTOR_TOKEN` that is set but empty or shorter than 16 characters stops the server at start.
- `QML_INSPECTOR_TOKEN` set for the server while the app has no token is an error on the first call.
- `QML_INSPECTOR_PORT` or `QML_INSPECTOR_TIMEOUT` that is not a number stops the server at start.
- The names of the Status app are not built in any more. For the Status app set `QML_INSPECTOR_PROFILE=status`. Without it, `icon="..."` is not shown, parts such as `buttonText` are shown with their name, `StatusListItem` rows are not listed as controls, and the drawer of the phone layout is not found.

**New**

- `qml_snapshot`, `qml_wait_for`, `qml_scroll`; `ref` and `objectName` and `text` as targets; annotations on every tool.

## Tests

```
npm test
```

The tests use a stand-in for the plugin (`test/fake-inspector.mjs`). No app is needed. The stand-in can act as the old plugin and as the new plugin, and the tests of the tools run against both.
