---
name: homedepot
description: Proven scraping playbook for homedepot.com search results (/s/<query>). Akamai Bot Manager hard-blocks raw curl with HTTP 403 (AkamaiGHost), but a puppeteer connection to the user's real Chrome via TORCH_CHROME_ENDPOINT walks straight through with zero challenges — no stealth plugin, no proxy, no captcha. Products are server-rendered in the HTML as `[data-testid="product-pod"]` blocks (each pod appears twice in the DOM, dedupe by product ID). Activate for any homedepot.com /s/ search scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Home Depot (homedepot.com)

> Akamai-protected Next.js site. Curl is dead on arrival (403 AkamaiGHost). Real Chrome via `TORCH_CHROME_ENDPOINT` passes silently. Once inside, product data is fully server-rendered in HTML — cheerio parses it. No API replay needed.

## Detection

| Signal          | Value                                                         |
| --------------- | ------------------------------------------------------------- |
| CDN / WAF       | AkamaiGHost + Akamai Bot Manager (`bm_ss`, `bm_so`, `akavpau`) |
| Framework       | Next.js (React SSR, `#__NEXT_DATA__` present but minimal)     |
| Anti-bot        | Akamai sensor challenge — 403 on curl, silent pass in real Chrome |
| Auth            | Not required for search                                       |
| Store / geo     | Prices and stock are localized; uses signed-in store cookie    |

## Architecture

- `/s/<query>` is an SSR search results page. All 24 product tiles are present in the initial HTML.
- Each product tile is rendered **twice** in the DOM (likely mobile + desktop layout variants). Dedupe by product ID parsed from the `/p/.../<id>` href, or by the id itself. Expect `pods.length == 48` and `unique == 24`.
- `#__NEXT_DATA__` exists but is not needed — direct cheerio selectors on `[data-testid="product-pod"]` give everything.
- No XHR/API replay necessary. No need to scroll, click, or dismiss modals. Just `domcontentloaded` + `waitForSelector`.

## Strategy used

- **Phase 0 (curl)** — fails. `curl -sL https://www.homedepot.com/s/drill` → HTTP 403 `AkamaiGHost`, 2.3KB sensor challenge body. Do not waste time here.
- **Phase 1 (framework JSON)** — `__NEXT_DATA__` is present but the searchModel payload is not populated (SSR streams tiles as HTML, not JSON). Skip.
- **Phase 2 (browser)** — `puppeteer.connect({ browserURL: TORCH_CHROME_ENDPOINT })` → `page.goto(url, { waitUntil: "domcontentloaded" })` → `waitForSelector('[data-testid="product-pod"]')`. Passes with zero friction. **No stealth plugin needed** — it IS the user's Chrome.

## Stealth config that works

```js
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({
  browserURL: process.env.TORCH_CHROME_ENDPOINT, // e.g. http://127.0.0.1:9222
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('[data-testid="product-pod"]', { timeout: 30000 });
// IMPORTANT: disconnect, don't close — don't kill the user's Chrome
await page.close();
browser.disconnect();
```

Do **not** use `waitUntil: "networkidle2"` — the page never idles (telemetry beacons, tracking pixels). Times out at 45s+.

## Extraction

All selectors are under each `[data-testid="product-pod"]`:

| Field         | Selector                                                | Notes                                 |
| ------------- | ------------------------------------------------------- | ------------------------------------- |
| URL           | `a[href*="/p/"]` → `href`                               | prefix `https://www.homedepot.com`     |
| Product ID    | `(url.match(/\/(\d+)$/) \|\| [])[1]`                    | use for dedupe                        |
| Title         | `[data-testid="product-header"]`                        | contains invisible soft-hyphens (U+00AD) — strip if needed |
| Brand         | `[data-testid="attribute-brandname-inline"]`            |                                       |
| Model / label | `[data-testid="attribute-product-label"]`               |                                       |
| Image         | `[data-testid="product-image__wrapper"] img` → `src`    |                                       |
| Price block   | `[data-testid="price-simple"]`                          | regex out `$x.xx` for current + `Was $x.xx` |
| Rating        | `[data-testid="product-pod__ratings-link"]`             | text like `(4.6 / 11086)`             |
| Promo         | `[data-testid="promotion"]`                             | optional                              |
| Availability  | `[data-testid="pod-footer"]`                            | includes pickup/delivery strings      |

Price parsing:

```js
const priceText = $pod.find('[data-testid="price-simple"]').text();
const current = (priceText.match(/\$[\d,]+(?:\.\d{2})?/) || [])[0];
const was = (priceText.match(/Was\s*(\$[\d,]+(?:\.\d{2})?)/) || [])[1];
```

Rating parsing:

```js
const m = $pod.find('[data-testid="product-pod__ratings-link"]').text().match(/\(([\d.]+)\s*\/\s*(\d+)\)/);
const rating = m ? parseFloat(m[1]) : null;
const reviewCount = m ? parseInt(m[2], 10) : null;
```

## Anti-blocking summary

| Layer                 | Needed? | Notes                                              |
| --------------------- | ------- | -------------------------------------------------- |
| 1. User-Agent         | —       | real Chrome sets it                                |
| 2. Headers            | —       | real Chrome sets them                              |
| 3. Cookies / session  | ✅      | comes free from user's Chrome profile              |
| 4. Stealth plugin     | ❌      | not needed when connected to real Chrome          |
| 5. Headed Chromium    | ✅ (via TORCH_CHROME_ENDPOINT) | disposable Chromium would trip Akamai |
| 6. CAPTCHA solver     | ❌      | no captcha encountered                             |
| 7. Residential proxy  | ❌      | not needed                                         |
| 8. Mobile UA          | ❌      |                                                    |
| 9. Login              | ❌      |                                                    |

Summary: Akamai on Home Depot scores the TLS fingerprint + browsing history + cookies. A clean puppeteer Chromium with stealth *will* get 403'd. The user's real Chrome passes instantly.

## Data shape

```json
{
  "id": "204279858",
  "title": "DEWALT20V MAX Cordless 1/2 in. Drill/Driver, (2) 20V 1.3Ah Batteries, Charger and Bag",
  "brand": "DEWALT",
  "model": "20V MAX Cordless 1/2 in. Drill/Driver, (2) 20V 1.3Ah Batteries, Charger and Bag",
  "url": "https://www.homedepot.com/p/DEWALT-.../204279858",
  "image": "https://images.thdstatic.com/productImages/.../dewalt-power-drills-dcd771c2-64_600.jpg",
  "currentPrice": "$99.00",
  "wasPrice": "$179.00",
  "priceText": "Limit 5 per order$99.00Was $179.00 Save $80.00 (45%)",
  "rating": 4.6,
  "reviewCount": 11086,
  "promo": null,
  "availability": "Ship to Store: Free | PickupDelivery: Free | TomorrowAdd to Cart"
}
```

## Pagination / crawl architecture

- 24 products per page.
- Pagination via query string: `?Nao=<start>` where `start = (page - 1) * 24`. E.g. page 2 → `?Nao=24`, page 3 → `?Nao=48`.
- Full example: `https://www.homedepot.com/s/drill?Nao=24`
- Loop sequentially with a single `browser` instance; open a fresh `page` per iteration and `page.close()` after. Stop when a page yields 0 new unique IDs.
- Keep concurrency at 1 — Akamai is tolerant of real Chrome but parallel tabs look abnormal.
- Checkpoint `results` to disk between pages on long crawls.

## Gotchas & lessons

1. **Curl is pointless.** `AkamaiGHost` 403 is instant. Don't retry with fancier headers — Akamai is TLS-fingerprinting, not header-sniffing. Go straight to Phase 2.
2. **Each product pod appears twice.** `$('[data-testid="product-pod"]').length === 48` on a 24-product page. Dedupe by the numeric product ID at the tail of `/p/.../<id>`.
3. **Do not use `networkidle2`.** Telemetry keeps the network alive forever; navigation will time out. Use `domcontentloaded` + `waitForSelector('[data-testid="product-pod"]')`.
4. **Titles contain soft hyphens** (`\u00AD`) inserted for line-breaking. Strip with `.replace(/\u00AD/g, "")` if matching against other sources.
5. **Brand is its own field** (`attribute-brandname-inline`) — don't try to parse it out of the title. The title string starts with the brand concatenated with no space (`DEWALT20V MAX...`).
6. **Prices are localized** to the store set in the user's Chrome profile cookie. If the client cares about a specific store, set it in Chrome before scraping — there is no clean query-string override.
7. **`disconnect()` not `close()`.** `browser.close()` would kill the user's real Chrome. Always `await page.close(); browser.disconnect();` when using `TORCH_CHROME_ENDPOINT`.
8. **Pagination param is `Nao`** (Not `page`, not `offset`). `?Nao=24` = page 2.

## Reference implementation

Working scraper: `work/homedepot/scrape.js` in this repo. Run:

```bash
node work/homedepot/scrape.js "drill" 1     # query, maxPages
# → output/homedepot-drill.json  (24 items)
```
