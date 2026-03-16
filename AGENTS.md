# Yerevan City CLI Agent Notes

This file is the stable operator/developer reference for the CLI in this folder.

Keep it curated. Document durable tool behavior and public contract changes, not session residue:

- public API findings
- browser/session findings
- DB/schema decisions
- basket contract changes
- planner/agent boundary decisions
- gotchas that are easy to forget after context compaction

## Agent Quick Start

If you are an agent entering this repo cold:

1. Run `node src/cli.js login` if the local session has not been captured yet.
2. Run `node src/cli.js sync auto` before making shopping decisions.
3. Use `lookup concepts`, `lookup categories`, and `lookup items` to gather evidence.
4. Treat the CLI as evidence + basket-mutation infrastructure, not as the planner.
5. Propose explicit basket lines first, then call `basket add` or `basket apply` only after approval.
6. Respond in the user's current language unless they ask otherwise. It is fine to use store-facing queries, exact product names, and JSON fields in whatever language best matches the live catalog.

Read this file for product boundaries and implementation notes.
Read `.codex/skills/yerevan-city-basket-agent/SKILL.md` or `.claude/skills/yerevan-city-basket-agent/SKILL.md` for the actual propose -> revise -> apply workflow.

## Current product boundary

This is the important architectural decision as of 2026-03-15:

- The CLI is **not** the shopping-list planner.
- The CLI **does** fetch orders and maintain local SQLite memory.
- The CLI **does** expose lookup/query surfaces over that memory plus live store search.
- The CLI **does** mutate the live basket when given explicit structured product selections.
- The agent skill is responsible for:
  - normalizing loose user text
  - decomposing lines like `сок яблочный и апельсиновый`
  - using DB/live lookup output plus its own judgment
  - choosing concrete SKUs and quantities
  - showing a suggested basket before mutation
  - revising that suggestion after user feedback
  - calling `basket add` / `basket apply` with explicit JSON

`basket plan` is intentionally not a public CLI surface anymore. The CLI hard-fails that command with a message pointing the caller back to the agent boundary.

## Current capabilities

- `login`
  - reads the freshest Yerevan City session from Chromium local storage
  - saves token/config for future API calls
- `orders list`
  - bulk order history
  - supports `--limit`, auto-pagination, export formats, and `--details`
  - excludes offline/in-store orders by default
- `orders get <id-or-external-id>`
  - fetches one order
  - supports numeric internal IDs and external IDs such as `ML...`
- `sync backfill`
  - imports all reachable order history into SQLite
  - hydrates online orders via detail endpoint
  - stores offline orders as summary-only
  - rebuilds derived item/concept memory
- `sync refresh`
  - refreshes front-of-history orders and derived memory
- `sync auto`
  - uses backfill when the local DB is empty
  - uses refresh when the local DB already has orders
  - this is the preferred first sync command for fresh agent sessions
- `lookup concepts <query>`
  - queries derived concept memory from the SQLite DB
- `lookup tree`
  - fetches or reuses the full live category tree
  - caches the tree in local state for reuse across CLI invocations
  - supports `--refresh` when the agent wants a forced refetch
- `lookup categories <query>`
  - searches the live category tree and returns likely category IDs/paths
  - uses the cached full-tree snapshot by default
- `lookup items [query]`
  - queries live store products and augments them with DB/history context
  - also supports `--category-id N...` so the caller can browse or search inside specific categories
  - supports `--browse` for exhaustive shelf fetches inside known categories
  - returns category evidence such as `queryCategoryHints`, per-candidate `categoryHints`, `discoveredCategories`, and browse metadata for the shelves it inspected
  - `queryCategoryHints` are intentionally weaker evidence than categories derived from actual item candidates; the agent should treat them as fallback leads, not the primary routing signal
  - applies `overrides` steering during ranking
  - for `prefer` overrides, planner can now inject the preferred SKU into the candidate set via targeted live search when the broad query does not return it directly
- `basket show`
  - reads live cart state
- `basket clear`
  - removes all live cart lines
- `basket add`
  - writes one explicit item into the live basket while keeping existing contents
- `basket apply`
  - writes a structured JSON payload of explicit items into the live basket
  - replaces by default, or merges with `--keep-existing`
- `overrides list|upsert|remove`
  - stores structured steering for future agent/query use
  - useful for persistent brand/flavor or pack-size preferences
  - can also encode a default quantity/weight for broad aliases such as `минералка`

## Companion agent skill

Companion skill path:

- `.codex/skills/yerevan-city-basket-agent/SKILL.md`

Claude mirror of the same skill:

- `.claude/skills/yerevan-city-basket-agent/SKILL.md`

Use that skill when a user gives a loose shopping list and wants the basket prepared.

Important:

- the skill owns normalization
- the skill owns ambiguous-line expansion
- the skill owns final SKU choice
- the skill owns the proposal/revision loop with the user
- the skill owns the reorder-vs-discovery judgment
- the skill owns multi-step discovery loops such as search -> inspect candidate categories -> browse shelves -> cross-check tree
- the CLI only provides evidence and basket mutation

Default interaction contract:

1. user sends loose list
2. agent runs `sync auto`, then normalizes and looks up candidates
3. agent treats most lines as restocks first, using history-backed live matches when they are available
4. only when that path fails or the user explicitly wants options, the agent widens into category discovery and shelf browsing
5. agent shows suggested basket or exhaustive options, depending on the request
6. user gives corrections or approval
7. agent revises or applies

Do not auto-apply a loose-list proposal on the first pass unless the user explicitly asked for immediate execution.

Language behavior:

- Keep the surrounding explanation, proposal, and follow-up in the user's current language.
- Do not switch the whole response to Russian just because the catalog examples or live product names are Russian.
- Use exact store-language product names or search terms only where they help the lookup or basket payload stay correct.

## Project layout

- `src/cli.js`
  - public command surface
  - help text
  - command dispatch
- `src/browserStorage.js`
  - browser profile discovery
  - Chromium LevelDB reading
  - extraction of local-storage auth keys
- `src/config.js`
  - config path helpers
  - DB path helper
- `src/api.js`
  - authenticated Yerevan City API client
  - order, address, category, product search, and cart methods
- `src/categories.js`
  - category tree loading
  - category-path flattening
  - category lookup/ranking helpers
- `src/db.js`
  - SQLite schema and migrations
  - raw order persistence
  - derived item/concept memory
  - overrides and saved plan storage
- `src/sync.js`
  - backfill/refresh logic
  - address context refresh
- `src/planner.js`
  - currently used for history-aware lookup/ranking helpers
  - contains experimental agent-like normalization/ranking logic
  - not part of the public CLI boundary anymore
- `src/basket.js`
  - low-level live basket reads/writes
  - structured basket input contract
- `src/agentOutput.js`
  - text renderers for sync/lookups/basket operations
- `src/output.js`
  - normalized order output and export renderers
- `README.md`
  - human-oriented usage summary

## Auth model

There is no interactive username/password flow.

`login` works by reading the already-authenticated browser session from Chromium local storage, then storing the extracted config locally.

Saved config path examples:

- macOS: `~/Library/Application Support/yerevan-city-cli/config.json`
- Windows: `%APPDATA%\\yerevan-city-cli\\config.json`
- Linux/XDG: `${XDG_CONFIG_HOME:-~/.config}/yerevan-city-cli/config.json`
- Any platform: set `YEREVAN_CITY_CONFIG_DIR` to override the config/state directory

Observed saved config fields:

- `apiBaseUrl`
- `token`
- `tokenMeta.issuedAt`
- `tokenMeta.expiresAt`
- `defaults.language`
- `defaults.cityId`
- `defaults.addressId`
- `defaults.osType`
- `source.browser`
- `source.profile`

## Browser findings

### Supported browser discovery

The implementation scans Chromium-family browser profiles on multiple platforms.

macOS roots:

- Chrome Canary
- Chrome
- Chromium
- Brave
- Arc

Windows roots:

- Chrome
- Chromium
- Brave

Linux/XDG roots:

- Chrome
- Chrome Beta
- Chromium
- Brave

Profiles scanned:

- `Default`
- `Profile N`
- `Person N`

Storage path pattern:

- `<browser data dir>/<profile>/Local Storage/leveldb`

### Local-storage keys

Observed Yerevan City keys:

- `token`
- `language`
- `cityId`
- `addressId`

Observed Chromium key shape:

- `_https://www.yerevan-city.am\0\1token`
- `_https://www.yerevan-city.am\0\1language`
- `_https://www.yerevan-city.am\0\1cityId`
- `_https://www.yerevan-city.am\0\1addressId`

### Why the final CLI uses local storage instead of CDP

Chrome MCP was useful for endpoint discovery, but the reusable CLI auth source is on-disk Chromium storage.

Important observations:

- expected `http://127.0.0.1:9222/json/*` returned `404` in this setup
- Apple Events JavaScript was not dependable here
- copied Chromium LevelDB storage was the most reliable reusable session source

### LevelDB access pattern

`src/browserStorage.js`:

1. finds candidate `Local Storage/leveldb` folders
2. copies the DB to a temp directory
3. deletes copied `LOCK`
4. opens the copy with `classic-level`
5. extracts only the Yerevan City keys

Copy-first is intentional so the browser can stay open.

## API findings

### Base URLs

- main API: `https://apishopv2.yerevan-city.am`
- marketplace API: `https://marketplaceapi.yerevan-city.am`

### Required headers

Observed working headers:

- `Accept: application/json`
- `Authorization: Bearer <token>`
- `content-language: 2`
- `CityId: 10078`
- `OsType: 3`
- `Content-Type: application/json` for POSTs

### Order endpoints

- `POST /api/Order/UserAllOrdersPaged`
- `GET /api/Order/GetById/{id}`

Offline/in-store orders are visible in paged history but detail hydration does not work through the public `GetById` API.

### Address endpoint

- `GET /api/Address/GetAll`

Observed response shape:

```json
{
  "success": true,
  "data": {
    "addresses": [
      {
        "id": 123456,
        "city": "Example city",
        "street": "Example street, Example city, Armenia",
        "buliding": "1/1",
        "entrance": 0,
        "floor": 0,
        "appartment": 0,
        "isDefault": true,
        "lat": 40.123456,
        "lng": 44.123456,
        "title": "Home"
      }
    ]
  }
}
```

This is how the tool recovers `lat/lng` for cart operations.

### Category endpoints

- `POST /api/Category/GetParentCategories`
- `POST /api/Category/GetCategory`
- `POST /api/Category/GetAllChildren`
- `POST /api/Product/GetByLastCategory`

Observed `GetParentCategories` request body:

```json
{}
```

Observed `GetCategory` request body:

```json
{
  "parentId": 2222
}
```

Observed `GetAllChildren` request body:

```json
{
  "parentId": 2222
}
```

Observed `GetByLastCategory` request body:

```json
{
  "categoryId": 2259,
  "count": 30,
  "page": 1,
  "priceFrom": null,
  "priceTo": null,
  "countries": [],
  "categories": [],
  "brands": [],
  "search": "zewa",
  "parentId": 2259,
  "isDiscounted": false,
  "sortBy": 3
}
```

Important practical note from 2026-03-15:

- `GetByLastCategory` appears to ignore its `search` field in practice
- verified against category `2259` (`Бумажные полотенца`): `search: null`, `search: "zewa"`, and `search: "pero"` returned the same five products
- for category-constrained text lookup, the client should page the category and filter locally instead of trusting the server-side `search`

### Product search

- `POST /api/Product/Search`

Observed request body:

```json
{
  "count": 20,
  "page": 1,
  "priceFrom": null,
  "priceTo": null,
  "countries": [],
  "categories": [],
  "brands": [],
  "search": "банан",
  "isDiscounted": false,
  "sortBy": 3
}
```

Important response fields:

- `id`
- `name`
- `nameEn`
- `nameRu`
- `categoryName`
- `price`
- `discountedPrice`
- `isKilogram`
- `minimumWeight`
- `weightStep`
- `stockDetails.availableCount`
- `stockDetails.availableWeight`
- `brandId`
- `productPricePerUnit`
- `weightProductPricePerUnit`
- `weightMeasure`

### Suggested products

- `GET /api/Product/GetSuggestedProducts/{productId}`

Discovered but not currently wired into the basket writer.

### Cart read endpoints

- `GET /api/Cart/GetItemsCount`
- `POST /api/Cart/GetCartItems`
- `GET https://marketplaceapi.yerevan-city.am/api/app/v1/cart/count`
- `GET https://marketplaceapi.yerevan-city.am/api/app/v1/cart/details`

Observed `GetCartItems` request body:

```json
{
  "lat": 40.123456,
  "lng": 44.123456,
  "isGreenLine": false
}
```

Observed cart item fields:

- `id`
- `name`
- `price`
- `count`
- `weight`
- `note`
- `isKilogram`
- `categoryId`
- `categoryName`
- `codeSap`
- `stockDetails.availableCount`
- `stockDetails.availableWeight`
- `weightMeasure`

Important empty-cart quirk:

- `items` comes back as `null`, not `[]`

### Cart mutation endpoint

- `POST /api/Cart/UpdateItems`

Observed non-weighted add:

```json
{
  "addressId": 123456,
  "id": 12345,
  "weight": 1,
  "quantity": 1,
  "lat": 40.123456,
  "lng": 44.123456,
  "isGreenLine": false
}
```

Observed weighted add:

```json
{
  "addressId": 123456,
  "id": 12345,
  "weight": 1500,
  "quantity": 1500,
  "note": "",
  "cut": false,
  "grind": false,
  "lat": 40.123456,
  "lng": 44.123456,
  "isGreenLine": false
}
```

Observed remove:

```json
{
  "addressId": 123456,
  "id": 12345,
  "weight": 0,
  "quantity": 0,
  "note": "",
  "cut": false,
  "grind": false,
  "lat": 40.123456,
  "lng": 44.123456,
  "isGreenLine": false
}
```

Important behavior notes:

- weighted products use grams
- for weighted products, both `weight` and `quantity` are sent in grams
- `UpdateItems` behaves like an absolute write for the current cart line, not a delta increment
- when eggs were added, the cart auto-added a bag line too

## DB design

SQLite file:

- `<platform config dir>/yerevan-city-cli/state.db`

Migration mechanism:

- `PRAGMA user_version`
- current schema version: `1`

Core tables:

- `sync_state`
- `orders`
- `order_items`
- `item_stats`
- `item_aliases`
- `concepts`
- `concept_aliases`
- `catalog_cache`
- `overrides`
- `basket_plans`
- `basket_plan_lines`

### Important modeling decisions

- order primary key is `order_key`, not raw numeric `order_id`
  - online: `online:<orderId>`
  - offline: `offline:<externalId>`
- offline orders are stored as summary-only and do not contribute line-item stats
- derived item/concept memory is rebuilt from online detailed items
- `catalog_cache` stores live product snapshots from search
- basket plans are still stored in DB because the internal planner code experimented with them, but they are not part of the public CLI boundary anymore

### Derived memory

`rebuildDerivedData()` materializes:

- item stats
- item aliases
- concepts
- concept aliases

Current heuristics:

- item key prefers product id, then SAP code, then simplified name
- concept key is guessed from simplified product/category names
- typical quantities use median-like logic over history

## Public basket contract

The basket writer expects explicit items chosen by the agent.

Accepted JSON:

```json
[
  { "productId": 15622, "quantity": 2, "query": "яйца" },
  { "productId": 13093, "weightGrams": 1500, "query": "бананы" }
]
```

or:

```json
{
  "replace": true,
  "items": [
    { "productId": 15622, "quantity": 2, "query": "яйца" },
    { "productId": 13093, "weightGrams": 1500, "query": "бананы" }
  ]
}
```

Supported per-item fields:

- `productId` (required)
- `quantity` for count-based products
- `weightGrams` for weighted products
- `query` or `name` so the tool can revalidate the product live
- `note`
- `cut`
- `grind`

Important practical note from 2026-03-15:

- exact `name` is the safest field for basket mutation revalidation
- broad normalized `query` labels such as `творог` or `пиво безалкогольное` can work for planning but still miss the exact live SKU during `basket apply`
- do not run `basket show` in parallel with `basket apply` when verifying the result; wait for the write to finish first or you can read a stale pre-apply cart snapshot

Behavior:

- `basket add`
  - keeps existing cart contents
  - writes one explicit item
- `basket apply`
  - replaces basket by default
  - uses `--keep-existing` to merge
- both commands:
  - revalidate the requested product live via search before mutating
  - revalidation currently prefers `query`, then `name`, then cached product name
  - trim requested amount to live availability if needed
  - skip items that cannot be found or are out of stock
  - if a first write skips broad-query items, a corrective `basket apply --keep-existing` with exact `name` values is a reliable recovery path

## Query surfaces for the agent skill

The intended agent workflow now is:

1. ensure `sync backfill` or `sync refresh` has run
2. inspect past orders with `orders list` / `orders get`
3. inspect memory with `lookup concepts`
4. for very broad staples like `молоко`, `творог`, or `минералка`, pivot from the generic noun into the strongest history-backed concept/name before trusting live search
5. inspect the live category tree with `lookup categories` when free-text search is noisy
6. inspect live candidates with `lookup items`, optionally with `--category-id`
7. persist stable user preferences with `overrides upsert` when they should influence future sessions
8. do normalization and SKU choice in the skill
9. call `basket add` or `basket apply` with explicit items

The agent should normalize shared-head lines itself, for example:

- `сок яблочный и апельсиновый`
  becomes
  - `сок яблочный`
  - `сок апельсиновый`

- `сок апельсиновый и яблочный`
  becomes
  - `сок апельсиновый`
  - `сок яблочный`

That normalization belongs in the skill layer, not the CLI contract.

The same rule applies to mixed-category lines:

- `пиво принглс краб или сметана зелень`
  becomes
  - `пиво`
  - `pringles краб`
  - `pringles сметана лук`

## Generalized workflow lessons

- A first full backfill can fail if multiple aliases normalize to the same string. `item_aliases` and `concept_aliases` should therefore use `INSERT OR IGNORE`.
- `src/planner.js` can keep experimental ranking helpers, but public shopping-list planning should stay outside the CLI surface.
- Broad live queries for generic nouns such as `молоко`, `творог`, or `минералка` can rank nonsense matches. The reliable pattern is `lookup concepts` first, then a targeted live lookup using the strongest history-backed phrase or a saved override.
- Query-level overrides are more useful when they can encode a default quantity or weight, not only a preferred SKU.
- For category-browsed goods like paper towels, use `lookup categories` first and be explicit about whether counts mean units, rolls, or packs.
- Exclude specialty formats like dispenser/refill paper towels by default unless the user explicitly asks for them.
- `basket apply` should use exact product `name` values or equally exact revalidation queries. Broad labels may work for proposal display but can fail during live mutation.
- For post-apply verification, wait for `basket apply` to finish before calling `basket show`; a parallel read can return a stale cart snapshot.
- The store may auto-add bag lines, so final cart line count can be larger than the number of requested products.
