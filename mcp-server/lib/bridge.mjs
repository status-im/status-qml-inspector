// TCP connection to the inspector plugin: one JSON object per line, replies matched by id.
import net from "node:net";

export class QtBridge {
  constructor({ host = "localhost", port = 3768, timeoutMs = 15000 } = {}) {
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
