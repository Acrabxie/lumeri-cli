#!/usr/bin/env node
process.env.LUMERI_PRODUCT = "video";
await import("./cli.js");
