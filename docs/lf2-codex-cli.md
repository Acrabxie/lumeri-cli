# LF2 through Lumeri CLI and a Codex subscription

This unpublished local release candidate adds an explicit `luvi lf2` command
to Video 1.0.2 and combined CLI 1.0.1. Published packages do not yet include it.
Those two versions have an approved local `release-lock.json` freeze; passing
package verification establishes their bytes without claiming publication.
Lumeri CLI owns the film request,
its four tools, Project and exported media. The official `codex app-server`
process supplies the creative model using its existing ChatGPT login. The CLI
neither imports OAuth tokens nor implements a subscription HTTP backend.
The legacy TUI and `luvi -p` Runtime route are unchanged. Quanta has no LF2 entry.

The model can inspect, author/revise an editable Scene, receive actual LF2 PNG
previews as images, and export MP4 and ProRes4444 MOV. Every operation uses the
normal Runtime Luc/Project Gate/Timeline/Job/CAS routes. It is a CLI-driven
model/tool loop, not a scripted film or an already-rendered video insertion.
The supplied prompt controls the subject, story and visual direction within
the trial's fixed format. Built-in filesystem image reads are disabled;
preview images arrive only through the declared LF2 tool responses. The
Runtime session has a zero model-spending budget; Codex supplies the model
through its own ChatGPT subscription.
On macOS, the CLI preflight requires at least 1.2 GiB of free Data space.

This first integration is a local trial: it accepts an owned 0600 readiness
file from an **isolated source Runtime**, and creates a new Project. It refuses
an existing Project and does not discover daily-App credentials. It does not
change the packaged App's Sign in with ChatGPT feature switch. Dimensions are
1280x720,30fps,240frames for the approved comparison. No API-key fallback is used.

```sh
node bin/luvi.js lf2 --prompt-file /absolute/brief.txt \
  --runtime-ready /absolute/owned/gateway.ready.json \
  --runtime-source /absolute/lf2-source \
  --output /absolute/new/film-output
```

Use `--model <id>` only to explicitly choose a model; otherwise the official
Codex client's configured model is retained. `codex login` manages sign-in.
A successful authentication check or model catalog is not proof of inference;
`cli-run.json` is written only after the completed model turn and both actual
exports. It records model identity and tool outcomes without tokens or PNG data.

For a reproducible disposable source Runtime with the existing native tools:

```sh
python -B scripts/lf2-trial-runtime.py \
  --runtime-source /absolute/lf2-source \
  --engine-dir /absolute/verified/frozen-engine-dir \
  --renderer-helper /absolute/verified/lumenframe2-renderer \
  --output /absolute/new/film-output --state /absolute/new/task-runtime \
  --prompt-file /absolute/brief.txt
```

This launcher temporarily binds the supplied native engine/helper only when
those paths are empty, stops its own Gateway/Workers, and restores the bindings
on exit. It does not build, install, publish or restart a production service.
Use the Runtime repository's existing Python venv and resource guards.

The app-server dynamic-tool interface is experimental. Tests cover its protocol
flow, refusal/incomplete-turn behavior, token-free metadata and actual CLI
orchestration; Runtime client tests cover HTTP revision/Scene/export behavior.
Run `npm test` for the full relevant CLI suite. Real subscription inference,
previews and complete media decoding remain separate live validation gates.

Official protocol reference: https://learn.chatgpt.com/docs/app-server

## Continue a quota-interrupted generated Scene

If the model saved a Scene and then exhausted its subscription before exports,
use `--resume-run /same/output/cli-failed-<id>.json` instead of a prompt. Keep the
same output folder and the same isolated Runtime state directory. The command
validates the original subscription record and its owned Scene file, then
checks the persisted Project revision, Scene revision and exact source before
resuming. It never recreates/reformats/reinserts a clip during continuation.
The model sees its earlier source, previews it and completes the exports. The
prior failure remains alongside the new successful run and records the lineage.
The Runtime launcher accepts the same `--resume-run` option. This narrow form
supports generated Scenes interrupted before any export; it refuses an already
completed film or a Project changed since the saved record.
