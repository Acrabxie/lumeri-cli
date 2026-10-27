# Lumeri Video

`lumeri-video` installs the `luvi` terminal client for **Lumeri Video**.
It connects to an already installed Lumeri Runtime and carries no model,
credential, or media-processing implementation.

## Install

```sh
npm install --global lumeri-video
```

Requires Node.js 22 or newer.

This source branch prepares an unpublished local 1.0.2 candidate for `luvi lf2`.
The npm install above still retrieves the published client. The candidate has
an approved local release freeze; verification does not establish publication.
See [the LF2 guide](docs/lf2-codex-cli.md): the trial uses an official Codex
process and an owned isolated source Runtime for an 8s/720p/30fps film; daily
App authentication is outside its current scope.

## Run

```sh
luvi
luvi -p "Trim the first three seconds"
luvi --json -p "Inspect the timeline"
luvi roughcut ./take.mov
```

Use `--server <url>` or `LUMERI_SERVER` when the Runtime is not at
`http://127.0.0.1:7788`. Run `luvi --help` for the complete command surface.

## Public package boundary

This package is a Runtime client. Account access, providers, and Runtime setup
remain in the installed Lumeri product. Runtime refusal is surfaced as a
generic authorization error.

## License

MIT.
