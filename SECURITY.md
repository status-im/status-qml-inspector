# Security

## What this is

A tool for tests and development. The plugin lets a client read the QML object tree of an app and send it mouse and
key input. The MCP server lets an AI agent do the same. **A client of the plugin can do what a user at the keyboard
can do, and can read more than a user sees.** Use it only with builds and profiles that are made for testing.

## Do not

- Do not put the plugin into a build that goes to users.
- Do not use it with a profile that holds real funds, a real recovery phrase or a real password.
- Do not turn on `QML_INSPECTOR_UNLIMITED_TOOLS` for an app that holds real data.

## What protects you

| Protection | Where | Details |
|---|---|---|
| The plugin is off unless the app is started with a switch (`STATUS_RUNTIME_TEST_MODE=1`, or on desktop only `QML_INSPECTOR_ALLOW=1`) | plugin | `qt-plugin/generic-plugin/README.md`, Run |
| It listens on `127.0.0.1` only. In dial-out mode it connects only to a relay on the same device | plugin | same file, Run and Dial-out mode |
| Optional token (`QML_INSPECTOR_TOKEN`, at least 16 characters): a client must send it first | plugin | same file, Run |
| At most 8 connections; nobody can lock a client out by holding connections open | plugin | same file, Run |
| Password text is hidden for a client that asks (`hideSecrets`). The MCP server (2.0 and later) always asks | plugin, MCP server | same file, Password fields |
| Tools that run code of the app, and choosing a file in a file dialog, are off by default | MCP server | `mcp-server/README.md`, Safety |

## What does not protect you

- **Without a token, every program on the same device can send commands.** On desktop a program of the same user can
  also read the token from the environment of the app.
- **The token is not encrypted** on the local socket, and the plugin does not prove that it is the app.
- **Password hiding is a guard against accidents, not a wall.** A client that does not send `hideSecrets` gets the
  text: test suites, a script, an AI agent that talks to the port without the MCP server, and a dial-out relay. A
  client with the unlimited tools can get it too.
- **Other secrets are not hidden:** a recovery phrase in a plain text field, a password after "show password", and
  screenshots.
- **What an AI agent reads goes to the provider of its model** and stays in the transcript of the session.

## Report a problem

Do not open a public issue for a problem that can harm a user. Use "Report a vulnerability" on the Security tab of
this repository, or write to a maintainer in private. For everything else, open an issue.
