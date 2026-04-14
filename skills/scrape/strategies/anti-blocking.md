# Anti-blocking techniques

## Signs of being blocked

- HTTP 403/429 responses
- Cloudflare challenge pages (check for `cf-ray` header, challenge HTML)
- Cloudflare Turnstile spinner ("Verifying you are human")
- CAPTCHAs
- Empty responses or different content vs real browser
- Connection timeouts
- Redirects to login/verification pages

## Why fresh Chromium gets blocked immediately

A `puppeteer.launch()` instance is a throwaway Chromium with:

- **Zero browsing history** — no prior visits to the target, no "this user has bought from us before" signal
- **Zero cookies** — no existing session, no ad network IDs, no login state
- **Fresh TLS state** — no resumed sessions, no OCSP cache, no QUIC 0-RTT tickets
- **Missing Client Hints** — `Sec-CH-UA-*` headers don't match a real user's device history
- **Missing extensions** — real users have ad blockers, 1Password, etc.; none look suspicious
- **`--enable-automation` remnants** — stealth plugin patches most but not all of them (new leaks appear every Chrome release)

Modern bot scoring (Akamai Bot Manager, PerimeterX/HUMAN, DataDome, Kasada, Shape) weighs *behavioral reputation* and *account-level history* more than any single fingerprint. A fresh Chromium scores terribly on those regardless of how well you patch it.

A real Chrome tab on your laptop scores well on all of the above without any effort. The correct first move is to use that, not to fight an uphill battle with stealth patches.

## Escalation order

Work through these layers in order. Stop when unblocked.

### Layer 0: connect to the user's real Chrome (try first if available)

Torch clones the user's Chrome profile into `~/.torch/chrome-profile` (or `$TORCH_CHROME_PROFILE`) on first run, then exposes `TORCH_CHROME_BIN`, `TORCH_CHROME_PROFILE`, and `TORCH_CHROME_PORT` in the agent env. **Torch does not spawn Chrome itself** — the `torch` command never opens a browser window on startup. The first scrape that needs a browser launches it on demand against the cloned profile, then every subsequent scrape in the same session reuses that one debug-port Chrome via `puppeteer.connect`.

```js
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = process.env.TORCH_CHROME_PORT ?? "9222";
const BROWSER_URL = `http://127.0.0.1:${PORT}`;

async function getRealChrome() {
  // 1. Reuse an already-running torch Chrome on this port
  try {
    return await puppeteer.connect({ browserURL: BROWSER_URL });
  } catch {}

  // 2. Launch one on demand against the cloned profile
  const bin = process.env.TORCH_CHROME_BIN;
  const profile = process.env.TORCH_CHROME_PROFILE;
  if (!bin || !profile || !existsSync(bin) || !existsSync(profile)) {
    throw new Error("real-chrome unavailable — fall back to Camoufox or Layer 1");
  }
  const child = spawn(bin, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--restore-last-session=false",
  ], { stdio: "ignore", detached: true });
  child.unref();

  // 3. Poll the debug port until it answers
  for (let i = 0; i < 40; i++) {
    try { return await puppeteer.connect({ browserURL: BROWSER_URL }); } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("real-chrome failed to come up on " + BROWSER_URL);
}

const browser = await getRealChrome();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle2" });
// ... scrape ...
await page.close();
browser.disconnect();  // NEVER call browser.close() — that kills the on-demand Chrome
```

This uses a clone of the user's real browser profile — real cookies, real history, real TLS state, real Client Hints. Most bot scoring systems let it through without any escalation. Skip all subsequent layers if this works.

**Why on-demand instead of pre-launch**: a `torch` invocation that just does `torch --help` or one-shot scrapes a public JSON API should never pop a browser window. The cloned profile sits on disk doing nothing until the first scrape proves it actually needs Chrome.

**Limitations**:
- Requires `TORCH_CHROME_BIN` and `TORCH_CHROME_PROFILE` to be set (torch's CLI exports them automatically; if they're missing you're on a VM or fresh CI box).
- Not usable in CI / headless servers without a logged-in Chrome user — use Camoufox (`TORCH_CAMOUFOX_ENDPOINT`) or Layer 1 (fresh Chromium + stealth) there instead.

### Layer 1: headed mode + stealth (fallback when real Chrome not available)

`headless: false` alone bypasses most Cloudflare sites. Combine with stealth plugin:

```js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

const browser = await puppeteer.launch({
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1920,1080",
  ],
});
```

This is the most effective first step. `headless: false` runs a real Chrome instance. `--disable-blink-features=AutomationControlled` removes the main detection flag. Stealth plugin patches the rest (`navigator.webdriver`, `chrome.runtime`, WebGL, plugin/mime types).

Only fall back to `headless: true` if you need to run on a headless server.

Flags to AVOID (they're detectable): `--disable-extensions`, `--mute-audio`, `--disable-background-networking`

### Layer 2: realistic headers + randomized viewport

```js
await page.setExtraHTTPHeaders({
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Referer": "https://www.google.com/",
});

await page.setViewport({
  width: Math.floor(1024 + Math.random() * 400),
  height: Math.floor(768 + Math.random() * 300),
});

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
];
await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
```

Fixed viewport dimensions and missing headers are fingerprinting vectors.

### Layer 3: cookie/session persistence

Save cookies after a successful visit, restore on next run to appear as a returning visitor:

```js
import fs from "fs";

const cookieFile = "./output/.cookies-" + domain + ".json";
if (fs.existsSync(cookieFile)) {
  const saved = JSON.parse(fs.readFileSync(cookieFile, "utf8"));
  await page.setCookie(...saved);
}

await page.goto(url, { waitUntil: "networkidle2" });

const cookies = await page.cookies();
fs.writeFileSync(cookieFile, JSON.stringify(cookies));
```

### Layer 4: behavioral mimicry

- Add random delays between actions (1-3 seconds, not fixed intervals)
- Scroll gradually instead of jumping to elements
- Move mouse before clicking (not instant teleport)
- Type with variable speed (~40 WPM with random per-key delays)
- Add occasional idle pauses (micro-jitter ±3-8px)

### Layer 5: Cloudflare challenge handling

If Cloudflare challenge detected:

```js
await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => !document.title.includes("Just a moment"), { timeout: 30000 });
```

To detect Turnstile CAPTCHAs:

```js
const hasCaptcha = await page.$('iframe[src*="captcha"], iframe[src*="turnstile"]');
```

Turnstile analyzes mouse movements, behavior patterns, and advanced fingerprinting. Stealth mode alone cannot bypass it — the spinner will spin forever. Escalate to Layer 6 or 7.

### Layer 6: real Chrome profile via debug port

Launch your actual Chrome browser with remote debugging enabled, then connect Puppeteer to it. Zero automation flags — it's a real browser with your real profile, cookies, and logged-in sessions.

```js
// Step 1: launch Chrome manually or via spawn:
// /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//   --remote-debugging-port=9222 \
//   --user-data-dir="$HOME/Library/Application Support/Google/Chrome"

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
});

const page = await browser.newPage();
await page.goto(url);
```

This bypasses all fingerprinting because it IS the user's real browser. Existing auth cookies, extensions, history — all present. Use 3-5 second delays between pages to look like a real user.

### Layer 7: proxy rotation

When all else fails, rotate residential proxies per browser instance:

```js
const browser = await puppeteer.launch({
  headless: false,
  args: [
    "--proxy-server=http://proxyhost:port",
    "--disable-blink-features=AutomationControlled",
  ],
});

await page.authenticate({ username: "user", password: "pass" });
```

Use sticky sessions for authenticated scraping (keep same IP). Use fresh IPs for public page crawling. Relaunch the browser for each new proxy.

### Layer 8: resource blocking (optional, for speed)

Block non-essential resources to speed up scraping. Only use after anti-blocking is solved — some sites detect this.

```js
await page.setRequestInterception(true);
page.on("request", (req) => {
  const type = req.resourceType();
  if (["image", "stylesheet", "font", "media"].includes(type)) {
    req.abort();
  } else {
    req.continue();
  }
});
```

### Layer 9: interactive fallback

When all automated approaches fail (Turnstile, advanced bot detection):

1. Detect the block (page title contains "Verifying", Turnstile iframe present, spinner not resolving)
2. Open the URL in the user's default browser: `open "<url>"`
3. Ask the user to navigate to the page and paste the direct product URL
4. Fetch that direct URL — direct product pages often bypass protection that search/listing pages trigger
