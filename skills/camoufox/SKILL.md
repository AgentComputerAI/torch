---
name: camoufox
description: Use Camoufox — a Firefox fork with C++-level fingerprint spoofing — for browser scraping when the user's real Chrome profile is not available. Activate on VMs, headless CI servers, remote machines without a GUI, or when torch needs multiple concurrent personas with rotated fingerprints. Detects via TORCH_CAMOUFOX_ENDPOINT env var. Drives from Node via playwright-core connecting to a Camoufox-hosted Playwright server.
metadata:
  author: torch
  version: "1.0.0"
---

# Camoufox

Camoufox is a [Firefox fork](https://github.com/daijro/camoufox) where fingerprint spoofing happens at the **C++ engine level** — `navigator.*`, WebGL, Canvas, AudioContext, screen geometry are all rewritten before any JavaScript can inspect them. That makes it structurally more robust than puppeteer-stealth, which patches the same signals via JavaScript shims that anti-bot systems can detect.

For torch, Camoufox is the answer to **"my machine can't run the real-Chrome-clone strategy"** — VMs, headless servers, CI pipelines, remote boxes with no host Chrome. It's a strict fallback, not a replacement: when `TORCH_CHROME_ENDPOINT` is available (the user's real profile), that's still the better choice because it has real cookies, history, and browsing reputation that Camoufox's synthetic fingerprints cannot replicate.

## When to activate

Use this skill when:

- **Running on a VM or headless server** — no host Chrome to clone, no GUI to drive a headed browser, and `puppeteer.launch()` with stealth gets detected on hard sites
- **Running in CI** — same reasons
- **You need concurrent personas** — torch's cloned profile is a single identity; Camoufox's [BrowserForge](https://github.com/daijro/browserforge) fingerprint generator produces internally-consistent fresh personas on demand (5% Linux, 2560x1440 at 9.5%, Intel HD GPU at 27.5%, etc. matching real-world distributions)
- **The current toolchain is genuinely failing** — a site that real-Chrome-clone + stealth + solver + proxy still can't crack (rare, but happens — Interstitial, Kasada, Shape)

Do **not** use this skill when:

- The user has a real Chrome profile torch can clone (`TORCH_CHROME_ENDPOINT` is set) — real profile beats synthetic fingerprint for account-level reputation scoring
- The site tests specifically for Chrome/Chromium (some sites use V8-specific quirks that SpiderMonkey cannot spoof)
- You only need to scrape soft targets where vanilla stealth plugin already works

## Installation

Camoufox is Python-first. torch drives it from Node via the Playwright server mode.

```bash
# 1. Install the Python library
pip install camoufox[geoip]

# 2. Fetch the patched Firefox binary (~200 MB)
python -m camoufox fetch

# 3. Install the Node-side Playwright client
npm install playwright-core
```

On a VM image, bake these into the base image so torch runs don't pay the install cost.

## Launching as a Playwright server

Camoufox exposes a Playwright server so clients in any language can connect.

```bash
# Foreground (for debugging)
python -m camoufox server --port 4444 --host 127.0.0.1

# Detached (typical usage)
nohup python -m camoufox server --port 4444 --host 127.0.0.1 \
  > /tmp/camoufox.log 2>&1 &
```

Once running, set `TORCH_CAMOUFOX_ENDPOINT=ws://127.0.0.1:4444` in your `.env`. torch auto-detects this on startup and threads it into the scrape skill's strategy ladder.

## Driving from Node

Inside a scrape script, prefer this order:

```js
import { chromium, firefox } from "playwright-core";

async function launchBrowser() {
  // 1. Real user Chrome (best — real cookies, history, TLS reputation)
  if (process.env.TORCH_CHROME_ENDPOINT) {
    return {
      browser: await chromium.connectOverCDP(process.env.TORCH_CHROME_ENDPOINT),
      kind: "real-chrome",
      cleanup: async (b) => { await b.close(); }, // disconnect only — do not kill user Chrome
    };
  }

  // 2. Camoufox (fallback — C++ stealth, works on VMs)
  if (process.env.TORCH_CAMOUFOX_ENDPOINT) {
    return {
      browser: await firefox.connect(process.env.TORCH_CAMOUFOX_ENDPOINT),
      kind: "camoufox",
      cleanup: async (b) => { await b.close(); },
    };
  }

  // 3. Disposable Chromium with stealth plugin (last resort — usually blocked on hard sites)
  const puppeteer = (await import("puppeteer-extra")).default;
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
  puppeteer.use(StealthPlugin());
  return {
    browser: await puppeteer.launch({ headless: false }),
    kind: "stealth-chromium",
    cleanup: async (b) => { await b.close(); },
  };
}

const { browser, kind, cleanup } = await launchBrowser();
console.log(`[torch] using ${kind}`);

const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto(url, { waitUntil: "networkidle" });
  // ... extract ...
} finally {
  await cleanup(browser);
}
```

Key difference from puppeteer: Camoufox uses **Firefox's Juggler protocol, not CDP**. That's why the Node client is `firefox.connect()` from `playwright-core`, not `puppeteer.connect()`. torch ships with `puppeteer-core` by default; you install `playwright-core` on demand when Camoufox is actually being used.

## Fingerprint control

BrowserForge generates fresh personas on each launch. To pin a specific persona, pass a fingerprint:

```js
const browser = await firefox.connect({
  wsEndpoint: process.env.TORCH_CAMOUFOX_ENDPOINT,
  // Camoufox server also accepts fingerprint config via HTTP API before connecting
});
```

For persona rotation across a batch scrape, restart the Camoufox server between sessions — each launch regenerates. For simultaneous concurrent personas, run multiple Camoufox servers on different ports and point torch runs at each.

## What gets spoofed (C++ level, undetectable from JS)

- `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `navigator.platform`, `navigator.userAgent`
- WebGL vendor/renderer/extensions/parameters
- Canvas 2D / WebGL canvas fingerprint (true noise, not readbackHooked)
- AudioContext sampleRate / channelCount / dynamics
- Screen dimensions, color depth, pixel ratio
- WebRTC IP leak prevention
- Battery API, geolocation, timezone, locale — all internally consistent with the spoofed persona

The internal consistency is what kills detection. A Windows UA with an Apple M1 GPU is the classic tell that puppeteer-stealth users get flagged on; Camoufox's BrowserForge refuses to generate impossible combinations.

## Virtual display (fully headless)

Camoufox includes a built-in Xvfb-style virtual display buffer so it can run headfully on machines with no X server. No `xvfb-run` wrapper needed — just launch it normally on a headless server.

This is the killer feature for VM/CI usage. The "headless: false" requirement that puppeteer-stealth fails on is a non-issue with Camoufox.

## Limitations and gotchas

1. **Firefox only.** Some sites have Chrome-specific code paths or test for V8 engine quirks (`eval.toString()`, specific `Function.prototype` behavior). Camoufox can't pass these. If you see "this site requires Chrome" errors, real-Chrome-clone is the only option.
2. **Maintenance hiccup.** As of 2026, Camoufox had a ~year gap in active development before being picked back up. Performance degraded during that gap; check the upstream issues list before depending on it for production.
3. **No real profile history.** Camoufox personas are synthetic — no prior visits to the target, no saved cookies, no ad network IDs, no browsing reputation. For sites that weight account-level behavior, this is worse than real-Chrome-clone.
4. **Install cost.** pip + Python + 200 MB Firefox binary + playwright-core Node dep. Bake into base images for CI.
5. **Protocol differences.** Playwright APIs only. puppeteer-core code won't work against Camoufox. Any scrape skill that wants to be Camoufox-compatible has to be written with Playwright idioms.

## Related skills

- `scrape` — the main scraping workflow. Its "Phase 2 browser" section checks for `TORCH_CAMOUFOX_ENDPOINT` as the second-choice backend after `TORCH_CHROME_ENDPOINT`.
- `proxy` — combine Camoufox with residential proxies when even C++-level stealth isn't enough. Camoufox supports proxies natively via `--proxy` launch args or per-context config.
- `2captcha`, `capmonster` — Camoufox can hit captchas too (behavioral detection is orthogonal to fingerprinting). Same solver APIs apply.
