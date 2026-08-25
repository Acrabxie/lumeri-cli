import assert from "node:assert/strict";
import { formatQuanta } from "../src/quanta.js";

const view = formatQuanta({
  project_id: "project-q",
  project_revision: 4,
  patch_seq: 7,
  quanta: {
    version: 2,
    theme: { mood: "calm-tech", aspect: "16:9" },
    root: {
      id: "root",
      children: [
        {
          id: "chapter-1",
          title: "Chapter One",
          children: [
            {
              id: "intro",
              layout: "title",
              title: "Introduction",
              blocks: [{ id: "title", kind: "text" }, { id: "cta", kind: "shape" }],
              children: [
                { id: "intro-1", dwell_sec: 1.2, visible_block_ids: ["title"], advance: "wait" },
                { id: "intro-2", dwell_sec: 2.0, visible_block_ids: ["title", "cta"], advance: "auto" },
              ],
              links: [{ trigger: "hotspot:cta", target: "quantum:details" }],
              transition: { kind: "fade" },
            },
          ],
        },
      ],
    },
  },
});

assert.equal(view.title, "Project project-q · revision 4 · patch 7");
assert.equal(view.scopeCount, 1);
assert.equal(view.stateCount, 2);
assert.match(view.lines.join("\n"), /mood: calm-tech \| aspect: 16:9/);
assert.match(view.lines.join("\n"), /▸ Chapter One/);
assert.match(view.lines.join("\n"), /\[intro\] title 2 state 1→2\/2 visible ~3\.2s/);
assert.match(view.lines.join("\n"), /⇢hotspot:cta→quantum:details/);
assert.match(view.lines.join("\n"), /⇥fade/);
assert.match(view.lines.join("\n"), /— 1 scopes, 2 states, ~3\.2s dwell/);

const empty = formatQuanta({ quanta: { root: { id: "root", children: [] } } });
assert.equal(empty.scopeCount, 0);
assert.match(empty.lines.join("\n"), /empty/);

console.log("PASS — Quanta CLI renders the canonical state tree, branches, and revisions");
