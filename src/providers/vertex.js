// Vertex / Gemini provider — Lumeri's intended primary brain.
//
// PLACEHOLDER ON PURPOSE. In Lumeri's architecture the Gemini orchestration runs
// in the cloud worker / sidecar, not in this CLI, so there's no loopback model
// call to make here yet. This stub nails down the seam and the contract: when
// the Vertex path is wired (or proxied through the sidecar), only this file
// changes — the router and callers stay put.
import { ProviderUnavailableError } from "./errors.js";

const REASON =
  "not wired — Lumeri's Vertex/Gemini brain runs in the cloud worker/sidecar";

export function vertexProvider() {
  return {
    name: "vertex",

    status() {
      return { available: false, reason: REASON };
    },

    async *stream() {
      throw new ProviderUnavailableError("vertex", REASON);
    },

    async respond() {
      throw new ProviderUnavailableError("vertex", REASON);
    },
  };
}
