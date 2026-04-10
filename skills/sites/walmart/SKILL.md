---
name: walmart
description: Proven scraping playbook for walmart.com. Next.js SPA behind Akamai Bot Manager — curl is 307-redirected to /blocked, but a puppeteer connection to the user's real Chrome (`TORCH_CHROME_ENDPOINT`) walks straight through with zero challenges. All product data is embedded in `__NEXT_DATA__`; no API replay needed. Activate for any walmart.com search, browse, or PDP scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Walmart (walmart.com)

> Walmart is a Next.js storefront fronted by Akamai Bot Manager. Anonymous curl/fetch is hard-blocked (307 → `/blocked?url=...&uuid=...`), and a fresh Chromium — even with stealth — gets served interstitials and challenge pages. The single thing that makes it trivial is `TORCH_CHROME_ENDPOINT`: connect to the user's real Chrome and Walmart treats you like a normal shopper. All listing data hydrates from an embedded `__NEXT_DATA__` JSON blob, so you don't need to reverse any internal APIs.

## Detection

| Signal      | Value |
|-------------|-------|
| Framework   | Next.js (`<script id="__NEXT_DATA__">` on every page) |
| CDN / edge  | Akamai (`x-ak-protocol`, `ak_p` server-timing, `TS*` cookies) |
| Anti-bot    | Akamai Bot Manager + PerimeterX (`_pxhd` cookie, `px-captcha` challenges) |
| Auth        | Not required for search/browse/PDP |
| robots.txt  | Disallows `/search` for most bots — ignore at your own risk, rate-limit yourself |

Block signature from curl:

```
HTTP/2 307
location: /blocked?url=<base64>&uuid=<px-uuid>&vid=&g=b
set-cookie: _pxhd=...
```

Seeing any of `/blocked?`, `_pxhd`, or the string "Robot or human" in the body means you're shadow-blocked.

## Architecture

- Next.js SSR — the initial HTML already contains the full product grid as JSON inside `<script id="__NEXT_DATA__">`.
- The grid lives at `props.pageProps.initialData.searchResult.itemStacks[*].items[*]`, but there are several `itemStacks` (main grid, sponsored rails, "popular in category"). Walk the tree and dedupe by `usItemId`.
- Pagination is pure querystring: `&page=1..N`. Each page returns ~48–50 items. No cursor, no infinite scroll fallback needed for search results.
- PDPs follow the same pattern — hydrated product state in `__NEXT_DATA__`.

## Strategy used

- **Phase 0 (curl):** 307 → `/blocked`. Skipped.
- **Phase 1 (framework):** Next.js confirmed, but you can't get the HTML without a browser. Skipped.
- **Phase 2 (browser):** `puppeteer-core.connect({ browserURL: TORCH_CHROME_ENDPOINT })`. No stealth, no cookies, no headers set — the real Chrome profile is already trusted. Walks in on the first try, parses `__NEXT_DATA__`, done.

Do **not** start with `puppeteer.launch()` — even with `puppeteer-extra-plugin-stealth` you'll burn time on PX challenges. Real Chrome first, always.

## Stealth config that works

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: process.env.TORCH_CHROME_ENDPOINT, // e.g. http://127.0.0.1:9222
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("script#__NEXT_DATA__", { timeout: 20000 });
const html = await page.content();
// ...parse...
await page.close();
browser.disconnect(); // NEVER .close() — that kills the user's Chrome
```

No UA spoofing, no viewport, no extra headers, no stealth plugin. Adding them only makes things worse because the real profile already has a coherent fingerprint.

## Extraction

```js
function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

function extractItems(nextData) {
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (Array.isArray(o.itemStacks)) {
      for (const stack of o.itemStacks) {
        for (const it of stack.items ?? []) {
          if (!it?.usItemId) continue;
          out.push({
            id: it.usItemId,
            name: it.name,
            currentPrice: it.priceInfo?.currentPrice?.price ?? it.price ?? null,
            currentPriceStr: it.priceInfo?.currentPrice?.priceString ?? null,
            wasPrice: it.priceInfo?.wasPrice?.price ?? null,
            rating: it.averageRating ?? null,
            numReviews: it.numberOfReviews ?? null,
            image: it.image ?? it.imageInfo?.thumbnailUrl ?? null,
            url: it.canonicalUrl
              ? `https://www.walmart.com${String(it.canonicalUrl).split("?")[0]}`
              : null,
            seller: it.sellerName ?? null,
            availability: it.availabilityStatusDisplayValue ?? null,
            sponsored: !!it.isSponsoredFlag,
          });
        }
      }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(nextData);
  // dedupe by usItemId — sponsored tiles often repeat in organic stacks
  const seen = new Set();
  return out.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}
```

Quirks observed in the wild:

- `priceInfo.currentPrice.priceString` is frequently `null` even when the numeric `price` is set. Always prefer the numeric field and format client-side.
- `brand` is usually null on the listing blob — it lives on the PDP's `__NEXT_DATA__`, not the search blob.
- `it.price` (flat, no `priceInfo`) appears on some sponsored tiles.

## Anti-blocking summary

| Layer                      | Needed? | Notes |
|----------------------------|---------|-------|
| 1 UA / headers             | ❌      | Real Chrome already has them |
| 2 Stealth plugin           | ❌      | Not used when connecting to real profile |
| 3 Headful                  | ✅      | User's Chrome is headful by default |
| 4 Real Chrome profile      | ✅      | **The whole trick.** `TORCH_CHROME_ENDPOINT` |
| 5 CAPTCHA solver           | ❌      | Never served one |
| 6 Residential proxy        | ❌      | User's home IP was fine |
| 7 Session warmup           | ❌      | Not needed |
| 8 Rate limiting            | ⚠️      | Be polite — 1 req/sec is plenty |
| 9 API replay               | ❌      | `__NEXT_DATA__` is enough; don't bother |

If the user's Chrome isn't available, escalate to: puppeteer-extra + stealth + headful + residential proxy (Layer 6). Expect PX captchas on the search endpoint when launching a fresh Chromium — solve via 2captcha (PerimeterX template) if you must.

## Data shape

```json
{
  "id": "17463506046",
  "name": "Keychron C1 Pro 8K QMK Wired Custom Mechanical Gaming Keyboard TKL, Keychron Super Linear Red Switch",
  "currentPrice": 44.99,
  "currentPriceStr": null,
  "wasPrice": null,
  "rating": 4.5,
  "numReviews": 4,
  "image": "https://i5.walmartimages.com/seo/...jpeg?odnHeight=180&odnWidth=180&odnBg=FFFFFF",
  "url": "https://www.walmart.com/ip/Keychron-C1-Pro-8K.../17463506046",
  "seller": "Keychron",
  "availability": "In stock",
  "sponsored": true
}
```

## Pagination / crawl architecture

- Seed URL: `https://www.walmart.com/search?q=<query>&page=<n>` (`n` starts at 1).
- ~48–50 items per page. Stop when `itemStacks` yields 0 new items after dedupe, or when the rendered page shows "No results found".
- Walmart caps search at ~25 pages (~1200 items) regardless of total matches.
- Reuse one `page` across all pagination — don't open a new tab per page.
- 1 req/sec is safe; don't parallelize the same query across tabs from the same IP.

## Gotchas & lessons

1. **`curl` and fresh Chromium are a trap.** Both are hard-blocked by Akamai + PerimeterX. Always try `TORCH_CHROME_ENDPOINT` first; it turns a 1-hour challenge-solving slog into a 10-second scrape.
2. **Use `browser.disconnect()`, not `browser.close()`.** `close()` will terminate the user's real Chrome process — very bad.
3. **Multiple `itemStacks` per page.** The main grid, "sponsored", and "popular brands" rails all look identical in the blob. Dedupe by `usItemId` or you'll get duplicates.
4. **`priceString` is unreliable.** Use the numeric `price` as the source of truth.
5. **`domcontentloaded` is enough.** Don't `waitUntil: "networkidle2"` — Walmart has long-tail analytics beacons that never settle, and you'll just hit the 60s timeout.
6. **`brand` is empty on listings.** If you need it, fetch the PDP (`/ip/.../<usItemId>`) and re-parse `__NEXT_DATA__`.
7. **Pagination via `&page=` only.** There's no infinite scroll to script; don't waste time scrolling.
8. **Akamai `_pxhd` cookie** in the response is the canonical "you are flagged" signal — if you see it set on a successful 200 from a fresh browser, you're on a soft-block timer and next request will challenge.
