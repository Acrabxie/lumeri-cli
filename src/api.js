// Typed wrappers over the Lumeri v3 HTTP surface (see gemia/v3_routes.py).
//   POST   /sessions                       -> create
//   GET    /sessions/{id}                  -> info (assets, latest_event_id)
//   POST   /sessions/{id}/turn             -> submit user message (202; 409 if busy)
//   POST   /sessions/{id}/assets           -> upload (raw body + X-Filename)
//   GET    /sessions/{id}/assets           -> list
//   GET    /sessions/{id}/timeline         -> project timeline
//   POST   /sessions/{id}/close            -> close

import fs from "node:fs";
import path from "node:path";
import { request } from "./http.js";

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function ok(res, ...accept) {
  const wanted = accept.length ? accept : [200, 201, 202];
  if (!wanted.includes(res.status)) {
    const msg = res.json?.error || res.text || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, res.json?.code);
  }
  return res.json;
}

export async function health(baseUrl) {
  const res = await request(baseUrl, "/health", { timeoutMs: 4000 });
  return res.status === 200;
}

export async function createSession(baseUrl) {
  const res = await request(baseUrl, "/sessions", { method: "POST", timeoutMs: 8000 });
  return ok(res, 201);
}

export async function getInfo(baseUrl, sessionId) {
  const res = await request(baseUrl, `/sessions/${sessionId}`);
  return ok(res, 200);
}

export async function submitTurn(baseUrl, sessionId, message) {
  const res = await request(baseUrl, `/sessions/${sessionId}/turn`, {
    method: "POST",
    json: { message },
  });
  // 409 = a turn is already running; surface it distinctly.
  if (res.status === 409) {
    throw new ApiError("a turn is already in progress", 409, "E_BUSY");
  }
  return ok(res, 202);
}

// Fetch the backend model catalog (priority-ordered) + active selection.
//   GET /model -> { slot, priority:[{id,label,provider}], efforts:[…], active }
// Mirrors the web client's /model command (static/v3/v3.js).
export async function getModel(baseUrl) {
  const res = await request(baseUrl, "/model");
  return ok(res, 200);
}

// Switch the active model and/or thinking effort. Send only the keys you want
// to change; a value of null/"" resets that dimension to the backend default.
//   POST /model { model?, effort? } -> { ok, slot, priority, efforts, active }
export async function setModel(baseUrl, { model, effort } = {}) {
  const json = {};
  if (model !== undefined) json.model = model;
  if (effort !== undefined) json.effort = effort;
  const res = await request(baseUrl, "/model", { method: "POST", json });
  return ok(res, 200);
}

export async function listAssets(baseUrl, sessionId) {
  const res = await request(baseUrl, `/sessions/${sessionId}/assets`);
  return ok(res, 200).assets || [];
}

export async function listMediaLibrary(baseUrl, { kind = "", q = "", limit = 100 } = {}) {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (q) params.set("q", q);
  if (limit) params.set("limit", String(limit));
  const suffix = params.toString() ? `?${params}` : "";
  const res = await request(baseUrl, `/media-library/list${suffix}`);
  return ok(res, 200).assets || [];
}

export async function annotateMediaLibrary(baseUrl, body) {
  const res = await request(baseUrl, "/media-library/annotate", {
    method: "POST",
    json: body,
    timeoutMs: 120000,
  });
  return ok(res, 200);
}

export async function listMediaAnnotations(baseUrl, assetId) {
  const res = await request(baseUrl, `/media-library/${encodeURIComponent(assetId)}/annotations`);
  return ok(res, 200).annotations || [];
}

// Deliver the user's answer to a pending `ask_question` (elicit) back to the
// session loop. Mirrors the web client (static/v3/v3.js showAskModal submit):
//   POST /sessions/{id}/ask_response  { question_id, answers }
// where `answers` is an OBJECT keyed by control key -> the user's value. The
// server (gemia/v3_routes.py _ask_response) requires both and 404s an unknown
// question_id. Accept 200/202/204 — the route returns 200 on success.
export async function submitAskResponse(baseUrl, sessionId, questionId, answers) {
  const res = await request(baseUrl, `/sessions/${sessionId}/ask_response`, {
    method: "POST",
    json: { question_id: questionId, answers },
  });
  return ok(res, 200, 202, 204);
}

// Toggle the session's plan mode (gemia/v3_routes.py _set_plan_mode). The
// backend also broadcasts a `plan_mode_changed` SSE event to every client.
export async function setPlanMode(baseUrl, sessionId, enabled) {
  const res = await request(baseUrl, `/sessions/${sessionId}/plan_mode`, {
    method: "POST",
    json: { enabled: !!enabled },
  });
  return ok(res, 200);
}

export async function getTimeline(baseUrl, sessionId) {
  const res = await request(baseUrl, `/sessions/${sessionId}/timeline`);
  return ok(res, 200);
}

// Background shell task chain (gemia run_in_background run_shell). listTasks
// returns the authoritative snapshot the SSE ring can't (used by /tasks and
// resyncAfterGap); killTask maps to POST .../tasks/{job_id}/kill.
export async function listTasks(baseUrl, sessionId) {
  const res = await request(baseUrl, `/sessions/${sessionId}/tasks`);
  return ok(res, 200);
}

export async function killTask(baseUrl, sessionId, jobId) {
  const res = await request(baseUrl, `/sessions/${sessionId}/tasks/${encodeURIComponent(jobId)}/kill`, {
    method: "POST",
  });
  return ok(res, 200);
}

export async function closeSession(baseUrl, sessionId) {
  const res = await request(baseUrl, `/sessions/${sessionId}/close`, {
    method: "POST",
    timeoutMs: 5000,
  });
  return ok(res, 200);
}

// Server cap is LUMERI_V3_UPLOAD_MAX_BYTES (default 500 MiB); mirror it here so
// oversized files are rejected immediately instead of streaming up then 413'ing.
const UPLOAD_CAP = 500 * 1024 * 1024;

export async function uploadAsset(baseUrl, sessionId, filePath) {
  const abs = path.resolve(filePath.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
  const stat = await fs.promises.stat(abs); // throws ENOENT with a clear message
  if (!stat.isFile()) throw new ApiError(`not a file: ${abs}`, 0, "E_NOT_FILE");
  if (stat.size <= 0) throw new ApiError(`file is empty: ${abs}`, 0, "E_EMPTY");
  if (stat.size > UPLOAD_CAP) {
    throw new ApiError(`file too large: ${stat.size} > ${UPLOAD_CAP} bytes`, 0, "E_TOO_LARGE");
  }
  // Stream from disk instead of buffering the whole file in memory.
  const res = await request(baseUrl, `/sessions/${sessionId}/assets`, {
    method: "POST",
    stream: fs.createReadStream(abs),
    contentLength: stat.size,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(path.basename(abs)),
    },
    timeoutMs: 300000,
  });
  return ok(res, 201);
}

export function assetUrl(baseUrl, sessionId, assetId) {
  return new URL(`/sessions/${sessionId}/assets/${assetId}`, baseUrl).toString();
}

// The read-only preview monitor (gemia static/v3/preview.html), attached to a
// specific session. Served same-origin with the sidecar.
export function previewUrl(baseUrl, sessionId) {
  const u = new URL("/video/preview.html", baseUrl);
  u.searchParams.set("session", sessionId);
  return u.toString();
}

export async function previewAvailable(baseUrl) {
  try {
    const res = await request(baseUrl, "/video/preview.html", { timeoutMs: 3000 });
    return res.status === 200;
  } catch {
    return false;
  }
}
