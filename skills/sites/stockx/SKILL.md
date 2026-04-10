---
name: stockx
description: Proven scraping playbook for stockx.com listing pages (e.g. /sneakers/most-active, /sneakers/release-date, category leaderboards). Cloudflare hard-blocks bare curl with `cf-mitigated: challenge` + HTTP 403, but a puppeteer connection to the user's real Chrome via TORCH_CHROME_ENDPOINT walks straight through with zero challenges — no stealth plugin, no proxy, no captcha. Products are server-rendered as `[data-testid="productTile"]` blocks; `__NEXT_DATA__` exists but does NOT contain product data (hydrated client-side). Activate for any stockx.com listing scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# StockX (stockx.com)

> StockX is a Next.js SPA behind Cloudflare with aggressive bot scoring. Curl is rejected at L7 with a `cf-mitigated: challenge` header. But a real Chrome session (via `TORCH_CHROME_ENDPOINT`) is let straight through — no challenge page, no captcha, no IUAM interstitial. All product tiles are in the initial DOM after hydration and can be scraped with `page.evaluate()`. Don't bother with `__NEXT_DATA__` — on listing pages it only contains i18n and req metadata, not the product list.

## Detection

| Signal          | Value                                                         |
|-----------------|---------------------------------------------------------------|
| CDN             | Cloudflare (`server: cloudflare`, `cf-ray`)                   |
| Framework       | Next.js (has `__NEXT_DATA__`, `/_next/` assets, `buildId`)    |
| Anti-bot        | Cloudflare Bot Management (`cf-mitigated: challenge` on curl) |
| Curl status     | **HTTP 403** on every bare request                            |
| Real Chrome     | ✅ 200 OK, full HTML, no interstitial                          |
| Auth required   | No                                                            |
| Rate limit      | Not hit during normal scraping cadence                        |

## Architecture

- Next.js SSR + hydration. The server sends full HTML with `[data-testid="productTile"]` tiles for the first page of results.
- Listings like `/sneakers/most-active` return **40 tiles** with no pagination link and no lazy-load extension — that's the full leaderboard for this view.
- Paginated categories use `?page=N` but additional pages can hang intermittently on `networkidle2`; use `domcontentloaded` + `waitForSelector` instead.
- `__NEXT_DATA__` on listing pages contains only `{ req, _nextI18Next }` under `pageProps`. Not useful. Scrape the DOM.
- Product detail pages and the GraphQL endpoint (`/api/graphql`) are a separate story — this skill only covers listing tiles.

## Strategy used

- **Phase 0 (curl)**: 403 + `cf-mitigated: challenge`. Skip.
- **Phase 1 (framework)**: Next.js, but `__NEXT_DATA__` is empty of product data. Skip.
- **Phase 2 (browser)**: `puppeteer.connect({ browserURL: TORCH_CHROME_ENDPOINT })`. **Works on the first try with zero evasion**. Don't bother with the stealth plugin fallback — a disposable Chromium gets hard-blocked by Cloudflare here.

## Stealth config that works

None. Just connect to the user's real Chrome:

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: process.env.TORCH_CHROME_ENDPOINT,
});
const page = await browser.newPage();
await page.goto("https://stockx.com/sneakers/most-active", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForSelector('[data-testid="productTile"]', { timeout: 30000 });
// ... scrape ...
await page.close();
browser.disconnect();  // NEVER .close() — that kills the user's Chrome
```

Do **NOT** use `waitUntil: "networkidle2"` — StockX keeps long-lived connections open (analytics, websockets) and navigation will time out. `domcontentloaded` + explicit `waitForSelector` is fast and reliable.

## Extraction

Each tile:

```html
<div data-testid="productTile">
  <a data-testid="productTile-ProductSwitcherLink" href="/nahmias-x-marty-supreme-a24-track-pant-blue-black">
    <img alt="NAHMIAS x Marty Supreme A24 Track Pant Blue/Black" src="https://images.stockx.com/...">
    <p data-testid="product-tile-title">NAHMIAS x Marty Supreme A24 Track Pant Blue/Black</p>
    <p>Lowest Ask</p>
    <p data-testid="product-tile-lowest-ask-amount" aria-label="Lowest Ask $405">$405</p>
    <span class="css-pgrg7t">Xpress Ship</span> <!-- optional -->
  </a>
</div>
```

```js
const products = await page.evaluate(() => {
  const abs = (h) => (h && h.startsWith("/") ? "https://stockx.com" + h : h);
  return Array.from(document.querySelectorAll('[data-testid="productTile"]')).map((el, i) => {
    const link = el.querySelector('a[data-testid="productTile-ProductSwitcherLink"]');
    const img = el.querySelector("img");
    return {
      rank: i + 1,
      title: el.querySelector('[data-testid="product-tile-title"]')?.textContent?.trim() || null,
      url: abs(link?.getAttribute("href")),
      slug: link?.getAttribute("href")?.replace(/^\//, "") || null,
      lowestAsk: el.querySelector('[data-testid="product-tile-lowest-ask-amount"]')?.textContent?.trim() || null,
      lowestAskLabel: el.querySelector('[data-testid="product-tile-lowest-ask-amount"]')?.getAttribute("aria-label") || null,
      xpressShip: !!el.querySelector('span.css-pgrg7t'),
      image: img?.getAttribute("src") || null,
      alt: img?.getAttribute("alt") || null,
    };
  });
});
```

Selectors are `data-testid` based and have been stable through multiple StockX redesigns. The `css-*` class on the Xpress Ship span is emotion-generated and WILL rotate — rederive it from the tile HTML if extraction starts missing `xpressShip`.

## Anti-blocking summary

| Layer                          | Needed? | Notes                                                         |
|--------------------------------|---------|---------------------------------------------------------------|
| 1. User-Agent / headers        | ❌      | Irrelevant — curl is blocked regardless of UA                 |
| 2. Cookie/session              | ❌      | Real Chrome carries it                                        |
| 3. HTTP/2 fingerprint          | ❌      | Real Chrome                                                   |
| 4. TLS / JA3                   | ❌      | Real Chrome                                                   |
| 5. Stealth plugin (disposable) | ❌      | Don't bother — Cloudflare still blocks disposable Chromium    |
| 6. Real Chrome via CDP         | ✅      | **THE** fix. `TORCH_CHROME_ENDPOINT` walks through unchallenged |
| 7. Residential proxy           | ❌      | Not needed from a clean residential IP                        |
| 8. Captcha solver              | ❌      | No captcha appears                                            |
| 9. Human-in-the-loop           | ❌      | —                                                             |

## Data shape

```json
{
  "rank": 1,
  "title": "NAHMIAS x Marty Supreme A24 Track Pant Blue/Black",
  "url": "https://stockx.com/nahmias-x-marty-supreme-a24-track-pant-blue-black",
  "slug": "nahmias-x-marty-supreme-a24-track-pant-blue-black",
  "lowestAsk": "$405",
  "lowestAskLabel": "Lowest Ask $405",
  "xpressShip": true,
  "image": "https://images.stockx.com/images/NAHMIAS-x-Marty-Supreme-A24-Track-Pant-Blue-Black.jpg?fit=fill&bg=FFFFFF&w=140&h=75&q=60&dpr=1&trim=color&updated_at=1764010752",
  "alt": "NAHMIAS x Marty Supreme A24 Track Pant Blue/Black"
}
```

## Pagination / crawl architecture

- `/sneakers/most-active` is a **fixed 40-item leaderboard** — no `?page=2`. Don't waste a request chasing it.
- Other listings (`/sneakers`, `/sneakers/release-date`, brand pages) use `?page=N`. They hang on `waitUntil: "networkidle2"` — always use `domcontentloaded` + `waitForSelector`.
- Respect a ~1–2s delay between page loads to stay off Cloudflare's rate heuristics.
- Checkpoint per page to JSON so a mid-crawl block doesn't lose prior pages.

## Gotchas & lessons

1. **Curl is a dead end.** 403 + `cf-mitigated: challenge` no matter the headers. Don't iterate on it.
2. **`__NEXT_DATA__` is a red herring.** It exists (~300 KB) but on listing pages contains only i18n + req metadata, no products. Skip it and scrape the DOM.
3. **Never `browser.close()`** when connected via `TORCH_CHROME_ENDPOINT` — that kills the user's Chrome. Always `disconnect()`.
4. **`waitUntil: "networkidle2"` hangs.** Analytics/ws connections keep the network busy. Use `domcontentloaded` + `waitForSelector('[data-testid="productTile"]')`.
5. **Disposable Chromium + stealth does NOT work here.** Cloudflare scores it as a bot. Real Chrome is mandatory.
6. **Emotion CSS classes rotate.** The Xpress Ship flag currently uses `span.css-pgrg7t` — rederive from a live tile if it breaks. The `data-testid` attributes are stable; everything else is not.
7. **No `product-tile-secondary-text` on most tiles.** Don't rely on a secondary subtitle field — most categories don't render one.
