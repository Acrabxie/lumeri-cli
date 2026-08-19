import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import readline from "node:readline";

export function trustedFoldersConfigPath(home = homedir()) {
  return resolve(home, ".lumeri", "config.toml");
}

function parseTrustedFolders(text) {
  const match = String(text || "").match(/^\s*trusted_folders\s*=\s*(\[[\s\S]*?\])\s*$/m);
  if (!match) return [];
  try {
    const values = JSON.parse(match[1]);
    return Array.isArray(values)
      ? values.filter((value) => typeof value === "string").map((value) => resolve(value))
      : [];
  } catch {
    return [];
  }
}

export function getTrustedFolders({ home = homedir() } = {}) {
  try { return parseTrustedFolders(readFileSync(trustedFoldersConfigPath(home), "utf8")); }
  catch { return []; }
}

export function isTrustedFolder(folder, options = {}) {
  const target = resolve(folder);
  return getTrustedFolders(options).includes(target);
}

export function trustFolder(folder, { home = homedir() } = {}) {
  const target = resolve(folder);
  const config = trustedFoldersConfigPath(home);
  let text = "";
  try { text = readFileSync(config, "utf8"); } catch { /* first run */ }
  const folders = [...new Set([...parseTrustedFolders(text), target])];
  const line = `trusted_folders = ${JSON.stringify(folders)}`;
  // Work with the exact [cli] section rather than a reluctant multiline regex:
  // the latter is easy to get wrong at EOF and could accidentally consume a
  // later TOML section.
  const start = text.search(/^\[cli\]\s*$/m);
  if (start !== -1) {
    const afterHeader = text.indexOf("\n", start) + 1;
    const nextHeader = text.slice(afterHeader).search(/^\[[^\]]+\]\s*$/m);
    const end = nextHeader === -1 ? text.length : afterHeader + nextHeader;
    const block = text.slice(start, end);
    const next = /^\s*trusted_folders\s*=.*$/m.test(block)
      ? block.replace(/^\s*trusted_folders\s*=.*$/m, line)
      : `${block.trimEnd()}\n${line}\n`;
    text = `${text.slice(0, start)}${next}${text.slice(end)}`;
  } else {
    text = `${text.trimEnd()}${text.trim() ? "\n\n" : ""}[cli]\n${line}\n`;
  }
  mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  const temporary = `${config}.tmp-${process.pid}`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, config);
  return target;
}

export async function requestFolderTrust({
  folder = process.cwd(), input = process.stdin, output = process.stdout, home = homedir(),
} = {}) {
  const target = resolve(folder);
  if (isTrustedFolder(target, { home })) return { folder: target, trusted: true, changed: false };
  if (!input.isTTY || !output.isTTY) return { folder: target, trusted: false, changed: false };
  const rl = readline.createInterface({ input, output });
  const answer = await new Promise((resolveAnswer) => rl.question(
    `Trust this folder for Lumeri Project access?\n  ${target}\n  [y/N] `,
    resolveAnswer,
  ));
  rl.close();
  // readline pauses its input on close, and the TUI starts on this very stdin a
  // moment later. Ink only attaches a 'readable' listener — it never resumes the
  // stream — so a paused stdin makes the whole TUI deaf: "/" opens no command
  // menu and typed characters are echoed by the terminal over the composer
  // placeholder instead of reaching the composer. Hand input back explicitly.
  input.resume();
  if (!/^(y|yes)$/i.test(String(answer).trim())) return { folder: target, trusted: false, changed: false };
  trustFolder(target, { home });
  return { folder: target, trusted: true, changed: true };
}
