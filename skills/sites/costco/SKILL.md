---
name: costco
description: Proven scraping playbook for costco.com category listings (e.g. /laptops.html, /computers.html). Akamai Bot Manager hard-blocks bare curl with HTTP 403 on the HTML pages, but Costco's internal catalog API at gdx-api.costco.com/catalog/search/api/v1/search is a public JSON POST endpoint with no auth, no cookies, and no anti-bot. Skip the browser entirely. Activate for any costco.com category listing scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Costco (costco.com)

> Costco's category HTML pages (`/laptops.html`, `/computers.html`, etc.) sit behind Akamai Bot Manager and return 403 to anything that doesn't look like a fully-warmed browser. The actual product grid is rendered client-side by a Next.js app at `/consumer-web/search/prd/catalog-usbc/` that POSTs to a backend search API. That backend API is public — no cookies, no tokens, no bot manager — so the correct strategy is to replay it directly with `fetch` and ignore the HTML page entirely.

## Detection

| Signal | Value |
|---|---|
| CDN / WAF | Akamai (`server: AkamaiGHost`, `bm_ss`/`bm_s`/`akavpau_*` cookies) |
| Frontend | Next.js SPA at `/consumer-web/search/prd/catalog-usbc/` |
| Bare curl on HTML | **403 Forbidden** (384-byte Akamai challenge body) |
| Real Chrome (`TORCH_CHROME_ENDPOINT`) on HTML | 200, but product DOM is empty until hydration |
| Backend API | `https://gdx-api.costco.com/catalog/search/api/v1/search` (POST) |
| API auth | **None** — no cookies, no tokens |
| API bot manager | **None** — plain `fetch` with a UA and 3 client headers works |

## Architecture

1. `GET /laptops.html` returns an Akamai-protected Next.js shell. The DOM has zero product tiles at `domcontentloaded`.
2. The shell hydrates and fires a single `POST https://gdx-api.costco.com/catalog/search/api/v1/search` with a JSON body containing `filterBy: ["attributes.category_uri: ANY(\"laptops\")"]` and `pageCategories: ["laptops"]`.
3. The response is a full search result with `searchResult.results[]` (each containing `product`, `variantRollupValues`, `rating`) plus facets and pagination (`totalSize`, `nextPageToken`).
4. Individual tile hydration additionally fires per-item `gdx-api.costco.com/catalog/product/product-api/v1/products/summary?items=...` calls — **skip those**, everything you need is already in the search response.

## Strategy used

- **Phase 0 (curl)**: 403 on `/laptops.html`. Akamai. Noted.
- **Phase 1 (framework)**: Next.js, but the initial HTML has no `__NEXT_DATA__` product payload and no `/_next/data/` JSON routes for this sub-app. Skipped.
- **Phase 2 (browser recon only)**: Connected to real Chrome via `TORCH_CHROME_ENDPOINT`, navigated to `/laptops.html`, captured network. Found `gdx-api.costco.com/catalog/search/api/v1/search` with the POST body and headers. Immediately abandoned the browser.
- **Phase 3**: Replayed the API directly with `fetch`. No cookies. No browser. ~1.7s for the whole category.

## Replay recipe

```js
const res = await fetch("https://gdx-api.costco.com/catalog/search/api/v1/search", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "client_id": "USBC",
    "client-identifier": "168287ea-1201-45f6-9b45-5bbea49f8ee7",
    "searchresultprovider": "GRS",
    "locale": "en-US",
    "origin": "https://www.costco.com",
    "referer": "https://www.costco.com/",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  },
  body: JSON.stringify({
    visitorId: "34605021473470492644037693828274183591", // any stable string works
    query: "",
    pageSize: 96,       // tested up to 96; default in-browser is 24
    offset: 0,
    orderBy: null,
    searchMode: "page",
    personalizationEnabled: false,
    warehouseId: "129-wh",
    shipToPostal: "95050",
    shipToState: "CA",
    deliveryLocations: ["129-wh"],
    filterBy: ['attributes.category_uri: ANY("laptops")'], // <-- category slug goes here
    pageCategories: ["laptops"],
  }),
});
```

The only headers that matter are `content-type`, `client_id: USBC`, `client-identifier` (any UUID), `searchresultprovider: GRS`, `origin`, `referer`, and a plausible `user-agent`. The `client-identifier` UUID appears to be long-lived and not per-session.

## Mapping categories to `filterBy`

The category slug in the URL (`/laptops.html` → `laptops`) is what goes into both `filterBy` and `pageCategories`. For nested categories, check the browser trace — the filter uses a literal `category_uri` attribute, not a path. When in doubt, navigate the category once in real Chrome and grab the POST body.

## Extraction

Each result in `searchResult.results[]`:

```js
function normalize(result) {
  const p = result.product;
  const v = result.variantRollupValues || {};
  return {
    id: result.id,
    title: p.title,
    brand: p.brands?.[0],
    categories: p.categories,
    price:         v["price"]?.[0] ?? null,
    originalPrice: v["originalPrice"]?.[0] ?? null,
    promoText:     v["inventory(847, attributes.promotion_short_text)"]?.[0] ?? null,
    availability:  v["inventory(129-wh, attributes.availability)"]?.[0] ?? null,
    pills:  p.attributes?.pills?.text ?? [],
    rating: p.rating ? { average: p.rating.averageRating, count: p.rating.ratingCount } : null,
    url:    p.uri, // already fully-qualified
  };
}
```

Key gotcha: **pricing lives in `variantRollupValues`, not `product.priceInfo`**. `product.priceInfo` does not exist on this endpoint. The scalar keys to use are `price`, `originalPrice`, and the warehouse-scoped `inventory(<whs>, price)` variants.

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| 1. Headers / UA | ✅ | `client_id`, `client-identifier`, `origin`, `referer`, UA |
| 2. Cookies / session warmup | ❌ | API is cookieless |
| 3. Stealth plugin | ❌ | No browser used |
| 4. Real Chrome (`TORCH_CHROME_ENDPOINT`) | 🔍 recon only | Needed once to discover the API |
| 5. CAPTCHA solver | ❌ | |
| 6. Residential proxy | ❌ | Clean from a US residential IP; untested from datacenter |
| 7. Rate limiting | ❌ | 200ms gap between pages is plenty |
| 8. Fingerprint rotation | ❌ | |
| 9. Human-in-the-loop | ❌ | |

## Data shape

```json
{
  "id": "4000274880",
  "title": "Microsoft Surface Laptop Copilot+ PC 13.8\" - Qualcomm Snapdragon X Plus (10 core) - 2304 x 1536 - Windows 11 - 16GB RAM - 1TB SSD",
  "brand": "Microsoft Surface",
  "categories": ["Computers", "Computers > Laptops", "Computers > Laptops > Windows Copilot+ PCs"],
  "price": 1099.99,
  "originalPrice": 1099.99,
  "discount": 0,
  "promoText": "$100 OFF,$100 OFF",
  "pills": ["Copilot+ PC", "Instant Savings"],
  "availability": "LOW_STOCK",
  "rating": { "average": 4.1923, "count": 78 },
  "url": "https://www.costco.com/p/-/microsoft-surface-laptop-copilot-pc-138---.../4000274880"
}
```

## Pagination

- `searchResult.totalSize` is the category total.
- `pageSize: 96` is the largest value tested (browser uses 24).
- Loop `offset += pageSize` until `results.length < pageSize` or `offset >= totalSize`.
- `nextPageToken` was empty on the laptops category (fits in one page); if it's present on larger categories it's likely usable as an alternative cursor.

## Gotchas & lessons

1. **Don't bother with the HTML.** `/laptops.html` is Akamai-gated (403 on curl) and the rendered DOM has no product data anyway — the whole grid is API-driven.
2. **`product.priceInfo` is null.** Price lives in `variantRollupValues.price[0]` and `variantRollupValues.originalPrice[0]`. The warehouse-scoped `inventory(847, price)` may differ from the base `price`; pick one convention and stick with it.
3. **`promoText` looks doubled** (`"$100 OFF,$100 OFF"`) because Costco concatenates promotion strings with a comma and sometimes repeats them. Split/dedupe if presenting to users.
4. **Do not replay the per-item `products/summary` calls.** They're an N+1 the browser fires for hydration; the bulk search already returns everything.
5. **`warehouseId`, `shipToPostal`, `shipToState`, `deliveryLocations`** can all be left at the recon defaults (`129-wh` / `95050` / `CA`) unless you need region-specific pricing or inventory. The API accepts them without validation from an external IP.
6. **`client-identifier`** is a UUID the Next.js app generates; the same value has worked across sessions. If it ever starts 401'ing, grab a fresh one from the browser trace.
7. **Akamai 403 on HTML is IP-sensitive.** If you're on a flagged datacenter IP, the *HTML* page may be blocked, but the `gdx-api.costco.com` endpoint still answers — so the API-replay path is resilient even when the frontend isn't.
