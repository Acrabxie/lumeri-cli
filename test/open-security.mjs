import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetUrl,
  closeSession,
  createSession,
  generateSessionTitle,
  getInfo,
  getQuanta,
  getTimeline,
  killTask,
  listAssets,
  listTasks,
  previewUrl,
  resumeSession,
  setPlanMode,
  submitAskResponse,
  submitTurn,
  uploadAsset,
} from "../src/api.js";
import { openInBrowser } from "../src/open.js";

const VALID_SESSION = "v3-Good_09";
const MALICIOUS_SESSION_IDS = [
  "v3-good&calc",
  "v3-good|calc",
  "v3-good<calc",
  "v3-good>calc",
  "v3-good^calc",
  "v3-good%calc",
];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function rejectsInvalidSession(action, label) {
  await assert.rejects(
    Promise.resolve().then(action),
    (error) => {
      assert.equal(error?.code, "E_INVALID_SESSION_ID", label);
      assert.equal(error?.status, 0, label);
      assert.equal(error?.message, "invalid Runtime session id", label);
      return true;
    },
    label,
  );
}

let returnedSessionId = VALID_SESSION;
const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    requests.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    let status = 200;
    if (req.method === "POST" && req.url === "/sessions") status = 201;
    else if (req.method === "POST" && req.url?.endsWith("/turn")) status = 202;
    else if (req.method === "POST" && req.url?.endsWith("/assets")) status = 201;

    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      session_id: returnedSessionId,
      title: "Safe title",
      assets: [],
      tasks: [],
      ok: true,
    }));
  });
});

const tempRoot = mkdtempSync(join(tmpdir(), "lumeri-open-security-"));
const uploadPath = join(tempRoot, "security probe &%.txt");
writeFileSync(uploadPath, "safe upload\n");

try {
  const baseUrl = await listen(server);

  // The Runtime response is the attacker-controlled source. Each shell
  // metacharacter must be rejected at create/resume before the ID can reach a
  // URL constructor or browser launcher.
  for (const malicious of MALICIOUS_SESSION_IDS) {
    returnedSessionId = malicious;
    await rejectsInvalidSession(
      () => createSession(baseUrl),
      `create response must reject ${JSON.stringify(malicious)}`,
    );
    await rejectsInvalidSession(
      () => resumeSession(baseUrl, VALID_SESSION),
      `resume response must reject ${JSON.stringify(malicious)}`,
    );
  }

  returnedSessionId = VALID_SESSION;
  for (const malicious of MALICIOUS_SESSION_IDS) {
    const before = requests.length;
    await rejectsInvalidSession(
      () => resumeSession(baseUrl, malicious),
      `resume selection must reject ${JSON.stringify(malicious)}`,
    );
    assert.equal(requests.length, before, "invalid resume selection must fail before HTTP");
  }

  for (const invalid of [
    "",
    "-leading",
    "_leading",
    "v3-bad/path",
    "v3-bad\\path",
    "v3-bad?query",
    "v3-bad#fragment",
    "v3-bad space",
    "v3-bad\r\nheader",
    "v3-bad-é",
    "A".repeat(65),
    123,
    null,
  ]) {
    const before = requests.length;
    await rejectsInvalidSession(
      () => resumeSession(baseUrl, invalid),
      `protocol-invalid session must reject ${JSON.stringify(invalid)}`,
    );
    assert.equal(requests.length, before, "protocol-invalid session must fail before HTTP");
  }

  // Every sibling session API must share the same fail-closed path boundary.
  const bad = MALICIOUS_SESSION_IDS[0];
  const siblingCalls = [
    ["getInfo", () => getInfo(baseUrl, bad)],
    ["submitTurn", () => submitTurn(baseUrl, bad, "hello")],
    ["generateSessionTitle", () => generateSessionTitle(baseUrl, bad, [])],
    ["listAssets", () => listAssets(baseUrl, bad)],
    ["submitAskResponse", () => submitAskResponse(baseUrl, bad, "ask_1", {})],
    ["setPlanMode", () => setPlanMode(baseUrl, bad, true)],
    ["getTimeline", () => getTimeline(baseUrl, bad)],
    ["getQuanta", () => getQuanta(baseUrl, bad)],
    ["listTasks", () => listTasks(baseUrl, bad)],
    ["killTask", () => killTask(baseUrl, bad, "job_1")],
    ["closeSession", () => closeSession(baseUrl, bad)],
    ["uploadAsset", () => uploadAsset(baseUrl, bad, "/path/need/not/exist")],
    ["assetUrl", () => assetUrl(baseUrl, bad, "asset_1")],
    ["previewUrl video", () => previewUrl(baseUrl, bad)],
    ["previewUrl quanta", () => previewUrl(baseUrl, bad, { product: "quanta" })],
  ];
  const beforeSiblingCalls = requests.length;
  for (const [label, call] of siblingCalls) {
    await rejectsInvalidSession(call, `${label} must share session validation`);
  }
  assert.equal(requests.length, beforeSiblingCalls, "invalid sibling calls must make no HTTP requests");

  // Legal Runtime IDs continue through create/resume and every existing API.
  assert.equal((await createSession(baseUrl)).session_id, VALID_SESSION);
  assert.equal((await resumeSession(baseUrl, VALID_SESSION)).session_id, VALID_SESSION);
  await resumeSession(baseUrl, `A${"b".repeat(63)}`);
  await getInfo(baseUrl, VALID_SESSION);
  await submitTurn(baseUrl, VALID_SESSION, "hello");
  assert.equal(await generateSessionTitle(baseUrl, VALID_SESSION, []), "Safe title");
  await listAssets(baseUrl, VALID_SESSION);
  await submitAskResponse(baseUrl, VALID_SESSION, "ask_1", {});
  await setPlanMode(baseUrl, VALID_SESSION, true);
  await getTimeline(baseUrl, VALID_SESSION);
  await getQuanta(baseUrl, VALID_SESSION);
  await listTasks(baseUrl, VALID_SESSION);
  await killTask(baseUrl, VALID_SESSION, "job /&|<>^%");
  await closeSession(baseUrl, VALID_SESSION);
  await uploadAsset(baseUrl, VALID_SESSION, uploadPath);

  const paths = requests.map(({ method, path }) => `${method} ${path}`);
  for (const expected of [
    `POST /sessions/${VALID_SESSION}/resume`,
    `GET /sessions/${VALID_SESSION}`,
    `POST /sessions/${VALID_SESSION}/turn`,
    `POST /sessions/${VALID_SESSION}/auto_title`,
    `GET /sessions/${VALID_SESSION}/assets`,
    `POST /sessions/${VALID_SESSION}/ask_response`,
    `POST /sessions/${VALID_SESSION}/plan_mode`,
    `GET /sessions/${VALID_SESSION}/timeline`,
    `GET /sessions/${VALID_SESSION}/quanta`,
    `GET /sessions/${VALID_SESSION}/tasks`,
    `POST /sessions/${VALID_SESSION}/tasks/job%20%2F%26%7C%3C%3E%5E%25/kill`,
    `POST /sessions/${VALID_SESSION}/close`,
    `POST /sessions/${VALID_SESSION}/assets`,
  ]) {
    assert.ok(paths.includes(expected), `missing legal request: ${expected}`);
  }

  const encodedAsset = assetUrl(
    "https://runtime.example:8443/runtime-root",
    VALID_SESSION,
    "asset /&|<>^%",
  );
  assert.equal(
    encodedAsset,
    `https://runtime.example:8443/sessions/${VALID_SESSION}/assets/asset%20%2F%26%7C%3C%3E%5E%25`,
  );
  assert.equal(
    previewUrl("http://127.0.0.1:7788/custom-root", VALID_SESSION),
    `http://127.0.0.1:7788/video/?mode=cli-preview&session=${VALID_SESSION}`,
  );
  assert.equal(
    previewUrl("https://runtime.example:8443/custom-root", VALID_SESSION, { product: "quanta" }),
    "https://runtime.example:8443/quanta",
  );

  // A fake launcher proves all platforms receive an HTTP(S) URL as one argv;
  // no real browser or Windows process is started by this test.
  const previousNoBrowser = process.env.LUMERI_NO_BROWSER;
  process.env.LUMERI_NO_BROWSER = "0";
  try {
    const launch = (platform, url, error = null) => {
      let invocation = null;
      let launchedError = null;
      const attempted = openInBrowser(
        url,
        (value) => {
          launchedError = value;
        },
        {
          platform,
          launcher(file, args, callback) {
            invocation = { file, args };
            callback(error);
          },
        },
      );
      return { attempted, invocation, launchedError };
    };

    const windowsUrl = `${encodedAsset}?download=1&source=cli`;

    let injectionLaunches = 0;
    for (const malicious of MALICIOUS_SESSION_IDS) {
      assert.throws(
        () => openInBrowser(
          assetUrl("http://127.0.0.1:7788", malicious, "asset_1"),
          undefined,
          {
            platform: "win32",
            launcher() {
              injectionLaunches += 1;
            },
          },
        ),
        (error) => error?.code === "E_INVALID_SESSION_ID",
      );
    }
    assert.equal(injectionLaunches, 0, "malicious Runtime session IDs must not reach Windows launch");

    const windows = launch("win32", windowsUrl);
    assert.equal(windows.attempted, true);
    assert.equal(windows.invocation.file, "explorer.exe");
    assert.deepEqual(windows.invocation.args, [windowsUrl]);
    assert.doesNotMatch(windows.invocation.file, /^(?:cmd|powershell|pwsh|wscript|cscript)(?:\.exe)?$/i);

    const mac = launch("darwin", "http://127.0.0.1:7788/video/");
    assert.deepEqual(mac.invocation, {
      file: "open",
      args: ["http://127.0.0.1:7788/video/"],
    });

    const linux = launch("linux", "https://runtime.example:8443/quanta");
    assert.deepEqual(linux.invocation, {
      file: "xdg-open",
      args: ["https://runtime.example:8443/quanta"],
    });

    const launchError = new Error("launcher failed");
    assert.equal(launch("win32", windowsUrl, launchError).launchedError, launchError);

    let rejectedLaunches = 0;
    for (const invalidUrl of [
      "file:///tmp/not-allowed",
      "javascript:alert(1)",
      "ftp://runtime.example/asset",
      "/relative/path",
    ]) {
      assert.throws(
        () => openInBrowser(invalidUrl, undefined, {
          platform: "win32",
          launcher() {
            rejectedLaunches += 1;
          },
        }),
        /browser URL must/,
      );
    }
    assert.equal(rejectedLaunches, 0, "non-HTTP(S) URLs must never reach a launcher");
  } finally {
    if (previousNoBrowser === undefined) delete process.env.LUMERI_NO_BROWSER;
    else process.env.LUMERI_NO_BROWSER = previousNoBrowser;
  }
} finally {
  server.closeAllConnections?.();
  if (server.listening) await close(server);
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("open security boundary: ok");
