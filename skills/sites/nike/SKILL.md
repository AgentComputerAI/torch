---
name: nike
description: Proven scraping playbook for nike.com. Skip the browser entirely — replay the internal api.nike.com product_wall endpoint directly with fetch. Public API, no cookies, no tokens, no anti-bot. Requires the nike-api-caller-id header and count=24 per page. Activate for any nike.com gridwall (/w/ URLs). Covers endpoint template, pagination, response shape, and known API quirks.
metadata:
  author: torch
  version: "1.0.0"
---

# Nike (nike.com)

> Custom React SPA with SSR bootstrap ("Web Shell"). The product grid hydrates from an internal `api.nike.com/discover/product_wall/v1` JSON API. There is **no** `__NEXT_DATA__` blob; only the first ~24 cards are server-rendered, the rest load via XHR on scroll.
>
> **Skip the browser entirely.** Replay the API with `fetch`. It's public, fast, and anti-bot-free — just send the right headers.

## Detection

| Signal | Value |
|---|---|
| **Framework** | Custom React SPA with "Web Shell" SSR |
| **API** | `api.nike.com/discover/product_wall/v1` — public JSON, cursor-paginated |
| **Anti-bot** | None on the API (for browsing). Akamai Bot Manager on www.nike.com, but the API bypasses it |
| **Auth** | Not required for catalog browse. SNKRS and checkout are gated. |
| **Rate limit** | None observed at ~7 req/s across 132 pages. 150ms sleep between pages is plenty. |

## Strategy

```
Skip browser entirely
  → GET api.nike.com/discover/product_wall/v1/... with nike-api-caller-id header
  → Follow pages.next cursor until empty
  → Flatten productGroupings[].products[] to one row per colorway
```

Never launch Puppeteer for Nike catalog scraping — the API is faster, cleaner, and has no rate limits.

## Endpoint template

US English "new releases" gridwall (`/w/new-3n82y`):

```
GET https://api.nike.com/discover/product_wall/v1/marketplace/US/language/en/consumerChannelId/d9a5bc42-4b9c-4976-858a-f159cf99c647
    ?path=/w/new-3n82y
    &attributeIds=53e430ba-a5de-4881-8015-68eb1cff459f
    &queryType=PRODUCTS
    &anchor=0
    &count=24
```

Parameters:

| Param | Value | Notes |
|---|---|---|
| `path` | The URL slug (e.g. `/w/new-3n82y`) | Identifies the gridwall |
| `attributeIds` | GUID for the category filter | Sniff once per category (see Gotchas) |
| `queryType` | `PRODUCTS` | Always |
| `anchor` | `0`, `24`, `48`, ... | Pagination offset, increments by `count` |
| `count` | `24` | **Required — larger values return HTTP 400** |

For other gridwalls, swap `path` and `attributeIds` to the target category's values. Find them by sniffing the page once in devtools.

## Required headers

```js
const headers = {
  "nike-api-caller-id": "nike:dotcom:browse:wall.client:2.0",
  "anonymousid": "a".repeat(32),  // any 32-char hex works; a static one is fine
  "accept": "*/*",
  "origin": "https://www.nike.com",
  "referer": "https://www.nike.com/",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
```

Without `nike-api-caller-id` the API returns:

```
{ "error": "NIKE_API_CALLER_ID_HEADER_NOT_PRESENT" }
```

`anonymousid` can be any hex string; the API only checks presence, not validity.

## Pagination

Follow `pages.next` (relative URL) until empty or null:

```js
let url = `https://api.nike.com/discover/product_wall/v1/marketplace/US/language/en/consumerChannelId/d9a5bc42-4b9c-4976-858a-f159cf99c647?path=/w/new-3n82y&attributeIds=53e430ba-a5de-4881-8015-68eb1cff459f&queryType=PRODUCTS&anchor=0&count=24`;

const allProducts = [];
const seen = new Set();

while (url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  for (const group of data.productGroupings ?? []) {
    for (const p of group.products ?? []) {
      if (seen.has(p.productCode)) continue;
      seen.add(p.productCode);
      allProducts.push(flatten(p));
    }
  }

  url = data.pages?.next
    ? `https://api.nike.com${data.pages.next}`
    : null;

  await new Promise((r) => setTimeout(r, 150));
}
```

`pages.totalPages` and `pages.totalResources` tell you how many cards remain — useful for progress logging.

## Response shape

```js
{
  productGroupings: [
    {
      cardType: "default",
      products: [
        {
          productCode,
          copy: { title, subTitle },
          prices: { currency, currentPrice, initialPrice, discounted, discountPercentage },
          displayColors: { simpleColor: { name, hex }, colorDescription },
          colorwayImages: { portraitURL, squarishURL },
          pdpUrl: { url, path },
          badgeLabel,
          featuredAttributes: [...],
          productType,      // "FOOTWEAR" | "APPAREL" | "EQUIPMENT" | "STORED_VALUE"
          productSubType,
          styleColor,
          groupKey,
          globalProductId,
          isNewUntil,
          // ...
        },
      ],
    },
    // ...
  ],
  pages: { next, prev, totalPages, totalResources },
}
```

Each `productGroupings[*]` is a **style group**; its `.products[]` are individual **colorway variants**. Flatten to one row per colorway and dedupe on `productCode`.

## Anti-blocking summary

| Technique | Needed? | Notes |
|---|---|---|
| Stealth plugin | ❌ N/A | No browser |
| `nike-api-caller-id` header | ✅ Yes | Required or API returns error |
| `anonymousid` header | ✅ Yes | Any 32-char hex; presence-checked only |
| Realistic UA | ⚠️ Recommended | Standard desktop Chrome UA |
| Residential proxies | ❌ No | Datacenter IPs work fine |
| Rate limiting | ❌ No | 7 req/s across 132 pages, no throttle observed |
| Session cookies | ❌ No | Stateless API |

Note: `curl -I` (HEAD) returns HTTP 400 because CORS preflight trips. Use **GET only**.

## Data shape (output rows, flattened)

```json
{
  "title": "Air Max 90",
  "subtitle": "Men's Shoes",
  "productCode": "FB9658-101",
  "styleColor": "FB9658-101",
  "groupKey": "FB9658",
  "globalProductId": "a1b2c3...",
  "productType": "FOOTWEAR",
  "productSubType": "SNEAKERS",
  "currency": "USD",
  "currentPrice": 130.0,
  "initialPrice": 130.0,
  "discountPercentage": 0,
  "color": "White",
  "colorHex": "#FFFFFF",
  "colorDescription": "White/Black/Cool Grey",
  "badge": null,
  "badgeAttribute": null,
  "isNewUntil": "2026-05-15T00:00:00Z",
  "featuredAttributes": [],
  "portraitImage": "https://static.nike.com/a/images/.../portrait.png",
  "squarishImage": "https://static.nike.com/a/images/.../squarish.png",
  "url": "https://www.nike.com/t/air-max-90-mens-shoes-..."
}
```

## Known gridwall sizes

| Gridwall | `path` | `attributeIds` | Pages | Groupings | Colorways |
|---|---|---|---|---|---|
| New releases | `/w/new-3n82y` | `53e430ba-a5de-4881-8015-68eb1cff459f` | ~132 | ~3,148 | ~4,800 |

Flattened colorway count is **~1.5× the `totalResources`** because `totalResources` counts groupings, not variants.

## Gotchas

1. **`count` > 24 → HTTP 400.** Stick to 24. This is hard-capped server-side.

2. **`attributeIds` is category-scoped** — every `/w/...` URL has a different GUID. Sniff it once via devtools → Network when you switch category, then hardcode.

3. **`totalResources` is the grouping count, not colorway count.** Expect ~1.5× more rows after flattening. Don't use it for progress % without adjusting.

4. **DOM-scraping caps at ~72 cards.** The scroll observer stops firing in headless mode after three batches. Always prefer the API — this is why we skip the browser entirely.

5. **HEAD returns 400** — CORS preflight trips on HEAD requests. Use GET only, even for probing.

6. **`anonymousid` is dummy-checked** — the API only verifies presence, not validity. A static string works across all requests.

7. **SNKRS is different** — this playbook covers `www.nike.com/w/*` catalog gridwalls. SNKRS (`www.nike.com/launch`) has its own API with real auth, device fingerprinting, and Akamai `_abck`/`bm_sz` cookie gating. Do **not** use this playbook for SNKRS.

## Output

`./output/nike.json`
