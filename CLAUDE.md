# Enchantment Calculator

Static site (no build, no dependencies) that finds the cheapest Java Edition anvil
order for combining enchanted books/items. Serve over HTTP (Workers fail on `file://`):
`python -m http.server 8080`.

## Files
- `index.html`: shell with 4 mount points: `#items`, `#wanted`, `#books`, `#results` (+ `#ranking` options, `#metrics` tiles, `#edition`, `#copy-link`).
- `js/App.js` (ES module, ~530 lines): state, rendering via `h(tag, attrs, ...children)`, worker lifecycle, URL save/load.
  State: `{ item, wanted: {ns: level}, auto_books, books: [{ id, type: "book"|"item", enchantments, prior_work, copies }], priority: [criteria, most important first], max_step: 1-39, no_step_limit, allow_incompatible, edition: "java"|"bedrock", rename, rename_to }`
  (`rename_to` is display-only: italic name on the final result, cut by Logic `cleanName` to 50/30 chars per edition;
  share links are base64 of UTF-8 so any characters survive)
  (`no_step_limit` is for mods that remove "Too Expensive!"; the worker gets `max_merge_levels: Infinity`;
  `allow_incompatible` is for mods that let conflicting enchantments go together). The engine never checks conflicts:
  Logic.js `sanitizeEnchantments`/`sanitizeBooks` and the editors keep every entry, and entries against each other,
  conflict-free unless `allow_incompatible` is on.
  Criteria: `levels`, `xp`, `max_step`, `prior_work` (`CRITERIA` in both Logic.js and Engine.js; a test keeps them equal).
  Recalc is debounced (`CALC_DELAY_MS`); cancel = terminate worker and start a new one.
- `js/Text.js` (ES module): `TEXT`, every string the page shows (labels, tooltips, messages), grouped by
  section; templated ones are functions (`name => ...`). index.html headings use `data-text="section.key"`.
  Add new UI text here, not inline in App.js. A test checks the criteria and `data-text` keys exist.
- `js/Engine.js` (UMD IIFE, NOT an ES module): pure, DOM-free search. Loaded by the worker via `importScripts`
  (`self.EnchantEngine`) and by Node tests via `require`. API: `createEngine(meta, { edition }) -> { solve, combine, makeLeaf }`,
  `experienceFromLevel`, `priorWorkPenalty`, `normalizePriority`, `CRITERIA`, `EDITIONS`, `MAXIMUM_MERGE_LEVELS`, `MAXIMUM_GROUPS`.
  `solve(entries, { priority, max_merge_levels, rename, onProgress })` memoizes on groups of entries, keeping the best
  nodes per (prior work, enchantment signature); returns the root merge-tree node (`left`/`right` children) or null.
  Totals (levels, XP) are additive, so one node per bucket is exact; when `max_step` outranks a total, the bucket
  keeps a Pareto front over (max step, totals) instead (see `dominance`). Old `objective` option still accepted.
  Speed: identical entries are one "kind", and a group is a mixed-radix code of how many of each kind it holds
  (`groupKinds`), so repeats are not re-solved. Each merge is `preview`ed into scratch space and only built if it
  survives its bucket; bucket keys are numbers (`keyLayout`), with text keys past 2^53.
  Limit: at most `MAXIMUM_GROUPS` (2^20) groups, i.e. 20 all-different entries; repeats are cheap. Logic.js
  `searchSize` computes the same groups/splits for the page's slow warning (`SLOW_SPLITS` in App.js) and limit.
- App.js extras: the step checklist is stored in `localStorage` (`CHECKLIST_STORAGE_KEY`) for the order on screen only,
  keyed by its steps (`orderKey`); custom entries reorder by a grip (`entryHandle`: drag or arrow keys; order is cosmetic);
  the result tiles are also the ranking (`renderMetrics`; both drag via pointer events in `dragToReorder` so touch works; values update in place so a result arriving mid-drag does not redraw them).
- `js/Calculator.js`: worker, one engine per edition. Messages in: `instantiate_metadata`, `calculate_optimal`
  (with `edition`, `rename`). Out: `progress`,
  `optimal_searched`, `calculation_failed` (all carry `request_id`).
- `js/Logic.js` (ES module): `createLogic(meta)` UI helpers: rarity, display names, tooltip sort, applicable
  enchantments, `maxAll`, `buildEntries(state)`, `missing`, `extra` (result enchantments not chosen), `bestLevels`/`checkBooks`/`addBook`/`twinOf` (pre-calculation warnings: a badge on the section 3
  heading whose bubble offers one fix per enchantment, a book at the chosen level; adding merges into an identical entry and drops books and
  items whose only enchantment is a lower level of it (any prior work; never the last item), with Undo in the toolbar, and marks on section 2 rows; App.js `infoTip` builds the badge), `collectSteps(root)` (steps in rounds of independent steps, cheapest first; `stepRounds` splits them), `serialize`/`deserialize`
  (share links; old `o` objective links still load). Also exports `roman`, `maxPriorWork(step_limit)` (highest usable
  prior work, from the 2^n - 1 penalty; Infinity with no limit), `MAX_STEP_LEVELS` (39),
  `CRITERIA`, `normalizePriority`, `movePriority`, `clampStepLimit`.
- `json/metadata.json`: keys `enchantments` ({incompatible, items, max_level, stylized, weight}), `items`,
  `icons`, `rarity`, `tooltip_order`. It's long, so grep for the entry you need instead of reading it all.
- `css/Style.css`, `img/<item>.png|svg`, `font/minecraft.woff`.

## Game rules implemented (Engine.js)
Book vs. item multipliers (`weight`), prior-work penalty `2^n - 1`, level caps,
merges of 40+ levels are "Too Expensive" (the user can lower this cap or remove it). Ties break on the next-ranked criterion.
Renaming (`rename`) adds 1 level to the final step, counted during the search since it can push that step past the limit.
Editions (Minecraft Wiki, "Anvil mechanics"): Java charges each enchantment's final level x multiplier; Bedrock only the
levels it gains over the target's. A metadata enchantment's `bedrock` object overrides its fields in Bedrock
(Impaling `weight` 1; Sweeping Edge `items: []`, since Bedrock lacks it). Logic.js `editionMetadata` applies the same overrides.

## Adding an item or enchantment
Edit `metadata.json` (enchantment `items` lists, `items`, `icons`, `rarity`, `tooltip_order`), add an image to
`img/`, then run the tests.

## Tests (run after engine/logic changes)
`node test/Engine.test.js` (includes brute-force cross-check) and `node test/Logic.test.mjs`
(loads Logic.js through a data: URL).

## CI and hosting
`.github/workflows/pages.yml` runs both test files on every push, pull request, and manual run. On `main`,
if the tests pass, it copies `index.html css js json img font` into `_site/` and deploys to GitHub Pages at
https://jmarcinik3.github.io/MinecraftEnchantmentCalculator/. New top-level site folders must be added to that copy step.
Deploy then runs `.github/stamp-version.sh`, which adds `?v=<commit>` to the page's references to its CSS, JS modules,
worker, Engine.js and metadata (in `_site` only), so cached copies (phones especially) are not reused. It fails if a
reference is missing: when renaming or adding one of those files or imports, update the script.

## Conventions
camelCase functions, PascalCase classes/filenames, snake_case variables, UPPER_CASE constants.
Keep Engine.js DOM-free and UMD. Keep UI text short, and in `js/Text.js`.
