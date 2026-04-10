---
name: amazon
description: Proven scraping playbook for amazon.com search result pages (/s?k=...). CloudFront + CAPTCHA wall blocks bare curl with HTTP 503, but a real Chrome session via the real Chrome debug port walks right through — no stealth, no proxy, no captcha. HTML is server-rendered; cheerio parses 22 results per page with stable `[data-component-type="s-search-result"]` blocks. Activate for any amazon.com /s search URL.
metadata:
  author: torch
  version: "1.0.0"
---

# Amazon (amazon.com)

> Amazon search pages are server-rendered HTML behind CloudFront. The only real obstacle is IP/UA reputation on anonymous clients (curl → `HTTP/2 503` + `x-cache: Error from cloudfront`). Attaching to the user's real Chrome profile via `127.0.0.1:9222` defeats the bot wall on the first request — no stealth plugin, no proxy, no captcha solver required. From there it's pure cheerio on 22 `s-search-result` cards per page.

## Detection

| Signal       | Value |
|--------------|-------|
| CDN          | CloudFront (`via: 1.1 ...cloudfront.net`, `x-amz-cf-id`, `x-amz-cf-pop`) |
| Framework    | Server-rendered HTML (no SPA, no hydration payload needed) |
| Anti-bot     | CloudFront + Amazon bot wall. Bare `curl` with a fake UA → **HTTP 503**, `x-cache: Error from cloudfront`. Escalates to Robot Check / CAPTCHA page if you push harder from a clean IP. |
| Auth         | Not required for /s search pages. |
| robots.txt   | Disallows `/s?`, but Amazon doesn't enforce it in-band — just don't abuse it. |

## Architecture

- `/s?k=<query>&page=<n>` returns full HTML with 22 result cards per page, already populated (no client-side hydration needed for the fields we care about).
- Each card is wrapped in `div[data-component-type="s-search-result"]` with `data-asin="<ASIN>"`.
- Title lives in `h2 span` (text). Link is `h2 a[href]` (relative, may be an `/sspa/click?...url=...` redirect for sponsored slots).
- Price is `.a-price > .a-offscreen` → `"$83.59"`.
- Rating **and** review count are both encoded in the aria-label of the review link:
  `"Rated 4.5 out of 5 stars by 1,234 reviews. Go to review section."` — regex it out, don't trust the nested star spans (they render with inconsistent text).
- Image: `img.s-image[src]`.
- Sponsored flag: presence of `.puis-sponsored-label-text` / `.s-sponsored-label-text` inside the card.

## Strategy used

- **Phase 0 (curl)** — failed. `curl -A <chrome UA> https://www.amazon.com/s?k=...` → `HTTP/2 503` from CloudFront. Confirmed this is IP/UA reputation, not a missing header.
- **Phase 1 (framework)** — skipped. No Next.js `__NEXT_DATA__`, no clean JSON API on public search. The HTML is the API.
- **Phase 2 (browser)** — `puppeteer.connect({ browserURL: the real Chrome debug port })` to the user's real Chrome. First request loaded full results, no challenge, no captcha. Then `page.content()` → cheerio. **Do not** use a fresh Chromium + stealth here; it's a wasted escalation step on Amazon.

## Stealth config that works

None needed beyond real Chrome. The real-Chrome connect *is* the stealth:

```js
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
// no UA override, no extra headers, no stealth plugin
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
```

Always `browser.disconnect()` at the end — `close()` would kill the user's real Chrome.

## Extraction

```js
import * as cheerio from "cheerio";

await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 30000 });
// Lazy-loaded images — scroll once to materialize them
await page.evaluate(async () => {
  for (let y = 0; y < 10; y++) {
    window.scrollBy(0, 900);
    await new Promise(r => setTimeout(r, 150));
  }
});

const $ = cheerio.load(await page.content());
const rows = [];
$('[data-component-type="s-search-result"]').each((_, el) => {
  const $el = $(el);
  const asin = $el.attr("data-asin");
  if (!asin) return;

  const title = $el.find("h2 span").first().text().trim();
  if (!title) return;

  const href = $el.find("h2 a").attr("href");
  const link = href ? new URL(href, "https://www.amazon.com").toString() : null;

  const priceText = $el.find(".a-price > .a-offscreen").first().text().trim() || null;
  const price = priceText ? parseFloat(priceText.replace(/[^\d.]/g, "")) : null;

  // Rating + review count from aria-label: "Rated 4.5 out of 5 stars by 1,234 reviews..."
  const aria = $el.find('a[aria-label*="out of 5 stars"]').attr("aria-label") || "";
  const rating = (aria.match(/([\d.]+)\s*out of 5/) || [])[1];
  const reviews = (aria.match(/by\s+([\d,]+)\s+review/i) || [])[1];

  const image = $el.find("img.s-image").attr("src") || null;
  const sponsored = $el.find(".puis-sponsored-label-text, .s-sponsored-label-text").length > 0;

  rows.push({
    asin,
    title,
    link,
    price,
    priceText,
    rating: rating ? parseFloat(rating) : null,
    reviewCount: reviews ? parseInt(reviews.replace(/,/g, ""), 10) : null,
    image,
    sponsored,
  });
});
```

Expect ~22 result cards per page. Sponsored-slot `link` values are `/sspa/click?...url=<urlencoded /dp/ path>` redirects — keep them as-is or decode the `url=` param if you need the canonical `/dp/` link.

## Anti-blocking summary

| Layer | Needed? | Notes |
|-------|---------|-------|
| 1. Basic headers / UA | — | Irrelevant once you're on real Chrome. |
| 2. Cheerio + fetch    | ❌ | Blocked at CloudFront, HTTP 503. |
| 3. Puppeteer (fresh Chromium + stealth) | ❌ (not tried, but known to trip Robot Check on a clean IP) |
| 4. **Puppeteer.connect → real Chrome (the real Chrome debug port)** | ✅ | The winning move. One-shot. |
| 5. CAPTCHA solver | ❌ | Never saw a captcha in this run. |
| 6. Residential proxy | ❌ | Real Chrome's existing session on a home IP was enough. |

If you ever *do* land on Robot Check (e.g. after hammering from a datacenter IP): slow down, randomize page intervals to 2–5s, and as a last resort route through the proxy skill with a US residential exit. Don't bother with 2captcha unless you see an actual captcha form.

## Data shape

```json
{
  "asin": "B0F58SM5BT",
  "title": "Newmen GM325Pro Mechanical Keyboard,104 Keys Rainbow LED Backlit ...",
  "link": "https://www.amazon.com/Newmen-GM325Pro-Mechanical-Keyboard-Keyboards/dp/B0F58SM5BT/ref=sr_1_4?...",
  "price": 19.99,
  "priceText": "$19.99",
  "rating": 4.4,
  "reviewCount": 216,
  "image": "https://m.media-amazon.com/images/I/71+fs+2vzoL._AC_UY218_.jpg",
  "sponsored": false,
  "page": 1
}
```

## Pagination / crawl architecture

- Append `&page=<n>` (1-indexed) to the base `/s?k=...` URL. Amazon caps organic results around page 20 (~400 items).
- One page at a time on a single tab, 1–2 s sleep between pages. Parallelism is not worth the bot-scoring risk.
- Checkpoint per page: write `output/amazon.com.partial.json` after each page so a mid-run block doesn't lose work.
- For multi-query crawls, loop queries serially, reuse the same `page` object, and disconnect only at the end.

## Gotchas & lessons

1. **Bare `curl` returns `HTTP/2 503` with `x-cache: Error from cloudfront`** — this is CloudFront bot-wall, not a missing header. Don't waste time tuning `User-Agent` / `Accept-Language` / cookies on fetch. Go straight to real Chrome.
2. **Do not use `puppeteer.launch()` with stealth as a starting point** on Amazon. Clean Chromium profiles from datacenter IPs get the Robot Check page. Real Chrome via `127.0.0.1:9222` is the default.
3. **Always `browser.disconnect()`, never `close()`** when attached to the user's Chrome, or you'll kill their browser.
4. **Rating + review count are in the aria-label**, not in the visible star span text. The star span frequently renders empty under cheerio; the aria-label `"Rated X out of 5 stars by N reviews..."` is the reliable source.
5. **Sponsored links use `/sspa/click?...url=<encoded>`**. They still resolve to a real product, but if you want the canonical `/dp/<ASIN>` path, URL-decode the `url=` query param.
6. **Images are lazy-loaded** — scroll the page once (`window.scrollBy` loop) before reading HTML or ~half the `img.s-image` `src` values will be data-URIs / placeholders.
7. **Exactly 22 organic result cards per page** is the expected count. If you see <10, you're on a Robot Check / captcha page — check `page.title()` for `Robot Check` / `Sorry` and back off.
8. **robots.txt disallows `/s?`** — Amazon doesn't enforce it technically, but keep volume sane and add delays. Don't parallelize aggressively.
