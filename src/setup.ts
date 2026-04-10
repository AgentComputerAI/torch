import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

const MODEL_PREFERENCES = [
  { spec: "anthropic/claude-opus-4-6", provider: "anthropic", reason: "best reasoning for complex scraping decisions" },
  { spec: "anthropic/claude-sonnet-4-6", provider: "anthropic", reason: "fast and capable, good default" },
  { spec: "openai/gpt-4o", provider: "openai", reason: "strong general reasoning" },
  { spec: "google/gemini-2.5-pro", provider: "google", reason: "good multimodal reasoning" },
  { spec: "xai/grok-3", provider: "xai", reason: "fast generation" },
];

function openUrl(url: string): boolean {
  try {
    if (process.platform === "darwin") execSync(`open "${url}"`);
    else if (process.platform === "win32") execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
  }
}

function loadEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

function saveEnvVar(envPath: string, key: string, value: string): void {
  mkdirSync(resolve(envPath, ".."), { recursive: true });
  const vars = loadEnvFile(envPath);
  vars[key] = value;
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
}

function discoverKey(key: string, ...envPaths: string[]): string | null {
  if (process.env[key]) return process.env[key]!;
  for (const path of envPaths) {
    const vars = loadEnvFile(path);
    if (vars[key]) return vars[key]!;
  }
  const homeEnv = resolve(homedir(), ".env");
  if (existsSync(homeEnv)) {
    const vars = loadEnvFile(homeEnv);
    if (vars[key]) return vars[key]!;
  }
  return null;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

export function isSetupComplete(home: string): boolean {
  const settingsPath = resolve(home, "settings.json");
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return settings.setupComplete === true;
  } catch {
    return false;
  }
}

function markSetupComplete(home: string): void {
  const settingsPath = resolve(home, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {}
  settings.setupComplete = true;
  mkdirSync(home, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function chooseDefaultModel(home: string, provider?: string): void {
  const authPath = resolve(home, "auth.json");
  const settingsPath = resolve(home, "settings.json");

  let bestMatch: (typeof MODEL_PREFERENCES)[0] | null = null;

  if (provider) {
    bestMatch = MODEL_PREFERENCES.find((m) => m.provider === provider) ?? null;
  }

  if (!bestMatch) {
    try {
      const auth = AuthStorage.create(authPath);
      for (const pref of MODEL_PREFERENCES) {
        const cred = auth.get(pref.provider);
        if (cred) { bestMatch = pref; break; }
      }
    } catch {}
  }

  if (!bestMatch) {
    for (const pref of MODEL_PREFERENCES) {
      const envKeys: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        google: "GEMINI_API_KEY",
        xai: "XAI_API_KEY",
      };
      if (process.env[envKeys[pref.provider] ?? ""]) { bestMatch = pref; break; }
    }
  }

  if (!bestMatch) return;

  const [prov, ...rest] = bestMatch.spec.split("/");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {}
  settings.defaultProvider = prov;
  settings.defaultModel = rest.join("/");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  p.log.info(`Default model: ${bestMatch.spec} (${bestMatch.reason})`);
}

export function loadTorchEnv(home: string, appRoot: string): void {
  const torchEnv = resolve(home, ".env");
  const appEnv = resolve(appRoot, ".env");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "TWOCAPTCHA_API_KEY",
    "CAPMONSTER_API_KEY",
    "AGENTMAIL_API_KEY",
    "PROXY_HOST",
    "PROXY_PORT",
    "PROXY_USERNAME",
    "PROXY_PASSWORD",
    "TORCH_CAMOUFOX_ENDPOINT",
  ]) {
    if (process.env[key]) continue;
    const found = discoverKey(key, torchEnv, appEnv);
    if (found) process.env[key] = found;
  }
}

export async function runSetup(home: string, appRoot: string): Promise<boolean> {
  p.intro("\x1b[38;2;255;160;20mtorch setup\x1b[0m");

  const torchEnv = resolve(home, ".env");
  const appEnv = resolve(appRoot, ".env");
  const authPath = resolve(home, "auth.json");

  const discovered = discoverKey("ANTHROPIC_API_KEY", torchEnv, appEnv);
  if (discovered) {
    const use = await p.confirm({
      message: `Found Anthropic key (${maskKey(discovered)}) — use it?`,
      active: "yes",
      inactive: "no",
    });
    if (!p.isCancel(use) && use) {
      saveEnvVar(torchEnv, "ANTHROPIC_API_KEY", discovered);
      process.env.ANTHROPIC_API_KEY = discovered;
      try {
        AuthStorage.create(authPath).set("anthropic", { type: "api_key", key: discovered });
      } catch {}
      p.log.success("Anthropic key saved");
      chooseDefaultModel(home, "anthropic");
      await promptOptionalKeys(home, appRoot);
      markSetupComplete(home);
      p.outro("🔥 Ready to scrape");
      return true;
    }
  }

  const method = await p.select({
    message: "How do you want to authenticate?",
    options: [
      { value: "oauth", label: "OAuth login", hint: "Claude Pro / Max subscription" },
      { value: "apikey", label: "API key", hint: "Anthropic, OpenAI, Google, xAI" },
      { value: "skip", label: "Skip for now", hint: "configure later" },
    ],
  });

  if (p.isCancel(method) || method === "skip") {
    markSetupComplete(home);
    p.outro("Run \x1b[38;2;255;140;0mtorch setup\x1b[0m anytime to configure.");
    return false;
  }

  if (method === "oauth") {
    const auth = AuthStorage.create(authPath);
    let oauthProviders: Array<{ id: string; name?: string }> = [];
    try {
      oauthProviders = auth.getOAuthProviders() as Array<{ id: string; name?: string }>;
    } catch {}

    if (oauthProviders.length === 0) {
      p.log.warn("No OAuth providers available in this build. Use API key instead.");
      markSetupComplete(home);
      return false;
    }

    const providerId = await p.select({
      message: "Choose provider",
      options: oauthProviders.map((pr) => ({ value: pr.id, label: pr.name ?? pr.id })),
    });

    if (p.isCancel(providerId)) {
      markSetupComplete(home);
      return false;
    }

    const s = p.spinner();
    s.start("Waiting for login...");

    try {
      await auth.login(providerId as string, {
        onAuth: (info: { url: string; instructions?: string }) => {
          s.stop("Opening browser...");
          openUrl(info.url);
          p.log.info(`Auth URL: ${info.url}`);
          if (info.instructions) p.log.info(info.instructions);
        },
        onPrompt: async (prompt: { message: string; placeholder?: string }) => {
          const val = await p.text({ message: prompt.message, placeholder: prompt.placeholder });
          return p.isCancel(val) ? "" : val;
        },
        onProgress: (message: string) => {
          p.log.step(message);
        },
        onManualCodeInput: async () => {
          const val = await p.text({ message: "Paste the redirect URL or authorization code:" });
          return p.isCancel(val) ? "" : val;
        },
        signal: new AbortController().signal,
      });
      p.log.success("Login complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(`OAuth failed: ${msg}`);
      markSetupComplete(home);
      return false;
    }
  }

  if (method === "apikey") {
    const providers = [
      { value: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY" },
      { value: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" },
      { value: "google", label: "Google Gemini", envKey: "GEMINI_API_KEY" },
      { value: "xai", label: "xAI", envKey: "XAI_API_KEY" },
    ];

    const providerId = await p.select({
      message: "Choose provider",
      options: providers.map((pr) => ({ value: pr.value, label: pr.label })),
    });

    if (p.isCancel(providerId)) {
      markSetupComplete(home);
      return false;
    }

    const provider = providers.find((pr) => pr.value === providerId)!;

    const key = await p.text({
      message: `${provider.label} API key`,
      placeholder: "sk-...",
    });

    if (p.isCancel(key) || !key) {
      p.log.warn("No key provided.");
      markSetupComplete(home);
      return false;
    }

    try {
      AuthStorage.create(authPath).set(providerId as string, { type: "api_key", key: key as string });
    } catch {}
    saveEnvVar(torchEnv, provider.envKey, key as string);
    process.env[provider.envKey] = key as string;
    p.log.success(`${provider.label} key saved`);
  }

  chooseDefaultModel(home);
  await promptOptionalKeys(home, appRoot);
  markSetupComplete(home);
  p.outro("🔥 Ready to scrape");
  return true;
}

async function promptOptionalKeys(home: string, appRoot: string): Promise<void> {
  const torchEnv = resolve(home, ".env");
  const appEnv = resolve(appRoot, ".env");

  const addOptional = await p.confirm({
    message: "Set up optional scraping tools? (captcha solvers, proxies, email)",
    active: "yes",
    inactive: "skip",
    initialValue: false,
  });

  if (p.isCancel(addOptional) || !addOptional) return;

  const services = [
    { key: "TWOCAPTCHA_API_KEY", label: "2Captcha", purpose: "CAPTCHA solving ($1/1k solves)" },
    { key: "CAPMONSTER_API_KEY", label: "CapMonster", purpose: "cheaper CAPTCHA solving ($0.60/1k)" },
    { key: "AGENTMAIL_API_KEY", label: "AgentMail", purpose: "disposable email for gated signups" },
  ];

  for (const svc of services) {
    const existing = discoverKey(svc.key, torchEnv, appEnv);
    if (existing) {
      const use = await p.confirm({
        message: `Found ${svc.label} key (${maskKey(existing)}) — use for ${svc.purpose}?`,
        active: "yes",
        inactive: "no",
      });
      if (!p.isCancel(use) && use) {
        saveEnvVar(torchEnv, svc.key, existing);
        process.env[svc.key] = existing;
        p.log.success(`${svc.key} saved`);
      }
      continue;
    }

    const val = await p.text({
      message: `${svc.label} API key (${svc.purpose})`,
      placeholder: "paste key or press enter to skip",
    });
    if (!p.isCancel(val) && val) {
      saveEnvVar(torchEnv, svc.key, val as string);
      process.env[svc.key] = val as string;
      p.log.success(`${svc.key} saved`);
    }
  }

  const addProxy = await p.confirm({
    message: "Set up a residential proxy? (for sites that IP-ban)",
    active: "yes",
    inactive: "skip",
    initialValue: false,
  });

  if (!p.isCancel(addProxy) && addProxy) {
    const host = await p.text({ message: "Proxy host", placeholder: "pr.oxylabs.io" });
    const port = await p.text({ message: "Proxy port", placeholder: "7777" });
    const user = await p.text({ message: "Proxy username" });
    const pass = await p.text({ message: "Proxy password" });

    if (!p.isCancel(host) && host) saveEnvVar(torchEnv, "PROXY_HOST", host as string);
    if (!p.isCancel(port) && port) saveEnvVar(torchEnv, "PROXY_PORT", port as string);
    if (!p.isCancel(user) && user) saveEnvVar(torchEnv, "PROXY_USERNAME", user as string);
    if (!p.isCancel(pass) && pass) saveEnvVar(torchEnv, "PROXY_PASSWORD", pass as string);
    p.log.success("Proxy credentials saved");
  }
}
