---
name: scrape
description: Scrape a website. Activates when user provides a URL to scrape, asks to extract data from a site, hits 403/blocking errors, or needs anti-bot evasion.
metadata:
  author: torch
  version: "1.0.0"
---

## Goal of a first-time scrape

**You are a scout, not a crawler.** On a site that does not already have a skill in `skills/sites/<slug>/`, the goal is to prove a strategy works on a small sample (5-20 items) and write a reusable playbook — NOT to extract every row on the site. Full crawls come on re-runs once the skill exists.

## Budget

- **~5 minutes total wall clock** for a new-site scrape. The user is watching a clock you cannot see.
- **Per-phase time boxes**:
  - Phase 0 (curl): 2 minutes max
  - Phase 1 (framework recon): 3 minutes max
  - Phase 2 (browser): 5 minutes max
- **Once extraction works on even 5 valid items, STOP.** Commit to that approach, write the skill, ship. Do not switch strategies to find a cleaner one. Do not chase pagination unless explicitly asked. Every extra minute you spend "improving" a working scrape is a minute spent not writing the skill.
- **After two failed strategies on the same page, stop escalating.** Write a skill documenting what you tried and which layer failed. A half-skill is more valuable than a timeout with nothing saved.

## Background execution

**Run scrapers as background processes, not synchronous bash.** You have pi-processes tools — use them. Synchronous `bash node scrape.js` blocks the turn, makes you blind to progress, and prevents steering. Background execution lets you watch logs, catch errors early, and kill a run once you have enough data.

Pattern:
1. Write `scrape.js`
2. Spawn it as a background process, tag it with the slug
3. Tail its log output
4. As soon as you see the first 5 items extract cleanly, you can either let it finish or kill it
5. Read `./output/<slug>.json`, verify, write the skill

## Naming invariants

Derive the **slug** ONCE at the start of the scrape from the brand/site name. Lowercase `[a-z0-9-]` only, no dots, no TLDs, no `www.` prefix. Examples: `amazon`, `hackernews`, `mcmaster`, `digikey`.

- Output file: `./output/<slug>.json` — **one file per scrape**, no variants
- Skill file: `./skills/sites/<slug>/SKILL.md` — directory name === slug === frontmatter `name:`
- Scratch files during exploration: prefix with `_scratch_` so they're easy to delete

## Adaptive reconnaissance workflow

Always follow this order. Each phase has an exit gate — skip ahead when possible.

### Phase 0 — curl assessment (always first)

```bash
curl -sL -D- <url> | head -300
```

From the response, determine:

1. **Framework** — check response headers and HTML against `strategies/framework-signatures.md`
2. **Target data** — is it present in the raw HTML?
3. **Sitemaps** — check `/sitemap.xml`, `/sitemap_index.xml`, `Sitemap:` in `/robots.txt`
4. **Protection** — 403 status, Cloudflare challenge, `cf-ray` / `cf-mitigated` headers

**Gate A**: All target data found in raw HTML + no protection → skip to Phase 3.

### Phase 1 — framework-aware extraction

Based on framework detected in Phase 0, use the matching strategy from `strategies/framework-signatures.md`:

- Next.js → `__NEXT_DATA__` JSON blob or `/_next/data/` routes
- Nuxt → `__NUXT__` / `__NUXT_DATA__` payload
- Shopify → `/products.json`, `/collections.json`, `.json` URL suffix
- WordPress → `/wp-json/wp/v2/` REST API
- React/Angular SPA → look for `/api/` or `/graphql` endpoints in source
- Any → check for `<script type="application/ld+json">` structured data

**Gate B**: Clean API or JSON data source found → skip browser, go to Phase 3.

### Phase 2 — browser scraping (last resort)

Only when Phase 0-1 failed:

1. **First, try connecting to the real Chrome at `http://127.0.0.1:9222`** (via `puppeteer.connect`). Torch auto-launches a Chrome instance on that port at startup using a clone of the user's profile, so this attaches to a real browser with real cookies, history, and TLS session state — the single biggest anti-blocking win.
2. If the connect throws (no Chrome running — e.g. VM or CI), check `process.env.TORCH_CAMOUFOX_ENDPOINT` and connect via `playwright-core`'s `firefox.connect(ws://...)` for the C++-level stealth fallback. See the `camoufox` skill for setup.
3. If neither is available, fall back to `puppeteer.launch()` with the stealth plugin (`reference/puppeteer-boilerplate.md`). Disposable Chromium with zero history — fine for soft targets but almost guaranteed to trip bot scoring on hard sites.
4. Capture network traffic to discover API endpoints called during page load.
5. If an API shows up in traffic → replay it directly with fetch, ditch the browser.
6. Otherwise extract from the rendered DOM.

If blocked, escalate through `strategies/anti-blocking.md`. Connecting to the real Chrome profile is the single biggest anti-blocking win — a fresh Chromium with stealth is a last resort, not a starting point.

#### Browser connect pattern

```js
import puppeteer from "puppeteer-core";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const REAL_CHROME = "http://127.0.0.1:9222";
let browser;
let kind;
let cleanup;

try {
  // Tier 1 — real Chrome (cloned profile, debug port)
  browser = await puppeteer.connect({ browserURL: REAL_CHROME });
  kind = "real-chrome";
  cleanup = async () => browser.disconnect(); // never close — it's the user's Chrome
} catch {
  if (process.env.TORCH_CAMOUFOX_ENDPOINT) {
    // Tier 2 — Camoufox via playwright-core (VMs / headless servers)
    const { firefox } = await import("playwright-core");
    browser = await firefox.connect(process.env.TORCH_CAMOUFOX_ENDPOINT);
    kind = "camoufox";
    cleanup = async () => browser.close();
  } else {
    // Tier 3 — disposable Chromium + stealth (almost always detected on hard sites)
    puppeteerExtra.use(StealthPlugin());
    browser = await puppeteerExtra.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    kind = "disposable-chromium";
    cleanup = async () => browser.close();
  }
}

console.log(`[torch] using ${kind}`);

const page = await browser.newPage();
try {
  await page.goto(url, { waitUntil: "networkidle2" });
  // ... scrape ...
} finally {
  await page.close();
  await cleanup();
}
```

The `disconnect()` vs `close()` distinction matters: `close()` would kill the user's real Chrome instance. Always `disconnect()` on the real-Chrome tier.

### Phase 3 — validate and extract

1. Test selectors/API endpoints against live data
2. Confirm data shape matches what user asked for
3. Write scraper using fastest approach that works
4. Run it, verify output
5. If incomplete or errored, fix and rerun

## Strategy priority

```
JSON API / data blob → Sitemap + fetch → Cheerio (static HTML) →
  Puppeteer.connect() to real Chrome (TORCH_CHROME_ENDPOINT) →
  Puppeteer.launch() disposable Chromium with stealth (fallback only)
```

Always prefer the cheapest strategy that returns the data. Escalate one step at a time — don't jump straight to a browser if cheerio works, and don't launch a fresh Chromium if the user has a real Chrome debug endpoint available.

## Pagination

- Detect next buttons or page numbers, loop through all
- Infinite scroll: scroll to bottom, wait 2s, check height, repeat until stable
- If sitemap exists, use it for URL discovery (60x faster than crawling)
- Look for paginated APIs: `?page=`, `?offset=`, `?cursor=`

## Dependencies

All pre-installed: puppeteer-extra, stealth plugin, adblocker plugin, cheerio. Use Node.js ES modules.

## Authentication

If a site requires login or rate-limits anonymous requests, use the agentmail skill to create a disposable email inbox for signups. Authenticated sessions often bypass rate limits and unlock more data.

## Implementation rules

- Start by scraping a single page first, confirm data is correct, then decide whether to scale up
- Write scraper to `scrape.js` (Node.js ES modules)
- Save output to `./output/<slug>.json` — **exactly one file, no variants**
- Spawn the scraper as a background process via pi-processes, tail its log
- Log progress from inside the scraper: `[scraped] 5 items so far`, `[scraped] 20 items, done`
- Wrap each page/URL in try-catch — log error, continue with rest
- Navigation timeout: 30s
- Retry failed requests up to 3 times with exponential backoff
- Save partial data if full scrape fails
- Always close browser in a finally block (or `disconnect()` if using `TORCH_CHROME_ENDPOINT`)

## Cleanup before writing the skill

Before finalizing, delete any exploration artifacts:
- `*_debug.*`, `*-debug.*`, `*.debug.*`
- Alternative output attempts (`<slug>_api.json`, `<slug>_dom.json`, etc.)
- Screenshots from recon
- Files prefixed `_scratch_`

Keep only the canonical `./output/<slug>.json` and `./skills/sites/<slug>/SKILL.md`.

## After a successful scrape

Save the proven method as a **per-site skill** so the next run can invoke it directly instead of re-running reconnaissance. Create `./skills/sites/<slug>/SKILL.md` where `<slug>` is a lowercase alphanumeric+hyphen identifier for the site (e.g. `mcmaster`, `digikey`, `hackernews` — no dots, no `www.` prefix).

Structure:

```markdown
---
name: <slug>
description: Proven scraping playbook for <full domain>. <one-line architecture summary: framework, CDN, anti-bot, notable gotchas>. Activate whenever the target URL is on <domain>.
metadata:
  author: torch
  version: "1.0.0"
---

# <Site name> (<domain>)

> One-paragraph summary of what makes this site distinctive to scrape.

## Detection
Table of signals: CDN, framework, anti-bot, auth, robots.txt.

## Architecture
How the site loads data — SPA shell, API endpoints, frames, hydration, etc.

## Strategy used
Phase 0 (curl), Phase 1 (framework), Phase 2 (browser) — what worked, what was skipped.

## Stealth config that works
Exact puppeteer launch args, headers, UA — copy-pasteable.

## Extraction
Selectors, regexes, JSON paths, frame navigation. Include code snippets.

## Anti-blocking summary
Table: which of the 9 layers were needed, which were not, notes.

## Data shape
JSON example of one extracted record.

## Pagination / crawl architecture
Seed URLs, concurrency, checkpointing, priority ordering.

## Gotchas & lessons
Numbered list of anything surprising or fragile.
```

Naming rules (enforced by the skill loader):

- Directory name and `name:` frontmatter field must match exactly.
- Use only lowercase `a-z`, `0-9`, and `-`. No dots, no underscores, no consecutive hyphens, no leading/trailing hyphen.
- Keep it short and recognizable — prefer `mcmaster` over `www-mcmaster-com`.

Once saved, pi-coding-agent will auto-discover the new skill on the next session. The scrape skill's reconnaissance phases can then be skipped for that domain.

Existing examples: see `skills/sites/doordash/SKILL.md` (SSR + Cloudflare) and `skills/sites/nike/SKILL.md` (pure JSON API, no browser) for full reference playbooks.

### Share it upstream

If the site didn't already have a skill before this run, **open a pull request adding `skills/sites/<slug>/SKILL.md` to `github.com/agentcomputer/torch`** so the next person scraping that site inherits the playbook instead of re-running recon. One site per PR. Tell the user once you've saved the skill locally that they should open the PR — see `contributing` for the general PR workflow and quality bar.
