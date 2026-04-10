---
name: huggingface
description: Proven scraping playbook for huggingface.co model/dataset/space listings. Skip the browser entirely — Hugging Face exposes a public, unauthenticated JSON API at /api/models, /api/datasets, /api/spaces that mirrors every filter and sort on the HTML listing pages. No cookies, no tokens, no anti-bot. Cursor pagination via the `Link: rel="next"` header. Activate for any huggingface.co /models, /datasets, or /spaces listing URL.
metadata:
  author: torch
  version: "1.0.0"
---

# Hugging Face (huggingface.co)

The model/dataset/space listing HTML pages are server-rendered behind CloudFront but there is no reason to scrape them — Hugging Face ships a public JSON API that backs the same UI and accepts every URL filter verbatim. One-to-one parameter mapping, no auth, no rate-limit in practice (a soft `ratelimit: "pages";q=100;w=300` is on the HTML routes, not /api).

## Detection

| Signal | Value |
|---|---|
| CDN | CloudFront (`x-cache: ... cloudfront.net`) |
| Framework | SvelteKit (`huggingface-moon`) |
| Anti-bot | None on `/api/*`. HTML pages have a soft page rate limit. |
| Auth | Not required for public models/datasets/spaces. |
| robots.txt | Allows `/api/` crawling. |

## Architecture

Every listing URL `https://huggingface.co/models?<filters>` has a direct JSON twin at `https://huggingface.co/api/models?<same filters>`. The HTML page is just a SvelteKit shell that calls the same endpoint client-side.

- Endpoint: `https://huggingface.co/api/models`
- Filters map 1:1: `pipeline_tag`, `library`, `language`, `license`, `other`, `search`, `author`, `filter`.
- Sort: `sort=trendingScore|downloads|likes|createdAt|lastModified` + `direction=-1|1`.
- Page size: `limit` (max 100 observed, use 100).
- Pagination: cursor-based via the `Link` response header (`<...cursor=...>; rel="next"`). Extract the `cursor` query param from that URL and pass it to the next request.

Also available:
- `/api/datasets` — same shape, for /datasets listings.
- `/api/spaces` — same shape, for /spaces listings.
- `/api/models/<repo_id>` — full model card metadata for a single repo.

## Strategy used

- **Phase 0 (curl):** HTML returns 200 but the data lives in a hydration blob. Not worth parsing — instead checked `/api/models?pipeline_tag=text-generation&sort=trendingScore`. Got clean JSON. Done.
- **Phase 1–2:** skipped.

## Stealth config that works

None needed. Plain `fetch` with a generic User-Agent.

```js
await fetch("https://huggingface.co/api/models?...", {
  headers: { "User-Agent": "Mozilla/5.0 torch-scraper" },
});
```

### Gotcha: Node IPv6

On some networks Node 20+ resolves `huggingface.co` to an IPv6 AAAA record that is not reachable and fails with `EHOSTUNREACH 2600:9000:...`. Force IPv4 via undici before any fetch:

```js
import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
```

## Extraction

Cursor pagination loop:

```js
const base = "https://huggingface.co/api/models";
const params = new URLSearchParams({
  pipeline_tag: "text-generation",
  sort: "trendingScore",
  direction: "-1",
  limit: "100",
});

let all = [], cursor = null;
while (true) {
  const url = cursor
    ? `${base}?${params}&cursor=${encodeURIComponent(cursor)}`
    : `${base}?${params}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 torch" } });
  const batch = await res.json();
  if (!batch.length) break;
  all.push(...batch);

  const link = res.headers.get("link");
  const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
  if (!m) break;
  cursor = new URL(m[1], "https://huggingface.co").searchParams.get("cursor");
  if (!cursor) break;
}
```

## Anti-blocking summary

| Layer | Needed? |
|---|---|
| 1. User-Agent | Optional (any UA works, default undici UA also works). |
| 2. Headers | No. |
| 3. Cookies/session | No. |
| 4. Proxies | No. |
| 5. Stealth browser | No. |
| 6. CAPTCHA solver | No. |
| 7. Residential IP | No. |
| 8. Login | No. |
| 9. Rate limit backoff | Not observed on /api, but be polite. |

## Data shape

```json
{
  "_id": "69cf884fa91383ae4eaaf4aa",
  "id": "zai-org/GLM-5.1",
  "likes": 858,
  "trendingScore": 858,
  "private": false,
  "downloads": 8465,
  "tags": ["transformers", "safetensors", "text-generation", "license:mit", "..."],
  "pipeline_tag": "text-generation",
  "library_name": "transformers",
  "createdAt": "2026-04-03T09:28:47.000Z",
  "modelId": "zai-org/GLM-5.1"
}
```

For full README / model card / siblings, call `/api/models/<id>?full=true`.

## Pagination / crawl architecture

- Use `limit=100` (observed max).
- Follow `Link: rel="next"` header until absent.
- 2000 models = 20 requests = ~6 seconds sequential. No need for concurrency.
- For full coverage of a pipeline_tag beyond 2000, split the query space with additional filters (e.g. `library`, `language`, or `createdAt` ranges).

## Gotchas & lessons

1. **IPv6 unreachable on some hosts** — set undici dispatcher to `family: 4` before fetching (see above).
2. **Sort names don't match the URL param on HTML** — the HTML URL uses `sort=trending`, the API uses `sort=trendingScore`. Other API sort values: `downloads`, `likes`, `createdAt`, `lastModified`.
3. **Cursor lives in the Link header, not the body.** Don't try to derive it from the last item.
4. **`limit` caps at ~100** — requesting 500 silently returns 100.
5. **Trending score decays** — the order is stable within a snapshot but re-running tomorrow will return a different top N. Store `createdAt` / `scrapedAt` with each record.
6. **HTML listing pages have a rate limit** (`ratelimit-policy: "pages";q=100;w=300` = 100 HTML page loads per 5 min per IP). The `/api` endpoints do not show this header — stay on the API.
