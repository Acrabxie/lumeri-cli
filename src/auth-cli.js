// Product login/logout/whoami — sign in to your Lumeri account from the
// terminal. Plain stdout (no Ink), mirroring the product Codex command so it composes in
// scripts and runs before the TUI. Two methods, same as the web client:
//   • Google   — opens the browser; the backend handles the loopback callback
//   • Email    — a 6-digit one-time code mailed to the address
// The backend owns the session (~/.gemia/accounts/active.json); the CLI never
// stores a token — it kicks off the flow and reads who is signed in.
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { openInBrowser } from "./open.js";
import { health } from "./api.js";
import {
  getSession,
  startGoogleLogin,
  startEmailLogin,
  verifyEmailLogin,
  logout,
  accountLabel,
} from "./auth.js";
import { configuredServer } from "./runtime-config.js";

function helpFor(commandName, productLabel) {
  return `${commandName} login — sign in to your Lumeri ${productLabel} account

Usage:
  ${commandName} login                 Choose Google or email one-time code
  ${commandName} login google          Sign in with Google in the browser
  ${commandName} login email [addr]    Sign in with a code mailed to you
  ${commandName} whoami                Print the signed-in account
  ${commandName} logout                Sign out

Options:
  -s, --server <url>           Lumeri sidecar URL
                               (default: $LUMERI_SERVER or ~/.lumeri/config.toml)
      --no-browser             Print sign-in URLs instead of opening the browser
                               (also: $LUMERI_NO_BROWSER=1)
`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Line reader that works for both a TTY (interactive) and a pipe (scripts/tests).
// question() resolves to the next line, or null at end-of-input — callers treat
// null as "gave up" instead of crashing on a closed stream.
function makePrompter() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const buffered = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (line) => {
    if (waiters.length) waiters.shift()(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return {
    question(prompt) {
      stdout.write(prompt);
      if (buffered.length) return Promise.resolve(buffered.shift());
      return closed ? Promise.resolve(null) : new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

async function currentId(baseUrl) {
  try {
    return (await getSession(baseUrl)).account?.account_id || null;
  } catch {
    return null;
  }
}

// Poll /auth/session until the active account changes away from prevId (the
// backend flips active.json once the browser callback completes), or give up.
async function pollUntilSignedIn(baseUrl, prevId, { timeoutMs = 180000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let acct = null;
    try {
      acct = (await getSession(baseUrl)).account || null;
    } catch {
      /* transient while the browser round-trips; keep polling */
    }
    if (acct && acct.account_id && acct.account_id !== prevId) return acct;
  }
  return null;
}

async function googleLogin(baseUrl, productLabel, commandName) {
  let start;
  try {
    start = await startGoogleLogin(baseUrl);
  } catch (e) {
    if (e.status === 400) {
      process.stdout.write(
        "Google sign-in isn't configured on the server.\n" +
          "  Set google_oauth_client_id in ~/.gemia/config.json, then restart the sidecar.\n",
      );
      return 1;
    }
    throw e;
  }
  const url = start.authorization_url;
  if (!url) {
    process.stderr.write("server did not return a sign-in URL\n");
    return 1;
  }
  const prevId = await currentId(baseUrl);
  const opened = openInBrowser(url);
  process.stdout.write(
    `${opened ? "Opening your browser to sign in with Google…" : "Open this URL to sign in with Google:"}\n  ${url}\nWaiting for you to approve…\n`,
  );
  const acct = await pollUntilSignedIn(baseUrl, prevId);
  if (!acct) {
    process.stdout.write(
      `Timed out waiting for the browser sign-in.\n  Finish in the browser, then run \`${commandName} whoami\`.\n`,
    );
    return 1;
  }
  process.stdout.write(`Signed in to Lumeri ${productLabel} as ${accountLabel(acct)}.\n`);
  return 0;
}

async function emailLogin(baseUrl, ask, presetEmail, productLabel, commandName) {
  let email = (presetEmail || "").trim();
  if (!email) {
    const entered = await ask("Email address: ");
    email = (entered || "").trim();
  }
  if (!email) {
    process.stderr.write("no email entered\n");
    return 1;
  }
  process.stdout.write(`Sending a code to ${email}…\n`);
  try {
    await startEmailLogin(baseUrl, email);
  } catch (e) {
    process.stderr.write(`could not send code: ${e.message}\n`);
    return 1;
  }
  process.stdout.write("Check your inbox — the code is valid for 10 minutes.\n");

  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await ask("Enter the 6-digit code (blank to resend): ");
    if (raw === null) {
      process.stderr.write("no code entered\n");
      return 1;
    }
    const code = raw.trim();
    if (!code) {
      try {
        await startEmailLogin(baseUrl, email);
        process.stdout.write("Code resent.\n");
      } catch (e) {
        process.stdout.write(`couldn't resend: ${e.message}\n`);
      }
      continue;
    }
    try {
      const r = await verifyEmailLogin(baseUrl, email, code);
      const acct = r.account || (await getSession(baseUrl)).account;
      process.stdout.write(`Signed in to Lumeri ${productLabel} as ${accountLabel(acct) || email}.\n`);
      return 0;
    } catch (e) {
      // E.g. "验证码不正确，还可尝试 N 次" / "验证码已过期，请重新获取".
      process.stdout.write(`${e.message}\n`);
    }
  }
  process.stderr.write(`Couldn't verify the code. Run \`${commandName} login\` to try again.\n`);
  return 1;
}

export async function run(argv, { product = "Video", commandName = "luvi" } = {}) {
  const HELP = helpFor(commandName, product);
  let baseUrl = configuredServer();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-s" || a === "--server") baseUrl = argv[++i];
    else if (a.startsWith("--server=")) baseUrl = a.slice("--server=".length);
    else if (a === "--no-browser") process.env.LUMERI_NO_BROWSER = "1";
    else rest.push(a);
  }

  const cmd = (rest[0] || "login").toLowerCase();
  if (cmd === "help" || rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (!(await health(baseUrl).catch(() => false))) {
    process.stderr.write(
      `Cannot reach the Lumeri sidecar at ${baseUrl}.\n` +
        "  Is it running? Override with --server <url> or $LUMERI_SERVER.\n",
    );
    return 1;
  }

  try {
    if (cmd === "whoami") {
      const acct = (await getSession(baseUrl)).account;
      process.stdout.write(acct ? `Lumeri ${product}: ${accountLabel(acct)}  (${acct.account_id})\n` : `Not signed in. Run \`${commandName} login\`.\n`);
      return acct ? 0 : 1;
    }
    if (cmd === "logout") {
      await logout(baseUrl);
      process.stdout.write(`Signed out of Lumeri ${product}.\n`);
      return 0;
    }
    if (cmd === "login") {
      const method = (rest[1] || "").toLowerCase();
      if (method === "google") return await googleLogin(baseUrl, product, commandName);

      const prompter = makePrompter();
      const ask = (q) => prompter.question(q);
      try {
        if (method === "email") return await emailLogin(baseUrl, ask, rest[2], product, commandName);

        // No method given → offer whatever the server supports.
        const session = await getSession(baseUrl).catch(() => ({}));
        const emailOn = session.email_login_enabled !== false;
        const hasGoogle = !!session.has_google_client_id;
        const methods = [];
        process.stdout.write("How do you want to sign in?\n");
        if (emailOn) {
          methods.push("email");
          process.stdout.write(`  [${methods.length}] Email one-time code\n`);
        }
        if (hasGoogle) {
          methods.push("google");
          process.stdout.write(`  [${methods.length}] Google (opens your browser)\n`);
        }
        if (!methods.length) {
          process.stderr.write("This server has no sign-in methods configured.\n");
          return 1;
        }
        const picked = await ask(`Choose 1-${methods.length} (default 1): `);
        const pick = (picked || "1").trim() || "1";
        const choice = methods[Number(pick) - 1] || methods[0];
        return choice === "google"
          ? await googleLogin(baseUrl, product, commandName)
          : await emailLogin(baseUrl, ask, undefined, product, commandName);
      } finally {
        prompter.close();
      }
    }

    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    return 2;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
}
