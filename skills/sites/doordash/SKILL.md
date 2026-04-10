---
name: doordash
description: Proven scraping playbook for doordash.com. React SPA behind Cloudflare with server-rendered deal carousels on /browse/deals. Cloudflare challenge clears automatically with puppeteer-extra stealth (no captcha, no proxies, no login needed). Activate for any doordash.com target. Covers carousel selectors, price-token parsing, geo-fenced deals, and known virtualization pitfalls.
metadata:
  author: torch
  version: "1.0.0"
---

# DoorDash (doordash.com)

> React SPA served through Cloudflare. Deal pages are server-side rendered with all items inlined in the initial HTML — don't bother with the GraphQL endpoints. A headed stealth Puppeteer session clears the Cloudflare challenge automatically; no captcha solver or proxy needed.

## Detection

| Signal | Value |
|---|---|
| **CDN** | Cloudflare (`cf-ray`, `cf-mitigated`, "Just a moment..." on raw curl) |
| **Framework** | React SPA with SSR bootstrap |
| **Anti-bot** | Cloudflare Managed Challenge — clears via stealth plugin, no CAPTCHA |
| **Rendering** | SSR for deals carousels; GraphQL for personalized/auth surfaces |
| **Auth** | Not required for `/browse/deals` |
| **Geo** | Results vary by geoIP — default US egress lands in SF 94107 |

## Strategy

```
Puppeteer (stealth, headed)
  → wait for networkidle2
  → scroll to trigger lazy sections
  → parse rendered HTML with Cheerio
```

**Do NOT** hit the GraphQL endpoints:

- `/graphql/homeLandingPageStores`, `getGeoByIP`, etc. fire on page load but none return the deals feed.
- The typical `facetFeed` endpoint only fires on authenticated/personalized surfaces, not `/browse/deals`.
- The deals feed is **inlined in the SSR HTML** — parse that directly.

## Stealth config that works

```js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

const browser = await puppeteer.launch({
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
  ],
});

const page = await browser.newPage();
await page.goto("https://www.doordash.com/browse/deals", { waitUntil: "networkidle2" });
```

Standard Chrome UA is fine — no rotation needed. Cloudflare clears on its own once JS runs.

Verify you're past the challenge before parsing:

```js
const title = await page.title();
if (title !== "Deals | Doordash") {
  throw new Error(`Unexpected page title: ${title} — Cloudflare may still be challenging`);
}
```

## Selectors

All selectors use `data-testid` attributes (stable):

| Element | Selector |
|---|---|
| Carousel row | `[data-testid="LegoStandardCarouselContainer"]` |
| Carousel header link | First `<a href>` inside the carousel — text like "Frozen Deals", URL `/convenience/category?store_id=<id>&l1_id=<dept>&filter_key=deals_deals` |
| Carousel item | `[data-testid="LegoFlexibleItemSquareContainer"]` |
| Item product id | `data-item-id` attribute on the item |
| Item image | `img[alt]` when rendered; fallback `picture > source[srcset]` |
| Discount label | `[data-testid^="percent_discount"]` or `[data-testid^="dollar_discount"]` |
| Store CTA | `[data-testid="ActionCard"]` → `href="/convenience/store/<id>"` |

### Price parsing — CRITICAL

Prices are split across **three separate text nodes** inside each item. Do **not** regex a single string. Join the text node sequence:

```
['$', '3', '99', '$4.69', '15% off', 'Product Name']
  → sale = $3.99
  → original = $4.69
  → discount = "15% off"
  → name = last entry
```

Member-only deals look like:

```
['$', '7', '69', '$5.99 with store membership', 'Product Name']
```

The unit suffix (`"ea"`, `"lb"`) appears right after the cents token when present.

```js
const items = $('[data-testid="LegoFlexibleItemSquareContainer"]').map((_, el) => {
  const textNodes = [];
  $(el).find('*').contents().each((_, n) => {
    if (n.type === 'text' && n.data.trim()) textNodes.push(n.data.trim());
  });

  // Join $, dollars, cents into sale_price
  const dollarIdx = textNodes.indexOf('$');
  const salePrice = dollarIdx >= 0
    ? parseFloat(`${textNodes[dollarIdx + 1]}.${textNodes[dollarIdx + 2]}`)
    : null;

  // Name is the last non-price text node
  const name = textNodes[textNodes.length - 1];

  // ... extract original_price, discount, etc.
  return { item_id: $(el).attr('data-item-id'), name, sale_price: salePrice };
}).get();
```

## Anti-blocking summary

| Technique | Needed? | Notes |
|---|---|---|
| Stealth plugin | ✅ Yes | Required to clear Cloudflare challenge |
| Headed mode | ✅ Yes | `headless: false` — challenge fails in headless |
| Realistic UA | ✅ Standard Chrome | No rotation needed |
| Residential proxies | ❌ No | Datacenter IPs work |
| CAPTCHA solver | ❌ No | Cloudflare shows "Just a moment" but auto-clears |
| Cookie persistence | ❌ No | Single-session works |
| Login | ❌ No | `/browse/deals` is public |

## Data shape

```json
{
  "source": "https://www.doordash.com/browse/deals",
  "scraped_at": "2026-04-09T12:00:00Z",
  "carousel_count": 12,
  "item_count": 118,
  "carousels": [
    {
      "department": "Drinks Deals",
      "store_id": "1741509",
      "l1_id": "751",
      "category_url": "https://www.doordash.com/convenience/category?store_id=1741509&l1_id=751&filter_key=deals_deals&show_store_header=true",
      "item_count": 10
    }
  ],
  "items": [
    {
      "item_id": "11547785152",
      "name": "Signature Select Refreshe Purified Drinking Water Bottles (16.9 oz x 24 ct)",
      "sale_price": 3.99,
      "sale_unit": null,
      "original_price": 4.69,
      "discount_label": "15% off",
      "member_price_note": null,
      "image_url": "https://img.cdn4dd.com/...",
      "department": "Drinks Deals",
      "store_id": "1741509",
      "l1_id": "751",
      "category_url": "https://www.doordash.com/convenience/category?..."
    }
  ]
}
```

## Pagination

None on `/browse/deals` — one SSR response returns ~10 items × 12 carousels = ~120 items. To see more:

1. Open each carousel's `category_url` individually (store × department deals filter).
2. Set a delivery address first — the page is keyed on geoIP otherwise.

**Do NOT click the in-carousel next buttons.** DoorDash virtualizes the carousel and newly-injected items re-parent into sibling DOM nodes, so you end up attributing items to the wrong department/store.

## Gotchas

1. **Geo-fenced deals** — results depend on geoIP. Default US egress lands in SF 94107. To target a specific region, drive the address picker in the UI before scraping.

2. **Label vs reality mismatch** — "Frozen Deals" / "Produce Deals" labels come from DoorDash's department slice, but the actual items inside can be mixed (the feed reorders by availability). Trust `store_id` + `l1_id` over the human label.

3. **Lazy images** — only ~35% of items have a rendered `<img>` at SSR time; the rest are still in `<picture>` placeholders. Fall back to `picture > source[srcset]`.

4. **Three-node price split** — prices are split across `$`, dollars, cents text nodes. Joining them is required; regex on a single string will miss.

5. **Member-only prices** — look like `$5.99 with store membership` after the cents token instead of a strikethrough original.

6. **Page title check** — "Deals | Doordash" confirms you landed past Cloudflare. Any other title means the challenge didn't clear.

7. **Carousel virtualization** — as above, don't click next. Navigate via `category_url` instead.

## Output

`./output/doordash.json`
