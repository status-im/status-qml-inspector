// TCP connection to the inspector plugin: one JSON object per line, replies matched by id.
import net from "node:net";

export class QtBridge {
  // token: the secret the plugin was started with (QML_INSPECTOR_TOKEN). Empty when the plugin has none.
  constructor({ host = "localhost", port = 3768, timeoutMs = 15000, token = "" } = {}) {
    this.token = token;
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = "";
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    await this._open();
    if (this.token) await this._authenticate();
  }

  // The token goes first on every new connection. The error texts never contain it.
  async _authenticate() {
    let reply;
    try {
      reply = await this._request("auth", { token: this.token });
    } catch (err) {
      this.close();
      throw new Error(`Cannot connect to the inspector: no answer to the token check (${err.message}).`);
    }
    if (!reply.error) return;
    this.close();
    if (/unknown command/i.test(reply.error)) {
      throw new Error("Cannot connect to the inspector: QML_INSPECTOR_TOKEN is set here, but the plugin in the app does not know the token check. " +
                      "It is an older plugin and takes commands from anyone on the device. Update the plugin, or unset QML_INSPECTOR_TOKEN to use it as it is.");
    }
    throw new Error("Cannot connect to the inspector: the plugin did not accept the token. " +
                    "QML_INSPECTOR_TOKEN must have the same value here and in the app.");
  }

  _open() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });

      sock.once("connect", () => {
        sock.setNoDelay(true);
        this.socket = sock;
        resolve();
      });

      sock.once("error", (err) => {
        reject(
          new Error(
            `Cannot connect to the inspector at ${this.host}:${this.port} (${err.message}). ` +
              `Make sure the Qt app is running with the inspector plugin loaded.`
          )
        );
      });

      sock.on("data", (chunk) => {
        this.buffer += chunk.toString("utf-8");
        this._processBuffer();
      });

      sock.on("close", () => {
        if (this.socket === sock) this.socket = null;
        this.buffer = "";
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Connection closed"));
        }
        this.pending.clear();
      });

      sock.on("error", () => {
        /* handled above on first connect; swallow subsequent */
      });
    });
  }

  _processBuffer() {
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        const id = String(msg.id);
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.resolve(msg);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  async send(command, params = {}) {
    await this.connect();
    const reply = await this._request(command, params);
    if (reply.error && /^Authentication required/.test(reply.error)) {
      this.close();
      throw new Error("Cannot connect to the inspector: the plugin asks for a token. " +
                      "Set QML_INSPECTOR_TOKEN to the value the app was started with.");
    }
    return reply;
  }

  _request(command, params) {
    const id = ++this.requestId;
    const payload = JSON.stringify({ id, command, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Request '${command}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(String(id), { resolve, reject, timer });
      this.socket.write(payload);
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}
