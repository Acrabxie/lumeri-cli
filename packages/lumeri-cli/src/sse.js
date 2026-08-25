// SSE client for /sessions/{id}/stream.
//
// Frames are `id: <n>\ndata: <json>\n\n` (see gemia/transport/sse.py). We track
// the last event id and resume with the `Last-Event-ID` header on reconnect so
// the server replays everything missed (or emits a synthetic `replay_gap`).

import { EventEmitter } from "node:events";
import { openStream } from "./http.js";

export class SseClient extends EventEmitter {
  constructor(baseUrl, sessionId, { lastEventId = null, connectTimeoutMs = 10_000 } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
    this.lastEventId = lastEventId;
    this.connectTimeoutMs = connectTimeoutMs;
    this.stopped = false;
    this.req = null;
    this.res = null;
    this.reconnectTimer = null;
    this.buf = "";
  }

  start() {
    this.stopped = false;
    this._connect();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.req) {
      try {
        this.req.destroy();
      } catch {
        /* ignore */
      }
    }
    this.req = null;
    this.res = null;
  }

  async _connect() {
    if (this.stopped) return;
    this.emit("state", "connecting");
    const headers = {};
    if (this.lastEventId != null) headers["Last-Event-ID"] = String(this.lastEventId);
    try {
      const { res, req } = await openStream(
        this.baseUrl,
        `/sessions/${this.sessionId}/stream`,
        {
          headers,
          onRequest: (req) => {
            this.req = req;
            if (this.stopped) req.destroy();
          },
          timeoutMs: this.connectTimeoutMs,
        },
      );
      if (this.stopped) {
        req.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        const status = res.statusCode || 0;
        res.resume();
        const denied = status === 401 || status === 403;
        const error = new Error(denied ? "Runtime authorization denied" : `stream HTTP ${status}`);
        error.status = status;
        error.code = denied ? "E_RUNTIME_ACCESS" : "E_STREAM_HTTP";
        if (denied) {
          this.stopped = true;
          this.req = null;
          this.res = null;
          this.emit("state", "offline");
          this.emit("error", error);
          return;
        }
        this.emit("error", error);
        return this._scheduleReconnect();
      }
      this.req = req;
      this.res = res;
      this.buf = "";
      res.setEncoding("utf8");
      this.emit("state", "live");
      res.on("data", (chunk) => this._onData(chunk));
      res.on("end", () => this._scheduleReconnect());
      res.on("close", () => this._scheduleReconnect());
      res.on("error", () => this._scheduleReconnect());
    } catch (err) {
      if (this.stopped) return;
      this.emit("error", err);
      this._scheduleReconnect();
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    // Event boundary is a blank line. Tolerate \r\n.
    let idx;
    while ((idx = this.buf.indexOf("\n\n")) !== -1 || (idx = this.buf.indexOf("\r\n\r\n")) !== -1) {
      const sep = this.buf.slice(idx, idx + 4) === "\r\n\r\n" ? 4 : 2;
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + sep);
      this._emitBlock(block);
    }
  }

  _emitBlock(block) {
    let id = null;
    const dataLines = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine.startsWith(":")) continue; // comment / heartbeat
      const colon = rawLine.indexOf(":");
      if (colon === -1) continue;
      const field = rawLine.slice(0, colon);
      let value = rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") id = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) {
      if (id != null) this.lastEventId = id;
      return;
    }
    let event;
    try {
      event = JSON.parse(dataLines.join("\n"));
    } catch (err) {
      // A malformed event was not consumed. Keep the cursor behind it so a
      // reconnect cannot silently skip data the client never understood.
      this.emit("parse_error", err, dataLines.join("\n"), id);
      return;
    }
    if (id != null) this.lastEventId = id;
    this.emit("event", event, id);
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.req = null;
    this.res = null;
    this.emit("state", "reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, 1200);
  }
}
