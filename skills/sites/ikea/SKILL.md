---
name: ikea
description: Proven scraping playbook for ikea.com /cat/ category pages (PLP). Server-rendered HTML with 24 products per page embedded as `[data-testid="plp-product-card"]` blocks, each carrying `data-ref-id`, `data-product-name`, `data-price`, `data-currency` attributes — no JSON blob needed, cheerio parses them straight. Cloudflare fronts the site but does NOT block bare curl for HTML (200 OK, no challenge); however the CDN caches `?page=N` aggressively and can return page 1 content to anonymous curl even for `?page=2`. Fix: drive pagination through a real Chrome via the real Chrome debug port — it bypasses the stale CDN cache and each `?page=N` navigation returns its own SSR batch of 24. Activate for any ikea.com /cat/ URL.
metadata:
  author: torch
  version: "1.0.0"
---

# IKEA (ikea.com)

> IKEA PLPs are boring-good SSR HTML. Every product card is a fat `<div data-testid="plp-product-card">` with all the important fields inline on data-attributes. The only real trap is Cloudflare's edge cache: plain curl gets a 200 but serves identical page-1 HTML for every `?page=N` query, so pagination has to go through a real browser (or cache-busting headers Cloudflare currently ignores). Real Chrome via `127.0.0.1:9222` walks through cleanly with zero challenges — no stealth, no proxy, no captcha.

## Detection

| Signal       | Value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| CDN          | Cloudflare (`cf-ray`, `cf-cache-status: HIT`, `server: cloudflare`)   |
| Framework    | Custom SSR (Java/Node "oink" backend — see `cache-tag: prod-oink-*`)  |
| Anti-bot     | **None on HTML.** Cloudflare only challenges API calls / write paths. |
| Auth         | Not required for PLP, PDP, or category browse.                        |
| Cache quirk  | `?page=N` is cached but the cache KEY ignores the page param for anonymous curl — Chrome navigations resolve correctly. |
| robots.txt   | Allows /us/en/cat/ (confirmed via sitemap links on the page).          |
| Redirects    | Some category slugs 301 to canonical (e.g. `office-chairs-20652` → `desk-chairs-20652`). Follow `Location`. |

## Architecture

- Pure server-rendered HTML. No `__NEXT_DATA__`, no GraphQL replay needed.
- 24 products per `?page=N` (even if `totalCount` is smaller — last page shortcircuits).
- Total count is printed inline as `Showing 24 of 63 results` inside `.catalog-product-list__total-count`. Parse it once on page 1 to know how many pages to crawl.
- Each card has all scrape-worthy fields on data-attributes — no need to traverse children for id/name/price:

  ```html
  <div class="plp-mastercard plp-fragment-wrapper plp-fragment-wrapper--grid"
       data-ref-id="10601124"
       data-product-number="10601124"
       data-price="199.99"
       data-currency="USD"
       data-product-name="CENTERHALV"
       data-testid="plp-product-card">
    …
  </div>
  ```

- "Show more" button is a JS handler that navigates to `?page=2` — it is NOT an xhr/fragment call. There is no /api/ pagination endpoint to replay.
- Variant-color swatches each link to a sibling `/p/` URL; raw `/p/` URL counts will exceed product counts (a 24-card page can emit 60+ `/p/` hrefs). Always count by `[data-testid="plp-product-card"]` or `[data-ref-id]`, never by `/p/` URL.

## Strategy used

- **Phase 0 (curl)** — 200 OK, Cloudflare but no challenge, all page-1 data in raw HTML. ✅
- **Phase 1 (framework)** — no JSON blob. Data is on DOM data-attributes, so cheerio is the right tool.
- **Phase 2 (browser)** — needed ONLY for pagination, because Cloudflare serves stale page-1 HTML to curl for every `?page=N`. Real Chrome via `127.0.0.1:9222` resolves each page correctly on `page.goto`.

You can scrape page 1 with plain curl + cheerio in milliseconds. Only reach for a browser when you need pages 2+.

## Stealth config that works

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });
const page = await browser.newPage();
await page.setCacheEnabled(false);
// no stealth, no UA override, no extra headers — real Chrome walks through
```

Nothing else is required. On disconnect, always `browser.disconnect()` (never `.close()` — it would kill the user's Chrome).

## Extraction

```js
import * as cheerio from "cheerio";

function parseCards(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('[data-testid="plp-product-card"]').each((_, el) => {
    const $el = $(el);
    items.push({
      id: $el.attr("data-ref-id"),                    // e.g. "10601124" or "s19445469"
      name: $el.attr("data-product-name"),            // "CENTERHALV"
      typeName: $el.find(".plp-price-module__description").text().trim(), // "Office chair, black"
      price: parseFloat($el.attr("data-price")),
      currency: $el.attr("data-currency"),
      url: new URL(
        $el.find('a[href*="/p/"]').first().attr("href"),
        "https://www.ikea.com",
      ).toString(),
      image: $el.find("img").first().attr("src"),
      topSeller: $el.find(".plp-product-badge--top-seller").length > 0,
      variantCount: $el.find(".plp-product-variant").length,
    });
  });
  return items;
}

// total count (parse once from page 1)
const total = html.match(/Showing\s+\d+\s+of\s+(\d+)\s+results/)?.[1];
```

## Anti-blocking summary

| Layer              | Needed? | Notes                                                       |
| ------------------ | :-----: | ----------------------------------------------------------- |
| UA / headers       |    ❌    | Default Chrome UA is fine. Curl works with no headers.      |
| Cookies / session  |    ❌    | Not required.                                               |
| Stealth plugin     |    ❌    | Real Chrome already looks real.                             |
| Residential proxy  |    ❌    | IP not checked.                                             |
| CAPTCHA solver     |    ❌    | No challenge surfaced.                                      |
| Real Chrome connect|    ✅    | Needed only to bypass CF edge cache for `?page=2+`.         |
| API replay         |   N/A   | No public "next page" xhr exists — pagination is full-page. |

## Data shape

```json
{
  "id": "10601124",
  "name": "CENTERHALV",
  "typeName": "Office chair, black",
  "price": 199.99,
  "currency": "USD",
  "url": "https://www.ikea.com/us/en/p/centerhalv-office-chair-black-10601124/",
  "image": "https://www.ikea.com/us/en/images/products/centerhalv-office-chair-black__1408739_pe971989_s5.jpg?f=xxs",
  "topSeller": true,
  "variantCount": 0
}
```

## Pagination / crawl architecture

1. `GET <cat_url>` (curl or browser). Parse total count with the `Showing X of N results` regex.
2. `pages = Math.ceil(N / 24)`.
3. For each `p` from 1..pages, navigate `?page=p` in the real Chrome (`page.setCacheEnabled(false)`), `waitForSelector('[data-testid="plp-product-card"]')`, grab `page.content()`, run `parseCards(html)`.
4. Dedupe by `id` (Map) as you go — the last page often repeats some items from the previous page depending on inventory ordering.
5. Stop early when `collected.size >= totalCount` or when a page adds zero new items.

Concurrency: 1 tab is plenty (63 items / 3 pages = <10s end-to-end). Navigating in parallel adds no speed and risks cache weirdness.

## Gotchas & lessons

1. **CDN cache serves stale `?page=N` to curl.** Curl any `?page=2` URL and you'll get the same 24 products as page 1, with `cf-cache-status: HIT`. Cache-Control / Pragma headers are ignored. Only a real browser navigation returns distinct page content.
2. **Category slugs can 301.** `/cat/office-chairs-20652/` → `/cat/desk-chairs-20652/`. Always `-L` follow redirects. The numeric ID is the stable key.
3. **`/p/` URL counts ≠ product counts.** Color variants inside a single card emit extra `/p/` hrefs. Always count products via `[data-testid="plp-product-card"]` (or `[data-ref-id]`).
4. **Last page is short.** With 63 total items you'll see 24 / 24 / 16 across pages 1–3, not 24 / 24 / 24 / padding.
5. **Total count selector.** The text `Showing X of N results` lives in `.catalog-product-list__total-count`; also inside an embedded JSON island as `"totalCount":N` — either works, the regex is safer.
6. **Product IDs can start with `s`.** e.g. `s19445469` for package/set products. Don't assume all-numeric.
7. **No JSON API.** IKEA has nothing like Nike's `api.nike.com` or Target's `redsky`. Don't waste time hunting — the HTML IS the API.
8. **Don't `browser.close()` the user's Chrome.** When connected via `127.0.0.1:9222`, always `browser.disconnect()` in the finally block.
