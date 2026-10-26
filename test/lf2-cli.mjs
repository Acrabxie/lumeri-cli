import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CodexLf2Session } from '../src/lf2/codex-app-server.js';
import { createLf2Film, parseLf2Args, loadLf2Resume } from '../src/lf2-cli.js';
import { parseMacResources } from '../src/lf2/resources.js';

function fakeCodex({ auth = 'chatgpt', completeStatus = 'completed' } = {}) {
  const requests = [], replies = []; let child;
  return { requests, replies, spawnImpl(command, args) {
    assert.equal(command, 'codex'); assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); };
    const send = message => child.stdout.write(JSON.stringify(message) + '\n');
    child.stdin.on('data', data => {
      for (const line of data.toString().trim().split('\n')) {
        const m = JSON.parse(line); if (!m.method) { replies.push(m); continue; }
        requests.push(m);
        let result = {};
        if (m.method === 'account/read') result = { account: { type: auth, email: 'private@example.invalid' } };
        if (m.method === 'config/read') result = { config: { mcp_servers: { unrelated: { env: { SECRET: 'do-not-log' } } } } };
        if (m.method === 'thread/start') result = { thread: { id: 'thread-test' }, model: 'configured-model', modelProvider: 'openai' };
        if (m.method === 'turn/start') {
          result = { turn: { id: 'turn-test' } };
          setTimeout(() => send({ id: 901, method: 'item/tool/call', params: { threadId: 'thread-test', turnId: 'turn-test', tool: 'lf2_test', callId: 'call-test', arguments: { value: 3 } } }), 5);
          setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: completeStatus } } }), 15);
        }
        if (m.id != null) send({ id: m.id, result });
      }
    });
    return child;
  } };
}

test('official app-server dynamic call stays in declared thread and disables unrelated MCP; auth metadata is sanitized', async () => {
  const fake = fakeCodex(), events = [], called = [];
  const session = new CodexLf2Session({ spawnImpl: fake.spawnImpl, onEvent: e => events.push(e) });
  try {
    const metadata = await session.start({ cwd: '/tmp', tools: [{ name: 'lf2_test' }], developerInstructions: 'Film tools only', onTool: async (name, input) => { called.push({ name, input }); return [{ type: 'inputImage', imageUrl: 'data:image/png;base64,AA==' }]; } });
    assert.equal(metadata.authentication, 'chatgpt');
    await session.run('Film request');
    assert.equal(called.length, 1); assert.equal(called[0].input.value, 3);
    assert.equal(fake.replies[0].result.success, true); assert.equal(fake.replies[0].result.contentItems[0].type, 'inputImage');
    const start = fake.requests.find(x => x.method === 'thread/start').params;
    assert.equal(start.config.mcp_servers.unrelated.enabled, false);
    assert.equal(start.config.features.shell_tool, false); assert.equal(start.sandbox, 'read-only');
    assert.equal(start.ephemeral, true); assert.equal(start.allowProviderModelFallback, false);
    assert.doesNotMatch(JSON.stringify(events), /private@example|do-not-log/);
  } finally { await session.close(); }
});

test('API-key auth and incomplete turns fail instead of claiming subscription success', async () => {
  for (const mode of ['apikey', 'failed']) {
    const f = fakeCodex({ auth: mode === 'apikey' ? mode : 'chatgpt', completeStatus: 'failed' });
    const session = new CodexLf2Session({ spawnImpl: f.spawnImpl });
    try {
      const start = session.start({ cwd: '/tmp', tools: [], onTool() {} });
      if (mode === 'apikey') await assert.rejects(start, /signed in with ChatGPT/);
      else { await start; await assert.rejects(session.run('request'), /film turn failed/); }
    } finally { await session.close(); }
  }
});

test('CLI orchestrates model-triggered save/preview/both exports, sends images and records no base64', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lf2-cli-'));
  const operations = []; let modelTool, closed = false;
  const runtime = {
    initialize: async () => operations.push('initialize'), inspect: async () => ({ project_revision: 0 }),
    saveScene: async ({ html }) => { assert.match(html, /render/); return { scene_revision: 1 }; },
    previewFrames: async () => ({ frames: [{ frameIndex: 120 }], images: [{ dataUrl: 'data:image/png;base64,PRIVATE_IMAGE' }] }),
    exportVideo: async ({ format }) => ({ path: join(dir, 'film.' + format), bytes: 100, jobId: 'job_' + format }),
  };
  try {
    const result = await createLf2Film({ prompt: 'Original dot-orbit-city', outputDir: dir, readyFile: '/tmp/ready', sourceRoot: '/tmp/runtime', codexBin: 'codex' }, {
      runtimeFactory: async () => runtime, checkResources: async () => {},
      sessionFactory: () => ({ start: async options => { modelTool = options.onTool; return { authentication: 'chatgpt' }; },
        run: async () => { await modelTool('lf2_scene_save', { html: 'function render() {}' }); const preview = await modelTool('lf2_preview', { frameIndices: [120] }); assert.equal(preview[1].type, 'inputImage'); await modelTool('lf2_export', { format: 'mp4' }); await modelTool('lf2_export', { format: 'mov' }); return { id: 'turn_cli' }; }, close: async () => { closed = true; } }),
    });
    assert.equal(result.status, 'completed'); assert.deepEqual(operations, ['initialize']); assert.equal(closed, true);
    const report = await readFile(join(dir, 'cli-run.json'), 'utf8'); assert.doesNotMatch(report, /PRIVATE_IMAGE|data:image/);
    await assert.rejects(createLf2Film({ prompt: 'x', outputDir: dir }), /Output already/);
  } finally { await rm(dir, { recursive: true }); }
});

test('argument parser requires explicit runtime/output and one prompt, no provider fallback flags', () => {
  assert.throws(() => parseLf2Args(['--prompt', 'test']), /Missing LF2/);
  assert.throws(() => parseLf2Args(['--api-key', 'secret']), /Unknown/);
  assert.throws(() => parseLf2Args(['--prompt', 'x', '--prompt-file', 'f']), /exactly one/);
  assert.equal(parseLf2Args(['--help']).help, true);
});

test('shared resource limits use exact memory formula and 1.2GiB floor', () => {
  const vm = 'page size of 16384 bytes\nAnonymous pages: 300000.\nPages purgeable: 5000.\nPages wired down: 200000.\nPages occupied by compressor: 300000.';
  const disk = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 999999 0 2000000 1% /System/Volumes/Data';
  assert.equal(parseMacResources(vm, disk).memoryBytes, 795000 * 16384);
  assert.throws(() => parseMacResources(vm.replace('300000.', '500000.'), disk), /15 GiB/);
  assert.throws(() => parseMacResources(vm, disk.replace('2000000', '1000000')), /1.2 GiB/);
});

test('resume validates original failed subscription record and same-directory owned Scene source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lf2-resume-'));
  const hex = 'a'.repeat(32), reportFile = join(dir, 'cli-failed-' + hex + '.json');
  const scene = {scene_id:'cli-film',html:'function render() {}'};
  const scenePath = join(dir, 'scene-p3-s0.json');
  const record = {status:'failed',codex:{authentication:'chatgpt',provider:'openai'},exports:[],tools:[{name:'lf2_scene_save',result:{projectId:'project_cli_'+hex,sessionId:'session_cli_'+hex,sceneId:'cli-film',projectRevision:3,sceneRevision:0,scenePath}}]};
  try {
    await writeFile(scenePath,JSON.stringify(scene),{mode:0o600});
    await writeFile(reportFile,JSON.stringify(record),{mode:0o600});
    const resumed=await loadLf2Resume(reportFile,dir);assert.equal(resumed.projectRevision,3);assert.deepEqual(resumed.scene,scene);
    await assert.rejects(loadLf2Resume(reportFile,join(dir,'elsewhere')),/same output directory/);
    record.codex.authentication='apiKey';await writeFile(reportFile,JSON.stringify(record));await assert.rejects(loadLf2Resume(reportFile,dir),/subscription/);
    record.codex.authentication='chatgpt';record.tools[0].result.scenePath='/outside/source.json';await writeFile(reportFile,JSON.stringify(record));await assert.rejects(loadLf2Resume(reportFile,dir),/outside/);
  } finally {await rm(dir,{recursive:true});}
});

test('CLI continuation passes original Project/revision/source to Runtime, previews then exports without authoring again', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lf2-continue-')),hex='b'.repeat(32);
  const scene={scene_id:'cli-film',html:'function render() { /* model authored */ }'};
  const scenePath=join(dir,'scene-p3-s0.json'),reportFile=join(dir,'cli-failed-'+hex+'.json');
  const record={status:'failed',codex:{authentication:'chatgpt',provider:'openai'},exports:[],tools:[{name:'lf2_scene_save',result:{projectId:'project_cli_'+hex,sessionId:'session_cli_'+hex,sceneId:'cli-film',projectRevision:3,sceneRevision:0,scenePath}}]};
  let onTool;
  try {
    await writeFile(scenePath,JSON.stringify(scene),{mode:0o600});await writeFile(reportFile,JSON.stringify(record),{mode:0o600});
    const result=await createLf2Film({resumeRun:reportFile,outputDir:dir,readyFile:'/tmp/ready',sourceRoot:'/tmp/source',codexBin:'codex'}, {
      checkResources:async()=>{},runtimeFactory:async options=>{assert.equal(options.projectId,record.tools[0].result.projectId);assert.equal(options.resume.projectRevision,3);assert.deepEqual(options.resume.scene,scene);return {initialize:async()=>{},inspect:async()=>({sceneRevision:0}),previewFrames:async()=>({images:[],frames:[{frameIndex:239}]}),saveScene:async()=>{throw new Error('unneeded generation');},exportVideo:async({format})=>({path:join(dir,'film.'+format)})};},
      sessionFactory:()=>({start:async options=>{onTool=options.onTool;assert.match(options.developerInstructions,/explicit continuation/);return {authentication:'chatgpt'};},run:async prompt=>{assert.match(prompt,/already|previous run/);await onTool('lf2_preview',{frameIndices:[239]});await onTool('lf2_export',{format:'mp4'});await onTool('lf2_export',{format:'mov'});return {id:'turn_resume'};},close:async()=>{}})
    });
    assert.equal(result.resumedFrom.projectRevision,3);assert.equal(result.resumedFrom.reportPath,reportFile);assert.equal(result.tools.some(t=>t.name==='lf2_scene_save'),false);
  }finally{await rm(dir,{recursive:true});}
});
