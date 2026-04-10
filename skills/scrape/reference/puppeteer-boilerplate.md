# Puppeteer boilerplate

Standard stealth browser setup. Copy this as the base for any browser-based scraper.

```js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import fs from "fs";

puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1920,1080",
  ],
});

const page = await browser.newPage();
await page.setViewport({
  width: Math.floor(1024 + Math.random() * 400),
  height: Math.floor(768 + Math.random() * 300),
});
await page.setUserAgent(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
);

try {
  await page.goto("https://example.com", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  // Extract data here

} finally {
  await browser.close();
}
```

## Infinite scroll pattern

```js
let previousHeight;
while (true) {
  previousHeight = await page.evaluate("document.body.scrollHeight");
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await new Promise((r) => setTimeout(r, 2000));
  const newHeight = await page.evaluate("document.body.scrollHeight");
  if (newHeight === previousHeight) break;
}
```

## API reverse engineering

Capture full request/response pairs — headers, cookies, auth tokens, POST bodies — during page load AND user interactions. This is how you find the real API behind any site.

```js
const captured = [];

page.on("request", (req) => {
  const url = req.url();
  if (url.includes("analytics") || url.includes("tracking")) return;
  captured.push({
    url,
    method: req.method(),
    headers: req.headers(),
    postData: req.postData() || null,
  });
});

page.on("response", async (res) => {
  const url = res.url();
  const contentType = res.headers()["content-type"] || "";
  if (!contentType.includes("json") && !contentType.includes("graphql")) return;
  const entry = captured.find((c) => c.url === url);
  if (!entry) return;
  try {
    entry.status = res.status();
    entry.responseHeaders = res.headers();
    entry.body = await res.json();
  } catch {}
});
```

After page load, interact with the page (click buttons, paginate, search, filter) and watch what new requests fire:

```js
await page.goto("https://example.com", { waitUntil: "networkidle2" });

// Click through interactions to trigger API calls
await page.click(".load-more-button");
await new Promise((r) => setTimeout(r, 3000));

// Log everything captured
for (const req of captured) {
  if (req.body) {
    console.log(`${req.method} ${req.url}`);
    console.log("  Request headers:", JSON.stringify(req.headers, null, 2));
    if (req.postData) console.log("  POST body:", req.postData);
    console.log("  Response:", JSON.stringify(req.body).slice(0, 500));
  }
}
```

Look for:
- **Auth tokens** in request headers (`Authorization`, `X-Api-Key`, cookies)
- **GraphQL queries** in POST bodies — these can be replayed directly with fetch
- **Pagination params** (`?page=`, `?offset=`, `?cursor=`) in the URL
- **Session cookies** that need to be forwarded

Once you find the API, replay it directly with `fetch()` and ditch the browser:

```js
const res = await fetch("https://example.com/api/products?page=1", {
  headers: {
    "Authorization": "Bearer <token from captured headers>",
    "Cookie": "<cookies from captured headers>",
    "Content-Type": "application/json",
  },
});
const data = await res.json();
```
