---
name: pypi
description: Proven scraping playbook for pypi.org. The /search HTML page is behind a FullStory client challenge (_fs-ch-*), but PyPI publishes an official RSS feed for newest packages at /rss/packages.xml with zero anti-bot. Use the RSS feed (or the JSON API) instead of scraping /search. Activate for any pypi.org target.
metadata:
  author: torch
  version: "1.0.0"
---

# PyPI (pypi.org)

> PyPI (Warehouse) exposes official RSS feeds and a JSON API that return the same data the /search HTML page would, without any anti-bot. The HTML /search endpoint is protected by a FullStory client challenge — don't bother with a browser.

## Detection

| Signal      | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Server      | `gunicorn` (Warehouse, the PyPI codebase)                       |
| CDN         | Fastly (`x-served-by: cache-*`)                                 |
| Anti-bot    | FullStory client challenge on `/search/*` (`/_fs-ch-*/script.js`) — serves a `Client Challenge` HTML stub to non-JS clients |
| Auth        | Not needed                                                      |
| robots.txt  | Disallows `/simple/` indexes; RSS feeds and JSON API are fine   |

Curl `https://pypi.org/search/?q=&o=-created` returns `<title>Client Challenge</title>` with a `/_fs-ch-1T1wmsGaOgGaSxcX/script.js` loader. A plain Chrome UA does not bypass it. Don't waste time — use the feeds.

## Architecture

PyPI is served by **Warehouse**. It exposes three scraper-friendly data sources that completely replace the need to scrape HTML:

1. **RSS feeds** (XML, unauthenticated, no anti-bot):
   - `https://pypi.org/rss/packages.xml` — 40 newest *packages* (first release only). This is the equivalent of `/search/?q=&o=-created`.
   - `https://pypi.org/rss/updates.xml` — 40 newest *releases* (includes new versions of existing packages).
   - `https://pypi.org/rss/project/<name>/releases.xml` — per-project release feed.
2. **JSON API** (unauthenticated):
   - `https://pypi.org/pypi/<name>/json` — full metadata for a package (description, author, classifiers, URLs, all releases, file hashes).
   - `https://pypi.org/pypi/<name>/<version>/json` — metadata for a specific release.
3. **BigQuery / Google Cloud public dataset** (`bigquery-public-data.pypi.*`) — for bulk historical data, not scraping.

Official docs: <https://warehouse.pypa.io/api-reference/feeds.html> and <https://warehouse.pypa.io/api-reference/json.html>.

## Strategy used

- **Phase 0 (curl)**: immediately saw FullStory Client Challenge on `/search/`. Skipped browser entirely.
- **Phase 1 (framework-aware)**: remembered PyPI = Warehouse, which ships official RSS + JSON. Fetched `/rss/packages.xml` → plain XML, 40 items, 0.2s.
- **Phase 2 (browser)**: not needed.

## Stealth config that works

None required. Plain `fetch` with any User-Agent works:

```js
fetch('https://pypi.org/rss/packages.xml', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; torch-scraper/1.0)',
    Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  },
});
```

## Extraction

Parse the RSS with cheerio in `xmlMode`:

```js
import * as cheerio from 'cheerio';
const $ = cheerio.load(xml, { xmlMode: true });
$('item').each((_, el) => {
  const $el = $(el);
  const title = $el.find('title').text().trim();       // "<name> added to PyPI"
  const link = $el.find('link').text().trim();         // https://pypi.org/project/<name>/
  const description = $el.find('description').text().trim();
  const pubDate = $el.find('pubDate').text().trim();   // RFC 822
  const name = title.replace(/ added to PyPI$/, '');
});
```

For richer metadata, hit `https://pypi.org/pypi/${name}/json` per package.

## Anti-blocking summary

| Layer                       | Needed? | Notes                                            |
| --------------------------- | ------- | ------------------------------------------------ |
| 1. Honest UA                | No      | Any UA works on feeds/JSON                       |
| 2. Stealth puppeteer        | No      | Don't use a browser                              |
| 3. Headed mode              | No      |                                                  |
| 4. Residential proxy        | No      |                                                  |
| 5. CAPTCHA solver           | No      |                                                  |
| 6. Session cookies          | No      |                                                  |
| 7. Request throttling       | Maybe   | Be polite on /pypi/<name>/json at scale          |
| 8. Auth login               | No      |                                                  |
| 9. Bypass FullStory challenge | **Avoid** | Only appears on /search/ HTML — just use feeds |

## Data shape

```json
{
  "name": "collaborativenotes-utils",
  "url": "https://pypi.org/project/collaborativenotes-utils/",
  "description": "Scoring, ranking and search utilities for CollaborativeNotes",
  "published": "Fri, 10 Apr 2026 00:31:39 GMT",
  "published_iso": "2026-04-10T00:31:39.000Z"
}
```

## Pagination / crawl architecture

- The RSS feed is **fixed at the latest 40 items**. There is no pagination.
- To go beyond 40 newest, either:
  - Poll `/rss/packages.xml` periodically (every few minutes) and dedupe by `guid`/`name`, or
  - Use the BigQuery public dataset for historical backfill, or
  - Walk `/simple/` for the full package index (but that returns names only — then hit `/pypi/<name>/json` per name; expect rate limiting at scale — throttle to a few req/s).
- For per-package deep crawl: seed from RSS, then fan out to `/pypi/<name>/json` with concurrency ≤ 5.

## Gotchas & lessons

1. **Do not scrape `/search/`** — FullStory client challenge blocks curl and plain puppeteer. The HTML doesn't give you more than the RSS feed anyway.
2. **RSS caps at 40** — it's a live feed, not a paginated archive. If you need more history, poll or use BigQuery.
3. **`packages.xml` vs `updates.xml`** — `packages.xml` is first-release-only (new projects), `updates.xml` is any new release (including version bumps). The search UI sorted by `-created` corresponds to `packages.xml`.
4. **`title` field has the suffix `" added to PyPI"`** — strip it to get the package name.
5. **pubDate is RFC 822** — parse with `new Date(pubDate)` (works in Node) for ISO output.
6. **robots.txt disallows `/simple/`** for generic crawlers but the JSON API is fair game. Be polite: throttle and set a descriptive UA.
7. **Classifiers, homepage, author, license** live on the JSON endpoint, not the RSS feed — join them if you need rich data.
