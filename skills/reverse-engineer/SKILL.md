---
name: reverse-engineer
description: Reverse-engineer a website's internal APIs, encrypted endpoints, WebSocket streams, and obfuscated JavaScript. Activates when the target data isn't in the HTML, when the site uses encrypted CloudFront/CDN payloads, when real-time streaming data is needed, or when the scrape skill's Phase 0-1 finds API calls that are encrypted, signed, or behind a custom protocol. Escalation ladder from simple network capture to protobuf schema reconstruction.
metadata:
  author: torch
  version: "2.0.0"
---

# Reverse Engineering

When the data isn't in the HTML, it's in an API. When the API isn't public, it's hidden in the JavaScript. When the JavaScript is obfuscated, the keys are still in the page source — because the browser needs them to decrypt, which means you can too.

This skill is an escalation ladder. Start at Level 1 and stop as soon as you have what you need.

## Escalation ladder

```
  Level 1   📡  Network capture          watch DevTools, find the API call
  Level 2   🔬  Response classification  Shannon entropy — plaintext vs compressed vs encrypted
  Level 3   🔁  API replay               copy as cURL, replay with fetch, 403 bypass tricks
  Level 4   🔑  Token extraction         find auth tokens, CSRF, API keys in page source
  Level 5   📦  JS deobfuscation         unpack webpack, deobfuscate, read the source
  Level 6   🔐  Payload decryption       NaCl / AES-GCM / CryptoJS — extract keys, decrypt
  Level 7   🔌  WebSocket interception    establish WS, subscribe to channels, decode frames
  Level 8   🔮  GraphQL reconstruction    extract queries from JS, force PersistedQueryNotFound
  Level 9   🧬  Protobuf decoding        reverse-engineer .proto schema from binary blobs
```

## Level 1 — Network capture

**When**: Phase 0 curl returns HTML with no target data. The data loads via XHR/fetch after JS runs.

Open the page in the real Chrome debug port, capture every API call during page load:

```js
const page = await browser.newPage();

const apiCalls = [];
page.on("response", async (res) => {
  const url = res.url();
  const ct = res.headers()["content-type"] || "";
  if (
    ct.includes("json") || ct.includes("grpc") || ct.includes("protobuf") ||
    url.includes("/api/") || url.includes("/graphql") || url.includes("/v1/") || url.includes("/v2/")
  ) {
    try {
      const body = await res.text();
      apiCalls.push({ url, status: res.status(), contentType: ct, size: body.length, sample: body.slice(0, 500) });
    } catch {}
  }
});

await page.goto(url, { waitUntil: "networkidle2" });

for (const call of apiCalls) {
  console.log(`${call.status} ${call.url} (${call.contentType}, ${call.size}B)`);
  console.log(`  ${call.sample.slice(0, 200)}`);
}
```

Most sites make 5-50 API calls during page load. Sort by response size — the largest JSON response usually contains the target data.

**Also capture request headers** — you'll need them for Level 2:

```js
page.on("request", (req) => {
  if (req.url().includes("/api/") || req.url().includes("/graphql")) {
    console.log("Request headers:", JSON.stringify(req.headers(), null, 2));
    if (req.postData()) console.log("Post body:", req.postData().slice(0, 500));
  }
});
```

**Quick alternative**: right-click any request in Chrome DevTools Network tab → "Copy as cURL (bash)" → paste into terminal. This copies method, headers, cookies, and payload in one shot.

**Tools**: Chrome DevTools Network tab, [API Reverse Engineer extension](https://github.com/ctala/api-reverse-engineer) (intercepts both fetch and XHR, exports JSON with every unique endpoint).

## Level 2 — Response classification

Before trying to parse an API response, measure its Shannon entropy to instantly know what you're dealing with:

```js
function shannonEntropy(buf) {
  const freq = new Map();
  for (const b of buf) freq.set(b, (freq.get(b) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / buf.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const res = await fetch(apiUrl);
const buf = new Uint8Array(await res.arrayBuffer());
const e = shannonEntropy(buf);

if (e < 6.0) console.log("Plaintext — parse as JSON/XML/HTML");
else if (e < 7.5) console.log("Compressed — try zlib.inflate or gzip");
else console.log("Encrypted — need to find decryption keys (Level 5)");
```

| Entropy | Meaning | Action |
|---|---|---|
| < 6.0 | Plaintext (JSON, XML, HTML, CSV) | Parse directly |
| 6.0 – 7.5 | Compressed (gzip, zlib, brotli) | Decompress then parse |
| > 7.5 | Encrypted or random | Escalate to Level 5 |

This saves time — don't waste 20 minutes trying to decrypt something that's just gzipped.

## Level 3 — API replay

**When**: Level 1 found the data endpoint and Level 2 confirmed it's readable (or you decompressed it).

Strip the captured request down to the minimum headers that work:

```js
const res = await fetch("https://api.example.com/v1/products?page=1", {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://www.example.com/",
    "Origin": "https://www.example.com",
  },
});
const data = await res.json();
```

Most internal APIs need fewer headers than the browser sends. Remove headers one at a time until you find the minimum set. Common essentials: `User-Agent`, `Referer`, `Origin`, and sometimes a custom caller-ID header (like Nike's `nike-api-caller-id`).

**If the API returns 401/403**: try these quick bypass tricks before escalating:

```js
const bypasses = [
  url,                          // original
  url + ".json",                // append .json
  url + "/",                    // trailing slash
  url + "%20",                  // URL-encoded space
  url + "#",                    // fragment
  url + "..;/",                 // path traversal normalize
  url.replace("/v2/", "/v1/"),  // downgrade API version
  url.replace("/v1/", "/v2/"),  // upgrade API version
];

for (const bypass of bypasses) {
  const res = await fetch(bypass, { headers, method: "GET" });
  if (res.ok) { console.log(`Bypass worked: ${bypass}`); break; }
}

// Also try different HTTP methods — some endpoints allow GET but block POST, or vice versa
for (const method of ["GET", "POST", "PUT", "OPTIONS"]) {
  const res = await fetch(url, { headers, method });
  if (res.ok) { console.log(`Method ${method} works`); break; }
}
```

Also check archive.org for historical snapshots of the API docs — sites sometimes had public Swagger/OpenAPI specs that have since been removed:
```js
const archiveUrl = `https://web.archive.org/web/2024*/https://api.example.com/swagger.json`;
```

If none of that works: escalate to Level 3 for token extraction.

**If the response is encrypted or binary**: escalate to Level 5 (encryption) or Level 8 (protobuf).

## Level 4 — Token extraction

**When**: The API requires auth tokens, CSRF tokens, API keys, or session cookies that aren't in your cookie jar.

Tokens are always somewhere the browser can read them. Common hiding spots:

| Location | How to extract |
|---|---|
| Inline `<script>` variables | Regex the HTML: `/api[_-]?key["'\s:=]+["']([^"']+)/gi` |
| `__NEXT_DATA__` props | `JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps` |
| `<meta>` tags | `document.querySelector('meta[name="csrf-token"]').content` |
| Cookies set by JS | `await page.cookies()` — filter for `token`, `session`, `csrf`, `auth` |
| `localStorage` / `sessionStorage` | `await page.evaluate(() => JSON.stringify(localStorage))` |
| Custom request headers | Capture from Level 1's `page.on("request")` — sites often generate tokens in JS and attach as `X-CSRF-Token`, `Authorization`, or custom headers |
| Hidden form inputs | `document.querySelector('input[name="authenticity_token"]').value` |

For long-lived sessions, cookies and tokens from the real Chrome profile clone often work directly — the user is already authenticated. Check cookies first before extracting fresh tokens.

**Obfuscated values**: if you see long unique-looking strings in request headers or query params, investigate when and where the first instance appeared. Use Chrome DevTools → "Search all files" (`Ctrl+Shift+F`) to find where the value is generated. It may be hardcoded, base64-encoded, computed from request components, or generated by an external library.

## Level 5 — JavaScript deobfuscation

**When**: The JS source is minified/obfuscated and you need to read it to find API endpoints, encryption keys, or token generation logic.

### Search before deobfuscating

Chrome DevTools → Sources → "Search all files" (`Ctrl+Shift+F`):

```
file:* query {         → find GraphQL queries
file:* mutation {      → find GraphQL mutations
file:* /api/           → find API endpoint URLs
file:* apiKey          → find API keys
file:* secretbox       → find NaCl encryption
file:* crypto.subtle   → find WebCrypto usage
file:* AES             → find AES encryption
file:* decrypt         → find decryption functions
```

This is often enough without full deobfuscation.

### Webpack unpacking

Most modern sites bundle with webpack. Torch can unpack and read them:

1. **Check for source maps first** — look for `//# sourceMappingURL=` at the bottom of JS files. If exposed, fetch the `.map` file and reconstruct original source.
2. **Beautify minified code** — pipe through prettier so it's readable: `npx prettier --parser babel bundle.js`
3. **Search the beautified source** for API endpoints, keys, and crypto functions — usually enough without full deobfuscation.
4. **If heavily obfuscated** (obfuscator.io, custom transforms), install and run a deobfuscator: `npx webcrack bundle.js -o unpacked/`

### Chrome DevTools Protocol instrumentation

For runtime analysis, use `Page.addScriptToEvaluateOnNewDocument` to inject code before the page's own scripts run:

```js
await page.evaluateOnNewDocument(() => {
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    console.log("[fetch]", args[0]?.url || args[0]);
    return origFetch.apply(this, args);
  };
});
```

This wins the "prototype race" — your patched `fetch` runs before the site's code, capturing every API call including ones fired during initialization.

### Breakpoints on crypto operations

Set conditional breakpoints on `crypto.subtle.decrypt`, `crypto.subtle.importKey`, or any function named `decrypt` to capture keys and IVs at runtime:

```js
await page.evaluateOnNewDocument(() => {
  const origDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  crypto.subtle.decrypt = async (algo, key, data) => {
    console.log("[crypto.subtle.decrypt]", JSON.stringify(algo), key, data.byteLength, "bytes");
    const result = await origDecrypt(algo, key, data);
    console.log("[decrypted]", new TextDecoder().decode(result).slice(0, 200));
    return result;
  };
});
```

## Level 6 — Payload decryption

**When**: API responses are base64-encoded blobs, not readable JSON. The response might start with `"` (JSON-wrapped base64 string) or contain binary data.

The decryption key is always in the JavaScript — the browser needs it to show data to the user, which means you can extract it.

### Detection patterns

| What you see | Likely encryption | Next step |
|---|---|---|
| Base64 string, ~200 bytes, JS has `secretbox` or `nacl` | NaCl `crypto_secretbox` | Find key (32 bytes) + nonce (24 bytes) in JS variables |
| Base64 string, JS has `crypto.subtle.decrypt` | WebCrypto AES-GCM or AES-CBC | Intercept `importKey` to capture the key + IV |
| Base64 string, JS imports `CryptoJS` or `crypto-js` | CryptoJS AES | Search JS for `CryptoJS.AES.decrypt(ciphertext, key)` |
| Response starts with `x\x9c` or `\x1f\x8b` | Not encrypted — just compressed (zlib / gzip) | `zlib.inflateSync(buffer)` or `zlib.gunzipSync(buffer)` |
| Short repeating patterns in ciphertext | Custom XOR or RC4 | Key is usually a short string nearby in JS |

### NaCl / libsodium `crypto_secretbox`

Used by Trading Economics and others. Look for variables named like `TEdecryptk`, `TEdecryptn`, or any 32-byte and 24-byte base64 strings near `secretbox` or `nacl` in the JS:

```js
import { secretbox } from "tweetnacl";
import { inflate } from "pako";

const key = Buffer.from(keyBase64, "base64");    // 32 bytes
const nonce = Buffer.from(nonceBase64, "base64"); // 24 bytes
const ciphertext = Buffer.from(ciphertextBase64, "base64");

const plaintext = secretbox.open(ciphertext, nonce, key);
if (!plaintext) throw new Error("Decryption failed — keys may have rotated");

const decompressed = inflate(plaintext, { to: "string" });
const data = JSON.parse(decompressed);
```

If keys rotate per session: fetch the page first to extract fresh keys, then hit the encrypted API endpoint with those keys.

### WebCrypto AES-GCM

Common pattern: the IV is embedded in the encrypted payload (first 12-16 bytes), the rest is ciphertext.

```js
const rawKey = Buffer.from(keyHex, "hex");
const encrypted = Buffer.from(encryptedBase64, "base64");
const iv = encrypted.slice(0, 12);
const ciphertext = encrypted.slice(12);

const cryptoKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
const text = new TextDecoder().decode(plaintext);
```

WebCrypto is cross-platform compatible with OpenSSL:
```bash
openssl enc -aes-256-gcm -d -in encrypted.bin -out decrypted.json -K <key_hex> -iv <iv_hex>
```

### CryptoJS / crypto-js (npm)

Found on many older sites. Search the JS for `CryptoJS.AES.decrypt`:

```js
import CryptoJS from "crypto-js";
const decrypted = CryptoJS.AES.decrypt(ciphertextBase64, secretKey);
const plaintext = decrypted.toString(CryptoJS.enc.Utf8);
```

The key is often a plain string (not binary) passed directly to `CryptoJS.AES.encrypt/decrypt`. Search JS for string literals near the `CryptoJS` import.

### Runtime key capture (universal)

If you can't find the keys statically, intercept them at runtime:

```js
await page.evaluateOnNewDocument(() => {
  const orig = crypto.subtle.importKey.bind(crypto.subtle);
  crypto.subtle.importKey = async (format, keyData, algo, extractable, usages) => {
    if (usages.includes("decrypt")) {
      const hex = Array.from(new Uint8Array(keyData)).map(b => b.toString(16).padStart(2, "0")).join("");
      console.log(`[KEY CAPTURED] format=${format} algo=${JSON.stringify(algo)} key=${hex}`);
    }
    return orig(format, keyData, algo, extractable, usages);
  };
});
```

Navigate to the page, let it load, and read the captured key from the console. This works for any WebCrypto-based encryption regardless of how the key is derived.

## Level 7 — WebSocket interception

**When**: The site uses real-time data (prices, scores, chat, notifications) delivered via WebSocket or Server-Sent Events.

### Finding the WebSocket endpoint

```js
page.on("websocket", (ws) => {
  console.log(`WebSocket opened: ${ws.url()}`);
  ws.on("framesent", (frame) => console.log(`→ ${typeof frame.payload === "string" ? frame.payload.slice(0, 200) : `[binary ${frame.payload.length}B]`}`));
  ws.on("framereceived", (frame) => console.log(`← ${typeof frame.payload === "string" ? frame.payload.slice(0, 200) : `[binary ${frame.payload.length}B]`}`));
});
```

Or search the page source: `html.match(/wss?:\/\/[^\s"']+/g)`

### Socket.IO protocol

Many sites (Trading Economics, etc.) use Socket.IO which has a polling transport fallback you can exploit:

```js
// Step 1: HTTP polling handshake — get a session ID
const handshake = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
  headers: { "User-Agent": "Mozilla/5.0", "Origin": origin },
});
const body = (await handshake.text()).replace(/^\d+/, "");
const { sid } = JSON.parse(body);

// Step 2: upgrade to WebSocket
import WebSocket from "ws";
const ws = new WebSocket(
  `${baseUrl.replace("https", "wss")}/socket.io/?EIO=4&transport=websocket&sid=${sid}`
);

ws.on("open", () => {
  ws.send("2probe");  // socket.io upgrade probe
  ws.send("5");       // upgrade confirmation
});

ws.on("message", (msg) => {
  const str = msg.toString();
  if (str === "2") { ws.send("3"); return; }  // ping-pong heartbeat
  if (str.startsWith("42")) {
    const [event, data] = JSON.parse(str.slice(2));
    console.log(`Event "${event}":`, JSON.stringify(data).slice(0, 200));
  }
});
```

Socket.IO message prefixes: `0` = connect, `2` = ping, `3` = pong, `4` = message, `42` = event with data.

### Subscribing to channels

Sites require subscribing after connecting. Find channel names from:
- `data-symbol` attributes on the page: `await page.$$eval("[data-symbol]", els => els.map(el => el.dataset.symbol))`
- Inline JS: search for `subscribe`, `emit`, `channel`, `room`
- The captured WebSocket frames from Step 1

```js
ws.send(`42["subscribe",{"channel":"commodities"}]`);
```

### Binary WebSocket frames

Set `ws.binaryType = "arraybuffer"` before receiving. Binary frames are often protobuf — escalate to Level 8.

### Keeping connections alive

Most WebSocket servers expect periodic heartbeats. Socket.IO handles this automatically (ping every 25s by default). For raw WebSocket, send the heartbeat message at the interval specified in the handshake response.

## Level 8 — GraphQL reconstruction

**When**: The site hits a `/graphql` endpoint but introspection is disabled (common in production).

### Extract queries from JavaScript bundles

Search all JS files loaded by the page:

```js
const scripts = await page.$$eval("script[src]", els => els.map(el => el.src));
for (const src of scripts) {
  const js = await (await fetch(src)).text();
  const queries = js.match(/query\s+\w+[\s\S]{10,500}?\{[\s\S]*?\}/g) || [];
  const mutations = js.match(/mutation\s+\w+[\s\S]{10,500}?\{[\s\S]*?\}/g) || [];
  if (queries.length || mutations.length) {
    console.log(`${src}: ${queries.length} queries, ${mutations.length} mutations`);
    for (const q of queries) console.log(q.slice(0, 300));
  }
}
```

Chrome DevTools shortcut: Sources → Search all files → `file:* query {` or `file:* mutation {`

### Persisted queries — force full query reveal

Sites using Apollo's `persistedQuery` extension only send a SHA-256 hash instead of the full query. Torch can force the full query to appear by intercepting and stripping the persisted query extension via puppeteer's request interception:

```js
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (req.url().includes("graphql") && req.method() === "POST") {
    try {
      const body = JSON.parse(req.postData());
      if (body.extensions?.persistedQuery) {
        delete body.extensions.persistedQuery;
        req.continue({ postData: JSON.stringify(body) });
        return;
      }
    } catch {}
  }
  req.continue();
});

page.on("response", async (res) => {
  if (res.url().includes("graphql")) {
    const data = await res.json().catch(() => null);
    if (data?.errors?.[0]?.message?.includes("PersistedQueryNotFound")) {
      console.log("PersistedQueryNotFound — client will retry with full query");
    }
    if (data?.data) {
      console.log("Got full query response:", JSON.stringify(data).slice(0, 500));
    }
  }
});
```

The server responds with `PersistedQueryNotFound`, and the client retries with the **full query text as a POST body**. Torch captures that POST to get the complete query — no external proxy needed.

### Schema brute-forcing (when all else fails)

Torch can reconstruct a GraphQL schema from error feedback alone — no introspection needed. Send queries with candidate field names and parse the error messages:

```js
const endpoint = "https://example.com/graphql";
const commonFields = ["id", "name", "email", "title", "description", "price", "url", "image", "createdAt", "updatedAt", "status", "type", "user", "users", "products", "items", "orders", "search"];

for (const field of commonFields) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ ${field} }` }),
  });
  const data = await res.json();
  const err = data.errors?.[0]?.message || "";
  if (err.includes("Cannot query field")) {
    // Field doesn't exist on Query — but the error confirms the parent type
    continue;
  }
  if (err.includes("must have a selection")) {
    // Field EXISTS but is an object type — recurse into it
    console.log(`${field}: object type (needs subfields)`);
  }
  if (data.data?.[field] !== undefined) {
    // Field exists and returned data
    console.log(`${field}: ${JSON.stringify(data.data[field]).slice(0, 200)}`);
  }
}
```

GraphQL error suggestions are also exploitable — some servers suggest valid fields when you query an invalid one (`Did you mean 'users'?`). Parse those suggestions to discover the schema faster. If the server disables suggestions too, try common field names from the UI labels on the page.

## Level 9 — Protobuf decoding

**When**: API responses or WebSocket frames contain binary data that isn't JSON, isn't compressed — it's Protocol Buffers.

Protobuf is a compact binary serialization format. Without the `.proto` schema definition, messages appear as raw binary blobs.

### Detecting protobuf

- Response `Content-Type` contains `application/grpc`, `application/x-protobuf`, or `application/protobuf`
- Binary WebSocket frames that aren't valid JSON or compressed data
- The JS imports `protobufjs`, `google-protobuf`, or references `.proto` files

### Decoding without the .proto file

Use `protoc --decode_raw` to see the wire format:

```bash
curl -s "https://api.example.com/data" | protoc --decode_raw
```

This shows field numbers and types but not field names. Output looks like:
```
1: "some string"
2: 42
3 {
  1: "nested"
  2: 1234567890
}
```

### Finding the .proto schema

1. **Search JS bundles** for `.proto` file contents — protobufjs embeds the schema as JSON:
   ```
   file:* "fields"  (in DevTools search)
   file:* proto3
   file:* protobuf
   ```
2. **Check for source maps** — `.proto` files sometimes survive webpack bundling
3. **Reconstruct from `--decode_raw` output** — map field numbers to likely names from the UI labels

### Decoding in Node with protobufjs

Once you have (or reconstruct) the schema:

```js
import protobuf from "protobufjs";

const root = await protobuf.load("schema.proto");
const MessageType = root.lookupType("package.MessageName");

const buffer = await (await fetch(url)).arrayBuffer();
const message = MessageType.decode(new Uint8Array(buffer));
const data = MessageType.toObject(message);
```

### gRPC-Web

Some sites use gRPC-Web which wraps protobuf in HTTP/2. The response has a 5-byte header (1 byte flags + 4 bytes message length) before the protobuf payload:

```js
const buf = Buffer.from(await res.arrayBuffer());
const messageLength = buf.readUInt32BE(1);
const protoBytes = buf.slice(5, 5 + messageLength);
const decoded = MessageType.decode(protoBytes);
```

## Output — write the API docs as a site skill

The reverse-engineering run is only valuable if the next person never has to repeat it. Capture the result as an in-depth API documentation file at `skills/sites/<slug>/SKILL.md` (same path the `scrape` skill writes to). Reverse-engineer skills are first-class site skills — the difference is that they document an **API**, not a DOM scrape.

The slug rule is the same as scrape: lowercase `[a-z0-9-]`, no dots, no `www.`, directory name === `name:` frontmatter (see `contributing` for the full convention).

### The final scraper must not open a browser

If the API replays cleanly with `fetch`, the published skill and its example code must use `fetch` only — **no `puppeteer.connect`, no `puppeteer.launch`, no Playwright, no real Chrome, no Camoufox**. The whole point of reverse engineering is to delete the browser from the hot path. A user running `torch <site>` against an API-backed skill should see an HTTP request fly, not a Chrome window pop up. Opening a browser when a 50ms `fetch` would do is the cardinal sin of this skill — it's slower, more fragile, and signals that the reverse-engineering work was abandoned halfway.

The browser is allowed in **two narrow cases**, and only when documented as such:

1. **Recon-only**, run once by the skill author to capture endpoints/headers/keys — never invoked by the final scraper.
2. **Per-session token bootstrap**, when the API requires a freshly-minted CSRF / auth / decryption key that can only be extracted from a live page load. Even then, open the page once, scrape the token, **disconnect**, and replay the API with `fetch` for every subsequent request. Document the bootstrap step explicitly so it's obvious why a browser appears at all.

If neither applies, the skill is browser-free. See `skills/sites/nike/SKILL.md` for the canonical "skip the browser entirely" example.

### Required sections in the per-site SKILL.md

Document every field below. If a section doesn't apply (e.g. no encryption), say "N/A" — don't omit it, so future readers know it was checked.

```markdown
---
name: <slug>
description: Proven API playbook for <domain>. <one line: which endpoint, what auth, what anti-bot, whether browser is needed>. Activate for any <domain> URL.
metadata:
  author: <handle>
  version: "1.0.0"
---

# <Site name> (<domain>)

> One-paragraph summary: which internal API powers the page, why fetch beats the browser, and any single gotcha that would otherwise burn an hour.

## Detection
Table: framework, CDN, anti-bot, auth, robots.txt, content-type of API responses.

## Strategy
Which level of the escalation ladder solved it (1-9). Which levels were tried and rejected, and why. State explicitly: "Browser needed? No / Yes — recon only / Yes — token bootstrap only".

## Endpoint(s)
- Full URL template with every path/query parameter labeled
- HTTP method
- Per-parameter table: name, example value, whether required, what it controls
- Cursor / pagination shape (link header, `next` field, `?page=`, etc.)

## Required headers
Copy-pasteable JS object with the **minimum** header set that works. Note any header whose absence returns a specific error string (quote the error). Mark headers that must be fresh per session vs. statically reusable.

## Auth / token extraction
- Where the token lives (cookie name, localStorage key, meta tag, inline script regex, `__NEXT_DATA__` path, ...)
- Lifetime (per-request, per-session, long-lived)
- Extraction snippet
- If the token is generated client-side, link to the JS file + line where it's computed

## Decryption (if applicable)
- Algorithm (NaCl secretbox / AES-GCM / CryptoJS / XOR / ...)
- Where the key and nonce/IV live in the page or JS
- Whether keys rotate per session
- Working decrypt snippet

## WebSocket / streaming (if applicable)
- WS URL, subprotocol, handshake flow
- Subscribe message format and channel discovery
- Heartbeat interval
- Frame format (JSON / protobuf / custom)

## GraphQL (if applicable)
- Full query text (not the persisted-query hash)
- Variables shape
- Whether persisted queries are enforced and how to bypass

## Protobuf (if applicable)
- `.proto` schema, or the `--decode_raw` field-number → field-name mapping you reconstructed
- gRPC-Web framing notes if relevant

## Replay snippet
A complete, runnable `fetch`-only example that pulls one page of real data. Must work when copy-pasted into a fresh file with zero edits beyond the query parameters. **No puppeteer imports.**

## Pagination / crawl architecture
Cursor field, page-size cap, observed rate limits, recommended sleep between requests, checkpointing strategy.

## Anti-blocking summary
Table: which of the 9 reverse-engineer levels were needed, which were not, notes. Same shape as the scrape skill's table.

## Data shape
JSON example of one decoded record. Show the **API response** shape, not the flattened output.

## Gotchas & lessons
Numbered list. Quote exact error strings. Note the things that made you waste time: param caps (e.g. Nike's `count > 24 → 400`), HEAD-vs-GET differences, header-presence checks, key rotation cadence, etc.

## What the API returns vs. what the HTML shows
APIs almost always return more fields than the rendered page. List the bonus fields — that's what makes the API worth reverse-engineering in the first place.
```

### Share it upstream

If the site didn't already have a skill before this run, **open a pull request adding `skills/sites/<slug>/SKILL.md` to `github.com/agentcomputer/torch`** so the next person hitting that domain inherits the API playbook instead of climbing the 9-level ladder again. One site per PR. Tell the user once you've saved the skill locally that they should open the PR — see `contributing` for the general PR workflow and quality bar.

A reverse-engineered API skill is one of the highest-leverage contributions to torch: every future invocation of `torch <site>` against that domain becomes a single `fetch` instead of a browser launch. That delta — 50ms vs 5 seconds, no anti-bot exposure, no rate limit risk — is the dividend of doing the work once and writing it down.

## npm packages torch can install on demand

These are Node libraries the agent installs via `npm install` when a specific level requires them. They're not external tools — they're dependencies torch uses in the scraper scripts it writes.

| Package | When needed |
|---|---|
| `tweetnacl` | Level 6 — NaCl `crypto_secretbox` decryption |
| `pako` | Level 5 — zlib/deflate decompression after decryption |
| `protobufjs` | Level 9 — protobuf encode/decode |
| `ws` | Level 6 — raw WebSocket client (when not using puppeteer's built-in WS capture) |
