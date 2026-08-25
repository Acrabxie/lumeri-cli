// Low-level HTTP against the local Lumeri sidecar. Uses Node's http/https
// modules directly (never a proxy) so a machine-wide HTTP_PROXY / FlClash can't
// hijack the loopback connection, and so we get raw streaming for SSE.

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { currentProduct } from "./product.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function lib(u) {
  return u.protocol === "https:" ? https : http;
}

function productHeaders(headers = {}, accept) {
  const merged = { Accept: accept, ...headers };
  const hasProduct = Object.keys(merged).some(
    (name) => name.toLowerCase() === "x-lumeri-product",
  );
  if (!hasProduct) merged["X-Lumeri-Product"] = currentProduct();
  return merged;
}

function responseByteLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    const error = new RangeError("maxResponseBytes must be a positive safe integer");
    error.code = "E_HTTP_RESPONSE_LIMIT_CONFIG";
    throw error;
  }
  return value;
}

function responseLimitError(limit, received) {
  const error = new Error(`Runtime response exceeded the ${limit}-byte limit`);
  error.code = "E_HTTP_RESPONSE_LIMIT";
  error.limit = limit;
  error.received = received;
  return error;
}

// JSON / raw-body / streamed request → resolves { status, headers, json, text }.
// Pass `stream` (a Readable) + `contentLength` to upload without buffering the
// whole body in memory.
export function request(baseUrl, path, opts = {}) {
  const {
    method = "GET",
    json,
    body,
    stream,
    contentLength,
    headers = {},
    timeoutMs = 30000,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = opts;
  const responseLimit = responseByteLimit(maxResponseBytes);
  const u = new URL(path, baseUrl);

  let payload = body;
  const hdrs = productHeaders(headers, "application/json");
  if (json !== undefined) {
    payload = Buffer.from(JSON.stringify(json), "utf8");
    hdrs["Content-Type"] = "application/json; charset=utf-8";
  }
  if (stream != null && contentLength != null && hdrs["Content-Length"] == null) {
    hdrs["Content-Length"] = contentLength;
  } else if (payload != null && hdrs["Content-Length"] == null) {
    hdrs["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = lib(u).request(
      u,
      { method, headers: hdrs },
      (res) => {
        const chunks = [];
        let received = 0;
        const stopAtLimit = (knownBytes) => {
          const error = responseLimitError(responseLimit, knownBytes);
          rejectOnce(error);
          res.destroy(error);
          req.destroy(error);
        };
        res.on("error", rejectOnce);
        res.on("aborted", () => {
          const error = new Error("Runtime response ended before completion");
          error.code = "E_HTTP_RESPONSE_ABORTED";
          rejectOnce(error);
        });
        const advertised = Number(res.headers["content-length"]);
        if (Number.isSafeInteger(advertised) && advertised > responseLimit) {
          stopAtLimit(advertised);
          return;
        }
        res.on("data", (chunk) => {
          received += chunk.byteLength;
          if (received > responseLimit) {
            stopAtLimit(received);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolveOnce({
            status: res.statusCode || 0,
            headers: res.headers,
            json: parsed,
            text,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on("error", rejectOnce);
    if (stream != null) {
      stream.on("error", (err) => req.destroy(err));
      stream.pipe(req);
    } else {
      if (payload != null) req.write(payload);
      req.end();
    }
  });
}

// Open a long-lived GET and hand the live response back to the caller for
// incremental reads (used by the SSE client). Resolves once headers arrive.
export function openStream(baseUrl, path, { headers = {}, onRequest, timeoutMs = 10_000 } = {}) {
  const u = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    let timer = null;
    const clearHeaderTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const req = lib(u).request(
      u,
      { method: "GET", headers: productHeaders(headers, "text/event-stream") },
      (res) => {
        clearHeaderTimer();
        resolve({ res, req });
      },
    );
    onRequest?.(req);
    req.on("error", (error) => {
      clearHeaderTimer();
      reject(error);
    });
    timer = setTimeout(() => {
      const error = new Error("timed out while connecting to the session stream");
      error.code = "E_STREAM_HEADERS_TIMEOUT";
      req.destroy(error);
    }, timeoutMs);
    timer.unref?.();
    req.end();
  });
}
