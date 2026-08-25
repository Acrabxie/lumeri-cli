// Product setup/onboard/init — a public-safe Runtime readiness check.
//
// It writes no local config and never manages accounts, credentials, models,
// providers, or the Runtime installation. Those stay behind the installed
// Lumeri product surface. This command only answers "is the Runtime reachable?".
import { health } from "./api.js";
import { configuredServer } from "./runtime-config.js";

const DEFAULT_SERVER = configuredServer();

// Pure: shared by this subcommand and the in-TUI `/setup` command.
export function setupGuidance(commandName = "luvi") {
  return [
    "Open or start the installed Lumeri Runtime, then try again.",
    "Account and model access are managed by the Lumeri product, not this CLI.",
    "",
    "If the Runtime is on another machine, point the CLI at it:",
    `  ${commandName} --server <url>        (or set LUMERI_SERVER)`,
  ];
}

function helpFor(commandName) {
  return `${commandName} setup — check the backend is ready to use

Usage:
  ${commandName} setup                 Check the configured server and print next steps
  ${commandName} onboard | init        Aliases for the same check

Options:
  -s, --server <url>           Lumeri backend URL
                               (default: $LUMERI_SERVER or ${DEFAULT_SERVER})
  -h, --help                   Show this help
`;
}

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
export async function run(argv = [], { commandName = "luvi" } = {}) {
  const { server, help } = parseArgs(argv);
  if (help) {
    process.stdout.write(helpFor(commandName));
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
    process.stdout.write(setupGuidance(commandName).join("\n") + "\n");
    return 1;
  }

  process.stdout.write(`✓ Backend ready at ${server}\n`);
  process.stdout.write("  Access is delegated to the installed Lumeri Runtime.\n");
  return 0;
}
