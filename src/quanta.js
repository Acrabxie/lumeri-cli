// Compact terminal view of the canonical Quanta v2 state tree. The backend
// owns normalization; this renderer only presents the returned structure.

const childrenOf = (node) => Array.isArray(node?.children)
  ? node.children.filter((child) => child && typeof child === "object")
  : [];

const isScope = (node) => Array.isArray(node?.blocks);

const leafBlockCount = (blocks) => (Array.isArray(blocks) ? blocks : []).reduce(
  (count, block) => count + (
    block && block.kind === "group" ? leafBlockCount(block.children) : 1
  ),
  0,
);

const seconds = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function scopeLine(scope, indent) {
  const states = childrenOf(scope);
  const leaves = leafBlockCount(scope.blocks);
  const visibility = states.map((state) => (state.visible_block_ids || []).length).join("→") || "0";
  const dwell = states.reduce((sum, state) => sum + seconds(state.dwell_sec), 0);
  const title = String(scope.title || "").trim();
  const links = (Array.isArray(scope.links) ? scope.links : [])
    .filter((link) => link && !(link.trigger === "advance" && link.target === "next"))
    .map((link) => `  ⇢${link.trigger || "?"}→${link.target || "?"}`)
    .join("");
  const transition = scope.transition?.kind && scope.transition.kind !== "cut"
    ? `  ⇥${scope.transition.kind}`
    : "";
  return `${indent}[${scope.id || "?"}] ${scope.layout || "content"} ` +
    `${states.length} state ${visibility}/${leaves} visible ~${dwell.toFixed(1)}s` +
    `${scope.hidden ? "  (hidden)" : ""}${title ? ` — “${title}”` : ""}${links}${transition}`;
}

export function formatQuanta(payload) {
  const doc = payload?.quanta && typeof payload.quanta === "object" ? payload.quanta : {};
  const root = doc.root && typeof doc.root === "object" ? doc.root : { children: [] };
  const lines = [];
  const theme = doc.theme && typeof doc.theme === "object" ? doc.theme : {};
  const themeBits = [
    theme.mood ? `mood: ${theme.mood}` : "",
    theme.aspect ? `aspect: ${theme.aspect}` : "",
  ].filter(Boolean);
  if (themeBits.length) lines.push(themeBits.join(" | "));

  let scopes = 0;
  let states = 0;
  let dwell = 0;
  const visit = (node, depth) => {
    for (const child of childrenOf(node)) {
      if (isScope(child)) {
        const childStates = childrenOf(child);
        scopes += 1;
        states += childStates.length;
        dwell += childStates.reduce((sum, state) => sum + seconds(state.dwell_sec), 0);
        lines.push(scopeLine(child, "  ".repeat(depth + 1)));
      } else {
        lines.push(`${"  ".repeat(depth)}▸ ${child.title || child.id || "untitled"}${child.hidden ? "  (hidden)" : ""}`);
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);

  if (scopes === 0) lines.push("(empty — describe a Quanta task to draft the state tree)");
  lines.push(`— ${scopes} scopes, ${states} states, ~${dwell.toFixed(1)}s dwell`);
  const revision = payload?.project_revision;
  const patchSeq = payload?.patch_seq;
  const metadata = [
    payload?.project_id ? `Project ${payload.project_id}` : "",
    Number.isFinite(Number(revision)) ? `revision ${revision}` : "",
    Number.isFinite(Number(patchSeq)) ? `patch ${patchSeq}` : "",
  ].filter(Boolean);
  return {
    title: metadata.join(" · ") || "Quanta state tree",
    lines,
    scopeCount: scopes,
    stateCount: states,
  };
}
