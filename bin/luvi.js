#!/usr/bin/env node
process.env.LUMERI_PRODUCT = "video";
if (process.argv[2] === "lf2") {
  const { runLf2 } = await import("../src/lf2-cli.js");
  process.exit(await runLf2(process.argv.slice(3)));
}
if (["--help", "-h"].includes(process.argv[2])) {
  process.stdout.write("Additional Video command\n  luvi lf2 --help      Local LF2 source-Runtime film trial\n\n");
}
await import("./cli.js");
