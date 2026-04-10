---
name: yelp
description: Proven scraping playbook for yelp.com search result pages (/search?find_desc=...&find_loc=...). Yelp is behind DataDome — bare curl gets HTTP 403 with `server: DataDome` and a captcha-delivery interstitial. A real Chrome session via TORCH_CHROME_ENDPOINT walks straight through after the first navigation (no captcha solver, no proxy needed) because the persistent `datadome` cookie is already trusted on the user's profile. HTML is server-rendered; cheerio parses 10 organic results per page. Activate for any yelp.com /search target.
metadata:
  author: torch
  version: "1.0.0"
---

# Yelp (yelp.com)

> Yelp's SERP is fully server-rendered HTML wrapped in a DataDome anti-bot. The trick is *not* to fight DataDome — connect to the user's real Chrome and the cookie does the work.

## Detection

| Signal      | Value                                         |
|-------------|-----------------------------------------------|
| CDN         | Fastly (`x-served-by: cache-pao-...`)         |
| Framework   | SSR HTML (no `__NEXT_DATA__`, no React shell) |
| Anti-bot    | **DataDome** (`server: DataDome`, `x-datadome: protected`, `x-dd-b: 2`) |
| Auth        | Not required for search                       |
| Structured  | `ld+json` BreadcrumbList + FAQPage only — no ItemList |
| robots.txt  | Disallows `/search` for most bots, but real users are fine |

`curl -sL https://www.yelp.com/search?find_desc=pizza&find_loc=New+York%2C+NY` → **HTTP 403** with a `geo.captcha-delivery.com` iframe in the body.

## Architecture

- Pure SSR. The full result list ships in the initial HTML — no XHR hydration.
- Each page returns 10 **organic** results plus ~13 ad cards (`[data-testid="serp-ia-card"]`).
- Pagination is `&start=10`, `&start=20`, … (offset, not page number).
- DataDome enforcement is per-session: the first navigation in a fresh browser context triggers a JS challenge, but a real Chrome with a persistent profile already has a valid `datadome` cookie and skates through. **Disposable Chromium with stealth is NOT enough** — DataDome scores it as a bot.

## Strategy used

- **Phase 0 (curl)**: 403 DataDome → escalate.
- **Phase 1 (framework)**: no Next/Nuxt blob, no API endpoint visible in source → escalate.
- **Phase 2 (browser)**: `puppeteer.connect({ browserURL: process.env.TORCH_CHROME_ENDPOINT })` → first nav clears DataDome automatically within ~1.5s, subsequent navs are instant.
- **Phase 3**: parse with cheerio, walk leaf-text spans for neighborhood/status/snippet.

## Stealth config that works

None. **Don't** use puppeteer-extra/stealth on the real-Chrome path — Yelp's profile cookie is the entire bypass. Just:

```js
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: process.env.TORCH_CHROME_ENDPOINT });
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 900 });
```

Always `browser.disconnect()` (never `close()`) when done — the user's Chrome must keep running.

### DataDome wait loop

After `goto(url, { waitUntil: "domcontentloaded" })` the page may briefly be the DataDome interstitial (`<title>yelp.com</title>`, ~1.6 KB body). Poll the title until it becomes the real Yelp page title, then read content:

```js
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1500));
  let title = "";
  try { title = await page.title(); } catch { continue; } // ctx may be destroyed mid-redirect
  if (title && !/^yelp\.com$/i.test(title)) break;
}
const html = await page.content();
```

Note the `try/catch` around `page.title()` — when DataDome's JS triggers a navigation the V8 execution context is destroyed and any in-flight evaluation throws "Execution context was destroyed". Just retry next tick.

## Extraction

The container for each organic result is an `<li>` whose descendants include `h3 a[href^="/biz/"]` (ad cards use `/adredir?...` hrefs, so the `^="/biz/"` selector excludes them).

Inside each `<li>`:

| Field          | Selector / heuristic                                                |
|----------------|---------------------------------------------------------------------|
| name           | `h3 a[href^="/biz/"]` text, strip leading `"\d+. "` numbering       |
| url / slug     | `h3 a[href^="/biz/"]` href (drop query string)                      |
| rating         | `[aria-label*="star rating"]` → parse `"4.6 star rating"`           |
| reviewCount    | `<span>` text matching `^\(\d+(\.\d+)?[km]?\s*reviews?\)$`           |
| neighborhood   | leaf text immediately *after* the `(N reviews)` span                |
| status         | leaf starting with `Closed/Open/Opens/Closes` + the next leaf        |
| snippet        | longest leaf text span (the review quote)                           |
| categories     | the **last** `<p>` inside the `<li>` (e.g. "Pizza", "Italian")       |
| photo          | first `<img>` `src`                                                  |

DOM-leaf-walk for L'industrie Pizzeria looks like:

```
<a> L'industrie Pizzeria
<span> 4.6
<span> (1.1k reviews)
<span> West Village
<span> Closed
<span> until Noon tomorrow
<span> delicious pizza
<a> more
<p> Pizza
```

So a single forward pass over leaf-text nodes recovers every field positionally, which is more robust than chasing Yelp's hashed `y-css-*` class names (they rotate).

### Review-count k/m parsing

```js
let n = m[1].toLowerCase(), mult = 1;
if (n.endsWith("k")) { mult = 1000; n = n.slice(0,-1); }
if (n.endsWith("m")) { mult = 1_000_000; n = n.slice(0,-1); }
reviewCount = Math.round(parseFloat(n) * mult);
```

## Anti-blocking summary

| Layer                              | Needed? | Notes                                       |
|------------------------------------|---------|---------------------------------------------|
| 1. UA / headers                    | No      | Real Chrome supplies them                   |
| 2. Cookies / session               | **Yes** | The persistent `datadome` cookie *is* the bypass |
| 3. Stealth plugin                  | No      | Counter-productive on the real-Chrome path  |
| 4. Real Chrome via CDP             | **Yes** | `TORCH_CHROME_ENDPOINT` mandatory           |
| 5. CAPTCHA solver (2Captcha/Capmonster) | No  | DataDome auto-clears, no captcha shown      |
| 6. Residential proxy               | No      | Single home IP is fine for ≤1 req/sec       |
| 7. Rate limit / backoff            | Light   | 1.5s polling between pages is plenty        |
| 8. Auth / login                    | No      | Search is anonymous-accessible              |
| 9. Headful display                 | No      | The user's Chrome is already headful        |

## Data shape

```json
{
  "position": 1,
  "name": "L'industrie Pizzeria",
  "slug": "l-industrie-pizzeria-new-york",
  "url": "https://www.yelp.com/biz/l-industrie-pizzeria-new-york",
  "rating": 4.6,
  "reviewCount": 1100,
  "neighborhood": "West Village",
  "status": "Closed until Noon tomorrow",
  "categories": "Pizza",
  "snippet": "I. get. the. hype!!! Delicious delicious pizza wooooow! ...",
  "photo": "https://s3-media0.fl.yelpcdn.com/bphoto/VQO7moX7jsJ2Ggfvb8cm5g/ls.jpg"
}
```

## Pagination / crawl architecture

- 10 organic results per page.
- Next page = append `&start=10`, `&start=20`, … to the original URL (preserve `find_desc` and `find_loc`).
- Yelp caps SERP at `start=230` (24 pages × 10) for most queries. Past that you get an empty / "no more results" page.
- Sequential is fine — one tab, one navigation at a time. Five pages = ~22s total in our run.
- Save partial output every page in case DataDome flares back up mid-run.

## Gotchas & lessons

1. **DataDome interstitial body is only ~1.6 KB** — if `page.content().length < 5000` you're still on the captcha. Poll the title rather than waiting on `networkidle2` (which can sit forever during the JS challenge).
2. **Don't use `puppeteer-extra-plugin-stealth` on the real-Chrome path.** It changes nothing (you're already a real browser) and can introduce CDP-injection footprints DataDome flags.
3. **Ad cards (`[data-testid="serp-ia-card"]`) use `/adredir` hrefs**, not `/biz/`. Filter with `h3 a[href^="/biz/"]` to grab only organic results.
4. **`y-css-*` class names rotate** between deploys. Never match on them — use semantic selectors (`h3`, `aria-label`, `data-testid`) or positional leaf-text walks.
5. **Execution-context-destroyed errors** during `page.title()` are normal mid-redirect; just retry on the next poll iteration.
6. **`page.goto` with `waitUntil: "networkidle2"` on the home page often times out** because Yelp keeps a long-lived analytics websocket open. Use `domcontentloaded` and rely on the title-poll loop instead.
7. **Categories field is the last `<p>`** in the card. There's exactly one `<p>` in most cards (everything else is `<span>`), which is why "look at the last `<p>`" is reliable.
8. **`find_loc` query param must be URL-encoded** with the comma as `%2C` (e.g. `New+York%2C+NY`). Yelp redirects to a different SERP if the comma is raw.
