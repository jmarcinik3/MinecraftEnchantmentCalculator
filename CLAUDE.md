# Enchantment Calculator

Static site (no build, no dependencies) that finds the cheapest Java Edition anvil
order for combining enchanted books/items. Serve over HTTP (Workers fail on `file://`):
`python -m http.server 8080`.

## Files
- `index.html`: shell with 2 left sections (1 Item and enchantments `#wanted`, 2 Books and items `#books`) and
  2 right ones (3 Best order: `#metrics` tiles and `#ranking` settings; 4 Anvil uses, `.results-card`: `#results` with status
  messages, anvil wear, the Steps/Tree row and the steps), all collapsible (+ `#edition`, `#copy-link`,
  `#language`, `#theme` (sun/moon: `setupTheme`/`renderTheme`, `THEME_STORAGE_KEY`, `data-theme` on <html>, set early by an inline
  script in index.html; Style.css dark tokens apply under `prefers-color-scheme: dark` unless `data-theme="light"`, or with
  `data-theme="dark"`), and the `#saved` menu, a `<details>` whose `#saved-panel` App.js fills). The header controls share
  `.header-control` (one height); under 600px they form a full-width row below the title, under 440px Copy link is icon-only).
- `js/App.js` (ES module, ~530 lines): state, rendering via `h(tag, attrs, ...children)`, worker lifecycle, URL save/load.
  State: `{ item, wanted: {ns: level}, auto_books, books: [{ id, type: "book"|"item", enchantments, prior_work, copies }], priority: [criteria, most important first], max_step: 1-39, no_step_limit, allow_incompatible, edition: "java"|"bedrock", rename, rename_to }`
  (`rename` is true exactly when `rename_to` has text; the name is shown in italics on the final result, cut by Logic `cleanName` to 50/30 chars per edition;
  share links are base64 of UTF-8 so any characters survive)
  (`no_step_limit` is for mods that remove "Too Expensive!"; the worker gets `max_merge_levels: Infinity`;
  `allow_incompatible` is for mods that let conflicting enchantments go together). The engine never checks conflicts:
  Logic.js `sanitizeEnchantments`/`sanitizeBooks` and the editors keep every entry, and entries against each other,
  conflict-free unless `allow_incompatible` is on.
  Criteria: `levels`, `xp`, `max_step`, `prior_work` (`CRITERIA` in both Logic.js and Engine.js; a test keeps them equal).
  Recalc is debounced (`CALC_DELAY_MS`); cancel = terminate worker and start a new one.
- `json/text/<language>.json` (`en`, `es`): every string the page shows (labels, tooltips, messages), grouped by
  section, plus `names: { items, enchantments, descriptions }` (the only place item and enchantment names live, English
  included; `descriptions`: what each enchantment does, in a few words).
  Templates use `{placeholder}` (arrays join as a localized list); number-dependent text is
  `{ "plural": "<value>", "one": ..., "other": ... }` (Intl.PluralRules forms). index.html headings use
  `data-text="section.key"`. Add new UI text there, in every language, not inline in App.js. Tests check each
  language has the same entries, kinds and placeholders as English, and every item/enchantment name.
- `js/Text.js` (ES module): the loader. `LANGUAGES` (code -> name; add a language here and as a JSON file),
  `loadLanguage(code)` fetches and compiles into `TEXT` in place, so templates are called with named values:
  `TEXT.wanted.replaces({ name })`. `compileText`/`setText` are the pure parts (used by tests).
  App.js `useEdition` passes `TEXT.names` to `createLogic(meta, names)`.
- `js/Engine.js` (UMD IIFE, NOT an ES module): pure, DOM-free search. Loaded by the worker via `importScripts`
  (`self.EnchantEngine`) and by Node tests via `require`. API: `createEngine(meta, { edition }) -> { solve, combine, makeLeaf }`,
  `experienceFromLevel`, `priorWorkPenalty`, `normalizePriority`, `CRITERIA`, `EDITIONS`, `MAXIMUM_MERGE_LEVELS`, `MAXIMUM_GROUPS`.
  `solve(entries, { priority, max_merge_levels, rename, next_best, onProgress })` (`next_best`: also sets `root.next_best`, the best other finished
  order with the same enchantments that the ranking puts after it, or null; the page doesn't ask for it yet) memoizes on groups of entries, keeping the best
  nodes per (prior work, enchantment signature); returns the root merge-tree node (`left`/`right` children) or null.
  Totals (levels, XP) are additive, so one node per bucket is exact; when `max_step` outranks a total, the bucket
  keeps a Pareto front over (max step, totals) instead (see `dominance`). Old `objective` option still accepted.
  Speed: identical entries are one "kind", and a group is a mixed-radix code of how many of each kind it holds
  (`groupKinds`), so repeats are not re-solved. Each merge is `preview`ed into scratch space and only built if it
  survives its bucket; bucket keys are numbers (`keyLayout`), with text keys past 2^53.
  Limit: at most `MAXIMUM_GROUPS` (2^20) groups, i.e. 20 all-different entries; repeats are cheap. Logic.js
  `searchSize` computes the same groups/splits for the page's slow warning (`SLOW_SPLITS` in App.js) and limit.
- Section 3 ("Best order", collapsed summary = all four results in ranking order, `renderOrderSummary`): the ? tip in its
  heading and, beside it in a `.section-head`, the settings menu (`#options-menu` `<details>`: a button showing
  `optionsSummary` + gear, opening `#limit-panel`, "Game rules": the level limit slider and the Allow conflicts switch (`conflictsSwitch`; the
  button's summary adds "Conflicts allowed" when on; under 600px the button is the gear alone, with a dot (`.changed`) when a
  rule isn't the default); closes on outside click/Escape via
  `setupMenuClosing`), then the tiles (`#metrics`), then `#ranking` (`renderRanking`: one `.options` grid with
  Rename and Your level; `updateLevelMeter` fills its XP bar and "Set to N"). Ticked steps count as 0 for your
  level (`remainingLevels`: already paid for), and ticking redraws the results; the Levels tile keeps the full total.
  On desktop (900px+) the right column is a window-high flex column (section 3 natural height, section 4 the rest) and only `.steps-scroll` (the steps or tree, under the Steps/Tree row)
  scrolls; `steps_scroll` keeps its position across redraws of the same order and view. Phones scroll the page.
- Options (`renderRanking`, 2-column `.options` grids, refocusing by `data-focus` after redraws):
  level limit slider 1-39 plus an ∞ button (= `no_step_limit`), commits on release, value tappable to type
  (`editLimit`); "Your level" −/+ (`holdButton` repeats while held) around a green number with an XP bar filling
  toward the order's total levels (`updateLevelMeter`), an on/off toggle showing `img/experience_orb.png`, and "Set to N" (`#level-set`: the unticked steps' total) (off shows ∞ in place of the number) (`level_on`,
  `LEVEL_ON_STORAGE_KEY`; `activeLevel()` is what the steps use; changing the number turns it on); Rename is one anvil-style name box (`nameField`:
  `img/name_tag.png`, "+1 level" badge, character count); empty is no rename and shows the item's name as a gray
  placeholder; any typed name renames; `state.rename` follows whether `rename_to` has text (`syncRename`,
  also on load/edition change), and typing only reschedules the search when that flips, without redrawing the box.
  Only the limit commits; your level and the name redraw just the results.
- The Best order "?" bubble and the Game rules "?"s (`helpTip`, Level limit and Allow conflicts) are `position: fixed` (`floatBubble`,
  `.info-tip.floating`, one shared scroll/resize listener), placed under the "?" on open, hover, focus and scroll, and the
  Game rules panel is fixed too (placed by `setupOptionsMenu`), so none of them adds height to the scrolling right column.
- Section 1 (`renderWanted`): until an item is picked, `itemGrid`; then a preview of the finished item (`wantedPreview`, the game
  slot + tooltip via `anvilCell`; the slot is `.item-menu-button`, opening `itemGrid` in `.item-menu` (`item_menu_open`;
  static in the card under 600px; `setupItemMenu` closes it on outside click/Escape)). The preview and the controls
  (toolbar, presets) form `wantedHead`: side by side when `#wanted` is 460px+ (container query; the preview has a fixed
  width there). The preview's height slides on change (`growSmoothly`, 0.25s, a timer clears it) and new lines open from
  0 height in place and fade in (`openLines`, `.fresh` from `preview_shown`); toggling "Allow conflicts" slides and fades each
  conflict group (`conflicts_toggled`, `.ench-group[data-group]`); all off with reduced motion. Then
  the toolbar, presets (`presetChips`; Logic.js `presets`: "best" = `maxAll` from nothing, plus one per `PRESET_SWAPS`
  entry the item takes; "best" is named after its pick when the item has one conflict set), then `wantedList`: rows (`wantedRow`: name in the game font, curses red, an `.ench-info` tip with
  `names.descriptions` (Logic `describe`), a `+N` hint once chosen (Logic `bookCost`: level x book multiplier), and a
  `levelBar`: role=slider, joined segments, tap/drag/arrow keys, always 5 segments wide so the I segments line up),
  "Pick one" groups as a switch (`groupSwitch`) plus the chosen one's row, partial conflicts in a left bracket
  (`.ench-group`), conflicting rows dimmed. Chosen rows get a CSS glint. Focus is restored by `data-focus` after redraws.
- Section 2 (`renderBooks`): an Automatic | Custom switch (`modeSwitch`; Custom = `customizeBooks`), then `.entry-grid`
  (2 columns once `#books` is 440px+, container query) of `entryCard`s: slot (stack count when copies > 1) + game
  tooltip; editable in Custom: grip, slot = book/item switch, copies/prior work badges (open `countPopover`), tooltip
  lines and "+ Add enchantment" (open `enchantPicker`: level bars via `levelBar(ns, level, blocker, onChoose, focus)`,
  section-1 picks first, conflicts on this entry replace, on other entries blocked; `setEntryLevel`, twin merge), ×; the
  last cell is `addCard`. One popover at a time (`entry_popover`, `placePopover` puts it in the grid under its card;
  outside click/Escape close). Cards slide on change (`cardRects`/`animateCards`, grid-relative, FLIP), and `render`
  and `renderBooks` keep the scroll position across the redraw.
  Also in Custom: `coverageStrip` (each section 1 pick reached ✓ or not; an amber chip runs `applyFix`, same as the ⚠ fixes),
  × fades out (`removeEntry`) with "Put back …" (`undo_books` + `undo_label`), ⧉ `duplicateEntry`, "Add book"/⧉ open the
  picker at once (`openPicker`/`focusPicker`; their buttons are `.popover-toggle` so the outside-click handler leaves it
  open), the picker lists section 1 picks first with "Show all" (`picker_all`) and highlights a tapped line's row
  (`entry_popover.ns`, `.spot`), a Cards | List switch (`viewSwitch`, `BOOKS_VIEW_STORAGE_KEY`; List = `.entry-card.compact`
  grid rows; switching morphs each card from its old box, `animateCards(..., morph)`), a type box making one book of every typed enchantment (`addTyped`, Logic.js `parseBooks` per piece: "prot 4, mending"), and dragging a tooltip line
  onto another card moves it (`lineDragStart`: mouse after 6px, touch after a 350ms hold; `moveEnchantment`).
- Section 4 Steps view (`renderResults`): toolbar = Steps/Tree, `stepProgress` ("3 of 7 done · N levels to go" bar + ↺ untick
  all), Copy steps, Print; a
  `.rounds.timeline` rail (round labels as breaks, a `.step-node` per step). `anvilStep`: a `.step-head` (the whole
  "☐ Step N" ticks; the first unticked step is `.current`; ticking, folding and Space keep that step where it was on screen
  (`keepInPlace`), and ticking scrolls down to the next unticked step only when it is below view (`revealBelow`, never up); Space on a
  focused step ticks it), steps fold to one line (`stepLine`; done ones by default, any by a click on the head or its button: `isFolded`/
  `toggleFold`, `step_folds` overrides, dropped for a step whose tick changes via `saveTicks`), the row is an anvil-window
  panel (`--gui-*` tokens), inputs show their section 2 entry (`entryRef`/`entryIndexOf`: "#3", hover highlights the card,
  tap scrolls to it) or "From step N", the result its prior work, the cost is amber within 5 of the level limit and red at
  it, and `levelMeter` draws "Lv 30 → 28" with a bar.
- All sections collapse from their heading (`.card.collapsible`, `setupCollapsing`; closed ones in
  `COLLAPSED_STORAGE_KEY`), showing a one-line summary (`renderSummaries`) while closed. The books badge in
  the heading is excluded from the toggle click.
- App.js extras: in `localStorage` (guarded `readStorage`/`writeStorage`), never in share links: "Your level"
  (`player_level`; Logic.js `levelTrack` shows the level before/after each step), the Steps/Tree view
  (`result_view`; `mergeTree`), saved setups (`SAVED_STORAGE_KEY`: `{name, item, link}`, link = `serialize` text,
  loaded via `readLink`; × removes one, with Undo until the menu closes: `removed_setup`), and the language. The Tree view (`mergeTree`) draws each entry as a game slot + tooltip (rarity colors, game font) and its
  step badges carry the same tick boxes as the Steps view (`stepTick`, shared ticks); each merge folds its inputs away like its step does (same `isFolded`/`toggleFold` state, ▾/▴ `.step-fold`). Ticking a step also ticks
  the steps it needs and unticking one unticks the steps that need it (Logic.js `tickStep`); "Uncheck all" clears them. Section 4's heading always shows the uses (`renderStepsSummary`) and the break risk (`anvilRisk`: an
  `.info-tip` pill with `img/anvil.png` and the chance, colored by Logic.js `anvilBreakChance`: 12% damage per use, breaks on the 3rd), "Copy steps" (`stepsText`), and Print (`@media print` in Style.css; `.print-only` lines).
  The step checklist is stored in `localStorage` (`CHECKLIST_STORAGE_KEY`) for the order on screen only,
  keyed by its steps (`orderKey`); custom entries reorder by a grip (`entryHandle`: drag or arrow keys over `.entry-card`s; order is cosmetic);
  the result tiles are also the ranking (`renderMetrics`; both drag via pointer events in `dragToReorder` so touch works; values update in place so a result arriving mid-drag does not redraw them).
- `js/Calculator.js`: worker, one engine per edition. Messages in: `instantiate_metadata`, `calculate_optimal`
  (with `edition`, `rename`). Out: `progress`,
  `optimal_searched`, `calculation_failed` (all carry `request_id`).
- `js/Logic.js` (ES module): `createLogic(meta, names)` UI helpers: rarity, display names, tooltip sort, applicable
  enchantments, `maxAll`, `buildEntries(state)`, `missing`, `extra` (result enchantments not chosen), `bestLevels`/`checkBooks`/`addBook`/`twinOf` (pre-calculation warnings: a badge on the section 2
  heading whose bubble offers one fix per enchantment, a book at the chosen level; adding merges into an identical entry and drops books and
  items whose only enchantment is a lower level of it (any prior work; never the last item), with Undo in the toolbar, and marks on section 1 rows; App.js `infoTip` builds the badge), `collectSteps(root)` (steps in rounds of independent steps, cheapest first; `stepRounds` splits them), `tickStep`, `serialize`/`deserialize`
  (share links; old `o` objective links still load). Also exports `roman`, `maxPriorWork(step_limit)` (highest usable
  prior work, from the 2^n - 1 penalty; Infinity with no limit), `MAX_STEP_LEVELS` (39),
  `CRITERIA`, `normalizePriority`, `movePriority`, `clampStepLimit`.
- `json/metadata.json`: game data only, no names: keys `enchantments` ({incompatible, items, max_level, weight,
  optional `bedrock`}), `items` (list of item namespaces), `icons`, `rarity`, `tooltip_order`. It's long, so grep for the entry you need instead of reading it all.
- `ServiceWorker.js` (site root, since a worker only covers its folder): offline copy, network first (with `cache: "no-cache"`, so the HTTP cache never serves a stale file). Precaches the
  JS/CSS/JSON files (add new ones to `FILES`); `VERSION` is stamped on deploy so the URLs match and old caches go.
  `manifest.webmanifest` + `img/app_icon_*.png` make it installable.
- `css/Style.css`, `img/<item>.png|svg`, `font/minecraft.woff`.

## Game rules implemented (Engine.js)
Book vs. item multipliers (`weight`), prior-work penalty `2^n - 1`, level caps,
merges of 40+ levels are "Too Expensive" (the user can lower this cap or remove it). Ties break on the next-ranked criterion.
Renaming (`rename`) adds 1 level to the final step, counted during the search since it can push that step past the limit.
Editions (Minecraft Wiki, "Anvil mechanics"): Java charges each enchantment's final level x multiplier; Bedrock only the
levels it gains over the target's. A metadata enchantment's `bedrock` object overrides its fields in Bedrock
(Impaling `weight` 1; Sweeping Edge `items: []`, since Bedrock lacks it). Logic.js `editionMetadata` applies the same overrides.

## Adding an item or enchantment
Edit `metadata.json` (enchantment `items` lists, `items`, `icons`, `rarity`, `tooltip_order`), add its name to
`names` in every `json/text/*.json`, add an image to `img/`, then run the tests.

## Tests (run after engine/logic changes)
`node test/Engine.test.js` (includes brute-force cross-check) and `node test/Logic.test.mjs`
(loads Logic.js and Text.js through data: URLs, `moduleUrl` inlining their `./X.js` imports, and reads json/text directly).

## CI and hosting
`.github/workflows/pages.yml` runs both test files on every push, pull request, and manual run. On `main`,
if the tests pass, it copies `index.html ServiceWorker.js manifest.webmanifest css js json img font` into `_site/` and deploys to GitHub Pages at
https://jmarcinik3.github.io/MinecraftEnchantmentCalculator/. New top-level site folders must be added to that copy step.
Deploy then runs `.github/stamp-version.sh`, which adds `?v=<commit>` to the page's references to its CSS, JS modules
(and Text.js `TEXT_VERSION` for the json/text files), worker, Engine.js and metadata, and sets ServiceWorker.js `VERSION` (in `_site` only), so cached copies (phones especially) are not reused. It fails if a
reference is missing: when renaming or adding one of those files or imports, update the script.

## Conventions
camelCase functions, PascalCase classes/filenames, snake_case variables, UPPER_CASE constants.
Keep Engine.js DOM-free and UMD. Keep UI text short, and in `json/text/*.json`.
