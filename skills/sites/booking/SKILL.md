---
name: booking
description: Proven scraping playbook for booking.com searchresults.html pages. CloudFront-fronted JS challenge blocks bare curl (HTTP 202 with a script-only interstitial), but a real Chrome session via TORCH_CHROME_ENDPOINT walks through on first navigation — no captcha, no proxy, no login. Listings are rendered client-side into [data-testid="property-card"] cards; pagination uses a "Load more results" button after the first 25. Prices only populate when the URL carries checkin/checkout/group_adults params. Activate for any booking.com /searchresults.html scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Booking.com (booking.com)

> Hotel/stay search results on `/searchresults.html?ss=<destination>`. Real Chrome via `TORCH_CHROME_ENDPOINT` clears the CloudFront JS challenge on first nav. Cards are in the DOM (not the initial HTML), pagination is click-to-load-more, and **prices are absent unless dates are in the URL**.

## Detection

| Signal      | Value |
|-------------|-------|
| CDN         | CloudFront (`server: CloudFront`, `x-amz-cf-*`) |
| Framework   | Custom edge (MFE shell: `web-shell-header-mfe`, `web-shell-footer-mfe`) |
| Anti-bot    | CloudFront JS interstitial on bare curl (HTTP 202, ~8 KB, `reportChallengeError(...)` in script) |
| Auth        | Not required for search results |
| robots.txt  | Disallows many deep paths; `/searchresults.html` is allowed |

## Architecture

- `/searchresults.html?ss=<q>` returns a tiny shell + JS that hydrates into a React-ish SPA.
- The first paint server-renders **1 placeholder card**; the rest are injected client-side.
- Initial batch is 25 cards; more load via a "Load more results" button (batches of ~25).
- A sign-in modal sometimes pops up — dismiss with `[aria-label="Dismiss sign-in info."]`.
- Each card has a stable `data-testid="property-card"` wrapper with sub-testids for `title`, `title-link`, `distance`, `review-score`, `price-and-discounted-price`, `price-for-x-nights`, `recommended-units`, `address-link`.

## Strategy used

- **Phase 0 (curl):** ❌ HTTP 202 challenge page, no data.
- **Phase 1 (framework JSON):** ❌ no `__NEXT_DATA__`, no global payload blob worth parsing.
- **Phase 2 (browser):** ✅ `puppeteer.connect({ browserURL: process.env.TORCH_CHROME_ENDPOINT })` — zero challenges, cards render immediately. No stealth plugin required.

## Stealth config that works

```js
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: process.env.TORCH_CHROME_ENDPOINT });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
// IMPORTANT: disconnect, do not close
```

No extra headers, no UA spoofing, no stealth plugin.

## Must-do: add dates to the URL

Without `checkin`/`checkout`, the page loads but **no price testids render** (`price-and-discounted-price` is absent, and no currency spans appear in cards). Always build the URL as:

```js
const d1 = new Date(Date.now() + 14*864e5).toISOString().slice(0,10);
const d2 = new Date(Date.now() + 16*864e5).toISOString().slice(0,10);
const url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(dest)}`
          + `&checkin=${d1}&checkout=${d2}&group_adults=2&no_rooms=1`;
```

## Extraction

```js
import * as cheerio from "cheerio";
const $ = cheerio.load(await page.content());
const rows = [];
$('[data-testid="property-card"]').each((_, el) => {
  const c = $(el);
  rows.push({
    name: c.find('[data-testid="title"]').first().text().trim(),
    link: (c.find('a[data-testid="title-link"]').attr("href") || "").split("?")[0],
    distance: c.find('[data-testid="distance"]').first().text().trim(),
    reviewScore: c.find('[data-testid="review-score"]').first().text().replace(/\s+/g, " ").trim(),
    price: c.find('[data-testid="price-and-discounted-price"]').first().text().trim(),
    priceForXNights: c.find('[data-testid="price-for-x-nights"]').first().text().trim(),
    recommendedUnit: c.find('[data-testid="recommended-units"]').first().text().replace(/\s+/g, " ").trim(),
    image: c.find("img").first().attr("src"),
  });
});
```

Review-score text comes out like `"Scored 9.3 9.3Wonderful 24 reviews"` — split on `/Scored ([\d.]+).*?([\d,]+) reviews/` if you need structured numbers.

## Anti-blocking summary

| Layer | Needed? | Note |
|---|---|---|
| 1. UA / headers | ❌ | Real Chrome handles it |
| 2. Cookies / session | ❌ | None required |
| 3. puppeteer-extra-stealth | ❌ | Not used |
| 4. Real Chrome (`TORCH_CHROME_ENDPOINT`) | ✅ | The single thing that matters |
| 5. CAPTCHA solver | ❌ | Never seen one |
| 6. Residential proxy | ❌ | Direct connection fine |
| 7. Rate limiting | ❌ | 758 cards in one session, no throttle |
| 8. Session warming | ❌ | First nav clears challenge |
| 9. Fingerprint rotation | ❌ | N/A |

## Data shape

```json
{
  "name": "2Rooms Haneda",
  "distance": "8.6 miles from downtown",
  "reviewScore": "Scored 9.3 9.3Wonderful 24 reviews",
  "price": "$410",
  "priceForXNights": "2 nights, 2 adults",
  "recommendedUnit": "One-Bedroom Apartment — Entire apartment • 1 bedroom • 1 bathroom • 495 ft² — Free cancellation",
  "image": "https://cf.bstatic.com/xdata/images/hotel/square240/608420811.webp?...",
  "link": "https://www.booking.com/hotel/jp/2rooms-haneda.html"
}
```

## Pagination / crawl architecture

Booking uses a **"Load more results" button**, not numbered pages. The loop:

```js
let last = 0, stagnant = 0;
for (let i = 0; i < 80 && stagnant < 3; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 1200));
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(x => /load more/i.test(x.textContent || ""));
    if (b) { b.click(); return true; }
    return false;
  });
  if (clicked) await new Promise(r => setTimeout(r, 1600));
  const n = await page.$$eval('[data-testid="property-card"]', els => els.length);
  if (n === last) stagnant++; else { stagnant = 0; last = n; }
}
```

Booking caps search results around ~1000 for a city query. For Tokyo with a 2-night stay we got 758 cards in ~90s. For bigger totals, split by district/neighborhood filter in the URL.

## Gotchas & lessons

1. **Price testids only exist with dates in the URL.** No `checkin`/`checkout` → no `price-and-discounted-price` at all.
2. **Initial HTML has just 1 placeholder card** — cheerio on the raw response is useless; you must wait for `[data-testid="property-card"]` to populate in the live DOM.
3. **Sign-in modal** sometimes appears on nav. Dismiss with `[aria-label="Dismiss sign-in info."]` in a try/catch (non-fatal).
4. **"Load more results" is a `<button>`, not an anchor** — find it by text match, not by testid (none exists).
5. **CloudFront returns 202, not 403**, on bare curl. It's a JS challenge page disguised as success — always check content length and look for `reportChallengeError` if using curl directly.
6. `close()` vs `disconnect()`: always `browser.disconnect()` when using `TORCH_CHROME_ENDPOINT` or you will kill the user's Chrome.
7. Hard cap appears to be ~1000 results per query; split by `nflt=` neighborhood filters or by dates to expand coverage.
8. `review-score` text is triple-concatenated (`"Scored X.Y X.YLabel N reviews"`) — regex it out if you need structured fields.
