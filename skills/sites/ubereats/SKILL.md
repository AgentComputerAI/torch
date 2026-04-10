---
name: ubereats
description: Proven scraping playbook for ubereats.com category pages (/category/<city>/<cuisine>). Fully server-rendered HTML behind Cloudflare, no anti-bot challenge on curl — plain GET returns every store card in the markup. No browser, no stealth, no proxy, no auth. One gotcha — Uber ships a 40KB+ CSP header that overflows Node's built-in fetch (undici HeadersOverflowError), so shell out to curl. Activate for any ubereats.com /category/ scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# Uber Eats (ubereats.com)

## TL;DR
`curl -sL --compressed <category_url>` returns a fully rendered HTML page with every store card in the DOM. Parse with cheerio. Pagination is `?page=N`, up to 4 pages (~21 stores/page) in a typical city/cuisine combo. No anti-bot defeats required.

## Detection

| Signal | Value |
|---|---|
| CDN | Cloudflare (`cf-ray`, `cf-cache-status: HIT`) |
| Framework | Custom SSR — React hydration payload in `<script type="application/json" id="__REDUX_STATE__">` |
| Anti-bot | **None** on /category/ pages via curl. `__cf_bm` cookie is set but not enforced. |
| Auth | Not required for SEO category pages |
| robots.txt | Allows /category/ |

## Architecture

Uber Eats ships a React SPA, but the /category/<city>/<cuisine> routes are fully server-rendered for SEO. Every store card is in the initial HTML as:

```html
<a data-testid="store-card" href="/store/<slug>/<storeUuid>">
  <h3>Store Name</h3>
  ...
</a>
```

The parent div wraps: image (+srcset), name, ETA ("25 min"), price tier ("$", "$$"), optional promo badge ("Spend $35, Save $7"), and a "New" label (see Gotchas).

A `window.__REDUX_STATE__` blob is also present but **avoid it** — it's embedded as a JSON-encoded *string* (with `\u0022` for quotes) and contains a nested `metaJson` field that uses URL-encoding (`%5C` for backslash) which trips any stock JSON parser. Cheerio on the DOM is far cleaner.

## Strategy used

- **Phase 0 (curl)** ✅ — HTTP 200, 1.2 MB HTML, all 21 store cards per page rendered inline. Done.
- Phase 1 — skipped (Phase 0 gate).
- Phase 2 — not needed.

## Fetch — the one gotcha

Uber's `content-security-policy` header is ~40KB of whitelisted domains. **Node's built-in `fetch` (undici) throws `UND_ERR_HEADERS_OVERFLOW`** because its default header size cap is 16 KB. Two options:

1. **Shell out to `curl`** (simplest, what this skill uses).
2. Or use undici with a custom `Agent({ maxHeaderSize: 65536 })`.

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

async function fetchPage(url) {
  const { stdout } = await execFileP(
    'curl',
    ['-sL', '--compressed', '-A', UA, '-H', 'accept-language: en-US,en;q=0.9', url],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  return cheerio.load(stdout);
}
```

A plain User-Agent (Chrome desktop) is enough. No cookies, no referer, no stealth.

## Extraction

```js
$('a[data-testid="store-card"]').each((_, el) => {
  const $a = $(el);
  const href = $a.attr('href');                    // /store/<slug>/<uuid>
  const name = $a.find('h3').text().trim();
  const $card = $a.parent();                       // card container
  const img = $card.find('img').first().attr('src');
  const text = $card.text().replace(/\s+/g, ' ').trim();

  const eta       = text.match(/(\d+)\s*min/)?.[1];
  const priceTier = text.match(/•\s*(\${1,4})(?!\d)/)?.[1];   // $, $$, $$$
  const promo     = text.match(/Spend \$\d+,?\s*Save \$\d+/)?.[0];
  // rating/reviews: "4.7 (1,234)" — absent on anonymous SEO page (see gotchas)
  const rating    = text.match(/(\d\.\d)\s*\((\d[\d,]*)\)/);

  const m = href.match(/\/store\/([^/]+)\/([^/?#]+)/);
  const slug      = m ? decodeURIComponent(m[1]) : null;
  const storeUuid = m?.[2];
});
```

## Pagination

```js
// On page 1, read max page number from pagination links:
let max = 1;
$('a[href*="?page="]').each((_, el) => {
  const m = ($(el).attr('href') || '').match(/\?page=(\d+)/);
  if (m) max = Math.max(max, parseInt(m[1], 10));
});
```

Then loop `?page=2 … ?page=N`. The pagination block often shows a "5" button but real data caps out earlier — **stop when a page returns 0 cards** (empty pages render an empty grid without an error). Page size is 21 for category pages. SF × pizza returned 84 stores across 4 real pages.

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| 1. UA spoof | ✅ | Real Chrome UA; bare curl UA also works but don't tempt fate |
| 2. Headers (accept-lang) | Recommended | |
| 3. Cookies / session | ❌ | Not needed |
| 4. Stealth plugin / headed | ❌ | |
| 5. CAPTCHA solver | ❌ | |
| 6. Residential proxy | ❌ | |
| 7. Real-Chrome endpoint | ❌ | |
| 8. Auth | ❌ | |
| 9. Rate limiting | 400 ms between pages is plenty | |

## Data shape

```json
{
  "name": "Tony's Pizza Napoletana",
  "slug": "tonys-pizza-napoletana",
  "storeUuid": "fKviGypwSDaWy6nGC2wQuQ",
  "url": "https://www.ubereats.com/store/tonys-pizza-napoletana/fKviGypwSDaWy6nGC2wQuQ",
  "eta": "47 min",
  "priceTier": "$$",
  "rating": null,
  "reviewCount": null,
  "promo": null,
  "image": "https://tb-static.uber.com/prod/image-proc/.../f6deb0afc24fee6f4bd31a35e6bcbd47.jpeg"
}
```

## Gotchas & lessons

1. **Ratings are absent on anonymous category pages.** Without a delivery address cookie, Uber labels every store as "New" (no star rating, no review count). If you need ratings, you must either (a) set a delivery address via the eater UI and replay the authenticated GraphQL call to `/_p/api/getFeedV1`, or (b) scrape the individual `/store/<slug>/<uuid>` PDPs, which *do* include rating/review count in their SSR payload.
2. **Node fetch fails on Uber's CSP header size.** Use curl or raise `maxHeaderSize`. See Fetch section above.
3. **The `__REDUX_STATE__` blob is a trap.** It's JSON-string-encoded with Unicode escapes (`\u0022`), and a nested `metaJson` field uses URL-encoding (`%5C"`) that breaks the outer JSON once you unescape. Parse the DOM instead.
4. **Page count in the paginator is aspirational.** SF × pizza shows "1 2 3 4 5" buttons but page 5 returns zero cards. Loop until `items.length === 0`.
5. **Card count is stable at 21/page** for category pages.
6. **Cloudflare issues `__cf_bm` on first response** but does not challenge subsequent requests for /category/ paths in the same run. No cookie jar required.
7. **URL-encoded slugs in hrefs** — names with `&`, spaces, apostrophes become `%26`, `%20`, etc. Run `decodeURIComponent()` if you want the human slug.
8. **Price tier parsing is fragile** — the bullet separator can be `  •  ` (two spaces each side). Use `/•\s*(\${1,4})/` rather than matching on literal whitespace.
