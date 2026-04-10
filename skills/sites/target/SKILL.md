---
name: target
description: Proven scraping playbook for target.com. Skip the browser entirely — replay the internal redsky.target.com plp_search_v2 endpoint directly with fetch. Public API, no cookies, no auth, no anti-bot (HumanSecurity/PerimeterX is only enforced on www.target.com HTML, not on redsky). Activate for any target.com search (/s?searchTerm=) or category (/c/) listing.
metadata:
  author: torch
  version: "1.0.0"
---

# Target (target.com)

> Target's public website (www.target.com) is a Next.js SPA wrapped in HumanSecurity (PerimeterX) bot scoring — a dead end for fetch. But the underlying data API, `redsky.target.com`, is **wide open**: no auth, no cookies, no anti-bot, just a static `key` query param. Replay `plp_search_v2` directly and you get full search/category listings with pagination metadata, 24 items per page, no browser needed.

## Detection

| Signal | Value |
|---|---|
| Framework | Next.js (top-of-funnel app) |
| CDN | Akamai + custom |
| Anti-bot (HTML) | HumanSecurity / PerimeterX (`PXGWPp4wUS`) |
| Anti-bot (API) | **None** |
| Auth required | No |
| robots.txt | Disallows `/s`, `/c/` for most crawlers — ignore, API is separate host |

## Architecture

- `www.target.com/s?searchTerm=X` is a Next.js page that client-hydrates product data from `redsky.target.com`.
- The API endpoint is `https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2`.
- It's a GraphQL-backed aggregation service exposed as a REST-ish GET. The full list of aggregation endpoints leaks in `window.__CONFIG__` on any target.com page (search `redsky_aggregations` in the HTML).
- The API key `9f36aeafbe60771e321a7cc95a78140772ab3e96` is hardcoded into the SPA config — it's the public `defaultServicesApiKey` and has been stable for years.

## Strategy used

- **Phase 0**: `curl https://www.target.com/s?searchTerm=headphones` returned the SPA shell with the full `window.__CONFIG__` JSON — extracted the redsky endpoint and apiKey from there.
- **Phase 1**: Hit `redsky.target.com/redsky_aggregations/v1/web/plp_search_v2` directly → clean JSON, zero blocking. **Skipped browser entirely.**
- **Phase 2**: Not needed.

## Endpoint

```
GET https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2
```

### Required query params

| Param | Value | Notes |
|---|---|---|
| `key` | `9f36aeafbe60771e321a7cc95a78140772ab3e96` | Hardcoded public key |
| `channel` | `WEB` | |
| `count` | `24` | Max items per page. 24 is the UI default; larger values appear to cap. |
| `offset` | `0` | Pagination: `(page - 1) * count` |
| `keyword` | `headphones` | Search term (for `/s`) |
| `page` | `/s/headphones` | Must match keyword; used for analytics |
| `platform` | `desktop` | |
| `pricing_store_id` | `2766` | Any valid store ID works. 2766 = SF Central. |
| `visitor_id` | `0000000000000000` | Can be zeros |
| `zip` | `94104` | Any US zip |
| `default_purchasability_filter` | `true` | |
| `include_sponsored` | `false` | **Set to false** — `true` triggers a sponsored-search backend error and returns HTTP 206 with errors (but data still comes through, so it also works). |

### Category pages

For `/c/<slug>/-/N-<id>`, swap `keyword` for `category` and use the N-id:

```
&category=5xtg5&page=%2Fc%2Fheadphones-audio-electronics%2F-%2FN-5xtg5
```

(Drop `keyword` in that case.)

## Stealth config that works

**None needed.** Plain fetch, any User-Agent. No cookies, no referer required (but sending `Origin: https://www.target.com` + `Referer: https://www.target.com/` is polite and defensive).

```js
const res = await fetch(url, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    Origin: "https://www.target.com",
    Referer: "https://www.target.com/",
    Accept: "application/json",
  },
});
```

## Extraction

Products live at `data.search.products` (NOT `data.search.search_response.products` — that key exists but is empty; easy gotcha). Metadata (`total_results`, `total_pages`, `current_page`) lives at `data.search.search_response.metadata`.

```js
const json = await res.json();
const products = json.data.search.products || [];
const meta = json.data.search.search_response.metadata;
// meta.total_results, meta.total_pages
```

### Per-product fields worth grabbing

```js
{
  tcin: p.tcin,
  title: p.item.product_description.title,
  brand: p.item.primary_brand?.name,
  url: p.item.enrichment.buy_url,
  image: p.item.enrichment.images.primary_image_url,
  current_price: p.price.current_retail,
  reg_price: p.price.reg_retail,
  formatted_price: p.price.formatted_current_price,
  rating: p.ratings_and_reviews?.statistics?.rating?.average,
  review_count: p.ratings_and_reviews?.statistics?.rating?.count,
}
```

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| 1. User-Agent | No | Any UA works |
| 2. Headers | No | Bare request works |
| 3. Cookies/session | No | |
| 4. Puppeteer stealth | No | No browser at all |
| 5. CAPTCHA solver | No | |
| 6. Residential proxy | No | Datacenter IPs fine |
| 7. Rate-limit backoff | Light | 250ms between pages is plenty |
| 8. Real Chrome profile | No | |
| 9. TLS fingerprint | No | Default Node fetch works |

## Data shape

```json
{
  "tcin": "91747218",
  "title": "Beats Solo 4 Bluetooth Wireless On-Ear Headphones - Cloud Pink",
  "brand": "Beats",
  "url": "https://www.target.com/p/beats-solo-4-bluetooth-wireless-on-ear-headphones-cloud-pink/-/A-91747218",
  "image": "https://target.scene7.com/is/image/Target/GUEST_6037f8a0-df3b-427f-806e-160d5a0ddb4f",
  "current_price": 129.99,
  "reg_price": 199.99,
  "formatted_price": "$129.99",
  "rating": 4.6,
  "review_count": 312
}
```

## Pagination

- Read `metadata.total_pages` from page 1, then loop `offset = (page - 1) * 24`.
- 624 results × 24/page = 26 pages, scraped serially in ~22s.
- For parallelism, 5-way concurrent is safe; haven't probed higher.

## Gotchas & lessons

1. **Products path is `data.search.products`, not `data.search.search_response.products`.** The latter is the same GraphQL node but products are hoisted one level up in the aggregation response. Walk the tree if in doubt.
2. **`include_sponsored=true` returns HTTP 206** with a `sponsored-search` backend error in `errors[]`, but `data.search.products` is still populated. Use `include_sponsored=false` for clean 200s.
3. **The API key is public and stable** — it's in `window.__CONFIG__.services.defaultServicesApiKey` on every target.com page. Rotate from there if it ever changes.
4. **`pricing_store_id` affects price/availability** — deals and in-store pickup vary by store. Use a consistent one if you care about reproducibility.
5. **www.target.com HTML is PerimeterX-protected** but you almost never need it. If you do (e.g. for PDP content not in the API), connect to real Chrome via `127.0.0.1:9222`. Disposable Chromium + stealth gets flagged fast.
6. **Category pages** use `category=<N-id>` instead of `keyword=`. The N-id is the last path segment of `/c/<slug>/-/N-xxxxx`.
7. **`count` > 24 doesn't help** — the backend seems to cap at 24 regardless of what you ask for.
