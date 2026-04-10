---
name: arxiv
description: Proven scraping playbook for arxiv.org listing pages (e.g. /list/<category>/recent). Plain server-rendered HTML, no anti-bot, no JS needed — just fetch + cheerio. Use `?show=2000` to get every entry on a single page. Activate for any arxiv.org /list/ or /abs/ URL.
metadata:
  author: torch
  version: "1.0.0"
---

# arXiv (arxiv.org)

arXiv is the friendliest scraping target on the internet. The listing pages are static server-rendered HTML with zero anti-bot, zero CAPTCHAs, zero rate-limit headers in practice, and a dead-simple `?skip=&show=` pagination query string that accepts arbitrarily large page sizes (tested up to 2000). Skip the browser; skip cheerio-heavy recon; just fetch and parse.

## Detection

| Signal | Value |
|---|---|
| Server | Google Frontend + Varnish cache |
| CDN / anti-bot | None visible (`x-cache: HIT` is normal) |
| Framework | Plain server-rendered HTML (no React, no Next, no hydration) |
| Auth | None |
| robots.txt | Allows `/list/`, `/abs/`, `/pdf/` |

`curl -sL https://arxiv.org/list/cs.AI/recent` returns the full DOM with every paper already in place. HTTP/2 200, no challenge page.

## Architecture

Listing pages live at `https://arxiv.org/list/<category>/recent` (or `/<YYMM>` for a specific month). Each entry is rendered as a `<dt>` + `<dd>` pair inside `<dl id="articles">`:

- `<dt>` holds the arXiv ID, abstract link, and pdf/html/other format links.
- `<dd>` holds `.list-title`, `.list-authors`, `.list-subjects`, and optional `.list-comments` / `.list-journal-ref`.

Pagination is a query string: `?skip=<n>&show=<page_size>`. The page honors `show=2000` and will emit the entire category on a single response, so for "recent" you almost never need to paginate.

## Strategy used

- **Phase 0 (curl):** 200 OK, full HTML, `Total of N entries` visible. Gate A passed.
- **Phase 1 (framework):** Not needed — raw HTML already contains all target data.
- **Phase 2 (browser):** Skipped entirely.

Final approach: single `fetch()` + cheerio selectors.

## Stealth config that works

None required. A polite UA is courteous but not necessary:

```js
fetch(url, {
  headers: { 'user-agent': 'Mozilla/5.0 (torch scraper; +https://github.com/agentcomputer/torch)' }
});
```

No cookies, no referer, no proxy, no stealth plugin.

## Extraction

Use `?show=2000` to grab the entire listing in one shot:

```js
const LIST_URL = 'https://arxiv.org/list/cs.AI/recent?skip=0&show=2000';
const html = await (await fetch(LIST_URL)).text();
const $ = cheerio.load(html);

const total = (html.match(/Total of (\d+) entries/) || [])[1];

const strip = ($el) => $el.clone().children('.descriptor').remove().end().text().replace(/\s+/g, ' ').trim();

const papers = [];
$('dl#articles > dt').each((_, dt) => {
  const $dt = $(dt);
  const $dd = $dt.next('dd');

  const idLink = $dt.find('a[title="Abstract"]').first();
  const arxivId = (idLink.text().match(/arXiv:(\S+)/) || [])[1];

  papers.push({
    arxiv_id: arxivId,
    title: strip($dd.find('.list-title')),
    authors: $dd.find('.list-authors a').map((_, a) => $(a).text().trim()).get(),
    primary_subject: $dd.find('.list-subjects .primary-subject').text().trim(),
    subjects: strip($dd.find('.list-subjects')).split(';').map(s => s.trim()).filter(Boolean),
    comments: strip($dd.find('.list-comments')) || null,
    journal_ref: strip($dd.find('.list-journal-ref')) || null,
    abs_url: `https://arxiv.org/abs/${arxivId}`,
    pdf_url: `https://arxiv.org/pdf/${arxivId}`,
    html_url: `https://arxiv.org/html/${arxivId}`,
  });
});
```

The `.descriptor` span is the bold "Title:" / "Authors:" / "Subjects:" label — always strip it before taking `.text()`.

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| 1. Polite UA | optional | nice to have, not required |
| 2. Retry/backoff | optional | arxiv is very reliable |
| 3. Stealth headers | ❌ | |
| 4. puppeteer-extra-stealth | ❌ | |
| 5. Headed browser | ❌ | |
| 6. CAPTCHA solver | ❌ | |
| 7. Residential proxy | ❌ | |
| 8. Session auth | ❌ | |
| 9. Human-in-the-loop | ❌ | |

Zero layers used.

## Data shape

```json
{
  "arxiv_id": "2604.07236",
  "title": "How Much LLM Does a Self-Revising Agent Actually Need?",
  "authors": ["Seongwoo Jeong", "Seonil Son"],
  "primary_subject": "Artificial Intelligence (cs.AI)",
  "subjects": ["Artificial Intelligence (cs.AI)", "Computation and Language (cs.CL)"],
  "comments": "WIP",
  "journal_ref": null,
  "abs_url": "https://arxiv.org/abs/2604.07236",
  "pdf_url": "https://arxiv.org/pdf/2604.07236",
  "html_url": "https://arxiv.org/html/2604.07236"
}
```

## Pagination / crawl architecture

- **Recent listings:** use `?skip=0&show=2000` — single request, covers the whole week (~1000–1500 entries for cs.AI).
- **Monthly listings:** same trick on `/list/<cat>/<YYMM>` (e.g. `/list/cs.AI/2604`).
- **If ever >2000 entries:** loop `skip = 0, 2000, 4000…` until the count of `<dt>` elements drops below page size.
- **Abstracts / full metadata:** follow `abs_url` — or prefer the official arXiv OAI-PMH API (`https://export.arxiv.org/api/query`) for bulk metadata with abstracts.

No concurrency or checkpointing needed at this scale.

## Gotchas & lessons

1. The page reports total count inside a `<small>` block but across multiple nodes — match `Total of (\d+) entries` against the raw HTML rather than a cheerio selector.
2. `.list-subjects` contains both the primary subject (wrapped in `.primary-subject`) and cross-lists separated by `;`. Split on `;` after stripping the descriptor.
3. Each metadata row starts with a bold `.descriptor` label ("Title:", "Authors:", …). Remove it before reading text or you'll get `"Title: Foo"`.
4. If you need abstracts, don't scrape /abs/ pages — use the arXiv API (`export.arxiv.org/api/query?id_list=...`). It's officially supported, returns Atom XML, and avoids hammering the site.
5. The listing is global across the category, so `/list/cs.AI/recent` includes cross-listed papers whose `primary_subject` is *not* cs.AI. Filter on `primary_subject` if you only want native cs.AI submissions.
6. arXiv IDs use the `YYMM.NNNNN` scheme; don't assume 4 digits after the dot — newer months use 5.
