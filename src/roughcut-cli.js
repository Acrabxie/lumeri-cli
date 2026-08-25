// Non-interactive, real-media rough-cut preparation.
// Uploads files through the same session API as the TUI, then waits for the
// local Whisper/proxy batch. It never edits a timeline.
import {
  closeSession,
  createSession,
  getRoughcutJob,
  health,
  startRoughcutPreparation,
  uploadAsset,
} from "./api.js";
import { configuredServer } from "./runtime-config.js";

const TERMINAL = new Set(["ready", "partial", "error", "interrupted"]);

function line(stream, text) {
  stream.write(`${text}\n`);
}

function parseArgs(argv, defaultServer) {
  const opts = {
    server: defaultServer,
    language: "auto",
    createProxies: true,
    paths: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "-s" || arg === "--server") opts.server = argv[++i] || "";
    else if (arg.startsWith("--server=")) opts.server = arg.slice(9);
    else if (arg === "-l" || arg === "--language") opts.language = argv[++i] || "auto";
    else if (arg.startsWith("--language=")) opts.language = arg.slice(11) || "auto";
    else if (arg === "--no-proxy") opts.createProxies = false;
    else if (arg.startsWith("-")) throw new Error(`unknown argument: ${arg}`);
    else opts.paths.push(arg);
  }
  return opts;
}

export const ROUGHCUT_HELP = `Usage
  luvi roughcut [options] <media...>

Prepare raw video/audio without editing the timeline: local transcription,
pause/filler review, take ranking, proxies, and resumable checkpoints.

Options
  -s, --server <url>       Lumeri server URL
  -l, --language <code>   Spoken language or auto (default: auto)
      --no-proxy           Skip low-resolution video proxies
  -h, --help               Show this help
`;

export async function runRoughcut(
  argv,
  {
    defaultServer = configuredServer(),
    stdout = process.stdout,
    stderr = process.stderr,
    pollMs = 1000,
    maxWaitMs = Number(process.env.LUMERI_ROUGHCUT_TIMEOUT_MS || 4 * 60 * 60 * 1000),
  } = {},
) {
  let opts;
  try {
    opts = parseArgs(argv, defaultServer);
  } catch (error) {
    line(stderr, `luvi roughcut: ${error.message}`);
    return 2;
  }
  if (opts.help) {
    stdout.write(ROUGHCUT_HELP);
    return 0;
  }
  if (!opts.paths.length) {
    line(stderr, "luvi roughcut: provide at least one video/audio path");
    return 2;
  }
  if (!(await health(opts.server).catch(() => false))) {
    line(stderr, `luvi roughcut: cannot reach Lumeri server at ${opts.server}`);
    return 1;
  }

  let sessionId = null;
  try {
    sessionId = (await createSession(opts.server)).session_id;
    const libraryIds = [];
    for (const path of opts.paths) {
      line(stdout, `Uploading ${path}`);
      const uploaded = await uploadAsset(opts.server, sessionId, path);
      if (!uploaded.library_asset_id) {
        throw new Error("server accepted the session upload but did not add it to the signed-in media library");
      }
      libraryIds.push(uploaded.library_asset_id);
      line(stdout, `Imported ${uploaded.filename} -> ${uploaded.library_asset_id}`);
    }

    let job = await startRoughcutPreparation(opts.server, {
      asset_ids: libraryIds,
      language: opts.language,
      create_proxies: opts.createProxies,
      resume: true,
    });
    line(stdout, `Preparing ${libraryIds.length} asset(s) as ${job.job_id}`);
    const deadline = Date.now() + maxWaitMs;
    let lastMessage = "";
    while (!TERMINAL.has(job.status)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${job.job_id}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      job = await getRoughcutJob(opts.server, job.job_id);
      const message = `${Math.round(Number(job.progress || 0))}% ${job.message || job.status}`;
      if (message !== lastMessage) {
        line(stdout, message);
        lastMessage = message;
      }
    }
    if (job.status === "ready") {
      line(stdout, job.result?.summary || `Prepared ${libraryIds.length} asset(s)`);
      for (const result of job.result?.results || []) {
        line(
          stdout,
          `${result.asset_id}: ${result.transcript_segments || 0} transcript segment(s), ` +
            `${result.cleanup_suggestions || 0} cleanup suggestion(s), take rank ${result.take?.rank || 1}`,
        );
      }
      return 0;
    }
    line(stderr, `luvi roughcut: ${job.error || job.message || job.status}`);
    return 1;
  } catch (error) {
    line(stderr, `luvi roughcut: ${error.message}`);
    return 1;
  } finally {
    if (sessionId) await closeSession(opts.server, sessionId).catch(() => {});
  }
}
