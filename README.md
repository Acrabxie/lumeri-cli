# Lumeri CLI

This repository is the public source for the product-scoped terminal clients
that connect to an already installed Lumeri Runtime:

| Package | Command | Status |
|---|---|---|
| `lumeri-video` | `luvi` | Current Lumeri Video CLI |
| `lumeri-quanta` | `luqu` | Current Lumeri Quanta CLI |
| `lumeri-cli` | `luvi`, `luqu` | Frozen combined compatibility package |

The root project is a private, non-publishable development workspace. Each
publishable package has an explicit template and file allowlist under
[`packages/`](./packages/).

## Install the CLIs

The published CLIs require Node.js 22 or newer.

### Windows (PowerShell)

Windows installation is available only through the official `irm` entry
points. Each installer downloads the pinned 1.0.1 archive from
`cli.lumeri.io`, verifies its SHA-256 digest, disables package lifecycle
scripts, and verifies the installed command shim.

```powershell
irm https://cli.lumeri.io/windows/install-video.ps1 | iex
irm https://cli.lumeri.io/windows/install-quanta.ps1 | iex
```

### macOS and Linux

Install from npm:

```sh
npm install --global lumeri-video
npm install --global lumeri-quanta
```

Or download the published package archives:

```sh
curl -fLO https://cli.lumeri.io/downloads/lumeri-video-1.0.1.tgz
curl -fLO https://cli.lumeri.io/downloads/lumeri-quanta-1.0.1.tgz
```

The packages may be installed together. Do not install them globally alongside
the combined `lumeri-cli` compatibility package because its command names
overlap.

Run the clients with:

```sh
luvi
luqu
```

Use `luvi --help` or `luqu --help` for launch options and primary entry points;
use `/help` inside the interactive TUI for its slash commands. The clients
expect Lumeri Runtime at `http://127.0.0.1:7788` by default; use `--server
<url>` or `LUMERI_SERVER` to select another Runtime endpoint.

## Public boundary

These packages are Runtime clients. They contain terminal presentation,
product-scoped request handling, local format validation, and the Runtime HTTP
and SSE transport.

They do not implement account sign-in or switching, select or configure model
providers, import subscription credentials, read API keys, install the Runtime,
or process media locally. Those responsibilities remain with the installed
Lumeri product and Runtime. A Runtime access refusal is exposed only as a
generic authorization error.

The interactive TUI does forward two explicit Runtime-control operations that
are already part of the 1.0.0 clients: `/sandbox on|off` changes the Runtime's
process-global host-sandbox setting, and `/tasks kill <job_id>` asks the Runtime
to stop one of its background jobs. The CLI does not implement either executor
or bypass Runtime authorization.

The package allowlists, repository boundary test, and pack verification are
designed to keep that separation observable.

## Historical branch

The former combined prototype at commit `890ae954` is preserved at
[`codex/archive-legacy-monolith-main-20260824-890ae95`](https://github.com/Acrabxie/lumeri-cli/tree/codex/archive-legacy-monolith-main-20260824-890ae95).

That branch is an archived historical snapshot, not the source for the current
npm packages. It includes obsolete pre-split experiments outside today's public
package boundary and should not be installed, linked, or used as a release
source.

## Develop

Use Node.js 22 and npm 11.17.0:

```sh
npm ci
npm test
```

The terminal IME escape-sequence harness is intentionally separate:

```sh
npm run test:ime
```

Run either product directly from the checkout without a global install:

```sh
npm run start:video
npm run start:quanta
```

## Reproducible packages

The generic packer takes files only from a package's explicit `files`
allowlist. A package-local file overrides the shared root file of the same path.
Inputs that are symbolic links, escape their source root, or are not regular
files are rejected. The generated tarball is then reopened and checked for its
actual paths, content hashes, and modes.

```sh
npm run pack:video
npm run pack:quanta
npm run pack:compat
npm run verify:packages
```

The three exact pack commands are toolchain-specific: use Node 22.23.2 with npm
11.17.0 for `pack:video` and `pack:quanta`, and Node 26.5.0 with npm 11.17.0 for
`pack:compat`.

[`release-lock.json`](./release-lock.json) records the exact published 1.0.1
split payload and artifact hashes alongside the exact published combined 1.0.0
compatibility payload. The split Video and Quanta tarballs reproduce
byte-for-byte under Node 22.23.2 with npm 11.17.0. The frozen combined
compatibility tarball used Node 26.5.0 with npm 11.17.0; Node 22 reproduces and
verifies its complete payload, while the gzip byte stream differs by producer.

Files under `packages/lumeri-cli/` preserve the exact published 1.0.0
compatibility payload, including its historical README. Its root-level
`npm link` development instructions are therefore non-normative; use this root
README for current development commands.

CI runs the public-boundary, Runtime, and IME tests. Its Node 22.23.2 job
reproduces the two split tarballs exactly and verifies the combined payload; a
separate Node 26.5.0 job reproduces the combined compatibility tarball exactly.
Both use npm 11.17.0, and neither publishes.

## Repository layout

```text
bin/                         product launchers and shared CLI entry
src/                         public Runtime-client implementation
packages/lumeri-video/       Video package template
packages/lumeri-quanta/      Quanta package template
packages/lumeri-cli/         frozen combined compatibility overrides
scripts/pack-package.mjs     allowlist-first generic packer
scripts/verify-packages.mjs  three-package release-lock verification
test/                        runtime, product, package, and boundary checks
release-lock.json            frozen npm artifact and payload evidence
```

Security reports are handled according to [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).
