# Run any OpenAI-compatible agent on your ChatGPT subscription

`lumeri codex` signs in with the **official "Sign in with ChatGPT" OAuth/PKCE
flow** (the same one the Codex CLI uses) and calls the ChatGPT Codex Responses
endpoint. Usage is deducted from your ChatGPT subscription's **Codex quota**, not
metered API-key billing — which is dramatically cheaper for heavy agent loops.

This doc describes the **OpenAI-compatible bridge** (`src/codex/openai-bridge.js`)
that lets *any* client speaking the OpenAI Chat Completions API — an editor, an
agent framework, or the Lumeri video orchestrator — run on that subscription
quota, with full tool-calling, image input, and streaming.

> Note: this reuses OpenAI's first-party OAuth client. OpenAI currently permits
> ChatGPT-subscription Codex usage from third-party clients (they're promoting
> Codex). If that ever changes, stop using the bridge. No credentials or tokens
> live in this repo — they stay in `~/.lumeri/codex-auth.json` (0600) on your
> machine.

## How it works

```
OpenAI-Chat-Completions client
        │  POST /v1/chat/completions  (messages, tools, images, stream)
        ▼
  openai-bridge.js  ── translates ──►  Codex Responses API
        │                              chatgpt.com/backend-api/codex/responses
        │  ◄── translates back ──      (bearer = subscription access_token
        ▼                               + chatgpt-account-id + originator)
  OpenAI SSE (content / tool_calls / usage)
```

The bridge is a thin, dependency-free translation layer:

- **Request**: OpenAI `messages` → Responses `input` items (`message`,
  `function_call`, `function_call_output`, `input_image`); OpenAI `tools` →
  Responses function tools; system messages → top-level `instructions`.
- **Response**: Responses SSE (`response.output_text.delta`,
  `response.output_item.added` for function calls,
  `response.function_call_arguments.delta`, `response.completed`) → OpenAI
  streaming chunks (`delta.content`, `delta.tool_calls`, `finish_reason`, `usage`).
- **Auth/transport** are reused from this package's `client.js` / `net.js` /
  `store.js` — including automatic token refresh and machine-proxy tunneling.
- **Token accounting**: every call's usage is appended to
  `src/codex/token-usage.jsonl` for cost/quota visibility.

## Use it

```bash
# 1. Authenticate once (browser OAuth, or reuse an existing Codex CLI login)
lumeri codex login       # or: lumeri codex import
lumeri codex status      # shows plan + token expiry

# 2. Start the bridge (set HTTPS_PROXY only where chatgpt.com needs a proxy)
HTTPS_PROXY=http://127.0.0.1:7890 node src/codex/openai-bridge.js
# -> http://127.0.0.1:7808/v1/chat/completions

# 3. Point any OpenAI-compatible client at it
export OPENAI_BASE_URL=http://127.0.0.1:7808/v1
export OPENAI_API_KEY=unused          # the bridge ignores it; auth is your login
# model id must be a ChatGPT-account slug, e.g. gpt-5.5 (not the metered gpt-5)
```

### Example: the Lumeri video orchestrator on your subscription

Lumeri's v3 brain speaks the OpenAI Chat Completions protocol. Point it at the
bridge and it plans, calls its ~100 editing verbs, inspects rendered frames, and
self-corrects — all on ChatGPT-subscription quota:

```bash
LUMERI_V3_PROVIDER=openai \
LUMERI_V3_MODEL=gpt-5.5 \
LUMERI_OPENAI_BASE_URL=http://127.0.0.1:7808/v1/chat/completions \
OPENAI_API_KEY=unused \
python server.py --port 7788
```

## Caveats

- **Model slugs**: the ChatGPT-account Codex path accepts its own ids (`gpt-5.5`,
  `gpt-5.4`), and rejects the metered `gpt-5` with HTTP 400.
- **`reasoning.effort`**: `gpt-5.5` accepts `none|low|medium|high|xhigh` (not
  `minimal`). Set `SHIM_REASONING` to override the default (`medium`).
- **Quota, not dollars**: heavy agent loops resend the full tool schema + history
  each turn (tens of thousands of input tokens per call). It's free against your
  subscription, but subject to that plan's rate/quota limits — not unlimited.
