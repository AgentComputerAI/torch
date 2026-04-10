---
name: ebay
description: Proven scraping playbook for ebay.com search result pages (/sch/i.html?_nkw=...). eBay gates first requests with a "Pardon Our Interruption" splash challenge, but it clears automatically in a real Chrome session via TORCH_CHROME_ENDPOINT — no 2Captcha, no proxies, no login needed. Activate for any ebay.com /sch/ target.
metadata:
  author: torch
  version: "1.0.0"
---

# eBay (ebay.com)

> eBay search pages are server-rendered HTML behind a one-time JS splash challenge (`splashui/challenge`, "Pardon Our Interruption"). With `puppeteer.connect()` to the user's real Chrome the challenge auto-redirects in under a second and the `ul.srp-results` list is fully populated. No captcha, no proxies.

## Detection

| Signal | Value |
| --- | --- |
| Server | `ebay-proxy-server` |
| Challenge | 307 → `/splashui/challenge?ap=1&appName=orch&ru=...` (title: "Pardon Our Interruption...") |
| Framework | Marko-rendered SSR HTML + eBay RUM client JS |
| Anti-bot | Custom splash challenge (uzm* cookies, `_crefId` JOSE token) — clears on real Chrome automatically |
| Auth | Not required for search |
| robots.txt | `/sch/` allowed for anonymous crawling |

## Architecture

- URL template: `https://www.ebay.com/sch/i.html?_nkw=<query>`
- First anonymous hit returns 307 → splash challenge HTML; the JS on that page sets `__uzm*` cookies, POSTs a token, and redirects back to the original URL.
- Once cookies are set (which happens instantly in a real Chrome profile) the SRP is plain SSR HTML. All items are present on load — no infinite scroll — but images/below-the-fold cards are lazy-loaded, so scroll before extracting.
- Listing cards are `<li class="s-card">` inside `ul.srp-results`. Newer layout — the legacy `.s-item` selectors no longer exist on /sch/i.html (2026).

## Strategy used

- **Phase 0 (curl)** — blocked by splash challenge (`Pardon Our Interruption`). Skipped Phase 1.
- **Phase 2 (browser)** — `puppeteer.connect({ browserURL: process.env.TORCH_CHROME_ENDPOINT })` cleared the challenge in one redirect. Extraction is pure DOM scraping; no API replay needed.

## Stealth config that works

No stealth plugin needed when using the real Chrome profile. Minimal connect:

```js
const browser = await puppeteer.connect({ browserURL: process.env.TORCH_CHROME_ENDPOINT });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

// If first hit landed on the splash page, wait for the auto-redirect
if ((await page.title()).includes("Pardon")) {
  await page.waitForNavigation({ timeout: 30000 }).catch(() => {});
}
await page.waitForSelector("ul.srp-results > li.s-card", { timeout: 30000 });
```

Always `page.close()` + `browser.disconnect()` (NOT `close()`) in finally.

## Extraction

```js
// Scroll to force lazy-loaded cards to render
await page.evaluate(async () => {
  await new Promise((resolve) => {
    let y = 0;
    const step = () => {
      window.scrollBy(0, 900);
      y += 900;
      if (y >= document.body.scrollHeight - window.innerHeight + 100) return resolve();
      setTimeout(step, 120);
    };
    step();
  });
});
await new Promise((r) => setTimeout(r, 800));

const items = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("ul.srp-results > li.s-card")) {
    const a = el.querySelector("a.s-card__link, a[href*='/itm/']");
    const href = a?.href;
    if (!href) continue;
    const text = (sel) => el.querySelector(sel)?.textContent?.trim() || null;
    out.push({
      listingId: el.getAttribute("data-listingid"),
      title:
        text(".s-card__title .su-styled-text") ||
        text(".s-card__title") ||
        el.querySelector("img")?.alt,
      price: text(".s-card__price"),
      subtitle: text(".s-card__subtitle"), // "Pre-Owned · Nintendo Switch · ..."
      attributes: Array.from(el.querySelectorAll(".s-card__attribute-row"))
        .map((n) => n.textContent.trim())
        .filter(Boolean),
      url: href.split("?")[0], // strip tracking
      image: el.querySelector("img")?.getAttribute("src"),
    });
  }
  return out;
});
```

Typical SRP yields ~60 cards (ul.srp-results) per page. Pagination: append `&_pgn=<N>` to the search URL.

## Anti-blocking summary

| Layer | Needed? | Notes |
| --- | --- | --- |
| 1. User-Agent | n/a | Real Chrome supplies it |
| 2. Headers | n/a | Real Chrome supplies them |
| 3. Cookies | ✅ auto | Splash sets `__uzm*`, `dp1`, `__deba` — persisted by real Chrome |
| 4. Stealth plugin | ❌ | Not needed when using TORCH_CHROME_ENDPOINT |
| 5. CAPTCHA solve | ❌ | Splash is JS-only, no visible captcha |
| 6. Residential proxy | ❌ | US datacenter IP worked fine |
| 7. Rate limiting | light | Sleep ~250ms between pages when paginating |
| 8. Session rotation | ❌ | Single session handled full page |
| 9. Headed mode | ❌ | Real Chrome is already headed |

## Data shape

```json
{
  "listingId": "326945696823",
  "title": "Nintendo Switch OLED Model - White and Green Joycons with Charger - Great Used",
  "price": "$251.99",
  "subtitle": "Pre-Owned · Nintendo Switch · Nintendo Switch (OLED Model)",
  "attributes": [
    "$251.99$279.99",
    "Buy It Now",
    "+$11.99 delivery",
    "Located in United States",
    "11 watchers",
    "Extra 7% off with coupon",
    "cocosprinkles 99.9% positive (37.5K)"
  ],
  "url": "https://www.ebay.com/itm/326945696823",
  "image": "https://i.ebayimg.com/images/g/CD4AAeSwxlRpXoQK/s-l500.webp"
}
```

## Pagination / crawl architecture

- `&_pgn=2`, `&_pgn=3`, … iterate until a page yields fewer than ~50 cards or the "no results" sentinel appears.
- `&_ipg=240` raises items-per-page to 240 (eBay caps there) — prefer this over deep pagination.
- For multi-query crawls, reuse the same tab — the splash cookies amortize across all subsequent URLs.

## Gotchas & lessons

1. **Legacy `.s-item` selectors are dead (2026 layout)**. Everything is `.s-card` / `.s-card__*` now. Old scraping tutorials using `li.s-item` will silently return 0 results.
2. **Lazy rendering**: without a scroll pass, only the first ~2 cards are hydrated into the DOM you can query. Always scroll the page before `evaluate()`.
3. **Splash challenge** is a 307 to `/splashui/challenge?ap=1&appName=orch`. Title contains "Pardon Our Interruption". Real Chrome clears it in ~500ms; fresh Chromium + stealth works too but occasionally loops.
4. **Title in `.s-card__title`** is wrapped in a `<span class="su-styled-text primary default">` — target that inner span first, fall back to `img[alt]`.
5. **Tracking params** in `href` are massive (`itmmeta`, `hash`, `itmprp`, etc.). Strip with `href.split("?")[0]` to get the canonical `/itm/<id>` URL.
6. **First card is sometimes the "Shop on eBay" placeholder** on some queries — filter by `title === 'Shop on eBay'` if you see it.
7. Use `disconnect()`, never `close()`, when connected via TORCH_CHROME_ENDPOINT — `close()` would kill the user's real Chrome.
