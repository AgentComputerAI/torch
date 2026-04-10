---
name: hackernews
description: Proven scraping playbook for news.ycombinator.com. Server-rendered static HTML (Arc/CL app), no CDN, no anti-bot, no JS required. Plain fetch + cheerio parses the front page in milliseconds. Activate for any news.ycombinator.com target. Covers front-page selectors, pagination, and the official Firebase API alternative.
metadata:
  author: torch
  version: "1.0.0"
---

# Hacker News (news.ycombinator.com)

> HN is the easiest scrape target on the internet. The entire front page is a single server-rendered HTML table with stable, decade-old class names. No cookies, no JS, no rate limits at normal pace. If you need more than a few pages, use the official Firebase API instead of scraping.

## Detection

| Signal     | Value |
|------------|-------|
| Server     | `nginx` (Arc / Common Lisp app behind it) |
| CDN        | None |
| Framework  | Server-rendered HTML tables, no SPA |
| Anti-bot   | None |
| Auth       | Not required for reading |
| robots.txt | Allows `/`, disallows `/x?`, `/r?`, `/vote?`, etc. Crawl-delay: 30 |

## Architecture

Every listing page (`/news`, `/newest`, `/front`, `/ask`, `/show`, `/jobs`, `?p=N`) is a single `<table id="hnmain">` with 30 stories. Each story is **two `<tr>` rows**:

1. `tr.athing.submission` — id, rank, title link, site domain
2. the next `<tr>` — subtext row with points, user, age, comments

The "More" link at the bottom (`a.morelink[rel=next]`) gives the next page URL, e.g. `?p=2`.

## Strategy used

- **Phase 0 (curl)**: HTTP 200, all data in raw HTML. **Gate A passed — skipped browser entirely.**
- Phase 1/2 not needed.

## Stealth config that works

None needed. Plain `fetch` works. A generic UA is polite:

```js
headers: { 'user-agent': 'Mozilla/5.0 (compatible; torch-scraper/1.0)' }
```

Respect `Crawl-delay: 30` from robots.txt if you hit many pages.

## Extraction

```js
import * as cheerio from 'cheerio';

const html = await (await fetch('https://news.ycombinator.com')).text();
const $ = cheerio.load(html);
const items = [];

$('tr.athing.submission').each((_, el) => {
  const $row = $(el);
  const id = $row.attr('id');
  const rank = parseInt($row.find('.rank').text(), 10);
  const $a = $row.find('.titleline > a').first();
  const title = $a.text().trim();
  const url = $a.attr('href');
  const site = $row.find('.sitestr').text().trim() || null;

  const $sub = $row.next().find('.subtext .subline');
  const points = parseInt($sub.find('.score').text(), 10) || 0;
  const user = $sub.find('.hnuser').text().trim() || null;
  const time = ($sub.find('.age').attr('title') || '').split(' ')[0] || null;
  const age = $sub.find('.age a').text().trim();
  const cmatch = $sub.find('a').last().text().match(/(\d+)\s*comment/);
  const comments = cmatch ? parseInt(cmatch[1], 10) : 0;

  items.push({ rank, id, title, url, site, points, user, comments, age, time,
               hn_url: `https://news.ycombinator.com/item?id=${id}` });
});
```

Key selectors (stable for 10+ years):

- `tr.athing.submission` — story row
- `.rank` — rank number (includes trailing `.`)
- `.titleline > a` — title + outbound URL
- `.sitestr` — domain badge
- `.subtext .subline .score` — "N points"
- `.subtext .subline .hnuser` — submitter
- `.subtext .subline .age` — `title` attr has ISO timestamp + unix epoch
- last `<a>` in subline — "N comments" (or "discuss" if zero)

## Anti-blocking summary

| Layer              | Needed? | Notes |
|--------------------|---------|-------|
| 1. User agent      | optional | any UA works; courtesy only |
| 2. Headers         | no      | — |
| 3. Stealth plugin  | no      | no browser needed |
| 4. Headed mode     | no      | — |
| 5. CAPTCHA solver  | no      | — |
| 6. Residential proxy | no    | — |
| 7. Session warmup  | no      | — |
| 8. Request throttle | if bulk | honor 30s crawl-delay for polite bulk |
| 9. CAPTCHA farms   | no      | — |

## Data shape

```json
{
  "rank": 1,
  "id": "47710907",
  "title": "Many African families spend fortunes burying their dead",
  "url": "https://davidoks.blog/p/how-funerals-keep-africa-poor",
  "site": "davidoks.blog",
  "points": 89,
  "user": "powera",
  "comments": 61,
  "age": "2 hours ago",
  "time": "2026-04-09T22:10:10",
  "hn_url": "https://news.ycombinator.com/item?id=47710907"
}
```

## Pagination / crawl architecture

- Front page: `https://news.ycombinator.com/news?p=1..N` (30 items/page, typically p=1..5).
- Next URL: read `a.morelink[rel=next]` `href` — don't hardcode `?p=`.
- Listings: `/news`, `/newest`, `/front`, `/ask`, `/show`, `/jobs`.
- Sleep ≥ 30s between pages if scraping many (robots.txt `Crawl-delay: 30`).

**For anything beyond the front page, prefer the official API.** HN publishes a full Firebase API at `https://hacker-news.firebaseio.com/v0/`:

- `topstories.json` → array of top 500 story IDs
- `newstories.json`, `beststories.json`, `askstories.json`, `showstories.json`, `jobstories.json`
- `item/<id>.json` → full story or comment
- `user/<username>.json` → user profile

No key, no rate limit headers, no HTML parsing. Use this for full-archive or historical scrapes. Only scrape HTML when you specifically need the **ranked front page** as displayed (the API gives IDs in rank order for topstories, so even that works via API).

## Gotchas & lessons

1. **Two rows per story.** `tr.athing.submission` is the title row; the subtext lives in `tr.athing.submission + tr`. Use `.next()`, not a descendant selector.
2. **Rank includes a trailing period** (`"1."`). `parseInt` strips it fine.
3. **Job posts have no user or comment count** — subtext has just an age link. Handle `points=0`, `user=null`, `comments=0` gracefully (the code above already does).
4. **Dead / flagged / [dupe] posts** still render; the title link text contains the marker. Filter on `.titleline .titleline-text` if you want to exclude them.
5. **`age` attr timestamp format**: `title="2026-04-09T22:10:10 1775772610"` — ISO 8601 space-separated unix epoch. Split on space.
6. **`.sitestr` is missing** for Ask HN / Show HN / job posts (self-posts). Default to `null`.
7. **Pagination link is `?p=2`, not `?page=2`**. Always read the morelink href instead of constructing it.
8. **robots.txt `Crawl-delay: 30`** is generous — respect it. HN's dang has historically rate-limited aggressive scrapers by IP.
9. **If you need comments, use the Firebase API**, not HTML. Comment trees are paginated weirdly in HTML and collapse on load.
