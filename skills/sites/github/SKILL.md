---
name: github
description: Proven scraping playbook for github.com. Server-rendered HTML, no anti-bot on public pages (trending, repos, users). Plain fetch + cheerio works — no browser, no headers, no auth. Activate for any github.com scrape that doesn't need the REST/GraphQL API.
metadata:
  author: torch
  version: "1.0.0"
---

# GitHub (github.com)

> GitHub's public HTML pages are fully server-rendered with no JS gating and no bot protection on unauthenticated GETs. A one-shot `fetch` + cheerio parse is all you need. Only reach for the REST API (`api.github.com`) when you hit the 60 req/hr unauthenticated limit or need structured fields (topics, license, default branch) not present on the HTML.

## Detection

| Signal | Value |
|---|---|
| CDN | GitHub edge (Varnish/Fastly) |
| Framework | Rails + Turbo, React islands |
| Anti-bot | None on public pages |
| Auth | Optional — anon works |
| Rate limit (HTML) | Generous, IP-based, soft |
| Rate limit (REST) | 60/hr unauth, 5000/hr with token |

## Architecture

- `/trending` is a normal Rails view. Repo cards are `<article class="Box-row">` inside `<div data-hpc>`.
- Note: the trending list size varies — historically 25, but currently GitHub often returns only ~10 cards. Don't hardcode the count.
- Repo pages (`/{owner}/{name}`) have data in multiple places: HTML meta tags, `<react-app>` embedded JSON payloads, and DOM nodes. For simple fields (stars, forks, description), raw DOM is easiest.
- Sitemaps at `/sitemap.xml` are huge — prefer targeted URL lists.

## Strategy used

Phase 0 curl → done. Data is in raw HTML, no protection headers, no JS required. Skip browser entirely.

## Extraction (trending)

```js
import { load } from 'cheerio';

const res = await fetch('https://github.com/trending', {
  headers: { 'User-Agent': 'Mozilla/5.0' },
});
const $ = load(await res.text());

$('article.Box-row').each((_, el) => {
  const $el = $(el);
  const fullName = $el.find('h2 a').attr('href').replace(/^\//, '').replace(/\s+/g, '');
  const description = $el.find('p').text().trim() || null;
  const language = $el.find('[itemprop="programmingLanguage"]').text().trim() || null;
  const stars = parseInt($el.find('a[href$="/stargazers"]').text().trim().replace(/,/g, '')) || 0;
  const forks = parseInt($el.find('a[href$="/forks"]').text().trim().replace(/,/g, '')) || 0;
  const starsToday = $el.find('span.d-inline-block.float-sm-right').text().trim().replace(/\s+/g, ' ');
  // ...
});
```

Language filter: `/trending/python?since=daily` — supports `daily|weekly|monthly` and any language slug.

## Anti-blocking summary

| Layer | Needed? |
|---|---|
| 1. Basic UA | Yes (any non-empty string) |
| 2. Full headers | No |
| 3. Cookies | No |
| 4. Stealth browser | No |
| 5+ | No |

A completely empty `fetch()` works too; the UA is cargo-culted.

## Data shape

```json
{
  "rank": 1,
  "owner": "NousResearch",
  "name": "hermes-agent",
  "full_name": "NousResearch/hermes-agent",
  "url": "https://github.com/NousResearch/hermes-agent",
  "description": "The agent that grows with you",
  "language": "Python",
  "language_color": "#3572A5",
  "stars": 44268,
  "forks": 5689,
  "stars_today": "6,485 stars today",
  "built_by": ["octocat", "..."]
}
```

## Pagination / crawl architecture

- Trending: single page, no pagination. Loop over `['daily','weekly','monthly'] × languages` if you need more.
- Repo lists (org/user): `?page=N&tab=repositories`, 30/page.
- For large crawls, prefer `api.github.com` with a token — sustains 5000 req/hr.

## Gotchas & lessons

1. `h2 a` href has leading slash AND embedded whitespace/newlines — strip both.
2. Trending shows a variable count (currently ~10, historically 25). Don't assert a length.
3. `built_by` avatars are inside `<img alt="@user">` — strip the `@`.
4. Stars/forks text contains thousands separators — remove commas before `parseInt`.
5. `span.d-inline-block.float-sm-right` holds "N stars today/this week/this month" — keep raw for transparency.
6. `itemprop="programmingLanguage"` is missing for repos without a detected primary language.
7. If you ever see a 429 on HTML: back off, or switch to `api.github.com` with a PAT.
