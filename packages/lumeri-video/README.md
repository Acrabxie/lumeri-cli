# Lumeri Video

`lumeri-video` installs the `luvi` terminal client for **Lumeri Video**.
It connects to an already installed Lumeri Runtime and carries no model,
credential, or media-processing implementation.

## Install

```sh
npm install --global lumeri-video
```

Requires Node.js 22 or newer.

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
