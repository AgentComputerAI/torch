---
name: airbnb
description: Proven scraping playbook for airbnb.com search result pages (/s/<location>/homes). Server-streamed React app — listing data is in a JSON blob inside `<script id="data-deferred-state-0">` (or `data-injector-instances` on cached responses). No anti-bot, no captcha, no proxy, no browser needed. Plain Node `fetch` + a UA header works. Pagination is a flat `?cursor=<base64>` param taken from `paginationInfo.pageCursors`. Activate for any airbnb.com /s/ search URL.
metadata:
  author: torch
  version: "1.0.0"
---

# Airbnb (airbnb.com)

> Airbnb's search results page renders fully on the server and ships all listing data inline as JSON. There is no anti-bot wall on `/s/<location>/homes` — a single `fetch` with a normal browser User-Agent returns HTTP 200 + ~900KB of HTML containing every listing on the page. Pagination is a flat list of opaque cursors discoverable from page 1.

## Detection

| Signal       | Value                                              |
|--------------|----------------------------------------------------|
| CDN          | Akamai (`akamai-request-bc` header)                |
| Origin       | nginx, `x-instrumentation: airbnb`                 |
| Framework    | Custom Airbnb "Niobe" GraphQL client + React SSR   |
| Anti-bot     | None on `/s/` HTML (Arkose Labs only on POST flows)|
| Auth         | Not required for search                            |
| robots.txt   | Allows `/s/` for major UAs                         |

`curl -sL` returns 200 immediately. No challenge, no JS check, no cookies needed beyond what the response sets.

## Architecture

- React SSR app shell at `/s/:location?/homes/:additionalRefinements?`.
- Search payload comes from the internal **Niobe** GraphQL endpoint (`StaysSearch` operation), but the SSR pass already inlines the response in the HTML. **There is no need to replay the GraphQL endpoint.**
- The inlined JSON lives in **one of two** script tags depending on which render path served the request:
  1. `<script id="data-deferred-state-0">` — streaming/deferred render. **This is what plain `fetch` from Node usually gets.** Path to listings: `niobeClientData[0][1].data.presentation.staysSearch.results.searchResults`.
  2. `<script id="data-injector-instances">` — fully inlined render (sometimes served to `curl`/cached). Path to listings: `root[3][1][2][1].data.presentation.staysSearch.results.searchResults`.
- Both paths land at the same `presentation.staysSearch.results` shape, so a stack-based walk that looks for `o.staysSearch.results.searchResults` works on either.
- Each page returns **18** results in `searchResults`. The map carousel (`mapResults.mapSearchResults`, ~20) overlaps but isn't needed.
- Pagination is a flat list of base64 cursors at `staysSearch.results.paginationInfo.pageCursors` (typically 15 cursors → ~270 listings cap per query). Append `?cursor=<urlencoded base64>` to the same URL.

## Strategy used

- **Phase 0 (curl)**: 200 OK, ~1.6MB HTML, all listings present inline. ✅ Stop here — no browser needed.
- **Phase 1 (framework)**: Found `data-deferred-state-0` / `data-injector-instances` script blob. Used directly. ✅
- **Phase 2 (browser)**: Skipped entirely.

## Stealth config that works

None. A single `fetch` with a normal browser UA is enough:

```js
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};
```

No cookies, no Cloudflare clearance, no `sec-ch-*` hints required.

## Extraction

```js
const decodeEntities = (s) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'");

function extractStaysSearch(html) {
  const candidates = [
    /<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/,
    /<script id="data-injector-instances"[^>]*>([\s\S]*?)<\/script>/,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (!m) continue;
    let j;
    try { j = JSON.parse(decodeEntities(m[1])); } catch { continue; }
    // Iterative walk — find `o.staysSearch.results.searchResults`
    const stack = [j];
    while (stack.length) {
      const o = stack.pop();
      if (o == null || typeof o !== "object") continue;
      if (Array.isArray(o?.staysSearch?.results?.searchResults)) {
        return o.staysSearch;
      }
      if (Array.isArray(o)) for (const v of o) stack.push(v);
      else for (const k of Object.keys(o)) stack.push(o[k]);
    }
  }
  throw new Error("staysSearch not found in payload");
}
```

The numeric room id is hidden inside `demandStayListing.id`, which is base64 of `DemandStayListing:<id>`:

```js
const decoded = Buffer.from(dsl.id, "base64").toString("utf8"); // "DemandStayListing:23829372"
const listingId = decoded.match(/(\d+)$/)?.[1];                  // "23829372"
const url = `https://www.airbnb.com/rooms/${listingId}`;
```

Important fields per `searchResults[i]`:

| Field                                                    | What it is                                          |
|----------------------------------------------------------|-----------------------------------------------------|
| `title`                                                  | "Home in Daly City" (property + neighborhood)       |
| `demandStayListing.description.name.localizedString…`    | Host-written listing title                          |
| `demandStayListing.id`                                   | base64 → numeric listing id                         |
| `demandStayListing.location.coordinate.{latitude,longitude}` | lat/lng                                         |
| `avgRatingLocalized` / `avgRatingA11yLabel`              | "4.96 (241)" / accessibility version with full text |
| `structuredDisplayPrice.primaryLine.{price,qualifier,accessibilityLabel}` | "$1,139" / "for 5 nights" |
| `badges[].text`                                          | "Guest favorite", "Superhost", etc.                 |
| `structuredContent.primaryLine[].body` + `secondaryLine[].body` | "1 bedroom", "1 queen bed", check-in dates  |
| `contextualPictures[].picture`                           | Full-size image URLs (`a0.muscache.com/im/...`)     |

## Anti-blocking summary

| Layer                          | Needed? | Notes                                       |
|--------------------------------|---------|---------------------------------------------|
| 1. Real browser UA             | ✅      | Just the UA header — that's it              |
| 2. Accept-Language header      | ✅      | Polite, also keeps response in English      |
| 3. Cookies / session warm-up   | ❌      | Not needed                                  |
| 4. puppeteer-extra-stealth     | ❌      | No browser at all                           |
| 5. Real-Chrome `connect()`     | ❌      | Not needed                                  |
| 6. CAPTCHA solver              | ❌      | No captcha on /s/                           |
| 7. Residential proxy           | ❌      | Same IP did 16 requests in 35s, no rate limit |
| 8. Slow + jitter               | ➖      | 600ms between pages out of politeness only  |
| 9. GraphQL replay              | ❌      | Inlined SSR data is sufficient              |

## Data shape

```json
{
  "listingId": "23829372",
  "title": "Home in Daly City",
  "name": "SF Amazing View & SUNroom: Spacious Private 1 bdrm",
  "rating": "4.96 (241)",
  "ratingA11y": "4.96 out of 5 average rating,  241 reviews",
  "price": "$1,139",
  "priceQualifier": "for 5 nights",
  "priceA11y": "$1,139 for 5 nights",
  "badges": ["Guest favorite"],
  "features": ["1 bedroom", "1 queen bed", "May 24 – 29"],
  "coordinate": { "lat": 37.70566, "lng": -122.43224 },
  "images": [
    "https://a0.muscache.com/im/pictures/hosting/Hosting-23829372/original/c0bf598f-….jpeg"
  ],
  "url": "https://www.airbnb.com/rooms/23829372"
}
```

## Pagination / crawl architecture

1. Fetch the seed URL (no `?cursor=`).
2. Read `staysSearch.results.paginationInfo.pageCursors` — typically **15 cursors**.
3. For each cursor `c`, fetch `${BASE}?cursor=${encodeURIComponent(c)}`. Page 1 cursor is the all-zero one and matches the seed fetch — skip the duplicate request.
4. Each page yields ~13–18 unique listings (some overlap between pages, dedupe by `listingId`).
5. Politeness: ~600ms between pages, no concurrency needed.
6. **Hard cap**: Airbnb only exposes ~270 listings per search query (15 × 18). To go deeper, narrow with filters (price band, neighborhood, dates, room type) and union the results.
7. Checkpoint: write `output/airbnb.json` after each page so a mid-run failure preserves progress.

Total runtime for one full SF search: **~35 seconds**, **245 unique listings**.

## Gotchas & lessons

1. **Two script tags, not one.** `curl` and `node fetch` get different render paths. Always try both `data-deferred-state-0` *and* `data-injector-instances` with the same walker — don't hardcode one path.
2. **Hardcoded JSON paths break.** The `root[3][1][2][1].data.presentation…` path from `data-injector-instances` does NOT exist in `data-deferred-state-0` (which uses `niobeClientData[0][1].data.presentation…`). Use a stack-walk that searches for the `staysSearch.results.searchResults` shape instead of pinning indices.
3. **HTML entities inside the script.** The JSON is HTML-entity-encoded (`&quot;`, `&amp;`, `&#x27;`). Decode before `JSON.parse`.
4. **`propertyId` is `null`.** The numeric id you want is inside `demandStayListing.id`, base64-encoded as `DemandStayListing:<id>`. Decode it.
5. **`paginationInfo.pageCursors[0]` === seed page.** Don't refetch — reuse the page-1 response.
6. **270-listing cap per query.** This is an Airbnb product limit, not a scraper bug. Slice the search with filters to get more.
7. **Map carousel overlaps results.** `mapResults.mapSearchResults` (~20) and `results.searchResults` (18) share most listings; stick to `searchResults` for the canonical paginated set.
8. **No Arkose / no captcha on GET /s/.** Arkose Labs (`airbnb-api.arkoselabs.com` in CSP) only kicks in on login/booking POST flows. Read-only search is wide open.
9. **Akamai is in front but not enforcing.** The `akamai-request-bc` header confirms Akamai routing, but no Bot Manager challenge is issued for `/s/` GETs from a normal UA. Don't waste time on TLS fingerprinting or proxy rotation unless Airbnb tightens this in the future.
