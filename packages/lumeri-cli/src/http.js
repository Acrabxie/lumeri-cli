// Low-level HTTP against the local Lumeri sidecar. Uses Node's http/https
// modules directly (never a proxy) so a machine-wide HTTP_PROXY / FlClash can't
// hijack the loopback connection, and so we get raw streaming for SSE.

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { currentProduct } from "./product.js";

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

// JSON / raw-body / streamed request → resolves { status, headers, json, text }.
// Pass `stream` (a Readable) + `contentLength` to upload without buffering the
// whole body in memory.
export function request(baseUrl, path, opts = {}) {
  const { method = "GET", json, body, stream, contentLength, headers = {}, timeoutMs = 30000 } = opts;
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
    const req = lib(u).request(
      u,
      { method, headers: hdrs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({
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
    req.on("error", reject);
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
