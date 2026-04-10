---
name: apple
description: Proven scraping playbook for apple.com /shop/buy-* configurator pages (Mac, iPhone, iPad, Watch). Server-rendered HTML with all product, pricing and configuration data embedded as JS object literals on `window.PRODUCT_SELECTION_BOOTSTRAP` (and friends). Plain fetch — no anti-bot, no browser, no auth — but the blob is a JS object literal, not strict JSON, so you must brace-balance. Activate for any apple.com /shop/buy-mac, /shop/buy-iphone, /shop/buy-ipad, /shop/buy-watch URL.
metadata:
  author: torch
  version: "1.0.0"
---

# Apple Store buy-flow (apple.com/shop/buy-*)

> Apple's online store is a thin client over a giant SSR HTML page. The configurator state — every SKU, color, chip, price, customization option — is embedded inline as JavaScript object literals. No XHRs needed: fetch the page, find the bootstrap, extract the inner JSON. Sub-second scrape, 0 anti-bot.

## Detection

| Signal       | Value                                              |
|--------------|----------------------------------------------------|
| Server       | `Server: Apple` (custom edge, not Akamai/CF)       |
| Status       | 200 to bare `curl` with no UA tricks               |
| Framework    | Custom AS (Apple Store) buyflow — not Next/Nuxt    |
| Anti-bot     | None on `/shop/buy-*` HTML                          |
| robots.txt   | Allows `/shop/buy-*` for Googlebot etc.            |
| Auth         | None required                                       |

## Architecture

The buyflow page ships ~550 KB of HTML containing several `window.*_BOOTSTRAP =` blocks injected by the server:

- `window.PRODUCT_SELECTION_BOOTSTRAP` — **the one you want**. Holds `productSelectionData` with `products[]`, `mainDisplayValues` (colors, sizes, chips, prices), and `configDisplayValues` (memory, storage, adapter, keyboard).
- `window.PURCHASE_OPTIONS_BOOTSTRAP` — checkout/financing options.
- `window.APPLECARE_BOOTSTRAP` — AppleCare add-ons.
- `window.TRADEUP_BOOTSTRAP` — trade-in calculator data.
- `window.LOCATION_BOOTSTRAP`, `window.ECHO_CONFIG`, `window.GLOBAL_ASSETS`, `window.NAMED_ASSETS`, `window.ACI_CONFIG_MAP`, `window.BUYFLOW_MESSAGES_BOOTSTRAP` — UI/i18n/asset metadata.

The React-ish client just hydrates from these. There is **no `/api/` you need to call** for the configurator — everything is server-printed.

## Strategy used

- **Phase 0 (curl)** — `curl -sL` returns 200 with the full HTML. Done.
- Phase 1/2 skipped.

## Stealth config

None required. Plain `fetch` works. **One gotcha**: Node's undici occasionally hangs on Apple's edge over IPv6 (`ETIMEDOUT` from `internalConnectMultiple`). Force IPv4:

```js
import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
```

A Safari UA is enough headers-wise, but anything works.

## Extraction

The bootstrap is **NOT strict JSON** — it's a JavaScript object literal with unquoted keys at the top level:

```js
window.PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: { ...real JSON... } };
```

So `JSON.parse` on the whole thing fails. The trick is: the *inner* `productSelectionData` value **is** strict JSON (every key is quoted from there down). Slice it out with a brace-balancer.

```js
function extractBalancedJSON(src, startIdx) {
  let depth = 0, inStr = false, esc = false, strCh = null;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

const bootIdx  = html.indexOf("window.PRODUCT_SELECTION_BOOTSTRAP");
const marker   = "productSelectionData:";
const dataStart = html.indexOf("{", html.indexOf(marker, bootIdx) + marker.length);
const data     = JSON.parse(extractBalancedJSON(html, dataStart));
```

**Do not** try a regex like `/PRODUCT_SELECTION_BOOTSTRAP\s*=\s*(\{[\s\S]*?\});/` — lazy match stops at the first inner `}` and greedy match overshoots. Brace-balance is the only reliable way.

### Useful paths inside `productSelectionData`

- `products[]` — every selectable SKU. Each has:
  - `btrOrFdPartNumber` — Apple part number (e.g. `MDH74LL/A`), null for fully-configurable variants
  - `aosContainerPartNumber` — internal model code (e.g. `RO_MBA_M5_13_INCH_SILVER_GOO_2026`)
  - `type` — `PRECONFIGURED_BTR` or `CONFIGURABLE`
  - `priceKey` — joins into `mainDisplayValues.prices`
  - `dimensions` — color / chip / size keys
  - `productConfiguration` — option codes (memory, storage, keyboard, …)
- `mainDisplayValues.prices[priceKey]` — `amount` (number), `currentPrice.amount` ("$1,099.00"), `acmiPrice` (financing), promo info.
- `mainDisplayValues["chassis-dimensionColor"]` — color swatch metadata, with `variantOrder`.
- `mainDisplayValues["chassis-dimensionScreensize"]` — size labels.
- `mainDisplayValues["processor-cpuCoreCount-gpuCoreCount"]` — chip variants with CPU/GPU core counts.
- `configDisplayValues["memory-dimensionMemory"]`, `["storage-dimensionCapacity"]`, `["power_adapter-wattage"]`, `["keyboard-localizationCode"]` — customization menus.

### Cleaning labels

Header strings contain HTML and Apple's `<as-footnote>` web component that wraps `<sup>` markers. Strip them:

```js
const stripTags = (s) => s
  .replace(/<as-footnote[\s\S]*?<\/as-footnote>/g, "")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ")
  .replace(/\s+Footnote\s+\d+/gi, "")
  .replace(/\s+/g, " ")
  .trim();
```

## Anti-blocking summary

| Layer                | Needed? | Notes                                  |
|----------------------|---------|----------------------------------------|
| Custom UA            | no      | default fetch UA works                 |
| Cookies / session    | no      |                                        |
| Real Chrome connect  | no      |                                        |
| Stealth puppeteer    | no      |                                        |
| Proxy / residential  | no      |                                        |
| CAPTCHA solver       | no      |                                        |
| **IPv4 forced**      | **yes** | undici sometimes hangs on Apple's IPv6 |

## Data shape (one product)

```json
{
  "partNumber": "MDH74LL/A",
  "containerPartNumber": "RO_MBA_M5_13_INCH_SILVER_GOO_2026",
  "type": "PRECONFIGURED_BTR",
  "screenSize": "13-inch",
  "color": "Silver",
  "cpuCores": "10",
  "gpuCores": "8",
  "price": 1099,
  "priceDisplay": "$1,099.00",
  "priceKey": "13inch-silver-10-8",
  "isComingSoon": false,
  "configuration": {
    "keyboard": "065-CKGP",
    "power_adapter": "065-CLJ7",
    "memory": "065-CK9N",
    "storage": "065-CK9T",
    "processor": "065-CK9H",
    "...": "..."
  }
}
```

## Pagination / crawl

No pagination — one HTTP request returns the entire configurator. To cover Apple's full catalog, just enumerate buy-flow URLs:

- `/shop/buy-mac/{macbook-air,macbook-pro,imac,mac-mini,mac-studio,mac-pro}`
- `/shop/buy-iphone/{iphone-17,iphone-17-pro,iphone-air,iphone-16,iphone-16e}`
- `/shop/buy-ipad/{ipad-pro,ipad-air,ipad,ipad-mini}`
- `/shop/buy-watch/{apple-watch-ultra,apple-watch-series-10,apple-watch-se}`

Same bootstrap shape for all of them. Run them concurrently with a small pool (4–8) — Apple's edge is fine with that.

## Gotchas & lessons

1. **`PRODUCT_SELECTION_BOOTSTRAP` is a JS object literal, not JSON.** The outer key `productSelectionData:` is unquoted. You can't `JSON.parse` the whole thing. Slice the inner value with a brace-balancer.
2. **Lazy regex `\{[\s\S]*?\}` will not work** — it stops at the first inner `}`. Greedy regex grabs too much. Use the brace-balancer above.
3. **Undici + Apple + IPv6 = silent ETIMEDOUT.** Force IPv4 with `setGlobalDispatcher(new Agent({ connect: { family: 4 } }))`. `curl` is unaffected because it falls back faster.
4. **Headers contain `<as-footnote>` web components.** Strip them before stripping generic tags, otherwise you get "Footnote 1" leaking into labels.
5. **Two SKU `type`s exist per (color, size, chip):** `PRECONFIGURED_BTR` (build-to-retail with a real `btrOrFdPartNumber`) and `CONFIGURABLE` (custom build, no part number until ordered). Both share the same `containerPartNumber`. If you only want shippable SKUs, filter to `PRECONFIGURED_BTR`.
6. **Pricing is keyed by a flat string** like `13inch-silver-10-8`, not nested. Always look up via `prices[product.priceKey]`.
7. **Localization**: the page is auto-localized by geo (you may see `content-language: en-GB` even on apple.com). To force US pricing, hit `https://www.apple.com/shop/buy-mac/macbook-air` from a US IP, or use `https://www.apple.com/{cc}/shop/buy-mac/macbook-air` for other regions (fr, de, jp, …) — same bootstrap shape, localized prices and currency.
8. **Other bootstraps follow the same pattern.** `APPLECARE_BOOTSTRAP`, `TRADEUP_BOOTSTRAP`, `PURCHASE_OPTIONS_BOOTSTRAP` all use the same `key: { ...real JSON... }` wrapper trick — the same brace-balancer extracts them.
