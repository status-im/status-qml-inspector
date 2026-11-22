// The test framework (test-framework/framework.mjs) is a second client of the plugin. It must send the token too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { FakeInspector, node } from "./fake-inspector.mjs";

const FRAMEWORK = new URL("../../test-framework/framework.mjs", import.meta.url).href;
const TOKEN = "a-token-of-16-chars";

// Runs one command through the framework's Inspector in a process of its own (it reads its settings from the environment).
function ask(vars) {
  const script = `const { Inspector } = await import(${JSON.stringify(FRAMEWORK)});
    const inspector = new Inspector();
    try { const reply = await inspector.send("getTree", { depth: 1 }); console.log(JSON.stringify({ ok: reply.ok === true, error: reply.error || null, host: inspector.host })); }
    catch (err) { console.log(JSON.stringify({ ok: false, error: err.message })); }
    inspector.disconnect();`;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, ...vars }, timeout: 10000 },
             (err, stdout, stderr) => resolve(stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()) : { ok: false, error: String(err || stderr) }));
  });
}

test("framework.mjs sends QML_INSPECTOR_TOKEN first, and says what is wrong when the token is missing or wrong", async () => {
  const fake = new FakeInspector(node("QGuiApplication", {}, [node("QQuickWindowQmlImpl", { inherits: ["QQuickWindow", "QWindow", "QObject"], title: "App" })]));
  fake.token = TOKEN;
  const port = await fake.listen();
  const vars = { QML_INSPECTOR_HOST: "127.0.0.1", QML_INSPECTOR_PORT: String(port) };
  try {
    const good = await ask({ ...vars, QML_INSPECTOR_TOKEN: TOKEN });
    assert.deepEqual([good.ok, good.error], [true, null]);
    assert.equal(fake.requests[0].command, "auth");
    assert.equal(fake.commands("getTree").length, 1);
    const none = await ask(vars);
    assert.equal(none.ok, false);
    assert.match(none.error, /QML_INSPECTOR_TOKEN/);
    const wrong = await ask({ ...vars, QML_INSPECTOR_TOKEN: "another-token-of-16" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /did not accept the token/);
    assert.ok(!wrong.error.includes("another-token"));
    assert.equal(fake.commands("getTree").length, 1);
  } finally {
    await fake.close();
  }
});

test("framework.mjs works as before with an app that has no token, and connects to 127.0.0.1 by default", async () => {
  const fake = new FakeInspector(node("QGuiApplication", {}, [node("QQuickWindowQmlImpl", { inherits: ["QQuickWindow", "QWindow", "QObject"], title: "App" })]));
  const port = await fake.listen();
  try {
    const reply = await ask({ QML_INSPECTOR_PORT: String(port) });
    assert.deepEqual([reply.ok, reply.host], [true, "127.0.0.1"]);
    assert.equal(fake.requests.filter((r) => r.command === "auth").length, 0);
  } finally {
    await fake.close();
  }
});
