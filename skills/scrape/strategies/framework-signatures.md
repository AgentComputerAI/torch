# Framework signatures

## Response header detection

| Header | Value contains | Framework | Data locations |
|--------|---------------|-----------|----------------|
| `X-Powered-By` | `Next.js` | Next.js | `__NEXT_DATA__` script tag, `/_next/data/` API |
| `X-Powered-By` | `Nuxt` | Nuxt.js | `__NUXT__` / `__NUXT_DATA__` script tag |
| `X-Powered-By` | `Express` | Express/Node | JSON APIs, check `/api/` paths |
| `Server` | `cloudflare` | Cloudflare (CDN) | Not a framework — note protection layer |
| `Link` | `</wp-content/` | WordPress | `/wp-json/wp/v2/` REST API, `ld+json` |
| `X-Shopify-Stage` | any | Shopify | `ld+json`, `/products.json`, `/collections.json` |
| `X-Drupal-Cache` | any | Drupal | `/jsonapi/`, `ld+json` |

## HTML signature detection

| Pattern | Framework | Search for | Skip |
|---------|-----------|------------|------|
| `<script id="__NEXT_DATA__"` | Next.js | Parse JSON from that script tag | `__NUXT__`, `__INITIAL_STATE__` |
| `window.__NUXT__` or `__NUXT_DATA__` | Nuxt.js | Parse embedded state object | `__NEXT_DATA__` |
| `window.__INITIAL_STATE__` | Vue/Redux SSR | Parse embedded state JSON | API sniffing if state has all data |
| `/wp-content/` in `<link>` tags | WordPress | `/wp-json/wp/v2/` API, `ld+json` | SPA state objects |
| `ng-version=` | Angular | XHR/fetch API calls | SSR data extraction |
| `data-reactroot` | React (CSR) | XHR/fetch API calls | SSR data objects (none exist) |
| `<script type="application/ld+json"` | Any (structured data) | Parse JSON-LD for product/article data | May be partial — verify completeness |
| `data-turbo-` | Rails/Turbo | Standard HTML selectors | SPA framework patterns |
| `_sveltekit` | SvelteKit | Embedded data in `__data` nodes | React/Vue patterns |

## Known major sites

| Domain | Architecture | Strategy | Notes |
|--------|-------------|----------|-------|
| `amazon.*` | Custom SSR | HTML selectors (`span.a-price`, `#productTitle`) | No JSON-LD, no `__NEXT_DATA__`, prices geo-locked |
| Shopify stores | Shopify Liquid | `ld+json` + `/products.json` | Append `.json` to product URLs |
| WordPress sites | WordPress | `/wp-json/wp/v2/` REST API | Check `robots.txt` for API access |
| `*.medium.com` | React SSR | `window.__APOLLO_STATE__` | GraphQL-backed |
| `linkedin.com` | React | Heavy protection, `ld+json` for public profiles | Requires auth for most data |
| `*.wixsite.com` | Wix | `window.warmupData` or `window.wixEmbedsAPI` | Complex state structure |

## Framework → search strategy

| Detected framework | Search first | Search if needed | Skip |
|--------------------|-------------|-----------------|------|
| Next.js | `__NEXT_DATA__` JSON | `/_next/data/` API routes | `__NUXT__`, `/wp-json/` |
| Nuxt.js | `__NUXT__` / `__NUXT_DATA__` | XHR/fetch API calls | `__NEXT_DATA__`, `/wp-json/` |
| WordPress | `/wp-json/wp/v2/` API | `ld+json`, HTML selectors | SPA state objects |
| Shopify | `ld+json` + `.json` URL suffix | `/products.json` endpoint | SPA state objects |
| React CSR | XHR/fetch API calls (browser required) | DOM selectors | SSR data objects |
| Angular | XHR/fetch API calls (browser required) | DOM selectors | SSR data objects |
| Custom SSR | HTML selectors, `ld+json` | API endpoints in traffic | SPA state objects |
| Static HTML | HTML selectors | Sitemaps for URL discovery | APIs, SPA state |
