// IME cursor regression. Ink renders the InputBox above the physical terminal
// cursor by default; useCursor() must explicitly move it to the composer so
// macOS can anchor Pinyin pre-edit text and its candidate menu in the right
// place. This TTY harness asserts the actual terminal escape positions.
import { EventEmitter } from "node:events";
import { Box, Text, render } from "ink";
import { html } from "../src/html.js";
import { InputBox } from "../src/components/InputBox.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TerminalOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  frames = [];

  write = (frame) => {
    this.frames.push(frame);
    return true;
  };
}

class TerminalInput extends EventEmitter {
  isTTY = true;
  data = null;

  setEncoding() {}
  setRawMode() {}
  ref() {}
  unref() {}

  read = () => {
    const value = this.data;
    this.data = null;
    return value;
  };

  send = (value) => {
    this.data = value;
    this.emit("readable");
  };
}

const stdout = new TerminalOutput();
const stdin = new TerminalInput();
const stderr = new TerminalOutput();
const app = render(html`<${Box} flexDirection="column">
  <${Text}>previous turn</${Text}>
  <${Text}>starter suggestion</${Text}>
  <${InputBox} onSubmit=${() => {}} history=${[]}/>
  <${Text}>/help commands</${Text}>
</${Box}>`, {
  stdout,
  stdin,
  stderr,
  exitOnCtrlC: false,
  interactive: true,
  maxFps: 60,
  patchConsole: false,
});

const failures = [];

// Wait through useBoxMetrics' first layout pass. The prompt is `› ` (two
// columns); the cursor should be at column 4 inside the bordered, padded box,
// rather than after the trailing status line.
await wait(100);
const initialOutput = stdout.frames.join("");
if (!initialOutput.includes("\x1b[3A\x1b[5G\x1b[?25h")) {
  failures.push("idle composer did not place the physical cursor inside the input box");
}

// CJK is six terminal columns, not three JavaScript string units: 4 + 6 = 10
// (CSI G is 1-based, so terminal column 11).
stdin.send("你是说");
await wait(100);
const typedOutput = stdout.frames.join("");
if (!typedOutput.includes("\x1b[3A\x1b[11G\x1b[?25h")) {
  failures.push("CJK input did not keep the physical cursor after the full display width");
}

app.unmount();
await app.waitUntilExit();

if (failures.length) {
  console.error("input-ime FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}

console.log("input-ime: PASS — composer cursor anchors IME and respects CJK width");
