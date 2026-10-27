// Token-free official Codex app-server client for the explicit LF2 command.
// Codex owns subscription credentials; this client never imports or stores them.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CodexLf2Session {
  constructor({ command = 'codex', spawnImpl = spawn, onEvent = () => {} } = {}) {
    this.command = command; this.spawnImpl = spawnImpl; this.onEvent = onEvent;
    this.pending = new Map(); this.sequence = 0; this.child = null; this.turnWaiter = null;
    this.toolQueue = Promise.resolve(); this.closed = false;
  }
  send(value) { this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method, params, timeout = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.turnWaiter?.reject(error); this.turnWaiter = null;
  }
  async receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return this.fail(new Error('Codex returned invalid JSON')); }
    if (message.id != null && !message.method) {
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`Codex RPC error: ${String(message.error.message).slice(0, 400)}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.id != null) {
      if (message.method !== 'item/tool/call') {
        this.send({ id: message.id, error: { code: -32601, message: 'This LF2 client handles only its declared film tools; approvals and other actions require the creator.' } });
        return;
      }
      this.toolQueue = this.toolQueue.then(async () => {
        const p = message.params;
        try {
          if (p.threadId !== this.threadId || (this.turnId && p.turnId !== this.turnId)) throw new Error('Tool call belongs to another film turn');
          if (!this.toolNames.has(p.tool)) throw new Error('Undeclared LF2 tool');
          this.onEvent({ type: 'tool/start', name: p.tool, callId: p.callId });
          const result = await this.onTool(p.tool, p.arguments);
          this.send({ id: message.id, result: { success: true, contentItems: result } });
          this.onEvent({ type: 'tool/completed', name: p.tool, callId: p.callId });
        } catch (error) {
          const reason = String(error.message).slice(0, 500);
          this.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: reason }] } });
          this.onEvent({ type: 'tool/failed', name: p.tool, reason });
        }
      }).catch(error => this.fail(error));
      return;
    }
    const p = message.params || {};
    if (message.method === 'item/agentMessage/delta') this.onEvent({ type: 'message/delta', text: p.delta });
    if (message.method === 'thread/tokenUsage/updated') this.onEvent({ type: 'usage', tokenUsage: p.tokenUsage });
    if (message.method === 'turn/completed' && p.threadId === this.threadId) {
      this.lastTurn = p.turn; this.turnWaiter?.resolve(p.turn); this.turnWaiter = null;
    }
    if (message.method === 'error') this.onEvent({ type: 'model/error', message: String(p.error?.message || 'Codex error').slice(0, 500), willRetry: p.willRetry });
  }
  async start({ cwd, tools, onTool, developerInstructions, model }) {
    this.onTool = onTool; this.toolNames = new Set(tools.map(t => t.name));
    const child = this.child = this.spawnImpl(this.command, ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}', '-c', 'features.apps=false'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderrBytes = 0;
    // Raw diagnostics may contain private local paths/configuration. Do not log them.
    child.stderr.on('data', value => { this.stderrBytes += value.length; });
    child.stdin.on('error', error => { if (!this.closed) this.fail(error); });
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => { if (!this.closed) this.fail(new Error(`Codex process exited (${code ?? signal})`)); });
    const lines = this.lines = createInterface({ input: child.stdout });
    lines.on('line', line => { this.receive(line).catch(error => this.fail(error)); });
    await this.request('initialize', { clientInfo: { name: 'lumeri_cli_lf2', title: 'Lumeri CLI LF2', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    const { account } = await this.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('Codex must be signed in with ChatGPT. Run codex login; API-key/provider fallback is not used.');
    this.onEvent({ type: 'subscription', authentication: account.type });
    const effective = await this.request('config/read', { includeLayers: false });
    const config = {
      features: { shell_tool: false, apply_patch_freeform: false, unified_exec: false, view_image_tool: false, apps: false, collab: false, multi_agent: false, browser_use: false, computer_use: false, image_generation: false, web_search: false, memories: false, memory_tool: false, skill_search: false },
      web_search: 'disabled', mcp_servers: {},
    };
    // Disabling each configured server also works with clients that merge empty tables.
    for (const name of Object.keys(effective.config?.mcp_servers || {})) config.mcp_servers[name] = { enabled: false };
    const result = await this.request('thread/start', { cwd, model: model || null, modelProvider: 'openai', allowProviderModelFallback: false,
      approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: true, environments: [], config, dynamicTools: tools, developerInstructions });
    if (result.modelProvider !== 'openai') throw new Error('Codex selected a different provider');
    this.threadId = result.thread.id;
    this.onEvent({ type: 'thread/started', threadId: this.threadId, model: result.model, provider: result.modelProvider });
    return { threadId: this.threadId, model: result.model, provider: result.modelProvider, authentication: account.type, processId: child.pid };
  }
  async run(prompt, { timeoutMs = 1200000 } = {}) {
    let timer;
    this.lastTurn = null; this.turnId = null;
    const finished = new Promise((resolve, reject) => { this.turnWaiter = { resolve, reject }; timer = setTimeout(() => reject(new Error('Codex film turn timed out')), timeoutMs); });
    finished.catch(() => {});
    try {
      const response = await this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      this.turnId = response.turn.id;
      const turn = this.lastTurn || await finished;
      await this.toolQueue;
      if (turn.status !== 'completed') throw new Error(`Codex film turn ${turn.status}: ${turn.error?.message || 'no completed result'}`);
      return turn;
    } finally { clearTimeout(timer); }
  }
  async close() {
    if (!this.child) return;
    if (this.turnWaiter && this.threadId && this.turnId) {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10000).catch(() => {});
    }
    this.closed = true;
    this.fail(new Error('LF2 client closed'));
    this.lines?.close(); this.child.stdin.end();
    if (this.child.exitCode == null && this.child.signalCode == null) {
      const exited = new Promise(resolve => this.child.once('exit', resolve));
      this.child.kill('SIGTERM');
      const timeout = setTimeout(() => this.child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timeout);
    }
  }
}
