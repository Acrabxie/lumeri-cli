#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render } from "ink";
import { html } from "../src/html.js";
import { App } from "../src/App.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const DEFAULT_SERVER = process.env.LUMERI_SERVER || "http://127.0.0.1:7788";

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
      process.stderr.write(`lumeri: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

const HELP = `Lumeri CLI — a terminal client for the Lumeri v3 video-editing agent

Usage
  lumeri [options]
  lumeri -p <prompt>                                     Run one full Lumeri Agent turn
  lumeri setup                                            Check the backend is ready (first-run guidance)
  lumeri login [google|email]                             Sign in (Google or email code)
  lumeri whoami | logout                                  Show / clear the signed-in account
  lumeri codex <login|import|status|whoami|logout>        Manage optional Codex subscription auth

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
  /upload <path>       Upload a media file to the session
  /preview             (Re)open the preview window in your browser
  /open <asset_id>     Open a result asset in the system viewer
  ctrl+c (twice)       Exit
`;

// `lumeri codex …` is a plain stdout subcommand (no TUI / no TTY required):
// the Codex-subscription backend — sign in with ChatGPT and run on its quota.
if (process.argv[2] === "codex") {
  const { run } = await import("../src/codex/cli.js");
  process.exit(await run(process.argv.slice(3)));
}

// `lumeri login|logout|whoami` — Lumeri account sign-in (Google or email code).
// Plain stdout (no TUI), like `lumeri codex …`, so it runs before/outside the app.
if (["login", "logout", "whoami"].includes(process.argv[2])) {
  const { run } = await import("../src/auth-cli.js");
  process.exit(await run(process.argv.slice(2)));
}

// `lumeri setup|onboard|init` — thin readiness check + first-run guidance.
// Runs before the TUI so it works even when the backend isn't up yet.
if (["setup", "onboard", "init"].includes(process.argv[2])) {
  const { run } = await import("../src/setup-cli.js");
  process.exit(await run(process.argv.slice(3)));
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
  process.exitCode = await runPrompt({ serverUrl: opts.server, prompt: opts.prompt });
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(
    "lumeri: this is an interactive TUI and needs a terminal (TTY).\n" +
      "Run it directly in your terminal, not through a pipe or non-interactive shell.\n",
  );
  process.exitCode = 1;
} else {
  // Fresh canvas for the ceremony.
  if (opts.splash) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const app = render(
    html`<${App} version=${pkg.version} serverUrl=${opts.server} splash=${opts.splash} preview=${opts.preview} />`,
    { exitOnCtrlC: false },
  );

  await app.waitUntilExit();
}
