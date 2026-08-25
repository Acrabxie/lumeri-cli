// Drift test: the CLI must handle every event kind the backend contract
// declares (gemia/v3_contract.py → vendored src/contract.json). Pure source
// extraction — no App render needed. Red cases:
//  - contract declares a kind App.js has no `case "..."` for (silent-drop bug
//    territory; the default banner is only for UNdeclared kinds);
//  - ask.js stops covering a declared ask control type.
import { readFileSync } from "node:fs";

import { EVENT_KINDS, ASK_CONTROLS, PROTOCOL_VERSION } from "../src/contract.js";

const fail = [];
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// 1) App.js handleEvent covers every declared kind.
const appSource = src("../src/App.js");
const caseKinds = new Set(
  [...appSource.matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]),
);
if (caseKinds.size < 18) {
  fail.push(`case extraction looks broken: only ${caseKinds.size} cases found`);
}
for (const kind of EVENT_KINDS) {
  if (!caseKinds.has(kind)) {
    fail.push(`App.js has no case for declared event kind "${kind}"`);
  }
}

// 2) ask.js covers every declared ask control type.
const askSource = src("../src/ask.js");
for (const control of ASK_CONTROLS) {
  if (!askSource.includes(`"${control}"`)) {
    fail.push(`ask.js does not mention ask control type "${control}"`);
  }
}

// 3) Sanity: contract itself is well-formed.
if (!Number.isInteger(PROTOCOL_VERSION) || PROTOCOL_VERSION < 1) {
  fail.push(`bad protocol_version: ${PROTOCOL_VERSION}`);
}

if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(
  `PASS — contract v${PROTOCOL_VERSION}: ${EVENT_KINDS.size} kinds handled, ` +
  `${ASK_CONTROLS.size} ask controls covered`,
);
process.exit(0);
