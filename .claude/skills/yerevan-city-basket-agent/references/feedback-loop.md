# Feedback Loop

Use this interaction pattern when working from a loose shopping list.

Tool root:

- the repository root that contains `src/cli.js`

Assumed working directory for command examples below:

- current directory is the repository root

## Default mode

The default is:

1. intake loose list
2. normalize and look up candidates
3. show a suggested basket
4. revise after user feedback
5. apply only after explicit approval

Keep the narrative response in the user's current language unless they ask otherwise.
Use exact store-language product names or query text only where needed for correct lookups or basket payloads.

Do not skip straight to `basket apply` unless the user clearly asked for immediate execution.

## Suggested response shape

When you have a first proposal, present:

- a short summary line
- the suggested basket lines
- any low-confidence or substituted choices
- a direct prompt for corrections or approval

Recommended structure:

```markdown
Suggested basket:

- `<normalized line>` -> `<chosen product>` x`N`
- `<normalized line>` -> `<chosen product>` `1500g`

Adjusted choices:

- `<user line>` -> `<what you normalized or substituted>` because `<short reason>`

If you want, tell me what to change. If this looks right, say `apply`.
```

## What counts as an adjusted choice

Call it out when you did any of these:

- split one user line into multiple explicit items
- chose a substitute because the historical favorite was unavailable
- picked one branch of an `or`
- rounded a weighted item to the live minimum or step
- chose a specific item from a broad category line

## Revising after feedback

If the user says things like:

- `not this yogurt, take the smaller one`
- `2 apple juices, no orange`
- `another beer`
- `no jam, take honey`

then:

1. update the normalized intent
2. re-run DB/live lookup if needed
3. update the structured payload
4. show the new proposal if the change is meaningful

For trivial quantity-only edits on the same chosen SKU, you can acknowledge the change briefly and keep moving toward approval.

If the user changes a quantity on a category-browsed good like paper towels:

1. state whether you are counting units, rolls, or packs
2. re-check cheap in-stock mixes if one SKU does not cover the whole request
3. call out any excluded specialty formats such as dispenser/refill towels

## Before apply

Before writing the basket:

- make sure the current proposal is explicit
- make sure quantities/weights are final
- make sure low-confidence lines are either resolved or intentionally omitted

Use this payload shape:

```json
{
  "replace": true,
  "items": [
    { "productId": 15622, "quantity": 2, "query": "яйца" },
    { "productId": 13093, "weightGrams": 1500, "query": "бананы" }
  ]
}
```

## After apply

After `basket apply`:

- verify with `node src/cli.js basket show --format json`
- wait for `basket apply` to finish before calling `basket show`; a parallel read can return a stale pre-apply cart snapshot
- summarize what was applied
- mention any skipped or trimmed items
- mention if the site auto-added bag lines
