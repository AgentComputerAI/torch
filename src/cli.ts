import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, dirname, delimiter } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isSetupComplete, loadTorchEnv, runSetup } from "./setup.js";

function loadEnv(dir: string): void {
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");

function getTorchHome(): string {
  return process.env.TORCH_HOME ?? resolve(homedir(), ".torch");
}

const CHROME_PORT = Number(process.env.TORCH_CHROME_PORT ?? "9222");

async function probeDebugPort(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${url}/json/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function findChromeBinary(): string | null {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : process.platform === "linux"
        ? [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ]
        : process.platform === "win32"
          ? [
              `${process.env["PROGRAMFILES"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
              `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
            ]
          : [];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function getRealChromeProfile(): string | null {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Google", "Chrome");
  }
  if (process.platform === "linux") {
    const gchrome = resolve(homedir(), ".config", "google-chrome");
    if (existsSync(gchrome)) return gchrome;
    return resolve(homedir(), ".config", "chromium");
  }
  if (process.platform === "win32") {
    return resolve(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "User Data");
  }
  return null;
}

const TORCH_CHROME_PROFILE_SUBDIR = "chrome-profile";

// Ephemeral caches — safe to skip during profile clone. Reduces typical clone from ~5GB to ~200MB.
const PROFILE_CLONE_EXCLUDES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "DawnCache",
  "Service Worker",
  "Crashpad",
  "Media Cache",
  "optimization_guide_model_store",
  "component_crx_cache",
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/Service Worker",
  "Default/Media Cache",
  "Default/File System",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
];

function cloneChromeProfile(src: string, dst: string): boolean {
  mkdirSync(dirname(dst), { recursive: true });
  const rsyncArgs = ["-a", "--delete"];
  for (const ex of PROFILE_CLONE_EXCLUDES) {
    rsyncArgs.push(`--exclude=${ex}`);
  }
  rsyncArgs.push(`${src.replace(/\/?$/, "/")}`, `${dst.replace(/\/?$/, "/")}`);
  const result = spawnSync("rsync", rsyncArgs, { stdio: "inherit" });
  return result.status === 0;
}

function stripSingletonLocks(profileDir: string): void {
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const p = resolve(profileDir, f);
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
}

async function launchTorchChrome(
  chromeBin: string,
  profileDir: string,
  url: string,
): Promise<boolean> {
  stripSingletonLocks(profileDir);

  const proc = spawn(
    chromeBin,
    [
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--disable-features=Translate",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  proc.unref();

  for (let i = 0; i < 75; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await probeDebugPort(url)) return true;
  }
  return false;
}

async function ensureChromeEndpoint(): Promise<string | null> {
  // 1. User override via env var
  if (process.env.TORCH_CHROME_ENDPOINT) return process.env.TORCH_CHROME_ENDPOINT;

  const url = `http://127.0.0.1:${CHROME_PORT}`;

  // 2. Already up — either user launched Chrome manually or a previous torch run did
  if (await probeDebugPort(url)) {
    console.error(
      `\x1b[38;2;255;160;20m[torch]\x1b[0m reusing Chrome debug port at ${url}`,
    );
    return url;
  }

  // 3. Auto-launch a torch-owned Chrome with a clone of the user's real profile
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    console.error(
      "\x1b[38;2;255;160;20m[torch]\x1b[0m Chrome not installed — falling back to disposable Chromium",
    );
    return null;
  }

  const torchProfile = resolve(getTorchHome(), TORCH_CHROME_PROFILE_SUBDIR);
  const realProfile = getRealChromeProfile();

  if (!existsSync(torchProfile)) {
    if (!realProfile || !existsSync(realProfile)) {
      console.error(
        "\x1b[38;2;255;160;20m[torch]\x1b[0m no Chrome profile to clone — falling back to disposable Chromium",
      );
      return null;
    }
    console.error(
      "\x1b[38;2;255;160;20m[torch]\x1b[0m cloning Chrome profile (one-time, ~10-30s)...",
    );
    console.error(
      `        source: ${realProfile}`,
    );
    console.error(
      `        target: ${torchProfile}`,
    );
    const ok = cloneChromeProfile(realProfile, torchProfile);
    if (!ok) {
      console.error(
        "\x1b[38;2;255;160;20m[torch]\x1b[0m profile clone failed — falling back to disposable Chromium",
      );
      return null;
    }
    console.error(
      "\x1b[38;2;255;160;20m[torch]\x1b[0m profile cloned. subsequent runs will reuse it instantly.",
    );
  }

  console.error(
    `\x1b[38;2;255;160;20m[torch]\x1b[0m launching Chrome with debug port on ${CHROME_PORT}...`,
  );

  const launched = await launchTorchChrome(chromeBin, torchProfile, url);
  if (!launched) {
    console.error(
      "\x1b[38;2;255;160;20m[torch]\x1b[0m Chrome launch timed out — falling back to disposable Chromium",
    );
    return null;
  }

  console.error(
    `\x1b[38;2;255;160;20m[torch]\x1b[0m Chrome ready at ${url} — scrapers will use cloned profile (real cookies, history, TLS state)`,
  );
  return url;
}

function copyMissingEntries(src: string, dest: string): void {
  const stat = statSync(src);

  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyMissingEntries(resolve(src, entry), resolve(dest, entry));
    }
    return;
  }

  if (existsSync(dest)) return;

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function seedHome(home: string): void {
  const bundled = resolve(APP_ROOT, ".torch");
  if (!existsSync(bundled)) return;

  const settingsDest = resolve(home, "settings.json");
  if (!existsSync(settingsDest)) {
    mkdirSync(home, { recursive: true });
    copyFileSync(resolve(bundled, "settings.json"), settingsDest);
  }

  const themeSrc = resolve(bundled, "themes");
  if (existsSync(themeSrc)) {
    const themeDest = resolve(home, "themes");
    copyMissingEntries(themeSrc, themeDest);
  }

  const agentsSrc = resolve(bundled, "agents");
  if (existsSync(agentsSrc)) {
    const agentsDest = resolve(home, "agents");
    copyMissingEntries(agentsSrc, agentsDest);
  }
}

function printHelp(): void {
  console.log(`
\x1b[1;38;2;255;220;80m  ████████╗ ██████╗ ██████╗  ██████╗██╗  ██╗\x1b[0m
\x1b[1;38;2;255;220;80m  ╚══██╔══╝██╔═══██╗██╔══██╗██╔════╝██║  ██║\x1b[0m
\x1b[1;38;2;255;160;20m     ██║   ██║   ██║██████╔╝██║     ███████║\x1b[0m
\x1b[1;38;2;255;160;20m     ██║   ██║   ██║██╔══██╗██║     ██╔══██║\x1b[0m
\x1b[1;38;2;255;100;0m     ██║   ╚██████╔╝██║  ██║╚██████╗██║  ██║\x1b[0m
\x1b[1;38;2;200;60;0m     ╚═╝    ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝\x1b[0m
`);
  console.log("  \x1b[1mUsage:\x1b[0m");
  console.log("    \x1b[38;2;255;140;0mtorch\x1b[0m                              Interactive scraping session");
  console.log('    \x1b[38;2;255;140;0mtorch\x1b[0m <url> "what to extract"      One-shot scrape');
  console.log("    \x1b[38;2;255;140;0mtorch\x1b[0m <url>                        Scrape all structured data");
  console.log("    \x1b[38;2;255;140;0mtorch --rpc\x1b[0m                        JSONL RPC mode (stdin/stdout)");
  console.log("    \x1b[38;2;255;140;0mtorch setup\x1b[0m                        Configure API keys and services");
  console.log("");
  console.log("  \x1b[1mOptions:\x1b[0m");
  console.log("    --rpc                Start in RPC mode (JSONL over stdin/stdout)");
  console.log("    --model <spec>       Model override (e.g. anthropic/claude-sonnet-4-6)");
  console.log("    --thinking <level>   off, minimal, low, medium, high, xhigh");
  console.log("    --continue, -c       Continue previous session");
  console.log("    --help               Show this help");
  console.log("    --version            Print version");
  console.log("");
  console.log("  \x1b[1mExamples:\x1b[0m");
  console.log('    \x1b[2m$\x1b[0m torch https://news.ycombinator.com \x1b[38;2;255;180;60m"top 30 posts with title, score, URL"\x1b[0m');
  console.log('    \x1b[2m$\x1b[0m torch https://quotes.toscrape.com \x1b[38;2;255;180;60m"all quotes with text and author"\x1b[0m');
  console.log("    \x1b[2m$\x1b[0m torch https://example.com/products");
  console.log("");
}

export async function main(): Promise<void> {
  loadEnv(APP_ROOT);
  loadEnv(process.cwd());

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      version: { type: "boolean" },
      model: { type: "string" },
      thinking: { type: "string" },
      continue: { type: "boolean", short: "c" },
      rpc: { type: "boolean" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (values.version) {
    const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8"));
    console.log(pkg.version);
    return;
  }

  const home = getTorchHome();
  seedHome(home);
  loadTorchEnv(home, APP_ROOT);

  if (!isSetupComplete(home) && !values.rpc) {
    await runSetup(home, APP_ROOT);
  }

  const chromeEndpoint = await ensureChromeEndpoint();

  const piCli = resolve(APP_ROOT, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(piCli)) {
    throw new Error("pi-coding-agent not found. Run 'npm install' in the torch directory.");
  }

  const systemPrompt = readFileSync(resolve(APP_ROOT, "SYSTEM.md"), "utf8");

  const piProcesses = resolve(APP_ROOT, "node_modules", "@aliou", "pi-processes");

  const piArgs: string[] = [
    "--system-prompt", systemPrompt,
    "--thinking", values.thinking ?? "medium",
    "--skill", resolve(APP_ROOT, "skills"),
    "--extension", resolve(APP_ROOT, "extensions", "header.ts"),
  ];

  // pi-processes gives the agent background-process tools (spawn, list, logs, kill, signal)
  // so long-running scrapes can run in the background and the agent can keep steering.
  // Without this, `bash` blocks the turn until the script finishes → 10-min timeouts.
  if (existsSync(piProcesses)) {
    piArgs.push("--extension", piProcesses);
  }

  if (values.model) piArgs.push("--model", values.model);
  if (values.continue) piArgs.push("--continue");

  if (values.rpc) {
    piArgs.push("--mode", "rpc");
  } else {
    const [url, ...descParts] = positionals;
    if (url) {
      const desc = descParts.join(" ") || "all available structured data";
      piArgs.push("-p", `Scrape ${url} and extract: ${desc}. Save results to ./output/`);
    }
  }

  const tsxLoader = resolve(APP_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
  const importArgs = existsSync(tsxLoader) ? ["--import", tsxLoader] : [];

  const child = spawn(process.execPath, [...importArgs, piCli, ...piArgs], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${resolve(APP_ROOT, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
      TORCH_HOME: home,
      PI_CODING_AGENT_DIR: home,
      PI_HARDWARE_CURSOR: process.env.PI_HARDWARE_CURSOR ?? "1",
      PI_SKIP_VERSION_CHECK: "1",
      ...(process.env.TORCH_CAMOUFOX_ENDPOINT
        ? { TORCH_CAMOUFOX_ENDPOINT: process.env.TORCH_CAMOUFOX_ENDPOINT }
        : {}),
    },
  });

  await new Promise<void>((res, rej) => {
    child.on("error", rej);
    child.on("exit", (code, signal) => {
      if (signal) {
        try { process.kill(process.pid, signal); } catch { process.exitCode = 1; }
        return;
      }
      process.exitCode = code ?? 0;
      res();
    });
  });
}
