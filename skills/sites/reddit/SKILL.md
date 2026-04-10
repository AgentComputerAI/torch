---
name: reddit
description: Proven scraping playbook for reddit.com. Skip the browser entirely — Reddit exposes a public JSON API by appending `.json` to any listing URL (subreddit, user, comments, search). No auth, no cookies, no anti-bot beyond a User-Agent check. Activate for any reddit.com listing or thread URL.
metadata:
  author: torch
  version: "1.0.0"
---

# Reddit (reddit.com)

Reddit's old `.json` endpoints are still live and unauthenticated. Any listing page — `/r/<sub>`, `/r/<sub>/top`, `/user/<name>`, `/r/<sub>/comments/<id>`, `/search` — becomes a JSON feed by appending `.json`. Pagination is cursor-based via the `after` token. **The only thing that will get you blocked is using the default `python-requests` / `node-fetch` / `curl/` User-Agent** — set any browser UA and you're fine.

Do not use Puppeteer for Reddit. It's strictly slower and no more capable than a plain `fetch`.

## Detection

| Signal | Value |
|---|---|
| CDN | Fastly (`x-served-by: cache-...`) |
| Framework | React SPA for HTML, but `.json` endpoints are the canonical data source |
| Anti-bot | User-Agent filter only — blocks default library UAs with HTTP 429 "Too Many Requests" |
| Auth required | No (for public subs) |
| Rate limit | ~60 req/min unauthenticated per IP; be polite with 1–2s between requests |
| robots.txt | Disallows most crawlers except Googlebot, but `.json` endpoints work fine |

## Architecture

- `https://www.reddit.com/r/<sub>.json?limit=100&after=<token>` returns a `Listing` wrapper.
- `data.children` is an array of `{ kind: 't3', data: { ... } }` for posts (`t3`), `t1` for comments.
- `data.after` is the next-page cursor (null when exhausted). `data.before` for previous.
- Max `limit` is 100 per request. Listings cap at ~1000 items total (~10 pages) regardless of how far you paginate — this is a hard Reddit limit, not a scraper bug.
- Sort variants: `/r/<sub>/hot.json`, `/top.json?t=week`, `/new.json`, `/rising.json`, `/controversial.json`.

## Strategy used

**Phase 0 only.** `curl https://www.reddit.com/r/programming.json -A "Mozilla/..."` returns the full JSON listing. Skipped Phases 1–2 entirely. No browser, no stealth, no proxy.

## Stealth config that works

```js
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
```

That's the entire config. No cookies, no referer, no proxies needed.

## Extraction

```js
const j = await (await fetch(
  `https://www.reddit.com/r/${sub}.json?limit=100${after ? `&after=${after}` : ''}`,
  { headers: { 'User-Agent': UA } }
)).json();

const posts = j.data.children
  .filter(c => c.kind === 't3')
  .map(c => ({
    id:           c.data.id,
    title:        c.data.title,
    author:       c.data.author,
    score:        c.data.score,
    upvote_ratio: c.data.upvote_ratio,
    num_comments: c.data.num_comments,
    created_iso:  new Date(c.data.created_utc * 1000).toISOString(),
    url:          c.data.url_overridden_by_dest || c.data.url,
    permalink:    `https://www.reddit.com${c.data.permalink}`,
    domain:       c.data.domain,
    flair:        c.data.link_flair_text,
    is_self:      c.data.is_self,
    selftext:     c.data.selftext || null,
  }));

const nextCursor = j.data.after; // null when done
```

For a full thread with comments, hit `https://www.reddit.com${permalink}.json` — returns a 2-element array `[postListing, commentListing]`.

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| 1. Browser User-Agent | **Yes** | The only thing that matters. Default lib UAs get 429'd. |
| 2. Accept/Accept-Language headers | No | Nice to have, not required. |
| 3. Puppeteer stealth | No | Don't use a browser at all. |
| 4. Headed Chrome | No | — |
| 5. CAPTCHA solver | No | None encountered on `.json` endpoints. |
| 6. Residential proxy | No | Only if you get rate-limited at scale. |
| 7. Session cookies | No | Public reads work anonymously. |
| 8. TLS fingerprint (curl_cffi) | No | Plain `fetch`/`curl` works. |
| 9. Account rotation | No | — |

## Data shape

```json
{
  "id": "1s9jkzi",
  "title": "Announcement: Temporary LLM Content Ban",
  "author": "ChemicalRascal",
  "score": 2684,
  "upvote_ratio": 0.95,
  "num_comments": 282,
  "created_iso": "2026-04-01T12:48:20.000Z",
  "domain": "self.programming",
  "url": "https://www.reddit.com/r/programming/comments/1s9jkzi/...",
  "permalink": "https://www.reddit.com/r/programming/comments/1s9jkzi/...",
  "flair": null,
  "is_self": true,
  "selftext": "Hey folks, ...",
  "over_18": false,
  "stickied": true
}
```

## Pagination / crawl architecture

- Loop: `after = j.data.after` until `after == null` or you hit ~10 pages (Reddit's 1000-item cap).
- `limit=100` is the max per request. Use it.
- Sleep 1–2 seconds between requests to stay under the unauth rate limit.
- Dedupe by post `id` — stickied posts occasionally appear across pages.
- To crawl further back than 1000 items, use `/search.json?q=subreddit:<sub>&restrict_sr=1&sort=new&t=all` with `after=t3_<id>` cursoring, or switch to Pushshift-style archives (separate service).
- For multi-sub crawls, run per-subreddit serially or with very low concurrency (2–3) — IP rate limit is per-IP, not per-sub.

## Gotchas & lessons

1. **Default UA = instant 429.** `curl` with no `-A` flag, `node-fetch` defaults, `python-requests/2.x` all get blocked. Any plausible browser UA works. This is the single most common reason people think "Reddit blocks scrapers."
2. **1000-item hard cap** on any listing. Don't waste time trying to paginate further — `after` will eventually return `null` or repeat. If you need deeper history, use search endpoints or an archive.
3. **Stickied posts** appear at the top of every page within a subreddit — dedupe by `id`.
4. **Crossposts** have `crosspost_parent_list` containing the original post; decide whether to flatten or skip.
5. **`url_overridden_by_dest`** is the true outbound link; `url` can sometimes be the reddit permalink for self posts. Prefer `url_overridden_by_dest || url`.
6. **HTML entities** in `title` and `selftext_html` — if you use `selftext_html`, decode it. `selftext` is plain markdown and usually what you want.
7. **`created_utc` is a float seconds epoch**, not milliseconds. Multiply by 1000 for JS `Date`.
8. **NSFW / quarantined subs** require an `over18=1` cookie on the www domain, or use `old.reddit.com` which is less strict. For normal subs this isn't needed.
9. **Auth via OAuth (`oauth.reddit.com`)** gives you 600 req / 10 min instead of ~60, and avoids UA issues entirely. Worth it for large crawls — register a free script-type app at reddit.com/prefs/apps.
10. **Parallel torch agents clobbering `scrape.js`**: unrelated to Reddit, but if you're running multiple torch sessions in the same cwd, use a unique filename like `scrape-reddit.js` and a unique output path. (This bit us during the initial run.)
