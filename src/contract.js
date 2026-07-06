// Vendored copy of the backend's protocol contract (gemia/v3_contract.py,
// exported by gemia scripts/export_contract.py). test/contract.mjs asserts
// App.js handles every event kind declared here; the backend's
// tests/test_v3_contract.py asserts this copy is fresh when both repos are
// present. Do not edit contract.json by hand — re-run the exporter.
import { readFileSync } from "node:fs";

const data = JSON.parse(
  readFileSync(new URL("./contract.json", import.meta.url), "utf8"),
);

export const CONTRACT = data;
export const PROTOCOL_VERSION = data.protocol_version;
export const EVENT_KINDS = new Set(data.event_kinds);
export const ASK_CONTROLS = new Set(data.ask_controls);
export const RECOVERY = new Set(data.recovery);
