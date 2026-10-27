import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createLf2Runtime } from "../src/lf2/runtime.js";

const TOKEN = "test-only-isolated-gateway-token-20261025";
const HTML = "<svg><circle r='20'/></svg><script>function render(frame,fps,p){}</script>";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDe0AAAAASUVORK5CYII=", "base64");
const VIDEO = Buffer.from("mock encoded media bytes; not a real render");
const copy = (value) => structuredClone(value);
const sorted = (value) => value && typeof value === "object"
  ? (Array.isArray(value) ? value.map(sorted) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))) : value;

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lf2-runtime-test-"));
  const sourceRoot = path.join(root, "source");
  const outputDir = path.join(root, "output");
  const readyFile = path.join(root, "ready.json");
  await fs.mkdir(sourceRoot);
  const projectId = "project_cli_trial", sessionId = "session_cli_trial", sceneId = "cli-film";
  const prefix = "/runtime/v1/video", session = `${prefix}/sessions/${sessionId}`;
  const state = { revision: 0, sceneRevision: null, scene: null, clips: [], project: false, session: false,
    width: 1920, height: 1080, fps: 24, requests: [], errors: [], ...overrides };
  const server = http.createServer(async (request, response) => {
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      assert.equal(request.headers["x-lumeri-gateway-token"], TOKEN);
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: request.method, route: request.url, body });
      if (state.intercept?.({ request, response, body, json })) return;
      if (request.url === `${prefix}/projects/${projectId}`) return json(state.project ? 200 : 404, state.project ? (state.projectReply ?? { project_id: projectId, revision: state.revision }) : {});
      if (request.url === session) return json(state.session ? 200 : 404, state.session ? (state.sessionReply ?? { project_id: projectId, session_id: sessionId }) : {});
      if (request.url === `${session}/resume`) {
        assert.equal(request.method, "POST"); assert.deepEqual(body, {});
        if (state.resumeRevisionChange) state.revision++;
        return json(200, state.resumeReply ?? { project_id: projectId, session_id: sessionId });
      }
      if (request.url === `${prefix}/projects`) {
        assert.equal(request.method, "POST"); assert.equal(body.project_id, projectId); assert.equal(state.project, false);
        state.project = true;
        return json(201, { project_id: projectId, revision: state.revision });
      }
      if (request.url === `${prefix}/sessions`) {
        assert.equal(body.expected_project_revision, state.revision);
        assert.equal(body.project_id, projectId); assert.equal(body.session_id, sessionId);
        assert.equal(body.budget_limit_usd, 0, "subscription film tools must not enable Runtime model spending");
        state.session = true;
        return json(201, { project_id: projectId, session_id: sessionId });
      }
      if (request.url === `${session}/timeline`) return json(200, {
        project_revision: state.revision,
        timeline: { width: state.width, height: state.height, fps: state.fps, duration: state.clips.length ? 8 : 0,
          tracks: [{ id: "OV1" }], clips: state.clips },
      });
      if (request.url === `${session}/timeline/patch`) {
        assert.equal(body.project_revision, state.revision); assert.equal(body.patch.op, "set_timeline_format");
        if (state.formatRefused) return json(202, { status: "awaiting_approval" });
        Object.assign(state, { width: body.patch.width, height: body.patch.height, fps: body.patch.fps });
        state.revision++;
        return json(200, { status: "succeeded", project_revision: state.revision });
      }
      if (request.url === `${session}/luc/panels/panel.lumenframe2/call`) {
        const { api, payload } = body;
        const answer = (value) => json(200, { ok: true, value });
        if (api === "renderer.scene.list") return answer({ project_revision: state.revision, scenes: state.scene ? [{ scene_id: sceneId }] : [] });
        if (api === "renderer.scene.read") {
          assert.equal(payload.scene_id, sceneId);
          const scene = sorted(state.scene);
          if (!payload.include_source) delete scene.html;
          return answer({ project_revision: state.revision, scene_revision: state.sceneRevision, scene });
        }
        if (api === "renderer.scene.write") {
          assert.equal(payload.project_revision, state.revision);
          assert.equal(payload.patch.expected_scene_revision, state.sceneRevision ?? 0);
          assert.equal(payload.patch.op, "save");
          if (state.saveRefused) return answer({ status: "awaiting_approval" });
          state.scene = copy(payload.patch.scene);
          state.sceneRevision = state.sceneRevision === null ? 0 : state.sceneRevision + 1;
          state.revision++;
          return answer({ status: "committed", project_revision: state.revision, scene_revision: state.sceneRevision });
        }
        if (api === "renderer.timeline.insert") {
          assert.equal(payload.project_revision, state.revision); assert.equal(payload.scene_id, sceneId);
          assert.equal(payload.track_id, "OV1"); assert.equal(payload.start, 0); assert.equal(state.clips.length, 0);
          state.clips.push({ id: "clip_native", media_kind: "lumenframe2", asset_id: "", start: 0, duration: 8,
            lf2: { scene_id: sceneId, scene_revision: state.sceneRevision } });
          state.revision++;
          return answer({ status: "applied", revision: state.revision, clip_id: "clip_native" });
        }
        if (api === "renderer.timeline.export") {
          assert.equal(payload.project_revision, state.revision);
          assert.match(payload.idempotency_key, new RegExp(`^lf2_export_${payload.output_format}_p${state.revision}_s${state.sceneRevision}$`));
          state.format = payload.output_format;
          return answer({ ...state.exportInitial, job: { job_id: "job_trial", state: "running" } });
        }
        throw new Error(`Unexpected mock API ${api}`);
      }
      if (request.url === `${session}/lumenframe2/timeline/frame`) {
        assert.equal(body.project_revision, state.revision);
        return json(200, { picture: state.picture ?? `data:image/png;base64,${PNG.toString("base64")}`,
          width: state.width, height: state.height, project_revision: state.revision });
      }
      if (request.url === `${session}/jobs/job_trial`) {
        state.revision++;
        return json(200, state.exportFinal ?? { status: "succeeded", asset: { asset_id: "asset_trial",
          content_type: state.format === "mov" ? "video/quicktime" : "video/mp4" }, execution_outcome: { status: "succeeded" } });
      }
      if (request.url === `${session}/assets/asset_trial`) {
        response.writeHead(200, { "Content-Type": state.downloadType ?? (state.format === "mov" ? "video/quicktime" : "video/mp4") });
        response.end(state.download ?? VIDEO);
        return;
      }
      throw new Error(`Unexpected mock route ${request.url}`);
    } catch (error) { state.errors.push(error); json(500, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ready = { host: "127.0.0.1", port: server.address().port, gateway_token: TOKEN,
    identity_mode: "isolated_static", source_root: sourceRoot };
  await fs.writeFile(readyFile, JSON.stringify(ready), { mode: 0o600 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true }); // Only this test's mkdtemp directory.
    assert.deepEqual(state.errors, []);
  });
  const options = { readyFile, sourceRoot, outputDir, projectId, sessionId, sceneId };
  return { state, options, ready, root, readyFile, outputDir,
    create: (extra = {}) => createLf2Runtime({ ...options, ...extra }) };
}

test("normal owned routes use live revisions, one native clip, editable source, PNG previews and Job/CAS exports", async (t) => {
  const f = await fixture(t);
  let fetches = 0;
  const client = await f.create({ fetchImpl: (url, options) => { fetches++; assert.equal(options.redirect, "error"); return fetch(url, options); } });
  assert.equal((await client.initialize()).projectRevision, 1);
  const saved = await client.saveScene({ html: HTML, parameters: { z: 1, a: 2 } });
  assert.equal(saved.sceneRevision, 0); assert.equal(saved.projectRevision, 3);
  assert.equal(JSON.parse(await fs.readFile(saved.scenePath, "utf8")).html, HTML);
  assert.equal(await fs.readFile(saved.htmlPath, "utf8"), HTML);
  const unchanged = await client.saveScene({ html: HTML, parameters: { a: 2, z: 1 } });
  assert.equal(unchanged.projectRevision, 3, "JSON key order must not cause a save");
  assert.equal(unchanged.scenePath, saved.scenePath);
  const changed = await client.saveScene({ html: HTML.replace("20", "30"), parameters: { a: 2, z: 1 } });
  assert.equal(changed.sceneRevision, 1); assert.equal(changed.projectRevision, 4);
  assert.equal(changed.timeline.clips.length, 1);
  const writes = f.state.requests.filter((r) => r.body?.api === "renderer.scene.write");
  assert.deepEqual(writes.map((r) => [r.body.payload.project_revision, r.body.payload.patch.expected_scene_revision]), [[1, 0], [3, 0]]);
  assert.equal(f.state.requests.filter((r) => r.body?.api === "renderer.timeline.insert").length, 1);
  const previews = await client.previewFrames({ frameIndices: [0, 239] });
  assert.equal(previews.images.length, 2);
  assert.equal(previews.images[0].mimeType, "image/png");
  assert.equal(previews.frames[1].frameIndex, 239);
  assert.deepEqual(await fs.readFile(previews.frames[0].path), PNG);
  assert.ok(!JSON.stringify(previews.frames).includes("base64"));
  const frameCalls = f.state.requests.filter((r) => r.route.endsWith("/lumenframe2/timeline/frame"));
  assert.equal(frameCalls[1].body.time, 239 / 30);
  const mov = await client.exportVideo({ format: "mov" });
  const mp4 = await client.exportVideo({ format: "mp4" });
  assert.equal(mov.mimeType, "video/quicktime"); assert.equal(path.extname(mov.path), ".mov");
  assert.equal(mp4.mimeType, "video/mp4"); assert.equal(path.extname(mp4.path), ".mp4");
  assert.deepEqual(await fs.readFile(mov.path), VIDEO); assert.equal(mov.bytes, VIDEO.length);
  assert.equal((await fs.stat(mov.path)).mode & 0o777, 0o600);
  assert.notEqual(mov.path, mp4.path); assert.ok(fetches > 10);
  assert.ok(!JSON.stringify([saved, changed, previews, mov, mp4, await client.inspect()]).includes(TOKEN));
  assert.equal((await client.initialize()).timeline.clips.length, 1, "same client initialize is safe to repeat");
});

test("fresh clients refuse pre-existing Project or session without writing", async (t) => {
  for (const existing of [{ project: true }, { session: true }]) await t.test(JSON.stringify(existing), async (t) => {
    const f = await fixture(t, existing); const client = await f.create();
    await assert.rejects(client.initialize(), /pre-existing/);
    assert.ok(f.state.requests.every((r) => r.method === "GET"));
  });
});

async function persistedFilm(t) {
  const f = await fixture(t);
  const original = await f.create(); await original.initialize();
  const saved = await original.saveScene({ html: HTML, parameters: { orange: "#f60" } });
  const resume = { projectRevision: saved.projectRevision, sceneRevision: saved.sceneRevision,
    scene: JSON.parse(await fs.readFile(saved.scenePath, "utf8")) };
  f.state.requests.length = 0;
  return { ...f, resume };
}

test("explicit owned resume validates persisted source and resumes only the existing session", async (t) => {
  const f = await persistedFilm(t);
  const before = copy({ scene: f.state.scene, clips: f.state.clips, revision: f.state.revision });
  const files = await fs.readdir(f.outputDir);
  const client = await f.create({ resume: f.resume });
  f.resume.scene.html = "caller changed its input after construction";
  const initialized = await client.initialize();
  assert.equal(initialized.projectRevision, 3); assert.equal(initialized.sceneRevision, 0);
  assert.deepEqual({ scene: f.state.scene, clips: f.state.clips, revision: f.state.revision }, before);
  assert.deepEqual(await fs.readdir(f.outputDir), files);
  const changes = f.state.requests.filter((r) => r.method === "POST" && !r.route.endsWith("/call"));
  assert.deepEqual(changes.map((r) => r.route), ["/runtime/v1/video/sessions/session_cli_trial/resume"]);
  assert.ok(f.state.requests.some((r) => r.body?.api === "renderer.scene.read" && r.body.payload.include_source === true));
  assert.ok(f.state.requests.every((r) => !["renderer.scene.write", "renderer.timeline.insert"].includes(r.body?.api)));
  await client.initialize();
  assert.equal(f.state.requests.filter((r) => r.route.endsWith("/resume")).length, 1);
  assert.equal((await client.previewFrames({ frameIndices: [0] })).images.length, 1);
});

test("malformed explicit resume is rejected before HTTP", async (t) => {
  const f = await persistedFilm(t);
  const bad = [null, {}, { ...f.resume, projectRevision: -1 }, { ...f.resume, sceneRevision: .5 },
    { ...f.resume, scene: { ...f.resume.scene, scene_id: "someone-else" } },
    { ...f.resume, scene: { ...f.resume.scene, width: 640 } },
    { ...f.resume, scene: { ...f.resume.scene, seed: NaN } },
    { ...f.resume, scene: { ...f.resume.scene, html: "" } },
    { ...f.resume, scene: { ...f.resume.scene, extra: true } }];
  for (const resume of bad) await assert.rejects(f.create({ resume }), /resume/i);
  assert.equal(f.state.requests.length, 0);
});

test("resume requires existing correctly bound IDs and the exact Project revision before normal resume", async (t) => {
  const cases = [{ project: false }, { session: false },
    { projectReply: { project_id: "other", revision: 3 } },
    { sessionReply: { project_id: "other", session_id: "session_cli_trial" } },
    { sessionReply: { project_id: "project_cli_trial", session_id: "other" } }, { revision: 4 }];
  for (const [index, change] of cases.entries()) await t.test(`binding ${index + 1}`, async (t) => {
    const f = await persistedFilm(t); Object.assign(f.state, change);
    const client = await f.create({ resume: f.resume });
    await assert.rejects(client.initialize(), /resume/i);
    assert.ok(f.state.requests.every((r) => r.method === "GET"));
  });
});

test("resume refuses Scene revision/source, native clip or concurrent Project changes without Scene edits", async (t) => {
  const cases = [
    (s) => { s.sceneRevision = 1; }, (s) => { s.scene.html += "changed"; },
    (s) => { s.scene.parameters.orange = "blue"; }, (s) => { s.clips = []; },
    (s) => { s.clips[0].media_kind = "video"; }, (s) => { s.clips[0].start = 1; },
    (s) => { s.clips[0].duration = 4; }, (s) => { s.width = 640; },
    (s) => { s.resumeRevisionChange = true; },
    (s) => { s.resumeReply = { project_id: "other", session_id: "session_cli_trial" }; },
  ];
  for (const [index, change] of cases.entries()) await t.test(`fence ${index + 1}`, async (t) => {
    const f = await persistedFilm(t); change(f.state);
    const before = copy({ scene: f.state.scene, clips: f.state.clips });
    const client = await f.create({ resume: f.resume });
    await assert.rejects(client.initialize());
    assert.deepEqual({ scene: f.state.scene, clips: f.state.clips }, before);
    assert.ok(f.state.requests.every((r) => !["renderer.scene.write", "renderer.timeline.insert"].includes(r.body?.api)));
    assert.ok(f.state.requests.every((r) => !r.route.endsWith("/timeline/patch")));
    await assert.rejects(client.previewFrames({ frameIndices: [0] }), /initialize/);
  });
});

test("only owned 0600 isolated readiness from the exact checkout is accepted", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.readyFile, 0o644);
  await assert.rejects(f.create(), /0600/);
  await fs.chmod(f.readyFile, 0o600);
  for (const bad of [{ identity_mode: "accounts" }, { source_root: f.root }, { host: "localhost" }, { port: "1234" }]) {
    await fs.writeFile(f.readyFile, JSON.stringify({ ...f.ready, ...bad }));
    await assert.rejects(f.create(), /isolated loopback/);
  }
  await fs.writeFile(f.readyFile, JSON.stringify(f.ready));
  const link = path.join(f.root, "ready-link.json"); await fs.symlink(f.readyFile, link);
  await assert.rejects(f.create({ readyFile: link }));
  assert.equal(f.state.requests.length, 0);
});

test("invalid model inputs and fixed film dimensions cannot change the Gateway", async (t) => {
  const f = await fixture(t); const client = await f.create();
  await assert.rejects(client.inspect(), /initialize/);
  await client.initialize(); const before = f.state.requests.length;
  for (const args of [{ html: "" }, { html: HTML, parameters: { x: NaN } }, { html: HTML, seed: -1 }]) await assert.rejects(client.saveScene(args));
  await assert.rejects(client.previewFrames({ frameIndices: [240] }));
  await assert.rejects(client.previewFrames({ frameIndices: Array(13).fill(0) }));
  await assert.rejects(client.exportVideo({ format: "avi" }));
  await assert.rejects(client.exportVideo({}));
  assert.equal(f.state.requests.length, before);
  await client.saveScene({ html: HTML });
  const writes = f.state.requests.filter((r) => r.body?.api === "renderer.scene.write").length;
  f.state.scene.duration_frames = 120;
  await assert.rejects(client.saveScene({ html: HTML + "changed" }), /dimensions, fps or duration changed/);
  assert.equal(f.state.requests.filter((r) => r.body?.api === "renderer.scene.write").length, writes);
});

test("Gate refusal never inserts a clip, auto-approves or writes source", async (t) => {
  const f = await fixture(t, { saveRefused: true }); const client = await f.create();
  await client.initialize();
  await assert.rejects(client.saveScene({ html: HTML }), /not committed/);
  assert.equal(f.state.clips.length, 0);
  assert.ok(f.state.requests.every((r) => !r.route.includes("approval")));
  await assert.rejects(fs.stat(f.outputDir), { code: "ENOENT" });
});

test("failed, refused and malformed Job completions publish no video", async (t) => {
  const cases = [
    { exportInitial: { status: "awaiting_approval" } },
    { exportFinal: { status: "failed" } },
    { exportFinal: { status: "denied" } },
    { exportFinal: { status: "cancelled" } },
    { exportFinal: { status: "succeeded", asset: { content_type: "video/quicktime" }, execution_outcome: { status: "succeeded" } } },
    { exportFinal: { status: "succeeded", asset: { asset_id: "asset_trial", content_type: "video/mp4" }, execution_outcome: { status: "succeeded" } } },
    { exportFinal: { status: "succeeded", asset: { asset_id: "asset_trial", content_type: "video/quicktime" }, execution_outcome: { status: "failed" } } },
    { downloadType: "text/html" }, { download: Buffer.alloc(0) },
  ];
  for (const [index, setting] of cases.entries()) await t.test(`case ${index + 1}`, async (t) => {
    const f = await fixture(t, setting); const client = await f.create();
    await client.initialize(); await client.saveScene({ html: HTML });
    await assert.rejects(client.exportVideo({ format: "mov" }));
    assert.ok((await fs.readdir(f.outputDir)).every((name) => !name.endsWith(".mov")));
    assert.ok(f.state.requests.every((r) => !r.route.includes("approval") && !r.route.includes("cancel")));
  });
});

test("invalid PNG responses do not create previews", async (t) => {
  const f = await fixture(t, { picture: "data:image/png;base64,aGVsbG8=" }); const client = await f.create();
  await client.initialize(); await client.saveScene({ html: HTML });
  await assert.rejects(client.previewFrames({ frameIndices: [0] }), /not PNG/);
  assert.ok((await fs.readdir(f.outputDir)).every((name) => !name.endsWith(".png")));
});

test("HTTP bodies cannot leak the token and redirects are not followed", async (t) => {
  for (const redirect of [false, true]) await t.test(redirect ? "redirect" : "HTTP error", async (t) => {
    const f = await fixture(t, { intercept: ({ response, json }) => {
      if (redirect) { response.writeHead(302, { Location: "http://127.0.0.1:1/forbidden" }); response.end(); }
      else json(503, { secret: TOKEN });
      return true;
    } });
    const client = await f.create();
    await assert.rejects(client.initialize(), (error) => { assert.ok(!String(error).includes(TOKEN)); return true; });
    assert.equal(f.state.requests.length, 1);
  });
});

test("output symlinks and existing editable source are not overwritten", async (t) => {
  const f = await fixture(t); const client = await f.create(); await client.initialize();
  await fs.mkdir(f.outputDir);
  const existing = path.join(f.outputDir, "scene-p3-s0.json"); await fs.writeFile(existing, "keep me");
  await assert.rejects(client.saveScene({ html: HTML }), { code: "EEXIST" });
  assert.equal(await fs.readFile(existing, "utf8"), "keep me");
  const other = path.join(f.root, "other"); await fs.mkdir(other);
  const link = path.join(f.root, "output-link"); await fs.symlink(other, link);
  // An already initialized client uses the same fixed output directory; use a
  // second newly owned Project fixture to exercise the symlink protection.
  const g = await fixture(t); const protectedClient = await g.create({ outputDir: link });
  await protectedClient.initialize();
  await assert.rejects(protectedClient.saveScene({ html: HTML }), /not a symlink/);
  assert.deepEqual(await fs.readdir(other), []);
});
