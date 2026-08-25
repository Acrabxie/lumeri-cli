# Lumeri Quanta

`lumeri-quanta` installs the `luqu` terminal client for **Lumeri Quanta**.
It connects to an already installed Lumeri Runtime and carries no model or
credential implementation.

## Install

```sh
npm install --global lumeri-quanta
```

Requires Node.js 22 or newer.

## Run

```sh
luqu
luqu -p "Create a discrete product walkthrough"
luqu --json -p "Inspect the state graph"
luqu check ./walkthrough.luqu
```

`luqu check` validates a local LUQU file without contacting the Runtime. Use
`--server <url>` or `LUMERI_SERVER` when the Runtime is not at
`http://127.0.0.1:7788`. Run `luqu --help` for the complete command surface.

## Public package boundary

This package is a Runtime client. Account access, providers, and Runtime setup
remain in the installed Lumeri product. Runtime refusal is surfaced as a
generic authorization error.

## License

MIT.
