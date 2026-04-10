---
name: 2captcha
description: Solve CAPTCHAs using the 2Captcha API — reCAPTCHA v2/v3, Cloudflare Turnstile, hCaptcha, image captchas, Geetest, FunCaptcha. Use when a scraper hits a visible CAPTCHA that stealth/headed mode cannot bypass (Layer 5+ in anti-blocking escalation). Requires TWOCAPTCHA_API_KEY env var. Human-backed workers, ~$1/1000 solves, 20-40s latency.
metadata:
  author: torch
  version: "1.0.0"
---

# 2Captcha

2Captcha is a human-backed CAPTCHA solving service. You send it a captcha challenge (usually just a `pageurl` + `sitekey`), it returns a token ~20-40s later, and you inject that token into the target page to bypass the captcha.

Use this skill when:

- Stealth mode + headed Chrome fail against Cloudflare Turnstile
- reCAPTCHA v2 / v3 blocks the flow
- hCaptcha, Geetest, FunCaptcha appear on signup/login pages
- You need image-text OCR fallback

For cheaper pricing (~$0.60/1K vs $1.00/1K) and faster solves, also check `capmonster` — the APIs are similar enough to swap providers.

## Installation

```bash
npm install @2captcha/captcha-solver
```

## Setup

```js
import TwoCaptcha from "@2captcha/captcha-solver";

// Default polling interval: 5000ms
const solver = new TwoCaptcha.Solver(process.env.TWOCAPTCHA_API_KEY);

// Or with custom polling (seconds)
const solver = new TwoCaptcha.Solver(process.env.TWOCAPTCHA_API_KEY, 10);
```

Always read the key from `process.env.TWOCAPTCHA_API_KEY` — never hardcode it. Torch loads `.env` from the repo root automatically.

## Check balance

Do this first in development to confirm your key works and you have funds:

```js
const balance = await solver.balance();
console.log(`2Captcha balance: $${balance}`);
```

2Captcha charges only for successful solves, but verify balance before starting large scrapes.

## Finding the sitekey

The sitekey is a public identifier the target site passes to the CAPTCHA provider. Find it before calling the solver:

| Captcha type | Where the sitekey lives |
|---|---|
| reCAPTCHA v2 | `<div class="g-recaptcha" data-sitekey="...">` or `iframe[src*="recaptcha"]` URL |
| reCAPTCHA v3 | `grecaptcha.execute('SITEKEY', ...)` in page JS |
| Turnstile | `<div class="cf-turnstile" data-sitekey="0x4AAA...">` or `iframe[src*="turnstile"]` |
| hCaptcha | `<div class="h-captcha" data-sitekey="...">` |

Extract it from Puppeteer:

```js
const sitekey = await page.$eval(
  '.g-recaptcha, .cf-turnstile, .h-captcha',
  (el) => el.getAttribute('data-sitekey')
);
```

## Cloudflare Turnstile

```js
const res = await solver.cloudflareTurnstile({
  pageurl: "https://example.com/login",
  sitekey: "0x4AAAAAAAAkg0s3VIOD10y4",
});

// res.data is the solved token
// Inject it into the hidden input the page reads on submit
await page.evaluate((token) => {
  document.querySelector('input[name="cf-turnstile-response"]').value = token;
}, res.data);
```

For invisible Turnstile (no checkbox), dispatch the callback the site registered:

```js
await page.evaluate((token) => {
  window.turnstile.callback?.(token);
}, res.data);
```

## reCAPTCHA v2

```js
const res = await solver.recaptcha({
  pageurl: "https://example.com/form",
  googlekey: "6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u",
});

// Inject the token into the hidden textarea
await page.evaluate((token) => {
  document.getElementById("g-recaptcha-response").innerHTML = token;
}, res.data);

// Submit the form
await page.click('button[type="submit"]');
```

For invisible reCAPTCHA (no checkbox), the site registers a callback. Call it manually:

```js
await page.evaluate((token) => {
  ___grecaptcha_cfg.clients[0].L.L.callback(token);
}, res.data);
```

The exact callback path varies per site — inspect `window.___grecaptcha_cfg` in devtools to find it.

## reCAPTCHA v3

reCAPTCHA v3 is score-based and action-aware. Pass the action name:

```js
const res = await solver.recaptcha({
  pageurl: "https://example.com",
  googlekey: "6Le...",
  version: "v3",
  action: "submit",
  min_score: 0.3,
});
```

Use the returned token in the `g-recaptcha-response` field of the form submission.

## hCaptcha

```js
const res = await solver.hcaptcha({
  pageurl: "https://example.com",
  sitekey: "10000000-ffff-ffff-ffff-000000000001",
});

await page.evaluate((token) => {
  document.querySelector('[name="h-captcha-response"]').value = token;
  document.querySelector('[name="g-recaptcha-response"]').value = token;
}, res.data);
```

## Image / text captcha

Base64-encode the image and send it:

```js
import fs from "node:fs";

const base64 = fs.readFileSync("./captcha.png").toString("base64");
const res = await solver.imageCaptcha({ body: base64 });
await page.type('input[name="captcha"]', res.data);
```

Or capture it from a live page:

```js
const el = await page.$('img.captcha');
const base64 = await el.screenshot({ encoding: "base64" });
const res = await solver.imageCaptcha({ body: base64 });
```

## Error handling

```js
try {
  const res = await solver.cloudflareTurnstile({ pageurl, sitekey });
  return res.data;
} catch (err) {
  if (err.message.includes("ERROR_ZERO_BALANCE")) {
    throw new Error("2Captcha balance empty — top up at 2captcha.com");
  }
  if (err.message.includes("ERROR_CAPTCHA_UNSOLVABLE")) {
    // Captcha workers couldn't solve it — try CapMonster or change approach
    return null;
  }
  throw err;
}
```

Common error codes:

| Code | Meaning | Action |
|---|---|---|
| `ERROR_ZERO_BALANCE` | Out of funds | Top up |
| `ERROR_WRONG_USER_KEY` | Invalid API key | Check TWOCAPTCHA_API_KEY |
| `ERROR_CAPTCHA_UNSOLVABLE` | Workers gave up after retries | Try capmonster or retry |
| `ERROR_NO_SLOT_AVAILABLE` | Queue full, try again | Wait 30s and retry |
| `CAPCHA_NOT_READY` | Still solving — solver handles this | (never reaches your code) |

## Puppeteer integration pattern

Wrap the whole flow in a helper:

```js
async function solveTurnstileIfPresent(page, solver) {
  const el = await page.$('.cf-turnstile, iframe[src*="turnstile"]');
  if (!el) return false;

  const sitekey = await page.$eval(
    '.cf-turnstile',
    (el) => el.getAttribute('data-sitekey')
  );

  console.log('Turnstile detected, solving via 2Captcha...');
  const res = await solver.cloudflareTurnstile({
    pageurl: page.url(),
    sitekey,
  });

  await page.evaluate((token) => {
    document.querySelector('input[name="cf-turnstile-response"]').value = token;
  }, res.data);

  return true;
}

// Usage in scraper:
await page.goto(url);
await solveTurnstileIfPresent(page, solver);
await page.click('button[type="submit"]');
```

## Costs (as of 2026)

| Captcha type | Price / 1000 solves |
|---|---|
| Image captcha | $0.50 |
| reCAPTCHA v2 | $1.00 |
| reCAPTCHA v3 | $2.00 |
| hCaptcha | $1.50 |
| Turnstile | $1.50 |
| FunCaptcha | $3.00 |

Tokens expire ~2 minutes after issue — use them immediately, don't cache.

## When NOT to use 2Captcha

- If plain stealth + headed mode works, skip the solver (don't pay for something you don't need)
- For sites using JavaScript-only fingerprinting (no CAPTCHA widget), a solver doesn't help — escalate to real Chrome via debug port (Layer 6) or residential proxies (Layer 7, see `proxy`)
- For hCaptcha specifically, 2Captcha accuracy dropped in late 2025 — prefer CapMonster or CapSolver
