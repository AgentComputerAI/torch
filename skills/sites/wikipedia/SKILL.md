---
name: wikipedia
description: Proven scraping playbook for en.wikipedia.org (and other language wikis). Server-rendered static HTML, no anti-bot, no JS required. Plain fetch + cheerio works. One important gotcha — since ~2023, section headings are wrapped in `<div class="mw-heading mw-heading2">` so `h2` is no longer a direct child of `.mw-parser-output`. Activate for any wikipedia.org article URL. Prefer the REST/Action API for structured data.
metadata:
  author: torch
  version: "1.0.0"
---

# Wikipedia (wikipedia.org)

> Wikipedia is the easiest possible scrape target: plain server-rendered HTML, generous robots.txt, no bot detection, no rate limiting for reasonable use, and an official API if you want to skip HTML entirely. The only real trap is the 2023+ heading-wrapper div — scrapers that look for `h2` as a direct child of `.mw-parser-output` will silently return zero sections.

## Detection

| Signal | Value |
|---|---|
| CDN | Wikimedia / Varnish (`x-cache`, `x-varnish`) |
| Framework | MediaWiki (server-rendered PHP) |
| Anti-bot | None |
| Auth | Not required for reads |
| robots.txt | Permissive for well-behaved bots; send a descriptive UA |
| JS required | No — full article in initial HTML |

## Architecture

Every article lives at `https://<lang>.wikipedia.org/wiki/<Title>` and is fully server-rendered. The article body is inside:

```
#mw-content-text > .mw-parser-output
```

Direct children of `.mw-parser-output` include `<p>`, `<ul>`, `<ol>`, tables, figures, and — crucially — `<div class="mw-heading mw-heading2/3/4">` wrappers around each section heading. Inside that wrapper is the real `<h2>`/`<h3>`/`<h4>` plus an edit-section link. There is no `.mw-headline` span anymore on modern output; the heading text is just the direct text of the `h2`/`h3`/`h4`.

Reference list: `ol.references > li`, with the citation text inside `.reference-text`.
Categories: `#mw-normal-catlinks ul li a`.

## Strategy used

- **Phase 0 (curl)**: Full article HTML returned in ~165 KB, no challenge, no 403. Gate A passed.
- **Phase 1**: Skipped — no framework JSON to extract; HTML is the source of truth.
- **Phase 2**: Skipped — no browser needed.

Total time to extract a full article: < 1 second.

## Alternative: official APIs (use these for structured data)

If you don't need HTML-level fidelity, skip scraping entirely:

- **REST API** — `https://en.wikipedia.org/api/rest_v1/page/summary/<Title>` returns title, extract, thumbnail, description.
- **REST API (HTML)** — `https://en.wikipedia.org/api/rest_v1/page/html/<Title>` returns clean Parsoid HTML (easier to parse than the skinned article page).
- **Action API** — `https://en.wikipedia.org/w/api.php?action=parse&page=<Title>&format=json&prop=sections|text|links|categories` returns everything as JSON.
- **Dumps** — for bulk work, use `dumps.wikimedia.org` instead of crawling.

Always send a descriptive `User-Agent` (Wikimedia's UA policy requires it): e.g. `torch-scraper/1.0 (https://github.com/agentcomputer/torch)`.

## Stealth config that works

None required. Plain `fetch` with a descriptive UA is enough:

```js
const res = await fetch(url, {
  headers: { "User-Agent": "torch-scraper/1.0 (https://github.com/agentcomputer/torch)" },
});
```

## Extraction

```js
import * as cheerio from "cheerio";

const $ = cheerio.load(html);
const title = $("#firstHeading").text().trim();
const lastModified = $("#footer-info-lastmod").text().trim();
const content = $("#mw-content-text .mw-parser-output").first();

const sections = [];
let current = { heading: "Introduction", level: 1, paragraphs: [] };

content.children().each((_, el) => {
  const $el = $(el);
  const tag = el.tagName?.toLowerCase();

  // GOTCHA: modern Wikipedia wraps headings in <div class="mw-heading mw-heading2">
  const isHeadingWrapper = tag === "div" && $el.hasClass("mw-heading");
  const $heading = isHeadingWrapper ? $el.find("h2,h3,h4").first() : null;
  const headingTag = $heading?.length ? $heading[0].tagName.toLowerCase() : null;

  if (/^h[2-4]$/.test(tag || "") || headingTag) {
    if (current.paragraphs.length) sections.push(current);
    const ht = headingTag || tag;
    const headingText =
      ($heading || $el).find(".mw-headline").text().trim() || // old skin
      ($heading || $el).text().trim();                         // new skin
    current = { heading: headingText, level: parseInt(ht[1], 10), paragraphs: [] };
  } else if (tag === "p") {
    const text = $el.text().replace(/\[\d+\]/g, "").trim();
    if (text) current.paragraphs.push(text);
  } else if (tag === "ul" || tag === "ol") {
    $el.children("li").each((_, li) => {
      const t = $(li).text().replace(/\[\d+\]/g, "").trim();
      if (t) current.paragraphs.push("• " + t);
    });
  }
});
if (current.paragraphs.length) sections.push(current);

// References
const references = [];
$("ol.references li").each((_, li) => {
  references.push({
    id: $(li).attr("id") || "",
    text: $(li).find(".reference-text").text().trim() || $(li).text().trim(),
  });
});

// Categories
const categories = [];
$("#mw-normal-catlinks ul li a").each((_, a) => categories.push($(a).text().trim()));
```

Strip citation markers with `.replace(/\[\d+\]/g, "")` before storing paragraph text — Wikipedia inlines footnote anchors like `[1]`, `[2]` that pollute the output otherwise.

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| Descriptive UA | Yes | Wikimedia UA policy; unbranded UAs may be blocked |
| Stealth plugin | No | No bot detection |
| Headed browser | No | No JS needed |
| Residential proxy | No | No IP blocks |
| CAPTCHA solver | No | None served |
| Real Chrome profile | No | Overkill |

## Data shape

```json
{
  "url": "https://en.wikipedia.org/wiki/Web_scraping",
  "title": "Web scraping",
  "lastModified": "This page was last edited on 9 April 2026, at 19:39 (UTC).",
  "scrapedAt": "2026-04-10T…Z",
  "sectionCount": 18,
  "sections": [
    { "heading": "Introduction", "level": 1, "paragraphs": ["Web scraping, web harvesting, …"] },
    { "heading": "History",      "level": 2, "paragraphs": ["…"] },
    { "heading": "United States","level": 3, "paragraphs": ["…"] }
  ],
  "references": [{ "id": "cite_note-1", "text": "…" }],
  "categories": ["Web scraping"]
}
```

## Pagination / crawl architecture

Single article = single request. For bulk crawling:

1. Use a **category membership** query (`action=query&list=categorymembers&cmtitle=Category:…`) to enumerate titles.
2. Or use the **monthly XML dumps** at `dumps.wikimedia.org` — infinitely faster than crawling HTML.
3. Concurrency: be polite — ≤ 5 parallel requests, back off on 429 (extremely rare).

## Gotchas & lessons

1. **Heading wrapper div (2023+)** — the single biggest trap. Scrapers that select `.mw-parser-output > h2` return zero sections on modern articles. Always look for `div.mw-heading` wrappers too.
2. **`.mw-headline` is gone** on the new Vector skin. Fall back to the heading element's own text.
3. **Citation markers** (`[1]`, `[2]`) appear inline inside `<p>` text — strip them with a regex or they'll litter your output.
4. **Infoboxes** (`.infobox`) are tables, not paragraphs — handle them separately if you need structured facts. For most articles, the Action API's `prop=pageprops` or Wikidata is cleaner.
5. **Disambiguation pages** look structurally identical to articles but the content is a list of links — detect via `<table id="disambigbox">` or the category `Category:Disambiguation pages`.
6. **Mobile domain** (`en.m.wikipedia.org`) has a different DOM — always use the canonical `en.wikipedia.org`.
7. **User-Agent**: Wikimedia explicitly blocks generic UAs like `python-requests/…` and empty UAs. Send a descriptive string with a contact URL.
8. **Prefer the API** for anything structured. HTML scraping is only justified when you need the exact rendered article body.
