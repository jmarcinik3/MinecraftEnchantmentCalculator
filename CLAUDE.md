# Enchantment Calculator

Static site (no build, no dependencies) that finds the cheapest Java Edition anvil
order for combining enchanted books/items. Serve over HTTP (Workers fail on `file://`):
`python -m http.server 8080`.

## Files
- `index.html`: shell with 4 mount points: `#items`, `#wanted`, `#books`, `#results` (+ `#objective`, `#copy-link`).
- `js/App.js` (ES module, ~530 lines): state, rendering via `h(tag, attrs, ...children)`, worker lifecycle, URL save/load.
  State: `{ item, wanted: {ns: level}, auto_books, books: [{ id, type: "book"|"item", enchantments, prior_work }], objective: "levels"|"xp" }`.
  Recalc is debounced (`CALC_DELAY_MS`); cancel = terminate worker and start a new one.
- `js/Engine.js` (UMD IIFE, NOT an ES module): pure, DOM-free search. Loaded by the worker via `importScripts`
  (`self.EnchantEngine`) and by Node tests via `require`. API: `createEngine(meta) -> { solve, combine, makeLeaf }`,
  `experienceFromLevel`, `priorWorkPenalty`, `MAXIMUM_MERGE_LEVELS`.
  `solve(entries, { objective, onProgress })` memoizes on item-subset bitmask, keeping the cheapest node per
  (prior work, enchantment signature); returns the root merge-tree node (`left`/`right` children) or null.
- `js/Calculator.js`: worker. Messages in: `instantiate_metadata`, `calculate_optimal`. Out: `progress`,
  `optimal_searched`, `calculation_failed` (all carry `request_id`).
- `js/Logic.js` (ES module): `createLogic(meta)` UI helpers: rarity, display names, tooltip sort, applicable
  enchantments, `maxAll`, `buildEntries(state)`, `missing`, `collectSteps(root)`, `serialize`/`deserialize`
  (share links). Also exports `roman`, `MAX_PRIOR_WORK` (6).
- `json/metadata.json`: keys `enchantments` ({incompatible, items, max_level, stylized, weight}), `items`,
  `icons`, `rarity`, `tooltip_order`. It's long, so grep for the entry you need instead of reading it all.
- `css/Style.css`, `img/<item>.png|svg`, `font/minecraft.woff`.

## Game rules implemented (Engine.js)
Book vs. item multipliers (`weight`), prior-work penalty `2^n - 1`, level caps, incompatible enchantments
dropped but cost 1 level, merges of 40+ levels are "Too Expensive". Ties break on the other objective.

## Adding an item or enchantment
Edit `metadata.json` (enchantment `items` lists, `items`, `icons`, `rarity`, `tooltip_order`), add an image to
`img/`, then run the tests.

## Tests (run after engine/logic changes)
`node test/Engine.test.js` (includes brute-force cross-check) and `node test/Logic.test.mjs`
(loads Logic.js through a data: URL).

## CI and hosting
`.github/workflows/pages.yml` runs both test files on every push, pull request, and manual run. On `main`,
if the tests pass, it copies `index.html css js json img font` into `_site/` and deploys to GitHub Pages at
https://jmarcinik3.github.io/EnchantmentCalculator/. New top-level site folders must be added to that copy step.

## Conventions
camelCase functions, PascalCase classes/filenames, snake_case variables, UPPER_CASE constants.
Keep Engine.js DOM-free and UMD. Keep UI text short.
