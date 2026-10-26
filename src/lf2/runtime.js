// Explicit trial client for an owned, isolated Runtime 1.1 Gateway. The
// subscription/model process never receives this Gateway's local token.
import { constants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const FORMATS = { mov: "video/quicktime", mp4: "video/mp4" };

// Unlike a process-wide fetch dispatcher, this transport never reads proxy
// configuration. It also never follows a redirect with the local token.
async function loopbackFetch(url, options = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password) {
    throw new Error("Only the isolated loopback Gateway is allowed");
  }
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method: options.method || "GET", headers: options.headers, agent: false,
      signal: AbortSignal.timeout(180_000),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(new Error("Gateway redirects are refused"));
        return;
      }
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be a bounded opaque identifier`);
  return value;
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value, (_key, part) => {
    if (["undefined", "function", "symbol", "bigint"].includes(typeof part)
        || (typeof part === "number" && !Number.isFinite(part))) throw new Error("Scene parameters must be finite JSON");
    return part;
  }));
}

export async function createLf2Runtime({
  readyFile, sourceRoot, outputDir, projectId, sessionId, sceneId = "cli-film",
  width = 1280, height = 720, fps = 30, durationFrames = 240, fetchImpl = loopbackFetch, resume,
} = {}) {
  identifier(projectId, "projectId"); identifier(sessionId, "sessionId"); identifier(sceneId, "sceneId");
  for (const [name, value] of Object.entries({ readyFile, sourceRoot, outputDir })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute task path`);
  }
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096)
      || width * height > 3840 * 2160 || !Number.isFinite(fps) || fps < 1 || fps > 120
      || !Number.isInteger(durationFrames) || durationFrames < 1 || durationFrames > 216000) {
    throw new Error("Invalid configured LF2 dimensions, fps or duration");
  }
  function sceneDocument({ html, parameters = {}, seed = 25 } = {}) {
    if (typeof html !== "string" || !html.trim() || Buffer.byteLength(html) > 512 * 1024) throw new Error("LF2 HTML must be nonempty and at most 512 KiB");
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Scene parameters must be an object");
    const cleanParameters = jsonCopy(parameters);
    if (Buffer.byteLength(JSON.stringify(cleanParameters)) > 32 * 1024) throw new Error("Scene parameters exceed 32 KiB");
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Scene seed must be uint32");
    return { format: "lumeri.lumenframe2.scene/v1", luc_id: "lumeri.lumenframe2", contract: "synchronous-reset/v1",
      renderer_version: "0.1.0", scene_id: sceneId, html, width, height, fps, duration_frames: durationFrames, parameters: cleanParameters, seed };
  }
  let expectedResume = null;
  if (resume !== undefined) {
    try {
      if (!resume || typeof resume !== "object" || Array.isArray(resume)
          || Object.keys(resume).length !== 3
          || !Number.isSafeInteger(resume.projectRevision) || resume.projectRevision < 0
          || !Number.isSafeInteger(resume.sceneRevision) || resume.sceneRevision < 0
          || !isDeepStrictEqual(resume.scene, sceneDocument(resume.scene))) throw new Error();
      expectedResume = jsonCopy(resume);
    } catch { throw new Error("Malformed LF2 resume: exact nonnegative revisions and a complete configured Scene are required"); }
  }
  const handle = await fs.open(readyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 65536) {
      throw new Error("Readiness must be an owned regular 0600 file");
    }
    try { manifest = JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error("Invalid task readiness JSON"); }
  } finally { await handle.close(); }
  if (!manifest || typeof manifest !== "object" || manifest.identity_mode !== "isolated_static" || manifest.host !== "127.0.0.1"
      || manifest.source_root !== path.resolve(sourceRoot)
      || !Number.isInteger(manifest.port) || manifest.port < 1 || manifest.port > 65535) {
    throw new Error("Readiness is not this source checkout's isolated loopback Gateway");
  }
  const token = manifest.gateway_token;
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
    throw new Error("Invalid task Gateway token");
  }
  const port = manifest.port;
  manifest = null;
  const baseOrigin = `http://127.0.0.1:${port}`;
  const base = baseOrigin + "/runtime/v1/video";
  const prefix = "/sessions/" + encodeURIComponent(sessionId);
  const panel = prefix + "/luc/panels/panel.lumenframe2/call";
  const fixed = new Set(["/projects", "/projects/" + projectId, "/sessions", prefix,
    prefix + "/timeline", prefix + "/timeline/patch", panel, prefix + "/lumenframe2/timeline/frame"]);
  if (expectedResume) fixed.add(prefix + "/resume");
  let initialized = false;
  let queue = Promise.resolve();
  const sceneFiles = new Map();
  const jobIds = new Map();
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const requireInitialized = () => { if (!initialized) throw new Error("Call initialize() before using this new film Project"); };

  async function request(route, body, { missingOk = false, binary = false } = {}) {
    const dynamic = route.startsWith(prefix + "/jobs/") || route.startsWith(prefix + "/assets/");
    if (!fixed.has(route) && !(dynamic && ID.test(route.slice(route.lastIndexOf("/") + 1)))) {
      throw new Error("Route is outside the owned LF2 Project/session");
    }
    let response;
    try {
      response = await fetchImpl(base + route, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { "X-Lumeri-Gateway-Token": token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error("LF2 Gateway connection failed (redirects and proxy routes are not allowed)"); }
    if (response.redirected || (response.url && new URL(response.url).origin !== baseOrigin)) {
      throw new Error("LF2 Gateway redirect refused");
    }
    if (missingOk && response.status === 404) { await response.body?.cancel(); return null; }
    if (![200, 201, 202].includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`LF2 Gateway HTTP ${response.status} at ${route}`);
    }
    if (binary) return response;
    if (!response.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected LF2 Gateway JSON");
    let value;
    try { value = await response.json(); }
    catch { throw new Error("Malformed LF2 Gateway JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected LF2 Gateway response object");
    return value;
  }
  async function call(api, payload) {
    const result = await request(panel, { api, payload });
    if (result.ok !== true || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error(`Luc refused ${api}`);
    return result.value;
  }
  const timeline = () => request(prefix + "/timeline");
  const readScene = (source = false) => call("renderer.scene.read", { scene_id: sceneId, include_source: source });

  async function writeExclusive(name, data) {
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(outputDir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("Output directory must be owned and not a symlink");
    const destination = path.join(outputDir, name);
    const file = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); await file.sync(); }
    catch (error) { await file.close(); await fs.unlink(destination); throw error; }
    await file.close();
    return destination;
  }
  async function inspectState() {
    const [listing, current] = await Promise.all([call("renderer.scene.list", {}), timeline()]);
    if (!Array.isArray(listing.scenes) || !current.timeline || !Array.isArray(current.timeline.clips)) throw new Error("Malformed owned LF2 Project state");
    if (listing.scenes.some((row) => row.scene_id !== sceneId)) throw new Error("Owned Project contains an unexpected Scene");
    const state = listing.scenes.length ? await readScene() : null;
    if (current.timeline.width !== width || current.timeline.height !== height || current.timeline.fps !== fps
        || (state && ["width", "height", "fps", "duration_frames"].some((key) => state.scene?.[key] !== ({ width, height, fps, duration_frames: durationFrames })[key]))) {
      throw new Error("Owned LF2 film dimensions, fps or duration changed");
    }
    const clips = current.timeline.clips;
    if (clips.length > 1 || clips.some((clip) => clip.media_kind !== "lumenframe2" || clip.lf2?.scene_id !== sceneId
        || clip.asset_id || Object.hasOwn(clip, "lf2_frames"))) throw new Error("Owned Timeline contains an unexpected clip");
    return {
      projectId, sessionId, sceneId, projectRevision: current.project_revision,
      sceneRevision: state?.scene_revision ?? null,
      scene: state?.scene ?? null,
      timeline: { width: current.timeline.width, height: current.timeline.height, fps: current.timeline.fps,
        duration: current.timeline.duration, clips: clips.map(({ id, media_kind, start, duration, lf2 }) => ({ id, media_kind, start, duration, lf2 })) },
    };
  }

  return {
    initialize: () => serial(async () => {
      if (initialized) return inspectState();
      if (expectedResume) {
        const project = await request("/projects/" + projectId, undefined, { missingOk: true });
        const session = await request(prefix, undefined, { missingOk: true });
        if (!project || !session || project.project_id !== projectId
            || session.project_id !== projectId || session.session_id !== sessionId
            || project.revision !== expectedResume.projectRevision) {
          throw new Error("LF2 resume requires existing bound Project/session IDs and the exact persisted Project revision");
        }
        const resumed = await request(prefix + "/resume", {});
        if (resumed.project_id !== projectId || resumed.session_id !== sessionId) throw new Error("LF2 resume returned different Project/session IDs");
        const current = await inspectState();
        const clip = current.timeline.clips[0];
        if (current.projectRevision !== expectedResume.projectRevision || current.sceneRevision !== expectedResume.sceneRevision
            || current.timeline.clips.length !== 1 || clip.start !== 0 || clip.duration !== durationFrames / fps) {
          throw new Error("LF2 resume persisted revisions or native Timeline clip do not match");
        }
        const stored = await readScene(true);
        if (stored.project_revision !== expectedResume.projectRevision || stored.scene_revision !== expectedResume.sceneRevision
            || !isDeepStrictEqual(stored.scene, expectedResume.scene)) throw new Error("LF2 resume persisted Scene revision or source does not match");
        initialized = true;
        return current;
      }
      if (await request("/projects/" + projectId, undefined, { missingOk: true })) throw new Error("Refusing pre-existing Project; choose a new task Project ID");
      if (await request(prefix, undefined, { missingOk: true })) throw new Error("Refusing pre-existing session");
      const project = await request("/projects", { name: "LF2 CLI film", project_id: projectId });
      await request("/sessions", { project_id: projectId, session_id: sessionId,
        expected_project_revision: project.revision, budget_limit_usd: .25 });
      const current = await timeline();
      const revision = current.project_revision;
      const formatted = await request(prefix + "/timeline/patch", {
        patch: { op: "set_timeline_format", width, height, fps }, project_revision: revision,
        turn_id: `lf2_format_p${revision}`, trace_id: `lf2_format_p${revision}`, idempotency_key: `lf2_format_p${revision}`,
      });
      if (formatted.status !== "succeeded") throw new Error("Timeline format was not committed; no approval was granted");
      initialized = true;
      return inspectState();
    }),
    inspect: () => serial(async () => { requireInitialized(); return inspectState(); }),
    saveScene: ({ html, parameters = {}, seed = 25 } = {}) => serial(async () => {
      requireInitialized();
      const scene = sceneDocument({ html, parameters, seed });
      const before = await inspectState();
      const previous = before.scene ? await readScene(true) : null;
      if (!previous || !isDeepStrictEqual(previous.scene, scene)) {
        const revision = previous?.project_revision ?? before.projectRevision;
        const sceneRevision = previous?.scene_revision ?? 0;
        const saved = await call("renderer.scene.write", { patch: { op: "save", scene_id: sceneId,
          expected_scene_revision: sceneRevision, scene }, project_revision: revision,
          idempotency_key: `lf2_save_p${revision}_s${sceneRevision}` });
        if (saved.status !== "committed") throw new Error("Scene save was not committed; no approval was granted");
      }
      const current = await timeline();
      if (!current.timeline.clips.length) {
        const revision = current.project_revision;
        const inserted = await call("renderer.timeline.insert", { scene_id: sceneId, track_id: "OV1", start: 0,
          project_revision: revision, idempotency_key: `lf2_insert_p${revision}` });
        if (inserted.status !== "applied") throw new Error("Native clip insertion was not applied; no approval was granted");
      }
      const result = await inspectState();
      const fileKey = `${result.projectRevision}-${result.sceneRevision}`;
      if (!sceneFiles.has(fileKey)) {
        const suffix = `p${result.projectRevision}-s${result.sceneRevision}`;
        const scenePath = await writeExclusive(`scene-${suffix}.json`, JSON.stringify(scene, null, 2) + "\n");
        const htmlPath = await writeExclusive(`scene-${suffix}.html`, html);
        sceneFiles.set(fileKey, { scenePath, htmlPath });
      }
      return { ...result, ...sceneFiles.get(fileKey) };
    }),
    previewFrames: ({ frameIndices } = {}) => serial(async () => {
      requireInitialized();
      if (!Array.isArray(frameIndices) || !frameIndices.length || frameIndices.length > 12
          || frameIndices.some((n) => !Number.isInteger(n) || n < 0 || n >= durationFrames)) throw new Error("Preview needs 1..12 valid frame indices");
      const state = await inspectState();
      if (!state.scene) throw new Error("Save a Scene before preview");
      const images = [], frames = [];
      for (const frameIndex of frameIndices) {
        const value = await request(prefix + "/lumenframe2/timeline/frame", { time: frameIndex / fps, project_revision: state.projectRevision });
        if (typeof value.picture !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.picture)) throw new Error("Runtime returned no PNG frame");
        const bytes = Buffer.from(value.picture.split(",")[1], "base64");
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Runtime frame is not PNG");
        const filename = `frame-${String(frameIndex).padStart(6, "0")}-${randomBytes(4).toString("hex")}.png`;
        const framePath = await writeExclusive(filename, bytes);
        images.push({ frameIndex, mimeType: "image/png", dataUrl: value.picture });
        frames.push({ frameIndex, path: framePath, width: value.width, height: value.height });
      }
      return { projectId, sessionId, sceneId, projectRevision: state.projectRevision, sceneRevision: state.sceneRevision, images, frames };
    }),
    exportVideo: ({ format } = {}) => serial(async () => {
      requireInitialized();
      if (typeof format !== "string" || !Object.hasOwn(FORMATS, format)) throw new Error("Export format must be explicit mp4 or mov");
      const state = await inspectState();
      if (!state.scene) throw new Error("Save a Scene before export");
      const key = `lf2_export_${format}_p${state.projectRevision}_s${state.sceneRevision}`;
      let value = await call("renderer.timeline.export", { project_revision: state.projectRevision, idempotency_key: key, output_format: format });
      const jobId = value.job?.job_id || jobIds.get(key);
      if (typeof jobId !== "string" || !ID.test(jobId)) throw new Error("Runtime returned no valid export Job handle");
      jobIds.set(key, jobId);
      const deadline = Date.now() + 600_000;
      while (value.status !== "succeeded") {
        if (["failed", "denied", "cancelled", "awaiting_approval", "approval_required"].includes(value.status)
            || ["failed", "cancelled", "abandoned"].includes(value.job?.state)) throw new Error(`LF2 export Job ${jobId} did not succeed; no approval was granted`);
        if (Date.now() >= deadline) throw new Error(`LF2 export Job ${jobId} remains pending; it was not cancelled`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        value = await request(prefix + "/jobs/" + jobId);
      }
      const asset = value.asset;
      if (!asset || typeof asset.asset_id !== "string" || !ID.test(asset.asset_id) || asset.content_type !== FORMATS[format]
          || value.execution_outcome?.status !== "succeeded") throw new Error("Export has no matching successful media asset");
      const response = await request(prefix + "/assets/" + asset.asset_id, undefined, { binary: true });
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== FORMATS[format]) throw new Error("Export download media type mismatch");
      let bytes = 0;
      async function* media() {
        for await (const chunk of response.body) { bytes += chunk.length; yield chunk; }
        if (!bytes) throw new Error("Export download is empty");
      }
      const outputPath = await writeExclusive(`film-${format}-${randomBytes(6).toString("hex")}.${format}`, media());
      return { path: outputPath, jobId, assetId: asset.asset_id, bytes, format, mimeType: FORMATS[format],
        projectId, sessionId, sceneId, projectRevision: state.projectRevision, sceneRevision: state.sceneRevision };
    }),
  };
}
