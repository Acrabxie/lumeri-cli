// `lumeri setup | onboard | init` — a thin readiness check + first-run guidance.
//
// It writes NO local config. The Lumeri backend owns onboarding: it configures
// ~/.gemia/config.json (model provider + search engine) and refuses to bind a
// port until a usable provider is set — so a server the CLI can reach is, by
// construction, already onboarded. This command just answers "is the backend
// ready?" and, if not, prints exactly what to run. Plain stdout (no TUI), like
// `lumeri login …`, so it composes in scripts and runs before the app.
import { health } from "./api.js";
import { getSession, accountLabel } from "./auth.js";

const DEFAULT_SERVER = process.env.LUMERI_SERVER || "http://127.0.0.1:7788";

// Pure: the actionable steps shown when the backend can't be reached. Shared by
// this subcommand and the in-TUI `/setup` command so the two never drift. The
// caller supplies its own "not reachable at <url>" header.
export function setupGuidance() {
  return [
    "First-time setup (on the machine that runs the server):",
    "  1) python -m gemia setup     # pick a model provider + search engine (SearXNG / DuckDuckGo / BYOK)",
    "  2) python -m gemia server    # start the Lumeri v3 backend (default :7788)",
    "",
    "Already running elsewhere? Point the CLI at it:",
    "  lumeri --server <url>        (or set LUMERI_SERVER)",
  ];
}

const HELP = `lumeri setup — check the backend is ready to use

Usage:
  lumeri setup                 Check the configured server and print next steps
  lumeri onboard | init        Aliases for the same check

Options:
  -s, --server <url>           Lumeri backend URL
                               (default: $LUMERI_SERVER or ${DEFAULT_SERVER})
  -h, --help                   Show this help
`;

function parseArgs(argv) {
  let server = DEFAULT_SERVER;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-s" || a === "--server") server = argv[++i];
    else if (a.startsWith("--server=")) server = a.slice("--server=".length);
  }
  return { server, help };
}

// Returns a process exit code (0 = ready, 1 = not reachable / needs setup).
export async function run(argv = []) {
  const { server, help } = parseArgs(argv);
  if (help) {
    process.stdout.write(HELP);
    return 0;
  }

  let reachable = false;
  try {
    reachable = await health(server);
  } catch {
    reachable = false;
  }

  if (!reachable) {
    process.stdout.write(`Backend not reachable at ${server}.\n\n`);
    process.stdout.write(setupGuidance().join("\n") + "\n");
    return 1;
  }

  process.stdout.write(`✓ Backend ready at ${server}\n`);
  // A reachable server is already onboarded (it won't bind a port otherwise),
  // so the only thing left to check is whether you're signed in.
  try {
    const session = await getSession(server);
    const label = accountLabel(session && session.account);
    if (label) process.stdout.write(`  Signed in as ${label}\n`);
    else process.stdout.write("  Not signed in — run `lumeri login` to use your account.\n");
  } catch {
    // Best-effort: readiness is already confirmed; a session hiccup isn't fatal.
  }
  return 0;
}
