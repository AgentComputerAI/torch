#!/usr/bin/env node
// drive-torch.mjs — minimal RPC driver for batch scraping with torch.
//
// Spawns `torch --rpc`, sends one `prompt` command, streams events on stdout,
// exits cleanly on `agent_end` or times out after 10 minutes. Useful for running
// many scrapes in parallel from a shell loop.
//
// Usage:
//   node scripts/drive-torch.mjs <slug> "<prompt>"
//   node scripts/drive-torch.mjs --verbose <slug> "<prompt>"
//
// Example (parallelize with xargs):
//   printf '%s\n' amazon walmart target | xargs -P 3 -I{} \
//     node scripts/drive-torch.mjs {} 'scrape https://www.{}.com'
//
// --verbose prints every tool call the agent makes, so you can watch progress.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 10 * 60 * 1000;

function printHelp() {
  process.stdout.write(`drive-torch — minimal RPC driver for batch scraping

Usage:
  drive-torch.mjs [--verbose] <slug> "<prompt>"

Arguments:
  slug     Short alphanumeric identifier for the site (e.g. "amazon", "hackernews").
           Used only for log prefixing — the actual slug torch uses comes from its
           own SYSTEM.md invariants.
  prompt   The natural-language prompt to send to torch. Typically "scrape <url>".

Options:
  --verbose   Print every tool call the agent makes, not just start/end events.
  --help      Show this help.

Exit codes:
  0   agent_end received, torch completed successfully
  1   torch exited without agent_end
  2   timeout
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.length < 2) {
  printHelp();
  process.exit(args.includes("--help") ? 0 : 1);
}

let verbose = false;
if (args[0] === "--verbose") {
  verbose = true;
  args.shift();
}

const [slug, prompt] = args;
if (!slug || !prompt) {
  printHelp();
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const torchBin = resolve(__dirname, "..", "bin", "torch.js");
const cwd = resolve(__dirname, "..");

const child = spawn(torchBin, ["--rpc"], { cwd, stdio: ["pipe", "pipe", "inherit"] });

const timer = setTimeout(() => {
  console.error(`[${slug}] TIMEOUT after ${TIMEOUT_MS / 1000}s`);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000);
  process.exitCode = 2;
}, TIMEOUT_MS);

let buf = "";
let agentEnded = false;
let summary = "";
let toolCalls = 0;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (verbose) {
      if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "tool_call") {
        const name = msg.assistantMessageEvent.name ?? "?";
        toolCalls++;
        console.error(`[${slug}] tool #${toolCalls} ${name}`);
      }
      if (msg.type === "turn_end") {
        console.error(`[${slug}] turn_end`);
      }
    }

    if (msg.type === "agent_end") {
      agentEnded = true;
      const lastMsg = msg.messages?.[msg.messages.length - 1];
      const content = lastMsg?.content?.find?.((c) => c.type === "text");
      summary = content?.text ?? "(no summary)";
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 500);
    }
  }
});

child.on("exit", (code) => {
  if (agentEnded) {
    console.log(`[${slug}] done (${toolCalls} tool calls)\n${summary}\n`);
    process.exit(0);
  }
  console.error(`[${slug}] exited code=${code} without agent_end`);
  process.exit(process.exitCode ?? 1);
});

child.stdin.write(
  JSON.stringify({ id: `p-${slug}`, type: "prompt", message: prompt }) + "\n",
);
