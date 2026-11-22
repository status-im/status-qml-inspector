// TCP connection to the inspector plugin: one JSON object per line, replies matched by id.
import net from "node:net";

// One socket with everything that belongs to it: its buffer and the requests that wait for a reply on it.
// When it closes, only its own requests fail.
class Connection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = "";
    this.closed = false;
    this.reason = "";   // what the plugin said before it closed the connection
    // The socket decodes UTF-8 itself and keeps a character that is split over two chunks.
    socket.setEncoding("utf8");
    socket.on("data", (text) => {
      this.buffer += text;
      this._processBuffer();
    });
    socket.on("close", () => {
      // What is left in the buffer can be the last line of the plugin, without a line end.
      if (this.buffer.trim()) this.buffer += "\n";
      this._processBuffer();
      this._fail(new Error(this.reason ? `Connection closed by the inspector: ${this.reason}` : "Connection closed"));
    });
    socket.on("error", () => {
      /* "close" follows and fails the requests */
    });
  }

  _fail(err) {
    this.closed = true;
    this.buffer = "";
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  _processBuffer() {
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a reply
      }
      const p = this.pending.get(String(msg.id));
      // A line with an error and no id of a request is the reason the plugin gives before it closes the connection
      // (too many connections, no token in time). It is kept, so that the user sees it.
      if (!p && msg && typeof msg.error === "string" && (msg.id === undefined || msg.id === null)) this.reason = msg.error.slice(0, 300);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(String(msg.id));
      p.resolve(msg);
    }
  }

  request(id, command, params) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("Connection closed"));
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Request '${command}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, command, params }) + "\n");
    });
  }

  destroy() {
    this.socket.destroy();
  }
}

export class QtBridge {
  // host: 127.0.0.1 and not "localhost". "localhost" can also mean ::1, where the plugin never listens
  //   and another program may: the token would go to that program.
  // token: the secret the plugin was started with (QML_INSPECTOR_TOKEN). Empty when the plugin has none.
  constructor({ host = "127.0.0.1", port = 3768, timeoutMs = 15000, token = "" } = {}) {
    this.token = token;
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.connection = null;  // the open connection, after the token check
    this.connecting = null;  // the one attempt to open it, shared by every caller that waits for it
    this.requestId = 0;
    this.onConnect = null;   // called after each new connection: object ids of an earlier one may mean other objects now
  }

  // For tests and diagnostics: the socket of the open connection.
  get socket() {
    return this.connection && !this.connection.closed ? this.connection.socket : null;
  }

  // -> the open connection. Calls that arrive while it is being opened wait for the same attempt:
  // there is never a second socket.
  connect() {
    if (this.connection && !this.connection.closed) return Promise.resolve(this.connection);
    if (!this.connecting) {
      this.connecting = this._open()
        .then(async (connection) => {
          if (this.token) await this._authenticate(connection);
          this.connection = connection;
          if (this.onConnect) this.onConnect();
          return connection;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  _open() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.once("connect", () => {
        socket.setNoDelay(true);
        resolve(new Connection(socket, this.timeoutMs));
      });
      socket.once("error", (err) => {
        reject(new Error(`Cannot connect to the inspector at ${this.host}:${this.port} (${err.message}). ` +
                         "Make sure the Qt app is running with the inspector plugin loaded."));
      });
    });
  }

  // The token goes first on every new connection. The error texts never contain it.
  async _authenticate(connection) {
    let reply;
    try {
      reply = await connection.request(++this.requestId, "auth", { token: this.token });
    } catch (err) {
      connection.destroy();
      if (connection.reason) throw new Error(`Cannot connect to the inspector: it closed the connection (${connection.reason}).`);
      throw new Error(`Cannot connect to the inspector: no answer to the token check (${err.message}).`);
    }
    if (!reply.error) {
      // A token is set here, so the user counts on the app taking commands only with it. An app without a token
      // takes them from every program on the device: going on would hide that.
      if (reply.auth === "not required") {
        connection.destroy();
        throw new Error("Cannot connect to the inspector: QML_INSPECTOR_TOKEN is set here, but the app was started without a token. " +
                        "Every program on the device can send it commands. Start the app with the same QML_INSPECTOR_TOKEN, or unset it here to use the app as it is.");
      }
      return;
    }
    connection.destroy();
    if (/unknown command/i.test(reply.error)) {
      throw new Error("Cannot connect to the inspector: QML_INSPECTOR_TOKEN is set here, but the plugin in the app does not know the token check. " +
                      "It is an older plugin and takes commands from anyone on the device. Update the plugin, or unset QML_INSPECTOR_TOKEN to use it as it is.");
    }
    throw new Error("Cannot connect to the inspector: the plugin did not accept the token. " +
                    "QML_INSPECTOR_TOKEN must have the same value here and in the app.");
  }

  async send(command, params = {}) {
    const connection = await this.connect();
    let reply;
    try {
      reply = await connection.request(++this.requestId, command, params);
    } catch (err) {
      // The plugin closed the connection and said why (for example: too many connections).
      if (connection.reason) throw new Error(`Cannot connect to the inspector: it closed the connection (${connection.reason}).`);
      throw err;
    }
    if (reply.error && /^Authentication required/.test(reply.error)) {
      this.close();
      throw new Error("Cannot connect to the inspector: the plugin asks for a token. " +
                      "Set QML_INSPECTOR_TOKEN to the value the app was started with.");
    }
    return reply;
  }

  close() {
    if (this.connection) this.connection.destroy();
    this.connection = null;
  }
}
