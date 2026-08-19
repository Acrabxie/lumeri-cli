#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render } from "ink";
import { html } from "../src/html.js";
import { App } from "../src/App.js";
import {
  commandNameForProduct,
  currentProduct,
  productLabelForProduct,
} from "../src/product.js";
import { configuredServer } from "../src/runtime-config.js";
import { requestFolderTrust } from "../src/trusted-folders.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const DEFAULT_SERVER = configuredServer();
const product = currentProduct();
const commandName = commandNameForProduct(product);
const productLabel = productLabelForProduct(product);
const workflowHelp = product === "video"
  ? `  ${commandName} roughcut [options] <media...>             Prepare raw media without timeline edits\n`
  : "";

function parseArgs(argv) {
  const noSplashEnv = /^(1|true|yes)$/i.test(process.env.LUMERI_NO_SPLASH || "");
  const noPreviewEnv = /^(1|true|yes)$/i.test(process.env.LUMERI_NO_PREVIEW || "");
  const opts = {
    server: DEFAULT_SERVER,
    help: false,
    version: false,
    prompt: null,
    splash: !noSplashEnv,
    preview: !noPreviewEnv,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-V" || a === "--version") opts.version = true;
    else if (a === "-p" || a === "--prompt") opts.prompt = argv[++i] ?? "";
    else if (a.startsWith("--prompt=")) opts.prompt = a.slice("--prompt=".length);
    else if (a === "-s" || a === "--server") opts.server = argv[++i];
    else if (a.startsWith("--server=")) opts.server = a.slice("--server=".length);
    else if (a === "--no-splash") opts.splash = false;
    else if (a === "--no-preview") opts.preview = false;
    else if (a === "--no-browser") process.env.LUMERI_NO_BROWSER = "1"; // src/open.js reads this
    else {
      process.stderr.write(`${commandName}: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

const HELP = `Lumeri ${productLabel} CLI — a terminal client for the Lumeri v3 ${product === "quanta" ? "Quanta workspace" : "video-editing agent"}

Usage
  ${commandName} [options]
  ${commandName} -p <prompt>                              Run one full Lumeri Agent turn
${workflowHelp}  ${commandName} setup                                     Check the backend is ready (first-run guidance)
  ${product === "quanta" ? `${commandName} check [--json] <file.luqu>                 Validate an offline LUQU file\n` : ""}  ${commandName} login [google|email]                      Sign in (Google or email code)
  ${commandName} login [google|email]                      Sign in (Google or email code)
  ${commandName} whoami | logout                           Show / clear the signed-in account
  ${commandName} codex <login|import|status|whoami|logout> Manage optional Codex subscription auth

Options
  -p, --prompt <text> Run one non-interactive Lumeri Agent turn
  -s, --server <url>   Lumeri sidecar base URL (default: ${DEFAULT_SERVER})
      --no-splash      Skip the startup animation
      --no-preview     Don't auto-open the preview window
      --no-browser     Never launch a browser — print URLs instead
  -V, --version        Print version and exit
  -h, --help           Show this help

Environment
  LUMERI_SERVER        Default server URL if --server is not given
  LUMERI_NO_SPLASH     Set to 1 to skip the startup animation
  LUMERI_NO_PREVIEW    Set to 1 to not auto-open the preview window
  LUMERI_NO_BROWSER    Set to 1 to never launch a browser (URLs are printed)

Inside the TUI
  /help                Show commands and shortcuts
  /project             List/create/use/resume Project workspaces
  /trust [path]        Trust a folder before binding it to a Project
  /upload <path>       Upload a media file to the session
  /preview             (Re)open the preview window in your browser
  /open <asset_id>     Open a result asset in the system viewer
  ctrl+c (twice)       Exit
`;

// `<product command> codex …` is a plain stdout subcommand (no TUI / no TTY required):
// the Codex-subscription backend — sign in with ChatGPT and run on its quota.
if (process.argv[2] === "codex") {
  const { run } = await import("../src/codex/cli.js");
  process.exit(await run(process.argv.slice(3), { commandName }));
}

// Product account sign-in is plain stdout so it runs before/outside the app.
if (["login", "logout", "whoami"].includes(process.argv[2])) {
  const { run } = await import("../src/auth-cli.js");
  process.exit(await run(process.argv.slice(2), { product: productLabel, commandName }));
}

// Product setup/onboard/init — thin readiness check + first-run guidance.
// Runs before the TUI so it works even when the backend isn't up yet.
if (["setup", "onboard", "init"].includes(process.argv[2])) {
  const { run } = await import("../src/setup-cli.js");
  process.exit(await run(process.argv.slice(3), { commandName }));
}

if (product === "video" && process.argv[2] === "roughcut") {
  const { runRoughcut } = await import("../src/roughcut-cli.js");
  process.exit(await runRoughcut(process.argv.slice(3), { defaultServer: DEFAULT_SERVER }));
}

// Offline structural validation is intentionally a Quanta-only command. It
// reads a self-contained .luqu file locally and never creates a host session.
if (product === "quanta" && process.argv[2] === "check") {
  const { runLuquCheck } = await import("../src/luqu-file.js");
  process.exit(await runLuquCheck(process.argv.slice(3), { commandName }));
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (opts.prompt != null) {
  const { runPrompt } = await import("../src/prompt-cli.js");
  process.exitCode = await runPrompt({
    serverUrl: opts.server,
    prompt: opts.prompt,
    commandName,
  });
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(
    `${commandName}: this is an interactive TUI and needs a terminal (TTY).\n` +
      "Run it directly in your terminal, not through a pipe or non-interactive shell.\n",
  );
  process.exitCode = 1;
} else {
  const trust = await requestFolderTrust();
  if (!trust.trusted) {
    process.stdout.write(`Folder not trusted. You can still use ${commandName}; use /trust <path> before binding a folder to a Project.\n`);
  }
  // Fresh canvas for the ceremony.
  if (opts.splash) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const app = render(
    html`<${App} version=${pkg.version} serverUrl=${opts.server} splash=${opts.splash} preview=${opts.preview} product=${product} commandName=${commandName} />`,
    { exitOnCtrlC: false },
  );

  await app.waitUntilExit();
}
