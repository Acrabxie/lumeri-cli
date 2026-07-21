import assert from "node:assert/strict";
import {
  compactTerminalSummary,
  lumeriTerminalTitle,
  setTerminalTitle,
} from "../src/terminal-title.js";

assert.equal(lumeriTerminalTitle(), "✦ Lumeri");
assert.equal(lumeriTerminalTitle("  猜一下我的年龄  "), "✦ Lumeri | 猜一下我的年龄");
assert.equal(
  lumeriTerminalTitle("做一个\n竖屏宣传片\u0007\u001b]0;injected"),
  "✦ Lumeri | 做一个 竖屏宣传片 ]0;injected",
  "control characters are neutralized before entering OSC 0",
);
assert.equal(compactTerminalSummary("一".repeat(50)).length, 40);
assert.ok(compactTerminalSummary("一".repeat(50)).endsWith("…"));

let written = "";
const tty = { isTTY: true, write: (chunk) => (written += chunk) };
assert.equal(setTerminalTitle("✦ Lumeri | 猜年龄", tty), true);
assert.equal(written, "\u001b]0;✦ Lumeri | 猜年龄\u0007");
assert.equal(setTerminalTitle("✦ Lumeri", { isTTY: false, write() {} }), false);

console.log("terminal-title.mjs: compact Lumeri OSC title is safe and stable");
