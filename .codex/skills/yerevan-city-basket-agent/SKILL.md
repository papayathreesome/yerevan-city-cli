---
name: yerevan-city-basket-agent
description: Use when turning a loose shopping list into an explicit basket proposal for the local `yerevan-city-cli` tool. Normalize ambiguous lines yourself, query the tool's history DB and live store lookups, show a suggested basket first, revise it after user feedback, and call `basket add` or `basket apply` only after explicit approval. Do not delegate planning back to the CLI.
---

# Yerevan City Basket Agent

Use this skill when a user gives a loose shopping list and wants the agent to prepare a Yerevan City basket.

Tool root:

- the repository root that contains `src/cli.js`

Working directory assumption for command examples below:

- current directory is the repository root

Read [AGENTS.md](../../../AGENTS.md) before doing the work if you need API/basket contract details.

Read [references/feedback-loop.md](references/feedback-loop.md) when you need the exact propose -> revise -> apply interaction shape.

Language behavior:

- Respond in the user's current language unless they ask otherwise.
- Do not switch the whole answer to Russian just because the catalog, history, or example queries contain Russian text.
- It is fine to use exact store-facing product names, query strings, and payload fields in whatever language best matches the live Yerevan City data.

## Workflow

1. Refresh local memory first.
   - Run `node src/cli.js sync auto --format json`
   - `sync auto` does a backfill when the local DB is empty and a refresh when it already has history.
2. Normalize the list yourself.
   - Split broad lines into explicit sub-queries.
   - Example:
     - `сок яблочный и апельсиновый`
       becomes
       - `сок яблочный`
       - `сок апельсиновый`
   - Example:
     - `сок апельсиновый и яблочный`
       becomes
       - `сок апельсиновый`
       - `сок яблочный`
   - Example:
     - `пиво принглс краб или сметана зелень`
       becomes
       - `пиво`
       - `pringles краб`
       - `pringles сметана лук`
3. Use the tool for evidence, not decisions.
   - Query history with `node src/cli.js lookup concepts <query> --format json`
   - Query live candidates with `node src/cli.js lookup items <query> --format json`
   - Default to the reorder path:
     - use history first
     - use the top known live SKU when it still clearly matches the request
     - do not widen into category browsing unless the normal restock path fails or the user explicitly wants options
   - Only enter the broader discovery loop when at least one of these is true:
     - the user asked for `all options`, `all available`, or a full shelf
     - the usual historical SKU is unavailable
     - the request is genuinely new and history is weak or empty
   - Discovery loop for broad or mixed-category requests:
     1. start with `lookup items <query> --format json`
     2. inspect returned `categoryHints` and `discoveredCategories`
     3. browse each likely shelf with `node src/cli.js lookup items [query] --category-id N --browse --format json`
     4. if the likely shelves still look incomplete, use `lookup categories <query>` and, rarely, `lookup tree` to search for missed categories
   - Treat `queryCategoryHints` as a hint, not ground truth; categories discovered from actual item candidates are stronger evidence.
   - In a mixed shelf browse, keep the full shelf in view but separate strict matches from same-shelf neighbors yourself.
   - For very broad staples like `молоко`, `творог`, or `минералка`, do not trust the raw generic live query by itself; use history first, then run a targeted live lookup with the strongest exact concept/name.
   - If the user states a stable future preference such as a preferred brand/flavor, persist it with `node src/cli.js overrides upsert ...` once the target SKU is clear and live.
   - Use `orders list/get` only when you need raw order detail context.
4. Choose concrete products yourself.
   - Prefer historically frequent items when they are still live.
   - Treat most requests as restocks first and discovery problems second.
   - If the top historical SKU is unavailable, choose the closest live substitute by brand, fat %, pack size, flavor, and category.
   - If the user gave an `or`, pick the best live option among the allowed choices.
   - If the user gave a broad category, choose the most defensible historically preferred live item.
   - If the user gave a count for something category-like such as paper towels, be explicit about whether that count means units, rolls, or packs before applying.
   - For quantity requests like `2 beers`, split across acceptable live fallbacks when the preferred SKU does not have enough stock.
5. Quantities:
   - Use historical typical quantity when the DB clearly supports it.
   - Otherwise default to `1`.
   - For weighted products, send grams and respect live step/minimums.
6. Build a suggested basket first.
   - Convert your chosen products into an explicit structured payload.
   - Show the user the suggested list before mutating the basket.
   - Include enough detail for quick approval or correction:
     - normalized line
     - chosen product
     - quantity or weight
     - short reason when the choice is not obvious
   - Keep the exact chosen product `name` in your working payload, not only the broad normalized `query`.
   - Keep the working explicit payload in the conversation so you can revise it after feedback.
7. Revise from user feedback.
   - If the user changes a flavor, brand, quantity, or item, update the proposal instead of applying immediately.
   - Re-run lookups when the feedback changes the target item materially.
   - Show the updated proposal again if the change was non-trivial.
8. Write the basket explicitly only after explicit approval.
   - Use `node src/cli.js basket add ...` for one-offs.
   - Use `node src/cli.js basket apply ...` with structured JSON for a full basket rewrite.
   - For final basket mutation, include exact `name` values for chosen SKUs whenever possible.
   - Do not rely on broad labels like `творог`, `сок яблочный`, or `пиво безалкогольное` as the only revalidation string in the final payload.
9. Verify the basket after writing.
   - Run `node src/cli.js basket show --format json`
   - Do not run `basket show` in parallel with `basket apply`; wait for the write to finish first.
   - If `skippedItems` is non-empty and the chosen products were known live, suspect basket revalidation mismatch from an overly broad `query`.
   - Re-apply only the skipped lines with `node src/cli.js basket apply --keep-existing ...`, using exact `name` values.
10. Update `AGENTS.md` only when you discover durable tool behavior or public contract changes.
   - Keep `AGENTS.md` stable and reusable; do not append session-specific notes or personal shopping residue.

## Basket JSON contract

Use an array:

```json
[
  { "productId": 15622, "quantity": 2, "query": "яйца", "name": "Яйца \"Аштарак\" XLarge 10шт" },
  { "productId": 13093, "weightGrams": 1500, "query": "бананы", "name": "Банан кг" }
]
```

Or an object:

```json
{
  "replace": true,
  "items": [
    { "productId": 15622, "quantity": 2, "query": "яйца", "name": "Яйца \"Аштарак\" XLarge 10шт" },
    { "productId": 13093, "weightGrams": 1500, "query": "бананы", "name": "Банан кг" }
  ]
}
```

## Persistent preferences

- If the user expresses a durable preference that should survive this basket, store it with `overrides upsert` after confirming the exact live SKU.
- Useful generic patterns:
  - a broad category alias can point to a preferred exact SKU
  - an override can carry a default quantity or weight for habitual stock-up items
- `lookup items` can now honor these `prefer` overrides even for broad queries by performing targeted live searches for the preferred SKU before ranking.

## Guardrails

- Do not call `basket plan`; it is intentionally outside the tool boundary.
- Do not mutate the basket on the first pass from a loose list unless the user explicitly asked for immediate apply.
- Do not assume the highest-ranked live result is good enough. Check whether it actually matches the intended normalized query.
- Do not assume the query-level category hint is the right shelf; prefer categories discovered from actual item candidates and explicit shelf browsing.
- For flavor-specific lines, reject category-neighbors that miss the requested flavor.
- Do not assume the user's remembered flavor+size combination exists live; verify exact SKU variants such as `лимон 1л` versus `1.5л`.
- Do not assume a successful `lookup items` result means `basket apply` will revalidate the same SKU from a broad query.
- For weighted produce, prefer the historically common weight rounded to the live step.
- For paper towels and similar category-browsed goods, exclude dispenser/refill SKUs by default unless the user explicitly wants them.
- After test writes, leave the basket in the state you intend; do not leave accidental extra test items behind.
