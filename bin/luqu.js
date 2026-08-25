#!/usr/bin/env node
process.env.LUMERI_PRODUCT = "quanta";
await import("./cli.js");
