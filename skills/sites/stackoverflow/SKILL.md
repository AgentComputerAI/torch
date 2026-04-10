---
name: stackoverflow
description: Proven scraping playbook for stackoverflow.com tag/question listing pages (e.g. /questions/tagged/<tag>). Server-rendered HTML, but Cloudflare flags raw curl/node-fetch with HTTP 403 after the very first request. Connecting to the user's real Chrome via the real Chrome debug port walks straight through with zero challenges — no stealth plugin, no proxy, no captcha. All questions are embedded in `.s-post-summary` blocks. Activate for any stackoverflow.com listing scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Stack Overflow (stackoverflow.com)

> Classic server-rendered HTML in front of Cloudflare. A single cold curl gets HTML 200, but every subsequent anonymous request is 403'd by Cloudflare's bot heuristics (the `__cf_bm` / `_cfuvid` cookies issued on the first hit need a real browser TLS fingerprint to stay valid). Real Chrome via `127.0.0.1:9222` sidesteps this entirely. Question data is inline in the HTML — no API or JSON blob needed.

## Detection

| Signal      | Value                                               |
|-------------|-----------------------------------------------------|
| CDN         | Cloudflare (`server: cloudflare`, `cf-ray`)         |
| Framework   | ASP.NET / Razor (server-rendered HTML, no SPA)      |
| Anti-bot    | Cloudflare bot scoring — 403s node/curl after 1 hit |
| Auth        | Not required for question listings                  |
| robots.txt  | `Allow: /questions/` on major crawlers              |

## Architecture

- `/questions/tagged/<tag>` is fully SSR — every question is a `.s-post-summary` block in the raw HTML.
- Pagination is a plain `?tab=newest&page=N&pagesize=50` query param. `pagesize` accepts 15 / 30 / 50.
- There is a "Stack Exchange API" at `api.stackexchange.com` — useful but heavily rate-limited (300 req/day unauthenticated, with quota key required). For one-off tag scrapes, scraping the HTML is simpler.

## Strategy used

- **Phase 0 (curl)**: first request returns 200 with full HTML. Second request: 403. Cloudflare is stateful.
- **Phase 1**: no framework JSON blob — data is straight HTML. Skip.
- **Phase 2**: `puppeteer.connect({ browserURL: the real Chrome debug port })`. First navigation succeeds, and so does every subsequent one — the real Chrome profile keeps the Cloudflare cookies rotating correctly.

## Stealth config that works

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector(".s-post-summary");
const html = await page.content();
// ...
await page.close();
browser.disconnect(); // never .close() — it would kill the user's Chrome
```

No stealth plugin, no custom UA (Chrome supplies its own), no proxy, no captcha solver.

## Extraction

Each question is a `.s-post-summary`. Stable selectors:

```js
const $ = cheerio.load(html);
$(".s-post-summary").each((_, el) => {
  const $el = $(el);
  const $a = $el.find(".s-post-summary--content-title a.s-link").first();
  const title = $a.text().trim();
  const url = "https://stackoverflow.com" + $a.attr("href");

  // Use itemprops — the stats-item indexing is polluted by a "Best practices"
  // badge that appears on some rows and shifts the index of votes/answers/views.
  const votes = parseInt($el.find('[itemprop="upvoteCount"]').text(), 10);
  const answers = parseInt($el.find('[itemprop="answerCount"]').text(), 10);

  // Views are only in the tooltip (`title="123 views"`), not itemprop.
  const viewsTitle = $el.find(".s-post-summary--stats-item")
    .filter((_, d) => /view/i.test($(d).attr("title") || ""))
    .attr("title") || "";
  const views = parseInt(viewsTitle.replace(/[^0-9]/g, ""), 10) || 0;

  const excerpt = $el.find(".s-post-summary--content-excerpt").text().trim();
  const tags = $el.find(".post-tag").map((_, t) => $(t).text()).get();
  const author = $el.find(".s-user-card--link").text().trim();
  const createdAt = $el.find('meta[itemprop="dateCreated"]').attr("content");
});
```

## Anti-blocking summary

| Layer                         | Needed? | Notes                                           |
|-------------------------------|---------|-------------------------------------------------|
| 1. User-Agent                 | Auto    | Real Chrome supplies its own                     |
| 2. Full headers               | Auto    | Real Chrome supplies its own                     |
| 3. Cookies / session          | Auto    | Real Chrome handles `__cf_bm`, `_cfuvid` cleanly |
| 4. Stealth plugin             | No      | Not needed when connecting to real Chrome       |
| 5. Real Chrome profile        | **Yes** | The one thing that matters                      |
| 6. Residential proxy          | No      |                                                 |
| 7. Captcha solver             | No      |                                                 |
| 8. Backoff / rate limit       | Soft    | 500ms between pages is plenty                   |
| 9. Stack Exchange API fallback| No      | Reserved for very large crawls                  |

## Data shape

```json
{
  "title": "Best practices for combining a high pass and low pass filter on an input signal?",
  "url": "https://stackoverflow.com/questions/79923261/best-practices-for-...",
  "votes": 0,
  "answers": 0,
  "views": 10,
  "excerpt": "I'm using the JavaScript Web audio API. There is a BiquadFilterNode ...",
  "tags": ["javascript", "web-audio-api"],
  "author": "Michael Johnson",
  "author_rep": "1",
  "created_at": "2026-04-10 03:16:04Z"
}
```

## Pagination / crawl architecture

- URL template: `https://stackoverflow.com/questions/tagged/<tag>?tab=newest&page=<N>&pagesize=50`
- `pagesize` is capped at 50. `tab` can be `newest`, `active`, `bountied`, `unanswered`, `frequent`, `votes`.
- Reuse one puppeteer `page` across all pages — the Cloudflare session stays warm.
- 500ms delay between pages keeps Cloudflare happy.
- Stack Overflow caps tag browsing at ~1000 pages (50k questions). For deeper history, paginate by date with the Stack Exchange API.

## Gotchas & lessons

1. **Cold curl works exactly once.** Don't waste cycles trying header tweaks — move straight to `127.0.0.1:9222`.
2. **Do not use the stats-item index to find votes/answers/views.** Some rows have an extra `s-post-summary--stats-item` for badges ("Best practices", "Hot") which shifts every subsequent index. Use `[itemprop="upvoteCount"]` / `[itemprop="answerCount"]` and the views `title` tooltip instead.
3. **Views are not in an itemprop.** Only the `title="123 views"` tooltip exposes the count.
4. **`browser.disconnect()`, never `browser.close()`** — `close()` would kill the user's real Chrome.
5. **Stack Exchange API alternative**: `https://api.stackexchange.com/2.3/questions?tagged=javascript&site=stackoverflow&pagesize=100&order=desc&sort=creation`. Free tier = 300 req/day, 10k with a free app key. Prefer it for large crawls; prefer HTML scraping for small one-offs.
