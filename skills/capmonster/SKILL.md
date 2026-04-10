---
name: capmonster
description: Solve CAPTCHAs using CapMonster Cloud — reCAPTCHA v2/v3, Cloudflare Turnstile (including cf_clearance cookies), GeeTest v3/v4, FunCaptcha, DataDome, AWS WAF, Imperva. AI-based solver, ~$0.60/1K reCAPTCHA (cheaper than 2Captcha), 10-30s latency. Use for cost-sensitive scraping or when 2Captcha fails. Requires CAPMONSTER_API_KEY env var.
metadata:
  author: torch
  version: "1.0.0"
---

# CapMonster Cloud

CapMonster Cloud is an AI-based CAPTCHA solver. Unlike 2Captcha (human workers), CapMonster uses trained models, which makes it faster (~10-30s) and cheaper (~$0.60/1K for reCAPTCHA v2) but slightly less reliable on novel challenge variants.

Use this skill when:

- You need to solve the same CAPTCHA types as 2Captcha, but want lower cost
- You're scraping at volume (>10K solves) where $0.40/1K savings matter
- You need `cf_clearance` cookies for Cloudflare Challenge pages (CapMonster has a dedicated task type for this)
- 2Captcha returns `ERROR_CAPTCHA_UNSOLVABLE` — try CapMonster as fallback

For the 2Captcha equivalent, see `2captcha`. The task shape is similar but the client API is different.

## Installation

Two npm packages exist. Prefer the **official** ZennoLab client:

```bash
# Official — maintained by capmonster.cloud
npm install @zennolab_com/capmonstercloud-client
```

```bash
# Community alternative — node-capmonster — only use if you need TypeScript types or features not in the official client
npm install node-capmonster
```

Examples below use the official client.

## Setup

```js
import {
  CapMonsterCloudClientFactory,
  ClientOptions,
} from "@zennolab_com/capmonstercloud-client";

const client = CapMonsterCloudClientFactory.Create(
  new ClientOptions({ clientKey: process.env.CAPMONSTER_API_KEY })
);
```

Read the key from `process.env.CAPMONSTER_API_KEY` — torch loads `.env` automatically.

## Check balance

```js
const balance = await client.getBalance();
console.log(`CapMonster balance: $${balance}`);
```

Pay-per-success billing: you're only charged for tasks that returned a valid token.

## Cloudflare Turnstile

### Simple Turnstile (no proxy)

```js
import { TurnstileRequest } from "@zennolab_com/capmonstercloud-client";

const req = new TurnstileRequest({
  websiteURL: "https://example.com/login",
  websiteKey: "0x4AAAAAAABUYP0XeMJF0xoy",
});

const res = await client.Solve(req);
const token = res.solution.token;

// Inject into the hidden field
await page.evaluate((t) => {
  document.querySelector('input[name="cf-turnstile-response"]').value = t;
}, token);
```

All Turnstile subtypes (manual, non-interactive, invisible) are auto-handled — don't specify subtype.

### Cloudflare Challenge → `cf_clearance` cookie

For the full-page "Verifying you are human" challenge (not just the widget), you need the `cf_clearance` cookie, which requires a proxy and the base64-encoded 403 HTML page:

```js
const req = new TurnstileRequest({
  websiteURL: "https://example.com",
  websiteKey: "0x4AAAAAAABUY0VLtOUMAHxE",
  cloudflareTaskType: "cf_clearance",
  proxyType: "http",
  proxyAddress: "your.proxy.host",
  proxyPort: 8080,
  proxyLogin: "user",
  proxyPassword: "pass",
  htmlPageBase64: Buffer.from(blockedHtml).toString("base64"),
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
});

const res = await client.Solve(req);
const cfClearance = res.solution.cf_clearance;

// Set the cookie on your Puppeteer context before retrying the request
await page.setCookie({
  name: "cf_clearance",
  value: cfClearance,
  domain: "example.com",
  path: "/",
});
```

**Critical**: the `userAgent` you send here must match the one Puppeteer uses when replaying with the cookie — Cloudflare binds `cf_clearance` to the exact UA string.

## reCAPTCHA v2

```js
import { RecaptchaV2Request } from "@zennolab_com/capmonstercloud-client";

const req = new RecaptchaV2Request({
  websiteURL: "https://example.com/form",
  websiteKey: "6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u",
});

const res = await client.Solve(req);
const token = res.solution.gRecaptchaResponse;

await page.evaluate((t) => {
  document.getElementById("g-recaptcha-response").innerHTML = t;
}, token);

await page.click('button[type="submit"]');
```

### reCAPTCHA v2 Invisible

Same request shape, add `isInvisible: true`:

```js
const req = new RecaptchaV2Request({
  websiteURL: "https://example.com",
  websiteKey: "6Lc...",
  isInvisible: true,
});
```

### reCAPTCHA v2 Enterprise

Use `RecaptchaV2EnterpriseRequest` and pass `enterprisePayload` if present in the page JS:

```js
import { RecaptchaV2EnterpriseRequest } from "@zennolab_com/capmonstercloud-client";

const req = new RecaptchaV2EnterpriseRequest({
  websiteURL: "https://example.com",
  websiteKey: "6Lc...",
  enterprisePayload: { s: "token-from-page" },
});
```

## reCAPTCHA v3

```js
import { RecaptchaV3ProxylessRequest } from "@zennolab_com/capmonstercloud-client";

const req = new RecaptchaV3ProxylessRequest({
  websiteURL: "https://example.com",
  websiteKey: "6Lc...",
  pageAction: "submit",
  minScore: 0.3,
});
```

## hCaptcha

```js
import { HCaptchaRequest } from "@zennolab_com/capmonstercloud-client";

const req = new HCaptchaRequest({
  websiteURL: "https://example.com",
  websiteKey: "10000000-ffff-ffff-ffff-000000000001",
});

const res = await client.Solve(req);
// res.solution.gRecaptchaResponse → same field name hCaptcha uses
```

## DataDome / Imperva / AWS WAF

CapMonster supports these as dedicated task types:

- `DataDomeRequest` — DataDome challenge, returns `datadome` cookie
- `AmazonTaskRequest` — AWS WAF captcha
- `ImpervaRequest` — Imperva/Incapsula

Pattern is identical: construct request, await `client.Solve(req)`, inject the returned cookie or token.

## Error handling

```js
import { CapmonsterError } from "@zennolab_com/capmonstercloud-client";

try {
  const res = await client.Solve(req);
  return res.solution.token;
} catch (err) {
  if (err instanceof CapmonsterError) {
    console.error(`CapMonster error ${err.errorCode}: ${err.errorDescription}`);

    if (err.errorCode === "ERROR_ZERO_BALANCE") {
      throw new Error("CapMonster balance empty");
    }
    if (err.errorCode === "ERROR_NO_SLOT_AVAILABLE") {
      // Queue full — back off and retry
      await new Promise((r) => setTimeout(r, 30000));
      return retry();
    }
  }
  throw err;
}
```

Common error codes:

| Code | Meaning |
|---|---|
| `ERROR_KEY_DOES_NOT_EXIST` | Invalid API key |
| `ERROR_ZERO_BALANCE` | Out of funds |
| `ERROR_NO_SLOT_AVAILABLE` | Worker pool exhausted |
| `ERROR_CAPTCHA_UNSOLVABLE` | Solver gave up after retries |
| `ERROR_PROXY_CONNECT_FAILED` | Bad proxy credentials for cf_clearance task |

## Puppeteer integration pattern

```js
async function solveTurnstileIfPresent(page, client) {
  const widget = await page.$('.cf-turnstile');
  if (!widget) return false;

  const sitekey = await page.$eval(
    '.cf-turnstile',
    (el) => el.getAttribute('data-sitekey')
  );

  console.log('Turnstile detected, solving via CapMonster...');
  const res = await client.Solve(
    new TurnstileRequest({ websiteURL: page.url(), websiteKey: sitekey })
  );

  await page.evaluate((t) => {
    document.querySelector('input[name="cf-turnstile-response"]').value = t;
  }, res.solution.token);

  return true;
}
```

## Costs (as of 2026)

| Captcha type | Price / 1000 solves |
|---|---|
| Image captcha | $0.30 |
| reCAPTCHA v2 | $0.60 |
| reCAPTCHA v3 | $1.20 |
| Turnstile | $1.00 |
| hCaptcha | $1.00 |
| cf_clearance | $2.50 |

Bonus program: up to 15% of balance refunded based on monthly volume.

## CapMonster vs 2Captcha — which to pick

| Factor | 2Captcha | CapMonster |
|---|---|---|
| reCAPTCHA v2 price | $1.00/1K | $0.60/1K |
| Solve time | 20-40s | 10-30s |
| Reliability on weird variants | Better (humans) | Worse (AI) |
| hCaptcha support | Dropped late 2025 | Fully supported |
| cf_clearance cookie | Not supported | Supported |

**Rule of thumb**: Try CapMonster first for volume. Fall back to 2Captcha if CapMonster returns `ERROR_CAPTCHA_UNSOLVABLE` twice in a row. For hCaptcha or `cf_clearance` cookies, use CapMonster directly.
