import assert from "node:assert";
import { spinnerFrames } from "../src/theme.js";

assert.ok(spinnerFrames.length >= 8, "working indicator should have enough motion frames");
assert.ok(spinnerFrames.every((frame) => frame.length === spinnerFrames[0].length), "frames must not resize the status line");
assert.ok(spinnerFrames.some((frame) => frame.includes("===")), "frames include the joined bar state");
assert.ok(spinnerFrames.some((frame) => /^ +o$/.test(frame)), "frames include the detached dot state");

console.log("spinner.mjs: Lumeri terminal working indicator is fixed-width");
