# Lumeri Video and Quanta CLI

A pair of product-scoped terminal clients for **Lumeri v3**: `luvi` for
**Lumeri Video** and `luqu` for **Lumeri Quanta**. Both use a TUI modeled on
Claude Code: a streaming chat transcript, live tool-call cards, FFmpeg
progress bars, slash commands, and an inline input box — all rendered with
[Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

It talks to a running Lumeri sidecar over its HTTP + SSE session protocol
(`POST /sessions`, `POST /sessions/{id}/turn`, `GET /sessions/{id}/stream`, …).
The CLI is a pure client — it ships no model, keys, or media processing.

```
╭─────────────────────────────────────────────────────────────╮
│  ● Lumeri Video  v1.0.0                                      │
│  /help for commands · /upload <path> to add media             │
╰─────────────────────────────────────────────────────────────╯

✔ connected · session v3-660dd4f26ca8

› color grade my clip warm

Sure — let me warm-grade your clip.

⏺ color_grade(style: "warm")
  ⎿ Applied warm grade to clip [v_002 ▶ video]
⏺ generate_video(prompt: "a neon city")
  ⎿ ✗ generate_video is not implemented
     E_NOT_IMPLEMENTED
     hint: this verb is a stub (Veo not wired)
     valid: edit_video, color_grade, composite

  delivered: v_002 · view: /open v_002
```

## Install

Install the published package globally:

```sh
npm install --global lumeri-cli
```

For local development from this repository:

```sh
cd lumeri-cli
npm install
npm link        # makes `luvi` and `luqu` real commands on your PATH
```

`npm link` symlinks `luvi` and `luqu` into your global bin (e.g.
`/opt/homebrew/bin`), so both are genuine launch commands resolved via PATH —
not shell aliases. The old `lumeri` launch name is not published.

Requires Node ≥ 18 (developed on Node 25). No build step — it runs straight from
source via [htm](https://github.com/developit/htm).

## Run

```sh
luvi                                      # Lumeri Video on http://127.0.0.1:7788
luqu                                      # Lumeri Quanta on the same runtime
luvi -p "剪掉开头三秒并导出"                # one Video Agent turn
luqu -p "把这个主题做成离散演示"             # one Quanta Agent turn
luqu check ./museum-tour.luqu                 # validate an offline LUQU v1/v2 file
luqu check --json ./museum-tour.luqu          # machine-readable graph/state report
luvi --server http://127.0.0.1:8000       # custom sidecar
LUMERI_SERVER=http://host:7788 luqu       # via env
node bin/luvi.js                           # without npm link
node bin/luqu.js
```

Launching plays a short ceremonial LUMERI wordmark scan (press any key to skip,
or `--no-splash` / `LUMERI_NO_SPLASH=1` to disable). The Lumeri server normally
listens on port 7788 and may be managed
by launchd on local installations; the connection is established behind the
animation.

`luvi`, `luqu`, and both `-p` forms use the sidecar's configured Lumeri Agent
and provider priority. Neither command forces Codex. `-p` differs only in terminal
presentation: it waits for one complete Agent turn, prints the final response,
then exits without opening the TUI or preview. Every HTTP and SSE request carries
the matching product identity, so Video and Quanta Projects/sessions stay isolated.
The command surfaces are also product-specific: `luvi` exposes timeline and
media-annotation commands, while `luqu` exposes the canonical discrete Quanta
state tree and branches through `/quanta` and opens the Quanta player.

`luqu check` is intentionally local-only: it reads a `.luqu` NDJSON file without
creating a session or contacting a model/server, checks the declared v1/v2
structure, and reports video states plus interactive, automatic and looping
edges. Unsupported v2 graph semantics exit non-zero rather than being presented
as a linear file.

## Optional Codex subscription credentials

Run a model on your **ChatGPT subscription's Codex quota** instead of metered
API keys — the same mechanism the Codex CLI and tools like OpenClaw / OpenCode
use. It's the official "Sign in with ChatGPT" OAuth flow (authorization code +
PKCE against `auth.openai.com`, loopback callback on `:1455`) — no cookie
scraping, no simulated login. After signing in, requests go to
`https://chatgpt.com/backend-api/codex/responses` with your bearer token +
account id, and usage is deducted from your plan's Codex limits.

```sh
luvi codex login                # sign in with ChatGPT in the browser
luvi codex import               # or reuse an existing `codex` CLI login
luvi codex status               # plan, account, token expiry
luvi codex logout
# The same credential commands are available under `luqu codex ...`.
```

Notes:
- ChatGPT-account Codex only accepts its own model slugs (e.g. `gpt-5.5`,
  `gpt-5.4`); the metered `gpt-5` is rejected with HTTP 400.
- Tokens live in `~/.lumeri/codex-auth.json` (`0600`), separate from
  `~/.codex/auth.json` — refreshing here never desyncs your Codex CLI login.
- Calls go out through your machine proxy (`HTTPS_PROXY`), unlike the loopback
  sidecar traffic which deliberately bypasses it.
- The programmatic surface is `createCodexProvider()` in
  [`src/codex/provider.js`](src/codex/provider.js) — `{ login, import, status,
  whoami, respond, stream }` — for wiring the subscription model into Lumeri.
- ⚠️ Reusing the first-party Codex OAuth client for third-party calls is a grey
  area; OpenAI may rate-limit or change this path. It's your own subscription,
  used locally.

### Multi-provider router — written, not enabled

`src/providers/` is dormant scaffolding for the day a single backend isn't
enough (e.g. if OpenAI revokes the subscription path). It defines one `Provider`
contract and three implementations — `vertex` (Lumeri's intended primary brain,
a stub today since Gemini runs in the cloud sidecar), `codex` (the subscription
provider above), `apikey` (metered last resort) — behind a `router` that fails
over to the next provider when one is unavailable (auth/quota/5xx), while never
switching mid-stream once tokens have started flowing.

Neither interactive product CLI nor its `-p` mode imports it; both delegate provider
selection to the Lumeri sidecar. Enabling this local router later would require
an explicit product decision, not an implicit Codex default.
Covered by `test/providers.mjs` (in `npm test`).

## Slash commands

| Command | Description |
|---|---|
| `/help` | Commands + keyboard shortcuts |
| `/new` | Fresh session; stays inside the current Project |
| `/project` | List Projects and the current Project's sessions |
| `/project create <name> [--folder <path>]` | Create and enter a Project; the folder is optional |
| `/project use <#\|name\|project_id>` | Enter an existing Project with a new session |
| `/project resume <#\|session_id>` | Resume a durable session in the current Project |
| `/project leave` | Leave the Project and start an independent Chat |
| `/clear` | Clear the visible transcript (keep the session) |
| `/upload <path>` | Upload a media file to the session |
| `/assets` | List assets in the session |
| `/preview` | (Re)open the preview window in your browser |
| `/open <asset_id>` | Open a result asset in the system viewer |
| `/session` | Session id, server, connection state |
| `/retry` | Reconnect / recreate the session |
| `/login` | Sign in — opens the web login page; `/login email` / `/login google` |
| `/logout` | Sign out of the current account |
| `/account [switch <#\|id>]` | Show the active account / roster, or switch |
| `/quit` | Exit |

Video-only commands:

| Command | Description |
|---|---|
| `/timeline` | Show the current Video project timeline |
| `/annotate <asset_id\|all>` | Annotate media-library videos |
| `/annotations [asset_id]` | List media-library annotations |

Quanta-only commands:

| Command | Description |
|---|---|
| `/quanta` | Show the canonical discrete state tree, branches, revision, and patch sequence |

### Project workspaces

A Project is one long-lived workspace, not a label on a single terminal
session. Every CLI session inside it uses the same Project memory and logs,
assets, editing storage, and timeline state. `/new` starts another session in
that same workspace; `/project leave` is the explicit way back to an
independent Chat. Project context stays isolated from every other Project.

### Accounts

Lumeri data (memory, sessions, media) is scoped per account by the gemia
sidecar, which holds the active-account session server-side
(`~/.gemia/accounts/`) — no token is ever stored on the client. Two ways to sign
in, both available inside the TUI (`/login`) and as a plain stdout command that
runs before the app (`luvi login` / `luqu login`):

The interactive CLI is fail-closed: it verifies the active account before it
creates a workspace session. Signed-out launches stay on the sign-in screen,
and a logout from this CLI or another Lumeri surface closes the current CLI
workspace and returns to that screen.

```
luvi login              # Lumeri Video: pick email code or Google
luvi login email        # a 6-digit code mailed to you
luvi whoami             # who's signed in
luvi logout
luqu login              # the same flow, scoped to Lumeri Quanta
```

- Email code: enter your address, the sidecar mails a 6-digit code (valid 10
  minutes), you type it back. Needs SMTP configured on the sidecar (the `smtp`
  block in `~/.gemia/config.json`).
- Google: opens your browser; the sidecar catches the loopback callback at
  `/auth/google/callback` and the CLI updates the moment you're signed in. Needs
  `google_oauth_client_id` on the sidecar (`~/.gemia/config.json` or
  `$GEMIA_GOOGLE_OAUTH_CLIENT_ID`).

The status line shows who you're signed in as. During a turn, its fixed-width
bar-and-dot motion marks that Lumeri is working without moving the prompt.

### Shortcuts

`enter` send · `\` + `enter` newline · `↑`/`↓` history & menu · `tab` complete a
`/command` · `esc` clear input · `ctrl+c` twice to exit.

## Preview window

On launch, `luvi` opens the 7788 **Lumeri Video** workspace at
`/video/?mode=cli-preview&session=<id>`, attached to the terminal's session.
`luqu` opens the **Lumeri Quanta** workspace at `/quanta`. Video CLI preview
mode removes the duplicate chat surfaces while preserving the canonical Video
canvas, timeline, modules, styling, and behavior.

Disable auto-open with `--no-preview` or `LUMERI_NO_PREVIEW=1`; reopen any time
with `/preview`. The terminal checks that the connected sidecar supports the
shared preview mode before opening it.

## What the terminal renders

The SSE stream is rendered faithfully — no synthesized progress or status:

- **`model_text_delta`** → streaming assistant text (Markdown-aware).
- **`model_tool_call_start` / `_ready`** → a `⏺ verb(args)` card.
- **`tool_exec_progress`** → a real FFmpeg progress bar (`█████░ 90%`).
- **`tool_exec_result`** → the verb summary + an `[asset_id ▶ kind]` chip.
- **`tool_exec_error`** → the typed error with `error_code`, `hint`,
  `recovery`, and `valid_options`.
- **`budget_gate`** → a budget banner with suggested alternatives.
- **`turn_complete`** → marks final `deliverable_asset_ids`.
- **`replay_gap`** → reconnects with `Last-Event-ID` and flags missed events.

## Develop without the backend

A scripted mock server speaks the same protocol so you can iterate offline:

```sh
npm run mock                              # http://127.0.0.1:7799
luvi --server http://127.0.0.1:7799       # in another terminal
```

## Test

```sh
npm test     # headless render regression check
```

## Layout

```
bin/luvi.js            Lumeri Video launch entry
bin/luqu.js            Lumeri Quanta launch entry
bin/cli.js             shared arg parsing, TTY guard, and <App/> renderer
src/App.js             session lifecycle, SSE dispatch, slash commands, state
src/api.js             v3 HTTP wrappers
src/http.js            loopback http/https (never proxied) + raw streaming
src/sse.js             SSE client with Last-Event-ID reconnect/replay
src/markdown.js        compact Markdown → Ink renderer
src/logo.js            LUMERI wordmark (figlet "ANSI Shadow")
src/components/        Splash · Banner · Turn · ToolCall · InputBox · StatusLine · Notice
web/preview.html       legacy standalone preview retained for older sidecars
scripts/mock-server.mjs   offline scripted v3 server
scripts/install-preview.mjs  legacy preview.html deployment helper
test/smoke.mjs         headless render assertions
test/recovery.mjs      replay_gap recovery / FIFO queue / open validation
test/preview-mode.mjs  shared Video preview URL/support assertions
test/preview.mjs       legacy standalone preview DOM assertions (jsdom)
```
