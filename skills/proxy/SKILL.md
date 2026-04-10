---
name: proxy
description: Use authenticated residential, datacenter, or mobile proxies with Puppeteer to bypass IP-based rate limiting, geo-blocks, and bot-detection. Covers Bright Data, Oxylabs, Smartproxy, and generic proxy-chain usage. Use when getting 403/429 from the target's IP reputation system, when stealth/CAPTCHA solving alone isn't enough, or when you need geo-targeted exit nodes.
metadata:
  author: torch
  version: "1.0.0"
---

# Proxy integration

Proxies are anti-blocking Layer 7 — escalate to them when IP-based blocking is the problem (403/429 on your datacenter IP, rate limits hit fast, geo-blocked content). They don't help with browser fingerprinting or JavaScript challenges — combine with stealth mode (`/scrape` anti-blocking) and CAPTCHA solvers (`/2captcha`, `/capmonster`) as needed.

## When to use a proxy

| Symptom | Likely cause | Fix |
|---|---|---|
| 403 on first request | IP reputation (datacenter flagged) | Residential proxy |
| 429 after 5-20 requests | Rate limit per IP | Rotating residential, one IP per request |
| "Not available in your country" | Geo-block | Country-specific exit node |
| Instant Turnstile / JS challenge | Fingerprinting, NOT IP | Don't use proxy — use stealth + solver |
| CAPTCHA appears | Behavior detection | Solver, not proxy (see `/2captcha`) |

Residential proxies cost money — don't reach for them before trying headed stealth mode and cookie persistence.

## Proxy types

| Type | Cost | Trust level | Use case |
|---|---|---|---|
| **Datacenter** | $0.50-$2/GB | Low (easy to flag) | Low-protection sites, high throughput |
| **Residential** | $4-$10/GB | High (real ISP IPs) | Protected sites, default choice |
| **Mobile (4G/5G)** | $10-$20/GB | Highest (shared carrier IPs) | Extreme protection, Instagram, TikTok |
| **ISP / Static residential** | $1-$3/IP/mo | High, sticky | Authenticated sessions |

## Provider comparison (2026)

| Provider | Starting price | Network | Strengths |
|---|---|---|---|
| **Smartproxy** | $4.50/GB | Large | Best small-scale value, no minimum, simple API |
| **Bright Data** | $5.88/GB | 150M+ IPs | Largest network, ZIP-code targeting, enterprise compliance |
| **Oxylabs** | $6.98/GB | 175M+ IPs | Fastest (~0.4s response), 99.82% success rate, $300 minimum |
| **IPRoyal** | $1.75/GB | Smaller | Cheapest residential, pay-as-you-go |
| **Decodo** (ex-Smartproxy) | $3.50/GB | Mid | Best value for mid-scale |

Default recommendation for torch: **Smartproxy** (no minimum, Puppeteer-friendly) or **IPRoyal** (cheapest). Pick Bright Data only if you need enterprise features or ZIP-precise geo-targeting.

## Method 1: `--proxy-server` + `page.authenticate()`

The simplest approach. Works with all providers.

```js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

const [host, port] = process.env.PROXY_URL.split(":"); // e.g. "pr.oxylabs.io:7777"

const browser = await puppeteer.launch({
  headless: false,
  args: [
    `--proxy-server=http://${host}:${port}`,
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
  ],
});

const page = await browser.newPage();

await page.authenticate({
  username: process.env.PROXY_USERNAME,
  password: process.env.PROXY_PASSWORD,
});

await page.goto("https://ip.oxylabs.io"); // verify the exit IP
```

**Limitation**: `page.authenticate()` uses the HTTP `Proxy-Authorization` header, which some endpoints (WebSockets, HTTP/2 pushes) don't honor. For those cases, use Method 2.

## Method 2: `proxy-chain` (anonymize + no page.authenticate)

`proxy-chain` spawns a local proxy that adds auth headers to every upstream request — works with WebSockets, doesn't need `page.authenticate`, and handles HTTPS tunneling cleanly.

```bash
npm install proxy-chain
```

```js
import proxyChain from "proxy-chain";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

// Build upstream URL with embedded credentials
const upstream = `http://${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}@${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;

// anonymizeProxy returns a local URL like http://127.0.0.1:12345
const anonymized = await proxyChain.anonymizeProxy(upstream);

const browser = await puppeteer.launch({
  headless: false,
  args: [`--proxy-server=${anonymized}`, "--no-sandbox"],
});

// ... scrape ...

await browser.close();
await proxyChain.closeAnonymizedProxy(anonymized, true);
```

Use this method by default — it's more robust.

## Provider-specific endpoints

### Oxylabs Residential

```js
const browser = await puppeteer.launch({
  args: ['--proxy-server=pr.oxylabs.io:7777'],
});
await page.authenticate({ username: 'USERNAME', password: 'PASSWORD' });
```

**Country-specific**: `us-pr.oxylabs.io:10000` (US), `gb-pr.oxylabs.io:20000` (UK). Port `10001` gives a **sticky session** (same IP across requests).

**Sticky session syntax**: append `-sessid-RANDOMSTRING` to username: `customer-USERNAME-sessid-abc123`.

### Bright Data Residential

Zone-based endpoints:

```js
const username = 'brd-customer-hl_XXXXXXX-zone-residential';
const password = 'YOUR_ZONE_PASSWORD';

const browser = await puppeteer.launch({
  args: ['--proxy-server=http://brd.superproxy.io:22225'],
});
await page.authenticate({ username, password });
```

**Country targeting**: `brd-customer-xxx-zone-residential-country-us` in the username.
**Session sticky**: append `-session-abc123` to username.
**Bright Data also offers "Web Scraping Browser"** — a managed Chromium instance you connect to via `puppeteer.connect({ browserWSEndpoint })`. Comes with built-in unblocking. Use when you don't want to manage proxies yourself.

### Smartproxy (now Decodo) Residential

```js
const browser = await puppeteer.launch({
  args: ['--proxy-server=gate.smartproxy.com:7000'],
});
await page.authenticate({
  username: 'user-USERNAME-country-us',
  password: 'PASSWORD',
});
```

Rotating by default. For sticky: `user-USERNAME-country-us-sessionduration-10` (10-minute sessions).

### IPRoyal

```js
const browser = await puppeteer.launch({
  args: ['--proxy-server=geo.iproyal.com:12321'],
});
await page.authenticate({
  username: 'USERNAME',
  password: 'PASSWORD_country-us_session-abc123_lifetime-10m',
});
```

Password-encoded options for country/session/lifetime.

## Rotating vs sticky sessions

| Mode | Use for |
|---|---|
| **Rotating (fresh IP per request)** | Crawling public pages, list-style scraping, avoiding rate limits |
| **Sticky (same IP for N minutes)** | Authenticated scraping (logins, carts), multi-step flows, sites that fingerprint session continuity |

Most providers default to rotating. To force sticky, embed a session ID in the username — the exact syntax varies per provider (see above).

## Rotating across a proxy list yourself

If you have a list of proxies and want to rotate manually:

```js
const proxies = [
  "http://user:pass@proxy1.example.com:8080",
  "http://user:pass@proxy2.example.com:8080",
  "http://user:pass@proxy3.example.com:8080",
];

async function scrapeWithRotation(urls) {
  for (const [i, url] of urls.entries()) {
    const proxy = proxies[i % proxies.length];
    const anonymized = await proxyChain.anonymizeProxy(proxy);

    const browser = await puppeteer.launch({
      args: [`--proxy-server=${anonymized}`],
    });

    try {
      const page = await browser.newPage();
      await page.goto(url);
      // ... extract ...
    } finally {
      await browser.close();
      await proxyChain.closeAnonymizedProxy(anonymized, true);
    }
  }
}
```

**Rule**: one browser instance per proxy. Don't try to change proxy mid-browser — relaunch.

## Verifying the proxy works

Before running a full scrape, confirm the proxy is actually routing:

```js
await page.goto("https://ip.oxylabs.io"); // or https://api.ipify.org?format=json
const ip = await page.evaluate(() => document.body.innerText);
console.log(`Exit IP: ${ip}`);
```

If it's your home IP, the proxy isn't engaged — check the `--proxy-server` flag and credentials.

## Environment variables

Standard env var layout torch uses:

```
PROXY_HOST=pr.oxylabs.io
PROXY_PORT=7777
PROXY_USERNAME=customer-USERNAME
PROXY_PASSWORD=PASSWORD
```

For provider-specific extras:

```
PROXY_COUNTRY=us                 # optional geo target
PROXY_SESSION_ID=abc123          # optional sticky session ID
```

## Combining proxy + stealth + solver

Full anti-blocking stack for a hard site:

```js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import proxyChain from "proxy-chain";
import TwoCaptcha from "@2captcha/captcha-solver";

puppeteer.use(StealthPlugin());
const solver = new TwoCaptcha.Solver(process.env.TWOCAPTCHA_API_KEY);

const upstream = `http://${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}@${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
const anonymized = await proxyChain.anonymizeProxy(upstream);

const browser = await puppeteer.launch({
  headless: false,
  args: [
    `--proxy-server=${anonymized}`,
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
  ],
});

const page = await browser.newPage();
await page.goto(targetUrl, { waitUntil: "networkidle2" });

// Check for Turnstile, solve if present
const widget = await page.$('.cf-turnstile');
if (widget) {
  const sitekey = await page.$eval('.cf-turnstile', el => el.getAttribute('data-sitekey'));
  const { data: token } = await solver.cloudflareTurnstile({ pageurl: page.url(), sitekey });
  await page.evaluate((t) => {
    document.querySelector('input[name="cf-turnstile-response"]').value = t;
  }, token);
}

// Scrape...

await browser.close();
await proxyChain.closeAnonymizedProxy(anonymized, true);
```

## When NOT to use a proxy

- Simple public sites that respond fine to stealth + headed mode — don't burn GB
- When the block is a CAPTCHA, not an IP ban (proxies don't solve CAPTCHAs — see `/2captcha` or `/capmonster`)
- When the target uses client-side fingerprinting (canvas, WebGL, audio) — a proxy changes only your IP, not your fingerprint. Fix fingerprinting first via stealth plugin.
