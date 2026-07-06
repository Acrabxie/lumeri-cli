// Unit tests for the slash-command autocomplete: a bare "/" must offer every
// visible command (the menu used to hard-cap at 6, hiding /login, /logout…),
// and menuScroll must keep the selected row inside the visible window.
// Run: node test/slash.mjs
import { COMMANDS, autocompleteState, menuScroll, parseSlash } from "../src/slash.js";

const fail = [];
const ok = (cond, msg) => {
  if (!cond) fail.push(msg);
};

// --- autocompleteState ------------------------------------------------------

// Bare "/" lists ALL non-hidden commands, including the ones past row 6.
{
  const st = autocompleteState("/");
  ok(st, 'bare "/" should produce a match state');
  const names = st ? st.matches.map((c) => c.name) : [];
  const visibleCount = COMMANDS.filter((c) => !c.hidden).length;
  ok(
    names.length === visibleCount,
    `bare "/" should match all ${visibleCount} visible commands (got ${names.length})`,
  );
  for (const must of ["login", "logout", "account", "session", "retry", "quit"]) {
    ok(names.includes(must), `bare "/" matches should include "${must}"`);
  }
  ok(!names.includes("exit"), 'hidden commands must not appear (got "exit")');
}

// Prefix narrowing still works.
{
  const st = autocompleteState("/log");
  const names = st ? st.matches.map((c) => c.name) : [];
  ok(
    names.length === 2 && names.includes("login") && names.includes("logout"),
    `"/log" should match exactly login+logout (got ${JSON.stringify(names)})`,
  );
}

// Non-slash lines and lines with a space are inactive.
ok(autocompleteState("hello") === null, "plain text must not autocomplete");
ok(autocompleteState("/open ab") === null, "a line with a space must not autocomplete");
ok(autocompleteState("/zzz") === null, "an unknown fragment must not autocomplete");

// --- menuScroll ---------------------------------------------------------------

// Short lists never scroll.
ok(menuScroll(4, 3, 0, 6) === 0, "total<=max keeps the window at 0");

// Walking down: window stays put until the selection passes the last row,
// then follows so the selection is the bottom visible row.
{
  let start = 0;
  const seen = [];
  for (let sel = 0; sel < 10; sel++) {
    start = menuScroll(10, sel, start, 6);
    seen.push(start);
    ok(sel >= start && sel < start + 6, `sel ${sel} must stay visible (start ${start})`);
  }
  ok(seen[5] === 0 && seen[6] === 1 && seen[9] === 4, `downward scroll positions wrong: ${seen}`);
}

// Wrap-around: from the bottom back to 0 snaps the window to the top.
ok(menuScroll(10, 0, 4, 6) === 0, "wrap to first row must scroll the window to 0");

// Wrap-around: from 0 up to the last row snaps the window to the end.
ok(menuScroll(10, 9, 0, 6) === 4, "wrap to last row must scroll the window to the end");

// A stale start beyond the clamp (list shrank) is pulled back into bounds.
ok(menuScroll(7, 6, 9, 6) === 1, "stale window start must clamp to total-max");

// --- parseSlash ---------------------------------------------------------------

{
  const p = parseSlash("/login");
  ok(p && p.name === "login" && p.arg === "", "parseSlash /login");
  const q = parseSlash("/open  as_001 ");
  ok(q && q.name === "open" && q.arg === "as_001", "parseSlash trims the arg");
  ok(parseSlash("hi /there") === null, "parseSlash rejects non-slash lines");
}

if (fail.length) {
  console.error(`slash tests FAILED (${fail.length}):`);
  for (const f of fail) console.error("  - " + f);
  process.exit(1);
}
console.log("slash tests passed");
