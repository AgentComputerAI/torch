---
name: contributing
description: How to contribute to torch — the PR workflow, quality bar, skill authoring conventions, and what not to contribute. Activate when the user asks "how do I contribute / upstream / share / PR this", wants to submit a new skill, or needs the contribution guidelines for any kind of change to the repo. Covers site skills, core skills, code changes, and documentation.
metadata:
  author: torch
  version: "1.0.0"
---

# Contributing to torch

Torch is an open playbook collection as much as it is a CLI. Every PR that adds a new site skill, fixes a selector, refines an anti-blocking layer, or improves a core skill makes the next person's scrape faster.

Upstream: `github.com/agentcomputer/torch`

## What you can contribute

| Kind | Where it lives | Typical PR size |
|---|---|---|
| **New site skill** | `skills/sites/<slug>/SKILL.md` | Single file |
| **Update to a site skill** | Same path, bump `metadata.version` | Single file |
| **New core skill** | `skills/<name>/SKILL.md` (+ references) | 1-5 files |
| **Improvement to a core skill** | Existing skill file | Single file |
| **Source code change** | `src/*.ts`, `bin/*` | Scoped to one concern |
| **Docs fix** | `README.md`, `SYSTEM.md` | Single file |

One concern per PR. Don't bundle a new site skill with a core skill rewrite — those get reviewed separately.

## Skill authoring conventions

All skills in torch follow the [Agent Skills spec](https://github.com/badlogic/pi-mono) that pi-coding-agent enforces. The loader will reject skills that don't comply.

### Frontmatter

Every `SKILL.md` starts with YAML frontmatter:

```markdown
---
name: <slug>
description: <specific, actionable description — this is what pi-coding-agent reads to decide when to route to the skill>
metadata:
  author: <your name or handle>
  version: "1.0.0"
---
```

Rules:

- `name` must match the parent directory name exactly.
- `name` must be `^[a-z0-9-]+$` — lowercase letters, digits, hyphens only. No dots, no underscores, no consecutive hyphens, no leading/trailing hyphen. Max 64 chars.
- `description` must be present and ≤ 1024 chars.
- `description` should be **specific** — it's what the agent reads to decide when to invoke the skill. "Does X" is weaker than "Does X when Y, using Z library, for targets like A, B, C".

### Content

Skill content is just markdown after the frontmatter. Structure it however makes sense for the subject, but good skills share these traits:

- **Dense with specifics.** Every code snippet is copy-pasteable. Every claim is verifiable.
- **Lead with the gate.** First paragraph tells the reader whether this skill applies to their situation.
- **Include what doesn't work.** A "Do NOT do X — here's why" note is worth a page of happy-path docs.
- **Comparable surfaces.** If there are alternatives (e.g. `2captcha` vs `capmonster`), reference them explicitly.

### Directory layout

Simple skill (single file):

```
skills/<name>/
  SKILL.md
```

Skill with reference material:

```
skills/<name>/
  SKILL.md
  references/
    deep-dive-topic-1.md
    deep-dive-topic-2.md
```

Keep `SKILL.md` focused. If a section grows past ~150 lines, split it into `references/` and link from the main skill. The agent reads the main file eagerly but only pulls references when the skill is actively in use.

## Quality bar for any PR

Before opening the PR:

- [ ] The change does one thing, not five
- [ ] Frontmatter is valid (name matches dir, description is specific)
- [ ] Every code snippet runs without edits
- [ ] No hardcoded credentials, API keys, tokens, cookies, or personal info
- [ ] No scraped data, `output/` dumps, or binary blobs
- [ ] No unrelated reformatting, import reordering, or "while I'm here" cleanups
- [ ] `npm run build` passes if you touched `src/`

## PR workflow

```bash
git checkout -b <kind>/<short-description>
# e.g. sites/doordash, core/proxy-smartproxy-update, fix/scrape-phase-0-typo

# ... make changes ...

git add <specific files>
git commit -m "<Short imperative summary>"
git push -u origin <branch>

gh pr create
```

In the PR description, include:

1. **What this changes** — one paragraph
2. **Why** — what problem it solves or what it unlocks
3. **How it was tested** — for site skills: which URLs, how many items scraped, date verified. For code: how you ran it locally
4. **Scope** — what's intentionally out of scope

One commit or many is fine — the PR gets squashed on merge. Keep the PR title short (< 70 chars).

## Updating an existing skill

Don't rewrite a skill you didn't author without understanding *why* it's written the way it is. If a selector changed or an anti-blocking layer became necessary:

1. Bump `metadata.version` (`"1.0.0"` → `"1.1.0"` for additions, `"2.0.0"` for breaking strategy changes)
2. Add a `## Changelog` section at the bottom noting what changed and why
3. Keep the old approach documented unless it definitively no longer works — future readers may want the history

## What NOT to contribute

- Skills for sites you only scraped once and can't reproduce
- Skills that wrap paid third-party APIs you don't disclose (unless the skill is *about* that API, like `2captcha`)
- Code changes that introduce new top-level dependencies without discussion — open an issue first
- Documentation for features that don't exist yet ("speculative docs")
- Anything whose sole purpose is to evade detection on sites you don't have permission to scrape
- Credentials, cookies, tokens, or session state (even in examples — use obvious placeholders)

When in doubt, open a draft PR and ask.

## Code of conduct

Be decent. Review other people's PRs the way you'd want yours reviewed — specific, kind, focused on the code. This is a small project; the whole point is that everyone benefits when someone figures out a new site.
