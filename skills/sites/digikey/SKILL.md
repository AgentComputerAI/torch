---
name: digikey
description: Proven scraping playbook for digikey.com /en/products/category/ listings. Cloudflare challenge (cf-mitigated: challenge) blocks bare curl with HTTP 403, but a puppeteer connection to the user's real Chrome via TORCH_CHROME_ENDPOINT walks straight through with zero stealth, no captcha, no proxy, no auth. Listings are server-rendered into a single `<table>` whose rows contain `a[href*="/en/products/detail/"]`; every parametric column (Core Processor, Speed, RAM, package, etc.) is just a `<th>`/`<td>` pair you can zip. Activate for any digikey.com /en/products/category/ scrape.
metadata:
  author: torch
  version: "1.0.0"
---

# DigiKey (digikey.com)

> Cloudflare-protected catalog with a fully server-rendered HTML product table. Real Chrome connect kills the challenge in one navigation. Pure DOM scrape — no API replay needed, every parametric column is in the table.

## Detection

| Signal | Value |
|---|---|
| CDN | Cloudflare (`server: cloudflare`, `cf-ray`) |
| Anti-bot | Cloudflare challenge — `cf-mitigated: challenge`, HTTP 403 on bare curl |
| Framework | Server-rendered HTML (no `__NEXT_DATA__`, no SPA hydration needed) |
| Auth | Not required |
| Captcha | None visible after CF clears |

Bare `curl https://www.digikey.com/en/products/category/microcontrollers/685` returns:

```
HTTP/2 403
cf-mitigated: challenge
server: cloudflare
```

…with a 4.7KB challenge HTML body. Fetch / node-fetch / requests are all blocked the same way.

## Architecture

- Single canonical category URL: `/en/products/category/<slug>/<id>` (e.g. microcontrollers = 685).
- HTML returned by Cloudflare-cleared session contains a `<table>` with:
  - `<thead><th>` cells for ~28 columns: blank (image), `Mfr Part #`, `Quantity Available`, `Price`, `Tariff Status`, `Series`, `Package`, `Product Status`, `DigiKey Programmable`, `Core Processor`, `Core Size`, `Speed`, `Connectivity`, `Peripherals`, `Number of I/O`, `Program Memory Size`, `Program Memory Type`, `EEPROM Size`, `RAM Size`, `Voltage - Supply (Vcc/Vdd)`, `Data Converters`, `Oscillator Type`, `Operating Temperature`, `Grade`, `Qualification`, `Mounting Type`, `Supplier Device Package`, `Package / Case`.
  - `<tbody><tr>` rows, 25 per page by default. Each row has `a[href*="/en/products/detail/<mfg>/<part>/<digikey-id>"]` and a thumbnail `<img>` from `mm.digikey.com`.
- Column set varies by category (microcontrollers exposes core/speed/memory; capacitors expose capacitance/voltage/ESR/etc.). Don't hard-code columns — read `<thead>` and zip.
- The only XHR seen during page load is `/en/api/scTools/Header2021/GeoInfo` (geo banner). No internal product API call is needed — everything is in the SSR HTML.

## Strategy used

- Phase 0 (curl): **failed** — 403 + Cloudflare challenge.
- Phase 1 (framework recon): skipped — site is plain SSR, no Next/Nuxt/Shopify/WP fingerprints.
- Phase 2 (browser): **`puppeteer-core` + `puppeteer.connect({ browserURL: TORCH_CHROME_ENDPOINT })`**. The challenge clears on first navigation in the user's real Chrome. No stealth plugin, no captcha solver, no proxy.

## Code

```js
import puppeteer from "puppeteer-core";
import fs from "fs";

const URL = "https://www.digikey.com/en/products/category/microcontrollers/685";
const browser = await puppeteer.connect({ browserURL: process.env.TORCH_CHROME_ENDPOINT });
const page = await browser.newPage();
await page.setViewport({ width: 1480, height: 950 });

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('a[href*="/en/products/detail/"]', { timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500)); // let parametric cells finish painting

  const data = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    const table = tables.find(t => t.querySelector('a[href*="/en/products/detail/"]'));
    if (!table) return { headers: [], rows: [] };
    const headers = [...table.querySelectorAll('thead th')].map(th => th.innerText.trim().replace(/\s+/g, ' '));
    const rows = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim().replace(/\s+/g, ' '));
      const link = tr.querySelector('a[href*="/en/products/detail/"]');
      if (!link) continue;
      const img = tr.querySelector('img');
      const obj = {
        detailUrl: new URL(link.getAttribute('href'), location.origin).toString(),
        image: img?.src ?? null,
      };
      headers.forEach((h, i) => { if (h) obj[h] = cells[i] ?? ""; });
      rows.push(obj);
    }
    return { headers, rows };
  });

  fs.writeFileSync("output/digikey.json", JSON.stringify({
    source: URL,
    scrapedAt: new Date().toISOString(),
    columns: data.headers,
    count: data.rows.length,
    products: data.rows,
  }, null, 2));
} finally {
  await page.close();
  browser.disconnect(); // never .close() — that would kill the user's Chrome
}
```

## Anti-blocking summary

| Layer | Needed? | Notes |
|---|---|---|
| 1. Realistic UA / headers | n/a | Real Chrome supplies them |
| 2. Stealth plugin | **no** | Not used; CF clears anyway |
| 3. Headed Chromium | **no** | Use `connect()`, not `launch()` |
| 4. Real Chrome profile | **yes** | `TORCH_CHROME_ENDPOINT` is the whole trick |
| 5. CAPTCHA solver | no | No interactive challenge |
| 6. Residential proxy | no | Datacenter IP fine via real Chrome |
| 7. Session warmup | no | First navigation works |
| 8. Auth | no | Public catalog |
| 9. TLS fingerprint | n/a | Real Chrome handles it |

## Data shape

```json
{
  "detailUrl": "https://www.digikey.com/en/products/detail/microchip-technology/PIC16F15213-I-SN/12807336",
  "image": "https://mm.digikey.com/Volume0/.../MFG_150~C04-057~SN,OA~8_tmb(64x64).jpg",
  "Mfr Part #": "PIC16F15213-I/SN IC MCU 8BIT 3.5KB FLASH 8SOIC Microchip Technology",
  "Quantity Available": "12,594 In Stock",
  "Price": "1 : $0.38000 Tube",
  "Series": "PIC® 16F, Functional Safety (FuSa)",
  "Package": "Tube",
  "Product Status": "Active",
  "Core Processor": "PIC",
  "Core Size": "8-Bit",
  "Speed": "32MHz",
  "Program Memory Size": "3.5KB (2K x 14)",
  "RAM Size": "256 x 8",
  "Voltage - Supply (Vcc/Vdd)": "1.8V ~ 5.5V",
  "Operating Temperature": "-40°C ~ 85°C (TA)",
  "Mounting Type": "Surface Mount",
  "Package / Case": "8-SOIC (0.154\", 3.90mm Width)"
}
```

The `Mfr Part #` cell is a concatenation: `<part> <description> <manufacturer>`. If you need them split, parse the inner DOM (the part is the `<a>` text, description and manufacturer are sibling spans) instead of the flat `innerText`.

The `Price` cell is the cheapest break only — `"1 : $0.38000 Tube"` means 1+ units at $0.38. Higher quantity breaks live on the detail page.

## Pagination

- Default page size: **25 rows**.
- URL params: `?page=2`, `?page=3`, … and `&pageSize=100` (max 100). Loop until the table returns fewer than `pageSize` rows.
- Big categories (microcontrollers ≈ 100K parts) are gated — past ~10 pages DigiKey starts redirecting to a "refine your search" interstitial. Apply at least one parametric filter (`?Core+Size=8-Bit`) to keep going, or scrape by sub-category.

## Gotchas & lessons

1. **Bare curl is dead.** Cloudflare returns 403 with `cf-mitigated: challenge`. Don't waste time on UA spoofing — go straight to real-Chrome connect.
2. **`disconnect()`, never `close()`.** `close()` would kill the user's actual Chrome window.
3. **Read `<thead>` dynamically.** Column count and order vary per category. Hard-coding column indexes will silently break the next category you scrape.
4. **`Mfr Part #` is a flat concat.** Part number, description, and manufacturer are visually distinct but `innerText` joins them. Use the inner `<a>` text for the clean part number, or split on the description.
5. **Stealth plugin is unnecessary** when using `TORCH_CHROME_ENDPOINT`. A previous run that tried `puppeteer-extra` + stealth got `null` for every field — likely because the page hadn't fully painted before extraction. The fix was a 2.5s post-selector wait, not more stealth.
6. **Only one XHR fires** during page load (`scTools/Header2021/GeoInfo`) and it's just for the country banner. There's no public product JSON API to replay — the table HTML is the source of truth.
7. **Cloudflare cookie persists** for 30 minutes (`__cf_bm`) per the response. Subsequent pages in the same Chrome session reuse it; no re-challenge.
