// Outbound HTTP for the OpenAI endpoints. Unlike src/http.js (which talks to
// the loopback sidecar and deliberately bypasses proxies), these calls go to
// auth.openai.com / chatgpt.com and MUST honour the machine proxy (Clash on
// 127.0.0.1:7890 here) — otherwise they're geo-blocked. Node's global fetch
// ignores *_PROXY, so we tunnel ourselves via HTTP CONNECT, zero deps.
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";

function noProxyMatch(hostname) {
  const list = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of list) {
    if (entry === "*") return true;
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (hostname === bare || hostname.endsWith("." + bare)) return true;
  }
  return false;
}

function proxyFor(target) {
  if (noProxyMatch(target.hostname)) return null;
  const env =
    target.protocol === "https:"
      ? process.env.HTTPS_PROXY || process.env.https_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  const raw = env || process.env.ALL_PROXY || process.env.all_proxy;
  return raw ? new URL(raw) : null;
}

// Resolve a ready-to-write socket to `target`, TLS-wrapped for https, tunneled
// through the proxy via CONNECT when one is configured.
function connect(target) {
  return new Promise((resolve, reject) => {
    const isTls = target.protocol === "https:";
    const port = Number(target.port) || (isTls ? 443 : 80);
    const proxy = proxyFor(target);

    const wrap = (sock) => {
      if (!isTls) return resolve(sock);
      const tlsSock = tls.connect(
        { socket: sock, servername: target.hostname, ALPNProtocols: ["http/1.1"] },
        () => resolve(tlsSock),
      );
      tlsSock.once("error", reject);
    };

    if (!proxy) {
      const sock = net.connect(port, target.hostname);
      sock.once("connect", () => wrap(sock));
      sock.once("error", reject);
      return;
    }

    const auth = proxy.username
      ? {
          "Proxy-Authorization":
            "Basic " +
            Buffer.from(
              `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
            ).toString("base64"),
        }
      : {};
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}`, ...auth },
    });
    req.once("connect", (res, sock) => {
      if (res.statusCode !== 200) {
        sock.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
        return;
      }
      wrap(sock);
    });
    req.once("error", reject);
    req.end();
  });
}

// Low-level request. Resolves { status, headers, stream } where stream is the
// raw IncomingMessage (consume for SSE, or buffer it). Honours AbortSignal.
export async function rawRequest(urlStr, { method = "GET", headers = {}, body, signal } = {}) {
  if (signal?.aborted) throw new Error("aborted");
  const target = new URL(urlStr);
  const sock = await connect(target);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        createConnection: () => sock,
        method,
        host: target.hostname,
        path: target.pathname + target.search,
        headers: { Host: target.host, ...headers },
      },
      (res) => resolve({ status: res.statusCode || 0, headers: res.headers, stream: res }),
    );
    const onAbort = () => req.destroy(new Error("aborted"));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.once("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function buffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// JSON request → { status, headers, json, text }. `json` body is serialized;
// `form` body is x-www-form-urlencoded.
export async function requestJson(urlStr, opts = {}) {
  const { method = "GET", headers = {}, json, form, signal } = opts;
  let body;
  const h = { Accept: "application/json", ...headers };
  if (json !== undefined) {
    body = Buffer.from(JSON.stringify(json), "utf8");
    h["Content-Type"] = "application/json";
  } else if (form !== undefined) {
    body = Buffer.from(new URLSearchParams(form).toString(), "utf8");
    h["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (body) h["Content-Length"] = Buffer.byteLength(body);
  const { status, headers: resHeaders, stream } = await rawRequest(urlStr, {
    method,
    headers: h,
    body,
    signal,
  });
  const text = await buffer(stream);
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* leave parsed null; caller can read text */
  }
  return { status, headers: resHeaders, json: parsed, text };
}
