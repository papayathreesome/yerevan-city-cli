# Napkin

Use this file as lightweight working memory for the repo.

Keep it short, practical, and shareable:

- mistakes worth not repeating
- user or workflow preferences that change how the tool should be used
- patterns that consistently work
- limitations that are easy to forget

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|

## User Preferences
- (record durable workflow preferences here)

## Patterns That Work
- (record reliable approaches here)
- `2026-03-15`: If the repo is a fresh checkout, run `npm install` before any `node src/cli.js ...` command. The CLI imports `classic-level` immediately via `src/browserStorage.js`, so even unrelated commands fail without dependencies.
- `2026-03-15`: For mineral-water habits, `lookup concepts вода` or a specific brand query like `lookup concepts бжни` surfaces useful history when colloquial `lookup concepts минералка` comes back empty.
- `2026-03-15`: For fresh berries, broad `lookup items ягоды` is noisy and pulls berry-flavored packaged goods. Use `lookup categories ягоды` and then specific fresh queries like `голубика` or `клубника`.
- `2026-03-15`: If `basket apply` skips known-live items, the `query` was probably too broad. Re-apply only the skipped lines with `--keep-existing` and set `query` to the exact live product name.
- `2026-03-16`: Treat most shopping lines as restocks first. Use history-backed `lookup concepts`/`lookup items` as the default path, and widen into `lookup items --category-id ... --browse` only when the usual SKU is unavailable, the request is genuinely new, or the user explicitly wants options.
- `2026-03-16`: `lookup tree` + cached category data make broad discovery cheaper across repeated CLI invocations. Use `lookup categories` or candidate-derived `discoveredCategories` to find likely shelves, then browse the full shelf directly.
- `2026-03-16`: Candidate-derived category hints are stronger than raw query-to-category matches. Use `queryCategoryHints` as fallback leads, not the main routing signal.

## Patterns That Don't Work
- (record failed approaches or sharp edges here)
- `2026-03-15`: `rm -f` on temp basket payload files was blocked by the command policy in this environment. Don't spend time on cleanup retries unless the leftover temp files matter.

## Domain Notes
- (record API, schema, or workflow facts here)
