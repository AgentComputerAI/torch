---
name: reverse-engineer
description: Reverse-engineer a website's internal APIs, encrypted endpoints, WebSocket streams, and obfuscated JavaScript. Activates when the target data isn't in the HTML, when the site uses encrypted CloudFront payloads, when real-time streaming data is needed, or when the scrape skill's Phase 0-1 finds API calls but can't read them because they're encrypted, signed, or behind a custom protocol.
metadata:
  author: torch
  version: "1.0.0"
---

# Reverse Engineering

When the data isn't in the HTML, it's in an API. When the API isn't public, it's hidden in the JavaScript. When the JavaScript is obfuscated, the keys are still in the page source. This skill is the playbook for finding and exploiting internal APIs that were never meant to be called directly.

## When to use this skill

- The scrape skill's Phase 0 (curl) returns HTML with no data — everything loads via XHR/fetch after JS runs
- Network tab shows API calls but the responses are encrypted, compressed, or encoded
- The site uses WebSocket or Server-Sent Events for real-time data
- GraphQL introspection is disabled but you can see queries in the source
- The site has a mobile app whose API is more permissive than the web version
- You need to sign requests with HMAC, generate tokens, or solve custom challenge-response protocols

## Phase 0 — Network reconnaissance

Open the site in the real Chrome debug port and capture all network traffic:

```js
const page = await browser.newPage();

const apiCalls = [];
page.on("response", async (res) => {
  const url = res.url();
  const ct = res.headers()["content-type"] || "";
  if (ct.includes("json") || ct.includes("grpc") || ct.includes("protobuf") || url.includes("/api/") || url.includes("/graphql")) {
    try {
      const body = await res.text();
      apiCalls.push({ url, status: res.status(), contentType: ct, bodyLength: body.length, bodySample: body.slice(0, 500) });
    } catch {}
  }
});

await page.goto(url, { waitUntil: "networkidle2" });
console.log(`Captured ${apiCalls.length} API calls`);
for (const call of apiCalls) {
  console.log(`  ${call.status} ${call.url} (${call.contentType}, ${call.bodyLength} bytes)`);
  console.log(`    ${call.bodySample.slice(0, 200)}`);
}
```

This reveals every internal API the page calls during load. Most sites make 5-50 API calls, and 1-3 of them contain the target data.

## Phase 1 — Identify the data endpoint

Look for these patterns in the captured calls:

| Pattern | What it means |
|---|---|
| `/api/v1/...`, `/api/v2/...` | REST API, usually the easiest to replay |
| `/graphql` with POST body | GraphQL — extract the query and variables |
| `/__NEXT_DATA__` in HTML | Next.js — data is in the page source, not a separate API |
| CloudFront domain (`d3*.cloudfront.net`) | CDN-cached API, possibly encrypted |
| `wss://` or `ws://` in the JS | WebSocket for real-time data |
| Response body starts with `"` and is base64 | Encrypted payload — needs decryption |
| Response body is binary / protobuf | gRPC or custom binary protocol |
| Response has `x-amz-*` headers | AWS API Gateway — may have signing requirements |

## Phase 2 — Replay the API directly

Once you find the data endpoint, replay it with `fetch` (no browser needed):

```js
const res = await fetch("https://api.example.com/v1/products?page=1", {
  headers: {
    "User-Agent": "Mozilla/5.0 ...",
    "Accept": "application/json",
    "Referer": "https://www.example.com/",
    "Origin": "https://www.example.com",
    // Copy any custom headers from the captured request
  },
});
const data = await res.json();
```

If the API returns 401/403, you need to extract auth tokens — see Phase 3.

## Phase 3 — Extract auth tokens and keys

Sites protect their internal APIs with various token schemes. All of them store the tokens somewhere the browser can read them — which means you can too.

### Inline script variables

```js
const html = await (await fetch(url)).text();

// Look for API keys, tokens, session IDs in inline scripts
const patterns = [
  /api[_-]?key["'\s:=]+["']([^"']+)["']/gi,
  /token["'\s:=]+["']([^"']+)["']/gi,
  /client[_-]?id["'\s:=]+["']([^"']+)["']/gi,
  /secret["'\s:=]+["']([a-zA-Z0-9+/=]{16,})["']/gi,
  /nonce["'\s:=]+["']([a-zA-Z0-9+/=]{16,})["']/gi,
];

for (const pattern of patterns) {
  for (const match of html.matchAll(pattern)) {
    console.log(`Found: ${match[0].slice(0, 100)}`);
  }
}
```

### Cookies set by JavaScript

```js
const cookies = await page.cookies();
for (const cookie of cookies) {
  if (cookie.name.includes("token") || cookie.name.includes("session") || cookie.name.includes("auth") || cookie.name.includes("csrf")) {
    console.log(`${cookie.name} = ${cookie.value.slice(0, 50)}...`);
  }
}
```

### `__NEXT_DATA__` props

Next.js pages embed API tokens in `props.pageProps`:

```js
const nextData = await page.$eval('#__NEXT_DATA__', el => JSON.parse(el.textContent));
// Tokens are often in nextData.props.pageProps.csrfToken,
// nextData.props.pageProps.session, or nextData.runtimeConfig
```

### Request headers from the network tab

Some sites generate tokens in JS and attach them as headers. Capture the exact headers from a successful API call and replay them:

```js
page.on("request", (req) => {
  if (req.url().includes("/api/")) {
    console.log("Headers:", JSON.stringify(req.headers(), null, 2));
  }
});
```

## Phase 4 — Decrypt encrypted payloads

Some sites encrypt API responses client-side. The decryption key is always in the JavaScript — it has to be, because the browser needs it.

### Common encryption patterns

| Library | How to detect | Key location |
|---|---|---|
| NaCl / libsodium `crypto_secretbox` | Base64 response, 24-byte nonce variable in JS | Look for `TEdecryptk`, `TEdecryptn`, or similar variables in inline scripts |
| AES-GCM via WebCrypto | `crypto.subtle.decrypt` in JS | Key imported from a hardcoded base64 string or derived from a password |
| Custom XOR / RC4 | Short key, repeating patterns in ciphertext | Key is usually a short string in the JS bundle |
| pako / zlib compression (not encryption) | Response starts with `x\x9c` or `\x1f\x8b` | Just decompress, no key needed |

### Decryption workflow

1. Find the decryption function in the JS source (search for `decrypt`, `decipher`, `secretbox`, `crypto.subtle`)
2. Extract the key and nonce/IV from the same source or from inline script variables
3. Decrypt in Node:

```js
import { secretbox } from "tweetnacl";
import { inflate } from "pako";

const key = Buffer.from(keyBase64, "base64");
const nonce = Buffer.from(nonceBase64, "base64");
const ciphertext = Buffer.from(ciphertextBase64, "base64");

const plaintext = secretbox.open(ciphertext, nonce, key);
const decompressed = inflate(plaintext, { to: "string" });
const data = JSON.parse(decompressed);
```

If keys rotate per session, fetch the page first to extract fresh keys, then hit the API.

## Phase 5 — WebSocket and streaming APIs

Real-time data (prices, sports scores, chat) often uses WebSocket or Server-Sent Events.

### Finding the WebSocket endpoint

```js
// Search page source for ws:// or wss:// URLs
const wsUrls = html.match(/wss?:\/\/[^\s"']+/g);

// Or intercept the WebSocket connection
page.on("websocket", (ws) => {
  console.log(`WebSocket opened: ${ws.url()}`);
  ws.on("framesent", (frame) => console.log(`→ ${frame.payload}`));
  ws.on("framereceived", (frame) => console.log(`← ${frame.payload}`));
});
```

### Socket.IO pattern

Many sites use Socket.IO which has a polling transport fallback:

```js
// Step 1: establish session via HTTP polling
const sessionRes = await fetch(`${wsUrl}/socket.io/?EIO=4&transport=polling`, {
  headers: { "User-Agent": "Mozilla/5.0", "Origin": origin },
});
const sessionData = (await sessionRes.text()).replace(/^\d+/, "");
const { sid } = JSON.parse(sessionData);

// Step 2: upgrade to WebSocket
import WebSocket from "ws";
const ws = new WebSocket(`${wsUrl.replace("https", "wss")}/socket.io/?EIO=4&transport=websocket&sid=${sid}`);
ws.on("open", () => ws.send("2probe")); // socket.io upgrade handshake
ws.on("message", (msg) => {
  const str = msg.toString();
  if (str.startsWith("42")) {
    const [event, data] = JSON.parse(str.slice(2));
    console.log(`Event: ${event}`, data);
  }
});
```

### Subscribing to channels

Sites often require subscribing to specific channels after connecting:

```js
// Find channel names in the page source
const channels = html.match(/subscribe\(['"]([^'"]+)['"]\)/g);
// Or from data-symbol attributes on the page
const symbols = await page.$$eval("[data-symbol]", els => els.map(el => el.dataset.symbol));

// Subscribe via socket.io emit
ws.send(`42["subscribe",{"channel":"${channelName}"}]`);
```

## Phase 6 — GraphQL introspection

When a site uses GraphQL but disables introspection:

1. Extract queries from the page source — search for `query {`, `mutation {`, `fragment ` in JS bundles
2. Look for persisted query hashes — some sites use `extensions: { persistedQuery: { sha256Hash: "..." } }` instead of sending the full query
3. Reconstruct the schema from captured queries + response shapes
4. Build your own queries from the discovered fields

```js
// Extract GraphQL queries from JS bundles
const jsUrls = await page.$$eval("script[src]", els => els.map(el => el.src));
for (const jsUrl of jsUrls) {
  const js = await (await fetch(jsUrl)).text();
  const queries = js.match(/query\s+\w+[\s\S]*?\{[\s\S]*?\}/g) || [];
  for (const q of queries) console.log(q.slice(0, 200));
}
```

## Phase 7 — Mobile app API discovery

Mobile apps often hit more permissive APIs than the web:

1. Use a proxy (mitmproxy, Charles) to intercept mobile traffic
2. Or decompile the APK/IPA and search for API URLs
3. Mobile APIs often use simpler auth (just an API key in a header) and return more data per request

This is out of scope for torch's browser-based workflow, but if you have the mobile app's API documented, torch can replay it with fetch.

## Output

After reverse-engineering the API, write the findings into the site skill. The skill should document:

- The exact API endpoint URL(s)
- Required headers (auth tokens, caller IDs, custom headers)
- Request/response format (JSON, protobuf, encrypted)
- Decryption keys and method (if encrypted), noting whether keys rotate
- WebSocket channel names and subscription protocol (if streaming)
- Rate limits observed
- What data is available vs what the HTML shows (APIs often return more)

This is the most valuable part of the playbook — the next person skips the entire reverse engineering process and goes straight to calling the API.
