// Explicit CLI-owned Codex-subscription -> LF2 trial. Legacy -p is unchanged.
import { readFile, mkdir, writeFile, access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLf2Runtime } from './lf2/runtime.js';
import { CodexLf2Session } from './lf2/codex-app-server.js';
import { checkMacResources } from './lf2/resources.js';

export const LF2_HELP = `Lumeri CLI LF2 — create an editable vector film with your Codex subscription

Usage
  luvi lf2 --prompt <text> --runtime-ready <file> --runtime-source <dir> --output <dir>
  luvi lf2 --prompt-file <file> --runtime-ready <file> --runtime-source <dir> --output <dir>
  luvi lf2 --resume-run <failed-run.json> --runtime-ready <file> --runtime-source <dir> --output <same-dir>

  --model <id>         Optional explicit Codex model; otherwise use its configured model
  --codex-bin <path>   Official Codex executable (default: codex)

This explicit trial uses an existing isolated local LF2 Runtime. It creates a
new Project and calls normal Luc/Project Gate/render/export routes. Codex owns
ChatGPT login; run codex login if needed. No API-key fallback or App changes.
Output: editable Scene, PNG previews, MP4 and ProRes4444 MOV; 8s/1280x720/30fps.
`;
export function parseLf2Args(argv) {
  const options = { codexBin: 'codex' };
  const keys = { '--prompt': 'prompt', '--prompt-file': 'promptFile', '--resume-run': 'resumeRun', '--runtime-ready': 'readyFile', '--runtime-source': 'sourceRoot', '--output': 'outputDir', '--model': 'model', '--codex-bin': 'codexBin' };
  for (let i = 0; i < argv.length; i++) {
    if (['--help', '-h'].includes(argv[i])) return { help: true };
    const key = keys[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown or missing LF2 argument: ${argv[i]}`);
    if (Object.hasOwn(options, key) && key !== 'codexBin') throw new Error(`Repeated LF2 argument: ${argv[i]}`);
    options[key] = argv[++i];
  }
  if ([options.prompt, options.promptFile, options.resumeRun].filter(Boolean).length !== 1) throw new Error('Supply exactly one of --prompt, --prompt-file or --resume-run');
  for (const key of ['readyFile', 'sourceRoot', 'outputDir']) if (!options[key]) throw new Error(`Missing LF2 option: ${key}`);
  return options;
}
export async function loadLf2Resume(reportPath, outputDir) {
  const reportFile = resolve(reportPath);
  const name = reportFile.slice(reportFile.lastIndexOf('/') + 1);
  if (!/^cli-failed-[0-9a-f]{32}\.json$/.test(name) || reportFile !== resolve(outputDir, name)) throw new Error('Resume report must be a prior failed CLI run in the same output directory');
  async function ownedJson(file) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) throw new Error('Resume files must be owned regular 0600 files');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  const record = await ownedJson(reportFile);
  if (record.status !== 'failed' || record.codex?.authentication !== 'chatgpt' || record.codex?.provider !== 'openai'
      || !Array.isArray(record.exports) || record.exports.length) throw new Error('Resume needs a subscription-generated Scene interrupted before exports');
  const saved = record.tools?.filter(row => row.name === 'lf2_scene_save').at(-1)?.result;
  if (!saved || !/^project_cli_[0-9a-f]{32}$/.test(saved.projectId) || saved.sessionId !== saved.projectId.replace('project_', 'session_')
      || saved.sceneId !== 'cli-film' || !Number.isInteger(saved.projectRevision) || !Number.isInteger(saved.sceneRevision)) throw new Error('Resume report has no valid generated LF2 Scene');
  const expectedPath = resolve(outputDir, `scene-p${saved.projectRevision}-s${saved.sceneRevision}.json`);
  if (saved.scenePath !== expectedPath) throw new Error('Resume Scene is outside the original output directory');
  const scene = await ownedJson(expectedPath);
  if (scene.scene_id !== saved.sceneId || typeof scene.html !== 'string' || !scene.html.trim()) throw new Error('Resume Scene source is missing');
  return { reportPath: reportFile, previousCodex: record.codex, projectId: saved.projectId, sessionId: saved.sessionId,
    sceneId: saved.sceneId, projectRevision: saved.projectRevision, sceneRevision: saved.sceneRevision, scene };
}

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export function filmTools() {
  return [
    { type: 'function', name: 'lf2_inspect', description: 'Inspect this new LF2 Project, native Timeline and current Scene revision.', inputSchema: object({}) },
    { type: 'function', name: 'lf2_scene_save', description: 'Author or revise the editable LF2 Scene. Provide a complete self-contained HTML/SVG document defining global synchronous function render(frame,fps,parameters). LF2 calls it with an integer frame. Every property must derive only from that frame; no clocks, timers, RAF, external resources, fetch, imports, fonts or raster media. Inline vector SVG and deterministic JS are supported. Fixed 1280x720,30fps,240frames. Scene is saved through the Luc and referenced natively on the Timeline. Same-duration revisions are allowed.',
      inputSchema: object({ html: { type: 'string' }, parameters: { type: 'object', additionalProperties: true }, seed: { type: 'integer' } }) },
    { type: 'function', name: 'lf2_preview', description: 'Render exact Timeline frames and SEE the returned PNG images before deciding whether to revise or export. Frame indices are 0..239. Preview several story phases and inspect visual quality.', inputSchema: object({ frameIndices: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 239 }, minItems: 1, maxItems: 12 } }) },
    { type: 'function', name: 'lf2_export', description: 'Export the current native LF2 Timeline through the real sandboxed engine and download the actual result. Choose mp4 for smaller default video or explicitly mov for ProRes4444 high fidelity. Call both formats before delivering. Export is asynchronous internally; this tool waits for its own job.', inputSchema: object({ format: { type: 'string', enum: ['mp4', 'mov'] } }) },
  ];
}
const INSTRUCTIONS = `You are the creative model inside Lumeri CLI. Acrab authorized this subscription-backed LF2 film test and the CLI host has registered the task. Work only through the four supplied LF2 tools in this new isolated Project. No shell, filesystem, connectors, agent delegation, network, login or system changes. Do not read a previous film's source. The creator already approved an eight-second silent 16:9 vector film: a dot becomes orbital paths which settle into a small city with buildings, trees and a passing train. Design it independently from the request. Use deliberate composition, clean vector silhouettes, coherent typography, legible hierarchy, restrained warm paper/teal/coral/ochre colors, smooth meaningful motion and an intentional final hold. No invented metrics or stock media. Call lf2_inspect, author the Scene using lf2_scene_save, inspect several real PNG previews across all phases (including last frame), improve the Scene if needed, then export BOTH mp4 and mov through lf2_export. The Scene must render deterministically at every frame including random seeks. The host fixes format to1280x720/30fps/240frames. Keep all important shapes within the frame. Your final reply to Acrab should briefly describe what was actually exported. A tool error is a failure to diagnose, never evidence of success.`;

export async function createLf2Film(options, { runtimeFactory = createLf2Runtime, sessionFactory = opts => new CodexLf2Session(opts), checkResources = checkMacResources, onProgress = () => {} } = {}) {
  await checkResources();
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  try { await access(resolve(outputDir, 'cli-run.json')); throw new Error('Output already has a CLI run; choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const resume = options.resumeRun ? await loadLf2Resume(options.resumeRun, outputDir) : null;
  const prompt = resume ? 'Acrab asks you to continue the same CLI film test. This Scene was authored and saved by Codex in the previous run, which hit its subscription usage limit before preview/export. Inspect the existing Project, preview several real frames across all phases including frame239, refine only if necessary, then export both MP4 and MOV. Start by previewing the saved Scene; preserve it if good. Here is its existing editable source for possible revisions:\n' + JSON.stringify(resume.scene) : options.promptFile ? await readFile(resolve(options.promptFile), 'utf8') : options.prompt;
  if (!prompt?.trim() || prompt.length > 50000) throw new Error('Film prompt must contain 1..50000 characters');
  const id = randomUUID().replaceAll('-', '');
  const runtime = await runtimeFactory({ readyFile: resolve(options.readyFile), sourceRoot: resolve(options.sourceRoot), outputDir,
    projectId: resume?.projectId || `project_cli_${id}`, sessionId: resume?.sessionId || `session_cli_${id}`, sceneId: 'cli-film',
    ...(resume ? { resume: { projectRevision: resume.projectRevision, sceneRevision: resume.sceneRevision, scene: resume.scene } } : {}) });
  const events = [], tools = [], exports = [];
  let message = '';
  const session = sessionFactory({ command: options.codexBin, onEvent(event) {
    if (event.type === 'message/delta') { message += event.text || ''; return; }
    events.push(event); onProgress(event);
  } });
  let identity;
  try {
    identity = await session.start({ cwd: outputDir, tools: filmTools(), developerInstructions: INSTRUCTIONS + (resume ? '\nThis is an explicit continuation: the existing Scene was already authored by the subscribed model. Begin with inspect and previews; only revise source if the actual pictures need it. Do not recreate the Project or Scene unnecessarily.' : ''), model: options.model,
      async onTool(name, arguments_) {
        await checkResources();
        const args = typeof arguments_ === 'string' ? JSON.parse(arguments_) : arguments_;
        let value;
        if (name === 'lf2_inspect') value = await runtime.inspect();
        else if (name === 'lf2_scene_save') value = await runtime.saveScene(args);
        else if (name === 'lf2_preview') value = await runtime.previewFrames(args);
        else if (name === 'lf2_export') { value = await runtime.exportVideo(args); exports.push({ ...value, format: args.format }); }
        else throw new Error('Unknown LF2 tool');
        const { images = [], ...summary } = value;
        tools.push({ name, result: summary });
        return [{ type: 'inputText', text: JSON.stringify(summary) }, ...images.map(image => ({ type: 'inputImage', imageUrl: image.dataUrl }))];
      } });
    await runtime.initialize();
    const turn = await session.run(prompt);
    if (!exports.some(e => e.format === 'mp4') || !exports.some(e => e.format === 'mov')) throw new Error('Model finished without successful MP4 and MOV exports');
    const result = { status: 'completed', route: 'Lumeri CLI -> official Codex app-server ChatGPT subscription -> native LF2 Luc/Gate/export', codex: identity,
      turnId: turn.id, outputDir, prompt, ...(resume ? { resumedFrom: { ...resume, scene: undefined } } : {}), tools, events, exports, reply: message };
    await writeFile(resolve(outputDir, 'cli-run.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) {
    await writeFile(resolve(outputDir, `cli-failed-${id}.json`), JSON.stringify({ status: 'failed', codex: identity, reason: String(error.message), tools, events, exports, reply: message }, null, 2), { flag: 'wx', mode: 0o600 });
    throw error;
  } finally { await session.close(); }
}
export async function runLf2(argv, { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  try {
    const options = parseLf2Args(argv);
    if (options.help) { stdout.write(LF2_HELP); return 0; }
    const result = await createLf2Film(options, { ...dependencies, onProgress: event => stdout.write(JSON.stringify(event) + '\n') });
    stdout.write(JSON.stringify({ status: result.status, exports: result.exports, reply: result.reply }) + '\n'); return 0;
  } catch (error) { stderr.write(`Lumeri CLI LF2: ${error.message}\n`); return 1; }
}
