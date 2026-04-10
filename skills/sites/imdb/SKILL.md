---
name: imdb
description: Proven scraping playbook for imdb.com. Next.js SPA behind CloudFront + AWS WAF (x-amzn-waf-action challenge on raw curl). Real Chrome via the real Chrome debug port sails past the challenge on first navigation — no captcha, no proxy. The clean path is __NEXT_DATA__ JSON on chart/list pages. Activate for any imdb.com target.
metadata:
  author: torch
  version: "1.0.0"
---

# IMDb (imdb.com)

Full catalog (charts, titles, names) is a Next.js app served via CloudFront with an AWS WAF challenge on bare curl requests. A real Chrome session (the real Chrome debug port) passes the challenge silently; `__NEXT_DATA__` then yields a complete, typed JSON payload that's vastly richer than the DOM.

## Detection

| Signal | Value |
| --- | --- |
| CDN | CloudFront (`via: 1.1 ...cloudfront.net`) |
| Framework | Next.js (`__NEXT_DATA__` present, `/_next/` assets) |
| Anti-bot | AWS WAF — returns `HTTP/2 202` + `x-amzn-waf-action: challenge` + empty body to plain curl, even with spoofed UA/headers |
| Auth | Not required for public chart/title/name pages |
| robots.txt | Allows most public paths; disallows `/search/`, `/find`, etc. |

## Architecture

- Next.js SSR: every chart/title page inlines a `<script id="__NEXT_DATA__">` JSON blob with the full page payload already resolved.
- Chart pages (`/chart/top`, `/chart/moviemeter`, `/chart/boxoffice`, …) expose the list at `props.pageProps.pageData.chartTitles.edges[].node`.
- Each node has `id` (tconst), `titleText`, `releaseYear`, `runtime`, `ratingsSummary` (aggregateRating + voteCount), `certificate`, `titleGenres`, `primaryImage`, etc. — no DOM scraping needed.

## Strategy used

- **Phase 0 (curl)**: blocked. `HTTP/2 202` + `x-amzn-waf-action: challenge`, zero body. Don't waste time tweaking headers — AWS WAF is JS-challenge based.
- **Phase 1 (framework)**: skipped as a standalone fetch path — same WAF wall — but `__NEXT_DATA__` is the extraction target once the page loads in a browser.
- **Phase 2 (browser)**: `puppeteer.connect({ browserURL: the real Chrome debug port })`. Real Chrome clears WAF on the first navigation with no interaction. No stealth plugin, no captcha solver, no proxy.

## Stealth config that works

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });
const page = await browser.newPage();
await page.goto("https://www.imdb.com/chart/top/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("li.ipc-metadata-list-summary-item");
```

No custom UA, no extra headers, no args — the real Chrome session is what matters. Remember to `browser.disconnect()` (never `close()`) so the user's Chrome keeps running.

## Extraction

Grab `__NEXT_DATA__` and walk the payload:

```js
const nextData = await page.evaluate(() => document.getElementById("__NEXT_DATA__")?.textContent);
const data = JSON.parse(nextData);
const edges = data.props.pageProps.pageData.chartTitles.edges;

const movies = edges.map((e, i) => {
  const n = e.node;
  return {
    rank: i + 1,
    id: n.id,                                 // tconst e.g. "tt0111161"
    title: n.titleText?.text,
    originalTitle: n.originalTitleText?.text,
    year: n.releaseYear?.year,
    runtimeSeconds: n.runtime?.seconds,
    rating: n.ratingsSummary?.aggregateRating,
    voteCount: n.ratingsSummary?.voteCount,
    certificate: n.certificate?.rating,
    genres: n.titleGenres?.genres?.map(g => g.genre?.text),
    url: `https://www.imdb.com/title/${n.id}/`,
    poster: n.primaryImage?.url,
  };
});
```

DOM fallback (if the payload shape ever changes): `li.ipc-metadata-list-summary-item` → `h3.ipc-title__text` (strip leading `N. `), `.cli-title-metadata span` (year / runtime / certificate), `.ipc-rating-star--rating`, `.ipc-rating-star--voteCount`, `a.ipc-title-link-wrapper[href]`.

## Anti-blocking summary

| Layer | Needed? | Notes |
| --- | --- | --- |
| 1. Headers/UA | — | Irrelevant, WAF ignores them |
| 2. Cookies/session | ✓ | Provided for free by real Chrome profile |
| 3. Stealth plugin | — | Not needed with real Chrome |
| 4. Headed Chromium | — | Real-Chrome connect is stronger |
| 5. CAPTCHA solver | — | No captcha, JS challenge only |
| 6. Residential proxy | — | Not needed |
| 7. Mobile/4G proxy | — | Not needed |
| 8. Human-in-the-loop | — | — |
| 9. Give up | — | — |

The single requirement is `127.0.0.1:9222` pointing at a real Chrome with any browsing history. A fresh puppeteer-extra-stealth Chromium *might* also work but is not tested here.

## Data shape

```json
{
  "rank": 1,
  "id": "tt0111161",
  "title": "The Shawshank Redemption",
  "originalTitle": "The Shawshank Redemption",
  "year": 1994,
  "runtimeSeconds": 8520,
  "rating": 9.3,
  "voteCount": 3176774,
  "certificate": "R",
  "genres": ["Drama"],
  "url": "https://www.imdb.com/title/tt0111161/",
  "poster": "https://m.media-amazon.com/images/M/.../_V1_.jpg"
}
```

`/chart/top` returns exactly 250 entries in one payload — no pagination.

## Pagination / crawl architecture

- `/chart/top`, `/chart/moviemeter`, `/chart/toptv`, `/chart/boxoffice` are all single-page payloads; one goto per chart.
- For title detail pages (`/title/ttXXXXXXX/`), reuse the same real-Chrome connect and pull `__NEXT_DATA__` → `props.pageProps.aboveTheFoldData` / `mainColumnData`.
- Advanced search (`/search/title/`) is blocked by robots.txt — prefer the official datasets at https://datasets.imdbws.com/ for bulk catalog crawls.

## Gotchas & lessons

1. Plain `curl` (even with a full browser header set) always returns `202` + `x-amzn-waf-action: challenge` and an empty body. Don't chase it — go straight to the browser.
2. Use `browser.disconnect()` not `browser.close()` when connected via `127.0.0.1:9222`, or you'll kill the user's Chrome.
3. `__NEXT_DATA__` is far richer than the DOM: poster URLs, vote counts, genres, tconsts, runtime in seconds — extract from the JSON, not CSS selectors.
4. `n.runtime.seconds` is in seconds; divide by 60 for minutes if needed.
5. Titles on charts sometimes have localized `titleText` vs `originalTitleText` depending on the session's region cookie — keep both.
6. For bulk catalog work (>a few thousand titles), switch to the official IMDb datasets (`title.basics.tsv.gz`, `title.ratings.tsv.gz`) — scraping 1M+ title pages through WAF is not worth it.
