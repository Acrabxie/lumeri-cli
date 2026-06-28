// `lumeri codex <subcommand>` — manage the ChatGPT-subscription Codex backend.
// Plain stdout (no Ink) so it composes in scripts.
import { createCodexProvider } from "./provider.js";
import { DEFAULT_MODEL } from "./constants.js";

const HELP = `lumeri codex — use your ChatGPT subscription's Codex quota

Usage:
  lumeri codex login            Sign in with ChatGPT in the browser (OAuth/PKCE)
  lumeri codex import           Reuse an existing Codex CLI login (no browser)
  lumeri codex status           Show login state, plan, token expiry
  lumeri codex whoami           Refresh if needed and print account + plan
  lumeri codex logout           Forget the stored tokens
  lumeri codex chat <prompt>    One-shot prompt, streamed (subscription quota)

Options for chat:
  -m, --model <id>     model id (default: ${DEFAULT_MODEL})
  -r, --reasoning <e>  reasoning effort: minimal|low|medium|high
  --system <text>      system instructions
`;

function fmtPlan(p) {
  return p ? p.toUpperCase() : "unknown";
}

export async function run(argv) {
  const sub = argv[0];
  const provider = createCodexProvider();

  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (sub) {
      case "status": {
        const s = provider.status();
        if (!s.loggedIn) {
          process.stdout.write("Not signed in.\n");
          if (s.codexLoginImportable)
            process.stdout.write("A Codex CLI login exists — run `lumeri codex import` to reuse it.\n");
          else process.stdout.write("Run `lumeri codex login`.\n");
          return 0;
        }
        const mins = s.accessTokenExpiresInSec != null ? Math.round(s.accessTokenExpiresInSec / 60) : "?";
        process.stdout.write(
          `Signed in as ${s.email || "?"}\n` +
            `  plan:        ${fmtPlan(s.plan)}\n` +
            `  account:     ${s.accountId}\n` +
            `  token:       ${s.accessTokenExpired ? "EXPIRED (will refresh on use)" : `valid ~${mins} min`}\n`,
        );
        return 0;
      }

      case "login": {
        process.stdout.write("Opening browser for ChatGPT sign-in…\n");
        const s = await provider.login({
          onUrl: (url) =>
            process.stdout.write(`If it didn't open, visit:\n  ${url}\n\nWaiting for authorization…\n`),
        });
        process.stdout.write(`✅ Signed in as ${s.email || "?"} (${fmtPlan(s.plan)} plan).\n`);
        return 0;
      }

      case "import": {
        const s = provider.importExisting();
        if (!s) {
          process.stdout.write("No importable Codex CLI login found (~/.codex/auth.json).\n");
          return 1;
        }
        process.stdout.write(`✅ Imported Codex login: ${s.email || "?"} (${fmtPlan(s.plan)} plan).\n`);
        return 0;
      }

      case "whoami": {
        const w = await provider.whoami();
        process.stdout.write(`${w.email || "?"} · ${fmtPlan(w.plan)} · account ${w.accountId}\n`);
        return 0;
      }

      case "logout": {
        process.stdout.write(provider.logout() ? "Logged out.\n" : "Nothing to log out.\n");
        return 0;
      }

      case "chat": {
        const opts = { model: DEFAULT_MODEL };
        const parts = [];
        for (let i = 1; i < argv.length; i++) {
          const a = argv[i];
          if (a === "-m" || a === "--model") opts.model = argv[++i];
          else if (a === "-r" || a === "--reasoning") opts.reasoningEffort = argv[++i];
          else if (a === "--system") opts.instructions = argv[++i];
          else parts.push(a);
        }
        const input = parts.join(" ").trim();
        if (!input) {
          process.stderr.write("usage: lumeri codex chat <prompt>\n");
          return 2;
        }
        let any = false;
        for await (const ev of provider.stream({ input, ...opts })) {
          if (ev.kind === "text") {
            process.stdout.write(ev.delta);
            any = true;
          } else if (ev.kind === "done") {
            const u = ev.usage;
            if (process.stderr.isTTY && u)
              process.stderr.write(
                `\n[tokens in:${u.input_tokens ?? "?"} out:${u.output_tokens ?? "?"} · subscription quota]\n`,
              );
            else process.stdout.write("\n");
          }
        }
        if (!any) process.stdout.write("\n(no text returned)\n");
        return 0;
      }

      default:
        process.stderr.write(`unknown subcommand: ${sub}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
}
