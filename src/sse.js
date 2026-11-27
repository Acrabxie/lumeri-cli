// SSE client for /sessions/{id}/stream.
//
// Frames are `id: <n>\ndata: <json>\n\n` (see gemia/transport/sse.py). We track
// the last event id and resume with the `Last-Event-ID` header on reconnect so
// the server replays everything missed (or emits a synthetic `replay_gap`).

import { EventEmitter } from "node:events";
import { openStream } from "./http.js";

export const DEFAULT_MAX_SSE_BUFFER_BYTES = 1024 * 1024;
export const DEFAULT_MAX_SSE_EVENT_BYTES = 512 * 1024;

const LF_BOUNDARY = Buffer.from("\n\n");
const CRLF_BOUNDARY = Buffer.from("\r\n\r\n");

function byteLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    const error = new RangeError(`${name} must be a positive safe integer`);
    error.code = "E_SSE_LIMIT_CONFIG";
    throw error;
  }
  return value;
}

function nextBoundary(buffer, start = 0) {
  const lf = buffer.indexOf(LF_BOUNDARY, start);
  const crlf = buffer.indexOf(CRLF_BOUNDARY, start);
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, bytes: 4 };
  return { index: lf, bytes: 2 };
}

function partialBoundaryBytes(buffer) {
  let matched = 0;
  for (const boundary of [LF_BOUNDARY, CRLF_BOUNDARY]) {
    for (let length = 1; length < boundary.length && length <= buffer.length; length += 1) {
      if (buffer.subarray(buffer.length - length).equals(boundary.subarray(0, length))) {
        matched = Math.max(matched, length);
      }
    }
  }
  return matched;
}

export class SseClient extends EventEmitter {
  constructor(baseUrl, sessionId, {
    lastEventId = null,
    connectTimeoutMs = 10_000,
    maxBufferBytes = DEFAULT_MAX_SSE_BUFFER_BYTES,
    maxEventBytes = DEFAULT_MAX_SSE_EVENT_BYTES,
  } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
    this.lastEventId = lastEventId;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxBufferBytes = byteLimit(maxBufferBytes, "maxBufferBytes");
    this.maxEventBytes = byteLimit(maxEventBytes, "maxEventBytes");
    this.stopped = false;
    this.fatalError = null;
    this.req = null;
    this.res = null;
    this.reconnectTimer = null;
    this.buf = Buffer.alloc(0);
  }

  start() {
    if (this.fatalError) return this;
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
    if (this.res) {
      try {
        this.res.destroy();
      } catch {
        /* ignore */
      }
    }
    this.req = null;
    this.res = null;
    this.buf = Buffer.alloc(0);
  }

  async _connect() {
    if (this.stopped) return;
    this.emit("state", "connecting");
    const headers = {};
    if (this.lastEventId != null) headers["Last-Event-ID"] = String(this.lastEventId);
    try {
      const { res, req } = await openStream(
        this.baseUrl,
        `/sessions/${encodeURIComponent(String(this.sessionId))}/stream`,
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
      this.buf = Buffer.alloc(0);
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
    if (this.stopped || this.fatalError) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    let offset = 0;
    while (offset < incoming.length && !this.stopped) {
      const available = this.maxBufferBytes - this.buf.length;
      if (available <= 0) {
        this._failAtLimit(
          "E_SSE_BUFFER_LIMIT",
          "session stream buffer",
          this.maxBufferBytes,
          this.buf.length + incoming.length - offset,
        );
        return;
      }
      const take = Math.min(available, incoming.length - offset);
      const slice = incoming.subarray(offset, offset + take);
      this.buf = this.buf.length === 0
        ? Buffer.from(slice)
        : Buffer.concat([this.buf, slice], this.buf.length + slice.length);
      offset += take;
      if (!this._drainBlocks()) return;

      const pendingEventBytes = this.buf.length - partialBoundaryBytes(this.buf);
      if (pendingEventBytes > this.maxEventBytes) {
        this._failAtLimit(
          "E_SSE_EVENT_LIMIT",
          "session stream event",
          this.maxEventBytes,
          pendingEventBytes,
        );
        return;
      }
      if (offset < incoming.length && this.buf.length >= this.maxBufferBytes) {
        this._failAtLimit(
          "E_SSE_BUFFER_LIMIT",
          "session stream buffer",
          this.maxBufferBytes,
          this.buf.length + incoming.length - offset,
        );
        return;
      }
    }
  }

  _drainBlocks() {
    let cursor = 0;
    let boundary;
    while ((boundary = nextBoundary(this.buf, cursor))) {
      const block = this.buf.subarray(cursor, boundary.index);
      if (block.length > this.maxEventBytes) {
        this._failAtLimit(
          "E_SSE_EVENT_LIMIT",
          "session stream event",
          this.maxEventBytes,
          block.length,
        );
        return false;
      }
      this._emitBlock(block);
      if (this.stopped) return false;
      cursor = boundary.index + boundary.bytes;
    }
    if (cursor > 0) this.buf = Buffer.from(this.buf.subarray(cursor));
    return true;
  }

  _failAtLimit(code, label, limit, received) {
    if (this.fatalError) return;
    const error = new Error(`${label} exceeded the ${limit}-byte limit`);
    error.code = code;
    error.limit = limit;
    error.received = received;
    this.fatalError = error;
    this.stop();
    this.emit("state", "offline");
    this.emit("error", error);
  }

  _emitBlock(block) {
    const text = Buffer.isBuffer(block) ? block.toString("utf8") : String(block);
    let id = null;
    const dataLines = [];
    for (const rawLine of text.split(/\r?\n/)) {
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
    if (this.stopped || this.fatalError || this.reconnectTimer) return;
    this.req = null;
    this.res = null;
    this.emit("state", "reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, 1200);
  }
}
