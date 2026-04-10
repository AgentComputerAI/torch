---
name: etsy
description: Proven scraping playbook for etsy.com search result pages (/search?q=...). DataDome protects the HTML edge (bare curl gets HTTP 403 with `x-datadome: protected` and a JS captcha shell), but a puppeteer-core connection to the user's real Chrome via `TORCH_CHROME_ENDPOINT` walks through on first navigation — no 2Captcha, no proxy, no login needed. HTML is server-rendered; cheerio parses ~60 `div.listing-link[data-listing-id]` cards per page with stable selectors. Activate for any etsy.com /search target.
metadata:
  author: torch
  version: "1.0.0"
---

# Etsy (etsy.com)

> Etsy search is a server-rendered listing grid wrapped in a DataDome shield. The shield only enforces on naive clients — a real Chrome session clears it transparently. Once you have the HTML, parsing is trivial cheerio work against class-stable selectors.

## Detection

| Signal         | Value |
|----------------|-------|
| Server         | Fastly + Varnish (`via: 1.1 varnish`, `x-fastly-backend-reqs`) |
| Framework      | Server-rendered HTML (legacy Etsy stack, not Next.js) |
| Anti-bot       | **DataDome** (`x-datadome: protected`, `x-datadome-riskscore`, `datadome` cookie) |
| Curl result    | `HTTP/2 403` + ~800-byte captcha shell (`<title>etsy.com</title>` + `var dd={…}` JS blob) |
| Real-Chrome    | 200 OK, full HTML (~1.7 MB), no challenge — first navigation |
| robots.txt     | Disallows /search for most bots, but the playbook is a Chrome session, not a crawler pretending to be Googlebot |
| Auth required  | No (anonymous search works) |

## Architecture

- `/search?q=<query>` returns fully server-rendered HTML. No hydration-dependent JSON blob is needed.
- Each listing is a `<div class="listing-link …" data-listing-id="…" data-shop-id="…">` wrapper. ~60 per page (24 are rendered eagerly; a gentle scroll surfaces ~36 more lazy tiles).
- Inside each card:
  - `h3.v2-listing-card__title` — product title
  - `span.currency-symbol` + `span.currency-value` — price tokens (sale price is first pair, original price is second pair when discounted)
  - `span.wt-screen-reader-only` contains full-text `Sale Price $7.95` / `Original Price $15.90` — more reliable than glueing tokens
  - `span.wt-text-title-small` — numeric star rating (e.g. `4.8`)
  - `p.wt-text-body-smaller` — review count in parentheses (e.g. `(139.7k)`)
  - `span.clickable-shop-name` — shop name
  - `span.wt-text-grey` containing `% off` — discount label
  - `img` — thumbnail (300×300 `il_300x300.*.jpg` on etsystatic.com)
  - `clg-signal` — badge text: `Popular now`, `Bestseller`, etc.

## Strategy used

- **Phase 0 (curl)**: 403 + DataDome shell. Skip.
- **Phase 1 (framework)**: no Next.js / Nuxt blob; the HTML is the source of truth. Skip API replay.
- **Phase 2 (browser)**: puppeteer-core `connect({ browserURL: TORCH_CHROME_ENDPOINT })` → warm on `https://www.etsy.com/` for ~2.5s → `goto(searchUrl)` → DataDome passes instantly → scroll 0..6000px to trigger lazy cards → `page.content()` → cheerio parse.

No stealth plugin is necessary when attaching to the user's real Chrome — the profile already has history, cookies, and a trusted TLS fingerprint. **Do not `browser.close()`** — always `page.close() + browser.disconnect()` or you will kill the user's Chrome.

## Stealth config that works

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: process.env.TORCH_CHROME_ENDPOINT, // http://127.0.0.1:9222
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

// Warm session on homepage first — helps DataDome see a human flow
await page.goto("https://www.etsy.com/", { waitUntil: "domcontentloaded" });
await new Promise(r => setTimeout(r, 2500));

await page.goto("https://www.etsy.com/search?q=handmade+soap", {
  waitUntil: "domcontentloaded",
  timeout: 45000,
});

// Gentle scroll to load lazy tiles beyond the first ~24
await page.evaluate(async () => {
  for (let y = 0; y < 6000; y += 800) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 300));
  }
});
await new Promise(r => setTimeout(r, 1500));

const html = await page.content();
await page.close();
browser.disconnect();
```

## Extraction

Iterate `div.listing-link[data-listing-id]` — NOT `a[href*="/listing/"]`, because each card has 2 anchors (image + title) and `closest()` from an anchor can land on the wrong ancestor.

```js
import * as cheerio from "cheerio";
const $ = cheerio.load(html);
const items = [];

$('div.listing-link[data-listing-id]').each((_, el) => {
  const $card = $(el);
  const id = $card.attr('data-listing-id');
  const $a = $card.find('a[href*="/listing/"]').first();
  const url = ($a.attr('href') || '').split('?')[0];

  const title = $card.find('h3.v2-listing-card__title').first().text().trim()
             || ($a.attr('aria-label') || '').trim();

  // Price: prefer the screen-reader strings, fall back to currency tokens
  const srSale = $card.find('span.wt-screen-reader-only')
    .filter((_, e) => /Sale Price|Price:/i.test($(e).text()))
    .first().text();
  const srOrig = $card.find('span.wt-screen-reader-only')
    .filter((_, e) => /Original Price/i.test($(e).text()))
    .first().text();
  const sym = $card.find('span.currency-symbol').first().text() || '$';
  const vals = $card.find('span.currency-value').map((_, e) => $(e).text().trim()).get();
  const currencyRe = /([£$€¥₹])\s?([\d.,]+)/;
  const mSale = srSale.match(currencyRe);
  const mOrig = srOrig.match(currencyRe);
  const price = mSale ? mSale[1] + mSale[2] : (vals[0] ? sym + vals[0] : '');
  const original_price = mOrig ? mOrig[1] + mOrig[2] : (vals[1] ? sym + vals[1] : null);

  const rating  = $card.find('span.wt-text-title-small').first().text().trim() || null;
  const reviews = $card.find('p.wt-text-body-smaller').first().text().replace(/[()]/g, '').trim() || null;
  const shop    = $card.find('span.clickable-shop-name').first().text().trim();
  const discount = ($card.find('span.wt-text-grey').text().match(/\d+%\s*off/i) || [null])[0];

  const $img = $card.find('img').first();
  const image = $img.attr('src') || $img.attr('data-src') || '';

  items.push({ id, title, price, original_price, discount, rating, reviews, shop, url, image });
});
```

## Anti-blocking summary

| Layer | Needed? | Notes |
|-------|---------|-------|
| 1. User-Agent / headers | — | Chrome session supplies its own |
| 2. Cookies / session warmup | ✅ | Hit `etsy.com/` first, then search. DataDome seems to accept the flow without extra work |
| 3. puppeteer-extra stealth | ❌ | Not needed when using `TORCH_CHROME_ENDPOINT` — the real profile beats any stealth plugin |
| 4. Headed Chromium | ❌ (n/a) | N/A — we connect to the user's real Chrome |
| 5. 2Captcha / CapMonster | ❌ | DataDome never issues a visible challenge on the real-Chrome path |
| 6. Residential proxy | ❌ | User's residential IP is fine |
| 7. Rate limiting | Low | Space page loads ≥3s to be polite; Etsy didn't throttle a single-page test |
| 8. Fingerprint rotation | ❌ | Single real profile works |
| 9. Login | ❌ | Anonymous search is complete |

**One-liner: real Chrome connect > everything else for Etsy.** Fresh `puppeteer.launch()` with stealth trips DataDome in testing — don't bother as a fallback without a residential proxy.

## Data shape

```json
{
  "id": "827696193",
  "title": "Black Raspberry Vanilla Soap | Handmade, Cold Process, Palm-Free, All Natural, Vegan, Fruity Summer Scent",
  "price": "$7.95",
  "original_price": "$15.90",
  "discount": "50% off",
  "rating": "4.8",
  "reviews": "139.7k",
  "shop": "SeedGeeks",
  "url": "https://www.etsy.com/listing/827696193/black-raspberry-vanilla-soap-handmade",
  "image": "https://i.etsystatic.com/10162345/r/il/835b0b/2492371864/il_300x300.2492371864_f3x9.jpg"
}
```

~60 items per search page after scroll. `handmade+soap` returned 60/60 with title, 60/60 with price, 60/60 with shop, 59/60 with rating.

## Pagination / crawl architecture

- Pagination: append `&page=N` to the search URL. Etsy caps search results to page 250 (`&page=250`); deep pages may redirect.
- For multi-page crawls, run pages sequentially in the same Chrome session with a 3–5s delay. Keep `TORCH_CHROME_ENDPOINT` stable — don't reconnect per page.
- For category/browse pages (e.g. `/c/bath-and-beauty/soaps`), the same selectors apply — it's the same listing-card component.
- Checkpoint to disk after every page (`output/etsy-<slug>-page-N.json`) so partial runs aren't lost.

## Gotchas & lessons

1. **`a[href*="/listing/"]` is a trap** — each card has 2+ listing anchors. Iterate `div.listing-link[data-listing-id]` instead; `data-listing-id` is the stable key.
2. **The "Loading" spinner leaks into text extraction.** Early cards contain a `<div class="wt-spinner">Loading</div>` placeholder. If you extract `$a.text()` you'll get `"Loading Popular now"`. Use `h3.v2-listing-card__title` specifically.
3. **Prices have two `span.currency-value` nodes when discounted** (sale then original). Prefer the `span.wt-screen-reader-only` strings (`Sale Price $7.95`, `Original Price $15.90`) — they're unambiguous and locale-aware.
4. **Every card shows an `AdBy` tooltip button**, even non-promoted ones. Detecting "ad" via the `AdBy` substring gives false positives. Use the `span.wt-screen-reader-only` text `"Ad from shop …"` instead if you need that boolean.
5. **Reviews format is `(139.7k)`** — parenthesized and abbreviated (`1.2k`, `16.4k`, `139.7k`). Strip parens; parse `k`/`m` suffix yourself if you need an integer.
6. **DataDome's `x-datadome-riskscore` was 0.996 on curl** — a very hostile score. Stealth-launched Chromium will almost certainly also be blocked; do not waste time on it without a residential proxy.
7. **Never `browser.close()`** when you used `TORCH_CHROME_ENDPOINT`. It will terminate the user's entire Chrome. Always `page.close() + browser.disconnect()`.
8. **First ~24 cards render eagerly; the rest are lazy.** Scroll 0→6000px in 800px steps with 300ms between steps to materialize all 60 before `page.content()`.
