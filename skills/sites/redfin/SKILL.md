---
name: redfin
description: Proven scraping playbook for redfin.com listings. The HTML pages are CloudFront-blocked (403) on bare curl, but Redfin exposes a public undocumented endpoint at /stingray/api/gis-csv that returns the entire region's listings as CSV with no auth, no cookies, no anti-bot. Skip the browser entirely. Activate for any redfin.com /city/, /zipcode/, /county/, or /neighborhood/ listing scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Redfin (redfin.com)

> Redfin's HTML pages sit behind CloudFront and return `403 ERROR — Request blocked` to plain curl, but their internal "Download All" CSV endpoint (`/stingray/api/gis-csv`) is wide open. One GET returns up to 350 listings with 27 columns of structured data — price, beds, baths, sqft, lat/lon, MLS#, URL, year built, HOA, etc. No browser, no captcha, no proxy.

## Detection

| Signal | Value |
| --- | --- |
| CDN | CloudFront (`x-amz-cf-id`, `via: 1.1 ...cloudfront.net`) |
| HTML on bare curl | **HTTP 403** "Request blocked" |
| API on bare curl | **HTTP 200** CSV |
| Auth | None |
| Anti-bot on API | None observed |
| robots.txt | Disallows crawling listing pages, but `/stingray/api/gis-csv` is the same endpoint the site's "Download All" button hits |

## Architecture

The page at `https://www.redfin.com/city/<region_id>/<STATE>/<City-Name>` is a React SPA. The "Download All" button on the search results page issues a single request to:

```
GET https://www.redfin.com/stingray/api/gis-csv
  ?al=1
  &market=<market_slug>
  &num_homes=350
  &ord=redfin-recommended-asc
  &page_number=1
  &region_id=<region_id>
  &region_type=6        # 6 = city. Other types: 2 = zip, 5 = county, 1 = neighborhood
  &sf=1,2,3,5,6,7
  &status=9             # 9 = active for sale
  &uipt=1,2,3,4,5,6,7,8 # property types
  &v=8
```

The response is a CSV file (`Content-Type: text/csv`) with 27 columns. **Cap is 350 listings per call** — `num_homes=1000` returns `{"errorMessage":"Invalid num_homes argument value","resultCode":101}`. The endpoint does not honor `page_number > 1` for additional pages on the same query (it returns the same first 350). To get more than 350, narrow the query (by zip, neighborhood, price band, or property type).

The `region_id` comes straight from the canonical URL. For `https://www.redfin.com/city/17151/CA/San-Francisco`, region_id = `17151`, region_type = `6`.

## Strategy used

- **Phase 0 — curl**: HTML → 403 CloudFront. Tried `/stingray/api/gis-csv` → 200 CSV. Done.
- **Phase 1**: skipped.
- **Phase 2**: skipped (no browser needed).
- **Phase 3**: parse CSV, normalize columns, save JSON.

Total scrape time: ~4 seconds for 350 listings.

## Stealth config that works

None needed. A vanilla `fetch()` with a normal desktop User-Agent is enough:

```js
const res = await fetch(url, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "text/csv,*/*",
  },
});
```

No cookies, no Referer, no `x-requested-with`, no proxy.

## Extraction

The CSV is standard RFC-4180 (quoted fields, embedded commas/quotes). Some Redfin endpoints prefix the body with `{}&&` as a JSON-hijacking guard — strip it if present:

```js
let text = await res.text();
if (text.startsWith("{}&&")) text = text.slice(4);
```

The 27 columns (header row, in order) are:

```
SALE TYPE, SOLD DATE, PROPERTY TYPE, ADDRESS, CITY, STATE OR PROVINCE,
ZIP OR POSTAL CODE, PRICE, BEDS, BATHS, LOCATION, SQUARE FEET, LOT SIZE,
YEAR BUILT, DAYS ON MARKET, $/SQUARE FEET, HOA/MONTH, STATUS,
NEXT OPEN HOUSE START TIME, NEXT OPEN HOUSE END TIME,
URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING),
SOURCE, MLS#, FAVORITE, INTERESTED, LATITUDE, LONGITUDE
```

**Gotcha**: the `URL` column already contains the full absolute URL (`https://www.redfin.com/CA/...`). Do not prepend `https://www.redfin.com/` — that produces `https://www.redfin.comhttps://www.redfin.com/...`.

The column header for the URL is the literal long string above — match by `header.find(h => h.startsWith("URL"))` rather than typing it out.

## Anti-blocking summary

| Layer | Needed? | Notes |
| --- | --- | --- |
| 1. Realistic UA | ✅ | Any modern desktop UA works |
| 2. Headers parity | ❌ | Default fetch headers are fine |
| 3. Rate limiting | ❌ | Single request per region |
| 4. Stealth puppeteer | ❌ | No browser needed |
| 5. Real-Chrome connect | ❌ | |
| 6. Residential proxy | ❌ | Datacenter IPs work |
| 7. CAPTCHA solver | ❌ | |
| 8. Login | ❌ | |
| 9. Headed mode | ❌ | |

## Data shape

```json
{
  "address": "433 Excelsior Ave",
  "city": "San Francisco",
  "state": "CA",
  "zip": "94112",
  "price": 1195000,
  "beds": 4,
  "baths": 3,
  "sqft": 1990,
  "lot_size": 2500,
  "year_built": 1922,
  "property_type": "Single Family Residential",
  "hoa_month": null,
  "status": "Active",
  "days_on_market": 1,
  "$_per_sqft": 601,
  "latitude": 37.7246424,
  "longitude": -122.4298525,
  "url": "https://www.redfin.com/CA/San-Francisco/433-Excelsior-Ave-94112/home/1214110",
  "mls": "426118688",
  "source": "San Francisco MLS"
}
```

## Pagination / crawl architecture

The endpoint hard-caps at 350 listings per query and `page_number` is effectively a no-op. To exceed 350 for a large city like San Francisco (3000+ active listings), shard the query:

1. **By zip code** — set `region_id=<zip>&region_type=2`. Get list of zips from `/zipcodes-in-city/<city>` page or hardcode.
2. **By price band** — add `min_price=<x>&max_price=<y>` and walk price brackets until each returns < 350.
3. **By property type** — split `uipt` into one call per type (`uipt=1` houses, `uipt=2` condos, etc.) and union the results, deduping by MLS#.
4. **By neighborhood** — `region_type=1` with neighborhood IDs from the city page.

Concurrency: 2-4 parallel requests is safe. Be polite, throttle with a small jitter.

## Gotchas & lessons

1. **`num_homes` is capped at 350**. Anything higher returns `resultCode:101`. The site UI uses 350 too.
2. **`page_number` is ignored** for paginating past 350 — you must shard the query instead.
3. **The HTML pages 403 on curl**, but the API doesn't. Don't waste time on stealth browsers — go straight to gis-csv.
4. **The URL column already includes the host.** Prepending `https://www.redfin.com` doubles it.
5. **The URL column header is huge** (`URL (SEE https://www.redfin.com/buy-a-home/...)`). Match it by `startsWith("URL")` so a Redfin tweak to the help link doesn't break extraction.
6. **`region_id` lives in the URL path** (`/city/17151/CA/San-Francisco` → `17151`). For other region types: zip code = `region_type=2&region_id=94110`, county = `region_type=5`, neighborhood = `region_type=1`.
7. **Some endpoints prefix `{}&&`** as a JSON-hijacking guard. The CSV endpoint usually doesn't, but strip it defensively.
8. **`status=9`** is "active". Use `status=139` for sold/active/pending mix. The site's filter UI exposes the full set.
9. **Sold listings have a `SOLD DATE`** and are excluded by default with `status=9`.
