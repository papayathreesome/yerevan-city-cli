# Yerevan City CLI

Agent-oriented CLI for Yerevan City.

It reuses an already-authenticated browser session, syncs order history into a local SQLite database, exposes that history plus live catalog lookups for reasoning, and mutates the live basket only from explicit structured selections.

## Why this exists

Yerevan City's site is usable for humans, but awkward for agent workflows:

- auth lives in browser storage rather than a clean API token flow
- broad store search can be noisy for generic grocery terms
- recurring choices benefit from local memory of prior orders
- basket writes should be explicit and auditable instead of "best guess" actions

This repo gives an AI agent a deterministic tool boundary for those jobs.

## Who it's for

- Codex and Claude Code agents that need a local shopping tool they can call directly
- developers building grocery/basket assistants on top of Yerevan City history
- power users who want a CLI for their own orders and basket operations

The repo ships mirrored companion skills for both agent environments:

- `.codex/skills/yerevan-city-basket-agent/SKILL.md`
- `.claude/skills/yerevan-city-basket-agent/SKILL.md`

Those skills are intended to turn a loose shopping list into an explicit basket proposal, revise it after user feedback, and only then call `basket add` or `basket apply`.

## Product boundary

The CLI is intentionally not the planner.

- The tool fetches orders and maintains local memory.
- The tool exposes lookup/query commands over that memory and the live catalog.
- The tool adds, clears, and rewrites concrete basket items.
- The agent handles normalization, judgment, SKU choice, and the propose -> revise -> apply loop.

Typical flow:

1. `login`
2. `sync auto`
3. agent uses `orders`, `lookup concepts`, `lookup categories`, and `lookup items`
4. agent proposes an explicit basket
5. `basket add` or `basket apply` happens only after approval

## Install

```bash
npm install
chmod +x src/cli.js
```

Run it directly with `node src/cli.js ...`, or register the `yerevan-city` binary from this folder with `npm link`.

## Main commands

Examples below assume you are in the repository root:

```bash
node src/cli.js login
node src/cli.js sync auto
node src/cli.js sync backfill
node src/cli.js sync refresh

node src/cli.js orders list --limit 40 --details --format json
node src/cli.js orders get 3500528 --format json

node src/cli.js lookup concepts яйца
node src/cli.js lookup categories бумажные полотенца
node src/cli.js lookup items банан --format json
node src/cli.js lookup items zewa --category-id 2259 --format json

node src/cli.js basket show --format json
node src/cli.js basket clear
node src/cli.js basket add --product-id 15622 --quantity 2 --query яйца
node src/cli.js basket apply --input basket.json --format json
```

## Structured basket input

`basket apply` accepts either a JSON array:

```json
[
  { "productId": 15622, "quantity": 2, "query": "яйца" },
  { "productId": 13093, "weightGrams": 1500, "query": "бананы" }
]
```

Or an object with explicit replace mode:

```json
{
  "replace": true,
  "items": [
    { "productId": 15622, "quantity": 2, "query": "яйца" },
    { "productId": 13093, "weightGrams": 1500, "query": "бананы" }
  ]
}
```

## Behavior notes

- `sync auto` uses backfill when the local DB is empty and refresh when it already has orders.
- `basket apply` replaces the basket by default; use `--keep-existing` to merge instead.
- The CLI revalidates live availability before mutating the basket.
- Weighted products use grams.
- `basket plan` is intentionally not a public command. Planning belongs in the agent layer.
- If broad text search is noisy, use `lookup categories` first and then `lookup items --category-id ...` to browse inside the right shelf.
- Very broad staples like `молоко`, `творог`, or `минералка` are often better handled through history-backed phrases or saved `overrides` than raw live search.
- `overrides upsert` can store a preferred SKU together with a default quantity or weight for recurring aliases.

## Environment notes

- `login` reads Chromium-family local-storage files. You should already be logged into `https://www.yerevan-city.am` in a supported browser profile.
- Browser discovery currently supports macOS, Windows, and Linux/XDG Chromium-family profiles.
- Config is stored in the platform config directory under `yerevan-city-cli/config.json`, or under `YEREVAN_CITY_CONFIG_DIR` if you override it.
- The SQLite DB lives alongside config as `state.db`.
- Bulk history excludes offline/in-store orders by default, but sync stores them as summary-only events.
- Offline/in-store orders are visible in history, but their line items are not exposed by the public detail API.
- Empty cart responses currently return `items: null`, not `[]`.

## More context

- `AGENTS.md` contains API notes, storage findings, schema decisions, and the intended agent/tool boundary.
- `src/cli.js --help` documents the public command surface.
