#!/usr/bin/env node
const v = process.versions.node.split(".").map(Number);
if ((v[0] ?? 0) < 20) {
  console.error(`torch requires Node.js 20+ (detected ${process.versions.node})`);
  process.exit(1);
}
await import("../dist/index.js");
