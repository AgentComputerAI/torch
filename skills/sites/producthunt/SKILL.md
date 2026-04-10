---
name: producthunt
description: Proven scraping playbook for producthunt.com homepage. Cloudflare-protected Next.js-ish SPA (no __NEXT_DATA__), but a puppeteer.connect() to the user's real Chrome via the real Chrome debug port walks straight through the CF challenge with zero stealth plugins. All homepage posts are server-rendered into the HTML as `section[data-test^="post-item-"]` blocks, grouped under `[data-test="homepage-section-{today|yesterday|last-week|last-month}"]`. Activate for any producthunt.com homepage scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Product Hunt (producthunt.com)

> Cloudflare-gated homepage that renders the full daily/weekly/monthly leaderboard directly into HTML. No JSON blob, no API replay — just cheerio over the DOM after a real-Chrome navigation.

## Detection

| Signal | Value |
|---|---|
| CDN | Cloudflare (`cf-ray`, `cf-mitigated: challenge`) |
| Framework | Custom React SSR (no `__NEXT_DATA__`, no `__APOLLO_STATE__`) |
| Anti-bot | Cloudflare managed challenge on bare curl → HTTP 403 |
| Auth | None required for homepage |
| robots.txt | Allows `/` |

Bare `curl https://www.producthunt.com/` → `HTTP/2 403` with `cf-mitigated: challenge`. A puppeteer.connect to the user's real Chrome (`127.0.0.1:9222`) clears the challenge in <1s with zero intervention — no stealth plugin, no proxy, no captcha solver.

## Architecture

Homepage is server-rendered HTML (~2.3 MB). All 92 posts for the current window are in the initial response under four sibling containers:

- `[data-test="homepage-section-today"]` — ~74 posts
- `[data-test="homepage-section-yesterday"]` — top 6
- `[data-test="homepage-section-last-week"]` — top 6
- `[data-test="homepage-section-last-month"]` — top 6

Each post is a `<section data-test="post-item-<id>">` block.

## Strategy used

- **Phase 0 (curl):** blocked by Cloudflare (`cf-mitigated: challenge`, 403).
- **Phase 1 (framework JSON):** no `__NEXT_DATA__`, no `window.__APOLLO_STATE__`. Skipped.
- **Phase 2 (browser):** `puppeteer.connect({ browserURL: "http://127.0.0.1:9222" })` → challenge clears instantly, HTML contains everything. Done.

## Stealth config that works

None. Just connect to real Chrome:

```js
const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
});
const page = await browser.newPage();
await page.goto("https://www.producthunt.com/", { waitUntil: "domcontentloaded" });
// Optional: poll title until it's not "Just a moment..."
await page.waitForSelector('section[data-test^="post-item-"]', { timeout: 15000 });
```

On teardown use `browser.disconnect()` — **never** `browser.close()` (would kill the user's real Chrome).

### Retry loop

The site occasionally returns a 502 Bad Gateway HTML page mid-session. Wrap the goto + extract in a 2–3 attempt retry that checks for `homepage-section-today` in `page.content()` before accepting the response.

## Extraction

```js
import * as cheerio from "cheerio";

function parsePost($, el) {
  const $el = $(el);
  const id = ($el.attr("data-test") || "").replace("post-item-", "");

  // Rank + name are baked into a single anchor: "1. Brila"
  const nameAnchor = $el.find(`[data-test^="post-name-"] a`).first();
  const slugHref = nameAnchor.attr("href") || "";          // "/products/brila-2"
  const raw = nameAnchor.text().trim();
  const m = raw.match(/^(\d+)\.\s*(.+)$/);
  const rank = m ? parseInt(m[1], 10) : null;
  const name = m ? m[2] : raw;

  // Tagline: the first <span> whose *direct* text is a real sentence
  // (skip the rank anchor, the "•" bullet, and contest pills).
  let tagline = "";
  $el.find("span").each((_, s) => {
    const direct = $(s).contents().filter((_, n) => n.type === "text").text().trim();
    if (!direct || direct === "•" || /^\d+\.\s/.test(direct) || direct.length < 5) return;
    if (!tagline) tagline = direct;
  });

  const topics = $el.find('a[href^="/topics/"]').map((_, a) => $(a).text().trim()).get();

  // Votes live inside [data-test="vote-button"]. Comments is the *other*
  // numeric <p> in the card (comments renders before votes in the DOM).
  const votes = $el.find('[data-test="vote-button"]').first().text().trim();
  let comments = null;
  $el.find("p").each((_, p) => {
    const t = $(p).text().trim();
    if (/^\d[\d,]*$/.test(t) && t !== votes && comments === null) comments = t;
  });

  return {
    id,
    rank,
    name,
    tagline,
    topics,
    url: slugHref ? `https://www.producthunt.com${slugHref}` : null,
    votes: votes ? parseInt(votes.replace(/[^\d]/g, ""), 10) : null,
    comments: comments ? parseInt(comments.replace(/[^\d]/g, ""), 10) : null,
  };
}

const $ = cheerio.load(html);
const sections = {};
for (const slug of ["today", "yesterday", "last-week", "last-month"]) {
  sections[slug] = $(`[data-test="homepage-section-${slug}"]`)
    .find('section[data-test^="post-item-"]')
    .map((_, el) => parsePost($, el)).get();
}
```

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| 1. UA + headers | no | real Chrome supplies them |
| 2. Cookies / session | no | fresh tab works |
| 3. Stealth plugin | no | real Chrome is not detected |
| 4. Real Chrome profile | **yes** | the single key to bypassing Cloudflare here |
| 5. CAPTCHA solver | no | challenge auto-clears |
| 6. Residential proxy | no | home IP is fine |
| 7. Rate limit | n/a | single request per scrape |
| 8. Device fingerprint | no | |
| 9. Behavioral | no | |

## Data shape

```json
{
  "id": "1094681",
  "rank": 1,
  "name": "Brila",
  "tagline": "One-page websites from real Google Maps reviews",
  "topics": ["Website Builder", "Artificial Intelligence"],
  "url": "https://www.producthunt.com/products/brila-2",
  "votes": 1076,
  "comments": 225
}
```

## Pagination / crawl architecture

Homepage is a single request — no pagination needed for the top 92. For historical days use `/leaderboard/daily/YYYY/MM/DD` (same markup, same `section[data-test^="post-item-"]` blocks). For per-product detail, hit `/products/<slug>`.

## Gotchas & lessons

1. **No `__NEXT_DATA__` / no Apollo state.** Don't waste time hunting for a JSON blob — the source of truth is the DOM.
2. **Cloudflare 502s.** Roughly 1-in-10 navigations return a bare `502: Bad gateway` HTML page. Check for the string `homepage-section-today` and retry (2–3 attempts is enough).
3. **Rank is embedded in the name anchor** as `"1. Brila"` — split on `^(\d+)\.\s`.
4. **Tagline is a plain `<span>`**, not an anchor. There's no tagline link — iterate spans and pick the first one with direct text that isn't a bullet or a rank.
5. **Comments vs votes ordering.** In the DOM, comments `<p>` comes *before* votes `<p>`. Use `[data-test="vote-button"]` to identify votes, then the other numeric `<p>` is comments.
6. **Contest pills** (e.g. "Alpha") are anchors to `/contests/...` that sit next to the name. Ignore them unless you want to capture contest membership.
7. **`browser.disconnect()` never `browser.close()`** when using `127.0.0.1:9222` — `close()` kills the user's real Chrome.
8. **Don't save the working script as `scrape.js`** in this repo — something in the environment rewrites that filename between runs. Use a unique name like `producthunt.mjs`.
