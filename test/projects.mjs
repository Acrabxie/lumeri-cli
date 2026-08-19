// Project workspace regression:
// - internal production containers stay hidden;
// - Project selection scopes newly-created sessions;
// - /new remains inside the current Project;
// - durable Project sessions can be resumed;
// - /project leave returns to an independent Chat.
process.env.LUMERI_NO_BROWSER = "1";

import assert from "node:assert/strict";
import http from "node:http";
import { render } from "ink-testing-library";
import { html } from "../src/html.js";
import { App } from "../src/App.js";
import {
  parseProjectCommand,
  selectProject,
  selectProjectSession,
  visibleProjects,
} from "../src/projects.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.deepEqual(parseProjectCommand(""), { action: "list" });
assert.deepEqual(parseProjectCommand("use Film A"), { action: "use", selector: "Film A" });
assert.deepEqual(
  parseProjectCommand("create New Film --folder /tmp/Source Clips"),
  { action: "create", name: "New Film", sourceRoot: "/tmp/Source Clips" },
);

const projectA = {
  project_id: "project-film-a",
  name: "Film A",
  source_root: "/tmp/Film A",
  sessions: [{ session_id: "saved-film-a", title: "Opening pass" }],
};
const internal = {
  project_id: "project-internal",
  name: "project-internal",
  source_root: "",
  sessions: [],
};
const qa = {
  project_id: "project-qa",
  name: "DMG Project QA",
  source_root: "",
  sessions: [],
};
const roster = visibleProjects({ projects: [internal, qa, projectA] });
assert.deepEqual(roster.map((project) => project.name), ["Film A"]);
assert.equal(selectProject(roster, "1"), projectA);
assert.equal(selectProject(roster, "Film A"), projectA);
assert.equal(selectProjectSession(projectA, "1").session_id, "saved-film-a");

let sessionSeq = 0;
const createdSessionBodies = [];
const createdProjects = [];
const resumedSessions = [];
const streamResponses = new Set();

const server = http.createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (done) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => done(raw ? JSON.parse(raw) : {}));
  };

  if (req.method === "GET" && req.url === "/health") return json(200, { ok: true });
  if (req.method === "GET" && req.url === "/projects") {
    return json(200, { projects: [internal, qa, projectA] });
  }
  if (req.method === "POST" && req.url === "/projects") {
    return readBody((body) => {
      createdProjects.push(body);
      json(201, {
        project_id: "project-new-film",
        name: body.name || "Source Clips",
        source_root: body.source_root || "",
        sessions: [],
      });
    });
  }
  if (req.method === "POST" && req.url === "/sessions") {
    return readBody((body) => {
      createdSessionBodies.push(body);
      sessionSeq += 1;
      json(201, {
        session_id: `v3-project-${sessionSeq}`,
        project_id: body.project_id || `project-chat-${sessionSeq}`,
      });
    });
  }
  const resumeMatch = req.url.match(/^\/sessions\/([^/]+)\/resume$/);
  if (req.method === "POST" && resumeMatch) {
    resumedSessions.push(resumeMatch[1]);
    req.resume();
    req.on("end", () => json(200, {
      session_id: resumeMatch[1],
      project_id: "project-film-a",
      plan_mode: false,
    }));
    return;
  }
  if (req.method === "GET" && req.url?.endsWith("/stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    streamResponses.add(res);
    req.on("close", () => streamResponses.delete(res));
    return;
  }
  if (req.method === "POST" && req.url?.endsWith("/close")) {
    req.resume();
    req.on("end", () => json(200, { closed: true }));
    return;
  }
  if (req.method === "GET" && req.url === "/auth/session") {
    return json(200, { account: { account_id: "local", email: "local@example.com" } });
  }
  if (req.method === "GET" && req.url === "/starter-recommendations") {
    return json(404, {});
  }
  return json(404, {});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { frames, lastFrame, stdin, unmount } = render(
  html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false} isFolderTrusted=${() => true} />`,
);

const command = async (text, waitMs = 350) => {
  stdin.write(text);
  await sleep(60);
  stdin.write("\r");
  await sleep(waitMs);
};

await sleep(450);
assert.deepEqual(createdSessionBodies[0], {}, "startup creates an independent Chat");

await command("/project");
const listed = frames.join("\n");
assert.match(listed, /Film A · 1 session\(s\) · folder bound/);
assert.doesNotMatch(listed, /project-internal/);
assert.doesNotMatch(listed, /DMG Project QA/);

await command("/project use 1", 500);
assert.equal(createdSessionBodies.at(-1).project_id, "project-film-a");
assert.match(lastFrame(), /Project: Film A/);
assert.match(frames.join("\n"), /shared Project memory, logs, assets, and edit state are active/);

await command("/new", 500);
assert.equal(
  createdSessionBodies.at(-1).project_id,
  "project-film-a",
  "/new must remain inside the current Project",
);

await command("/project resume 1", 500);
assert.deepEqual(resumedSessions, ["saved-film-a"]);
assert.match(lastFrame(), /Project: Film A/);

await command("/project create New Film --folder /tmp/Source Clips", 500);
assert.deepEqual(createdProjects, [{ name: "New Film", source_root: "/tmp/Source Clips" }]);
assert.equal(createdSessionBodies.at(-1).project_id, "project-new-film");
assert.match(lastFrame(), /Project: New Film/);

await command("/project leave", 500);
assert.deepEqual(createdSessionBodies.at(-1), {}, "leaving Project creates an independent Chat");
assert.doesNotMatch(lastFrame(), /Project:/);

unmount();
for (const response of streamResponses) response.end();
server.close();
console.log("project workspace tests passed");
