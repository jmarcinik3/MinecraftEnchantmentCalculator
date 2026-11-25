# Enchantment Calculator

Static site (no build, no dependencies) that finds the cheapest Java Edition anvil
order for combining enchanted books/items. Serve over HTTP (Workers fail on `file://`):
`python -m http.server 8080`.

## Files
- `index.html`: shell with 2 left sections (1 Item and enchantments `#wanted`, 2 Books and items `#books`) and
  2 right ones (3 Best order: `#metrics` tiles and `#ranking` settings; 4 Anvil uses, `.results-card`: `#results` with status
  messages, anvil wear, the Steps | Slots | Tree row and the steps), all collapsible (+ `#copy-link`,
  `#language`, `#theme` (sun/moon: `setupTheme`/`renderTheme`, `THEME_STORAGE_KEY`, `data-theme` on <html>, set early by an inline
  script in index.html; Style.css dark tokens apply under `prefers-color-scheme: dark` unless `data-theme="light"`, or with
  `data-theme="dark"`), and the `#saved` menu, a `<details>` whose `#saved-panel` App.js fills). The header controls share
  `.header-control` (one height); under 600px they form a full-width row below the title, under 440px Copy link is icon-only).
- The page is `js/App.js` plus ES modules split by section (no build step; cycles between them are fine, since they only
  call each other's functions at run time). `Store.js`: shared state (`state`, `logic`, `meta`, `language`, `next_book_id`...;
  other modules import these live bindings and change them only through `setState`, `setLogic`... and `nextBookId()`, since an import
  can't be assigned). `Dom.js`: `h(tag, attrs, ...children)`, `$`, `icon`, guarded storage, `copyText`, `motionOk` (reduced motion), `keepGlintsInStep`.
  `Motion.js`: the animations (`growSmoothly`, `openLines`/`closeLines`, `slideWidth`, `cardRects`/`animateCards`, `keepInPlace`, `revealBelow`).
  `Wanted.js` section 1, `Books.js` section 2, `Ranking.js` the result tiles, `Options.js` level limit/rename/Your level,
  `Results.js` section 4 (steps, tree, progress, checklist), `Calc.js` worker, requests and the other-edition comparison,
  `Link.js` share links, `Tips.js` the "?" bubbles, `App.js` state changes, `render`, collapsing, language, saved setups, theme, `init`.
  A new module goes in ServiceWorker.js `FILES`; `stamp-version.sh` stamps every `from "./X.js"` automatically. Function names
  below live in the module for their section (grep for them).
- State and rendering:
  State: `{ item, wanted: {ns: level}, auto_books, books: [{ id, type: "book"|"item", enchantments, prior_work, copies }], priority: [criteria, most important first], max_step: 1-39, no_step_limit, allow_incompatible, edition: "java"|"bedrock", rename, rename_to }`
  (`rename` is true exactly when `rename_to` has text; the name is shown in italics on the final result, cut by Logic `cleanName` to 50/30 chars per edition, counted in UTF-16 units as the game and `maxlength` do (an emoji is 2; a switch to Bedrock and back keeps the uncut name, App.js `uncut_name`);
  share links are base64 of UTF-8 so any characters survive)
  (`no_step_limit` is for mods that remove "Too Expensive!"; the worker gets `max_merge_levels: Infinity`;
  `allow_incompatible` is for mods that let conflicting enchantments go together). The engine never checks conflicts:
  Logic.js `sanitizeEnchantments`/`sanitizeBooks` and the editors keep every entry, and entries against each other,
  conflict-free unless `allow_incompatible` is on.
  Criteria: `levels`, `xp`, `max_step`, `prior_work` (`CRITERIA` in both Logic.js and Engine.js; a test keeps them equal).
  Recalc is debounced (`CALC_DELAY_MS`); cancel = terminate worker and start a new one. A slow search's bar says the time so far, then
  an estimate of what is left (Calc.js `progressLabel`, refreshed every second; the engine reports every 1/2000 of the splits).
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
  `solve(entries, { priority, max_merge_levels, rename, onProgress })` memoizes on groups of entries, keeping the best
  nodes per (prior work, enchantment signature); returns the root merge-tree node (`left`/`right` children) or null.
  Totals (levels, XP) are additive, so one node per bucket is exact; when `max_step` outranks a total, the bucket
  keeps a Pareto front over (max step, totals) instead (see `dominance`). Old `objective` option still accepted.
  Speed: identical entries are one "kind", and a group is a mixed-radix code of how many of each kind it holds
  (`groupKinds`), so repeats are not re-solved. Each merge is `preview`ed into scratch space and only built if it
  survives its bucket; bucket keys are numbers (`keyLayout`), with text keys past 2^53.
  Limit: at most `MAXIMUM_GROUPS` (2^20) groups, i.e. 20 all-different entries; repeats are cheap. Logic.js
  `searchSize` computes the same groups/splits for the page's slow warning (`SLOW_SPLITS` in Store.js) and limit.
- Section 3 ("Best order", collapsed summary = all four results in ranking order, `renderOrderSummary`): the ? tip in its
  heading (the heading row is a `.section-head`: the h2 and the collapse arrow), then `#metrics` (`renderMetrics`): the "Rank by"
  chips (`rankPresets`, `RANK_PRESETS`: one tap puts a criterion first), the four tiles (a grip, the number, the label; the value with its unit,
  `criteria.<c>.unit`, and a note under it, `criteria.<c>.note`; the Max level tile says "(limit N)" and is amber within 5 levels of the
  limit, red at it: `.near`/`.at`) and a caption in words (`rankCaption`), then `#ranking` (`renderRanking`: one `.options` grid with Rename and
  Your level; under 480px each label sits above its control). The Game rules menu is in the page header with the other global buttons
  (`#options-menu` `<details>`, `.header-control.options-button`: the label "Game rules" + gear, its hover title and label say the limit and
  conflicts; a dot (`.changed`) when a rule isn't the default, and under 600px the gear alone). It opens `#limit-panel`: the level limit slider, the Allow
  conflicts switch (`conflictsSwitch`) and "Reset to vanilla" (`resetRules`, disabled while the rules are the game's own); it closes on outside click/Escape via `setupMenuClosing`. Ticked steps count as 0 for your
  level (`remainingLevels`: already paid for), and ticking redraws the results; the Levels tile keeps the full total.
  On desktop (900px+) the right column is a window-high flex column (section 3 natural height, section 4 the rest) and only `.steps-scroll` (the steps or tree, under the Steps | Slots | Tree row)
  scrolls; `steps_scroll` keeps its position across redraws of the same order and view. Phones scroll the page.
- Options (`renderRanking`, refocusing by `data-focus` after redraws): the level limit slider 1-39 (in the Game rules menu) plus an
  infinity button (= `no_step_limit`), commits on release, value tappable to type (`editLimit`). "Your level" is a switch, "Track my
  level" (`level_on`, `LEVEL_ON_STORAGE_KEY`; `activeLevel()` is what the steps use); on, it opens (`openRow`/`closeRow`) a number with - / +
  (`holdButton` repeats while held) and an XP bar filling toward the order's total levels (`updateLevelMeter`), a "Set to the N you need" button
  (`#level-set`: the unticked steps' total) and a status line (`#level-status`: "Need N more levels" in red, or "Enough for this order" in green).
  Rename is one anvil-style name box (`nameField`: `img/name_tag.svg`, "+1 level" badge, character count); empty is no rename and shows the
  item's name as a gray placeholder; any typed name renames; `state.rename` follows whether `rename_to` has text (`syncRename`,
  also on load/edition change), and typing only reschedules the search when that flips, without redrawing the box.
  Only the limit commits; your level and the name redraw just the results.
- With no order within the limit, Section 4 says why and, from a second search with no limit that ranks the biggest step first
  (`findBreak` in Calc.js, `last_break`), shows where it breaks (`whereItBreaks`: the step that costs most, as three slots, with its cost)
  and the cheapest way out: "Raise the limit to N" (the smallest limit that works), or, when even the game's 39 would stop it, "Remove the limit (mods)".
- The Best order "?" bubble and the Game rules "?"s (`helpTip`, Level limit and Allow conflicts) are `position: fixed` (`floatBubble`,
  `.info-tip.floating`, one shared scroll/resize listener), placed under the "?" on open, hover, focus and scroll, and the
  Game rules panel is fixed too (placed by `setupOptionsMenu`), so none of them adds height to the scrolling right column.
- Section 1 (`renderWanted`): until an item is picked, `itemGrid`; then a preview of the finished item (`wantedPreview`, the game
  slot + tooltip via `anvilCell`; the slot is `.item-menu-button`, opening `itemGrid` in `.item-menu` (`item_menu_open`;
  static in the card under 600px; `setupItemMenu` closes it on outside click/Escape)). The preview and the controls
  (toolbar, presets) form `wantedHead`: side by side when `#wanted` is 460px+ (container query; the preview has a fixed
  width there). The preview's height slides on change (`growSmoothly`, 0.25s, a timer clears it) and new lines open from
  0 height in place and fade in (`openLines`, `.fresh` from `preview_shown`; removed lines fold away in place, `closeLines`; a swap that leaves the box the same size rolls every changed row together like a counter, in one direction (`rollLines`: old text out one edge, new in from the other, clipped to the row, rows matched by position; the direction follows the enchantments that stay: they end up lower (a line added above) = down, higher (a line above went) = up; else the replacing enchantment lower in the tooltip order = up, higher = down; level-only changes by level; else up); the tooltip's width slides too, `slideWidth`; only a fade when the box ends the same size, as when swapping conflicting picks); toggling "Allow conflicts" slides and fades each
  conflict group (`conflicts_toggled`, `.ench-group[data-group]`); all off with reduced motion. Then
  the presets (`presetChips`; Logic.js `presets`: "best" = `maxAll` from nothing, plus one per `PRESET_SWAPS`
  entry the item takes; "best" is named after its pick when the item has one conflict set), then `wantedList`, in this order: enchantments alone, "Pick one" cards, "Some conflict" brackets (each alphabetical; `byKind`), then the Curses and each mod's folded section ordered the same way: rows (`wantedRow`: a CSS grid, so rows line up: name in the game font (curses red) with `names.descriptions` (Logic `describe`) under it, a `+N` hint once chosen (Logic `bookCost`: level x book multiplier), a
  `levelBar` (role=slider, joined segments, tap/drag/arrow keys, always 5 segments wide, the missing levels drawn as a faint track so right edges line up), and a × that clears it; narrow cards (container query) put the bar under the name),
  "Pick one" groups as a card (`.ench-group.exclusive`: label, switch (`groupSwitch`), chosen row), partial conflicts in a left bracket
  (`.ench-group`), conflicting rows dimmed. A "Pick one" group going to or from None opens or closes its chosen row (`animatePick`: `openRow`, `closeRow` with a copy of the old row) while the options and the border fade between their looks. A row whose height changes at a redraw (a "not on your books" note appearing) eases to it (`data-ns` on `.ench-row`, `old_rows` in `renderWanted`). A box that folds away (`openRow`/`closeRow`/`revealBar`/`leaveBar`) shrinks its padding, borders and margins too (`boxOf`/`FOLDED` in Motion.js), or it would end still tall and vanish with a jump. The cost line's hidden state is `.idle` (not `.empty`, which is the empty-state boxes' padding). Dom.js `keepGlintsInStep` starts every glint (`glint`, `row-glint`) at the animation timeline's zero, so a redraw never starts a sheen over. Section 1 never scrolls the page when its tooltip resizes (the rows below just move). Switching a "Pick one" member whose bar has a different length rolls the bar (`rollLevelBar`: every new segment unrolls and every lost one rolls away at the same moment, and a bar of more than five levels wraps into rows of five whose height eases when it gains or loses a row). A chosen row is tinted with an accent bar. There is no toolbar: the presets (label above, chips wrapping) start with "Plain" (nothing chosen, the way to clear) and chosen rows glint again (`row-glint`). Focus is restored by `data-focus` after redraws. Custom elements: the level bar's segments are game inventory slots (gray, beveled; a chosen level lit purple); the item grid is slots with the game's tooltip on hover/focus (`.item-tip`: name and `item_takes`); each row has a small book (`.ench-book`, dim until chosen; the row's own sheen passes over it) and a dimmed row says "Replaces X" (`.replaces-mark`); the preview tooltip ends with a `.cost-line` (XP orb + "N Levels", the last result's `cumulative_levels`; `updateCostMeter` is called by `renderResults`; it takes no width, folds away while there is no result, and opens, closes and fades its words smoothly); hovering or focusing a preset shows a `.compare-tip` tooltip of what it adds (+, `.changed`), raises or removes (-, `.removed`) (not on touch).
- Section 2 (`renderBooks`): a toolbar (Automatic | Custom `modeSwitch`, Custom = `customizeBooks`; the Cards | List icon pair
  `viewSwitch`, at the right end since it is a preference) then `.entry-grid`
  (2 columns once `#books` is 440px+, container query) of `entryCard`s: the slot on the left (stack count when copies > 1) and the
  game tooltip beside it; editable in Custom: a strip (`.entry-head`) above the tooltip with the grip, the badges and ⧉ ×; the slot
  is the book/item switch (its corner button `.stack-edit` opens the copies stepper, kind "copies", with hold-to-repeat `startHold`, and the mouse wheel over it changes the copies) (a swap badge `.swap-glyph` on hover/focus, always on touch); copies show as the stack count on the slot and prior work as an anvil badge only when it isn't 0; without that badge a quiet ⋯ (`.entry-more`)
  opens the prior work popover (`countPopover`, kind "work": a row of anvils, tap the nth for n uses, `workRow`), and the grip and ⋯ show only
  while the card is hovered or focused with a mouse (`@media (hover: hover)`); the icon buttons have 28x24px hit areas (40x32 on touch);
  an entry with enchantments adds from a small "+" in its name row (`.entry-add-plus`), an empty one has the full "+ Add enchantment" line
  (both open `enchantPicker`; in every level bar up/down move to the neighbouring enchantment's bar and left/right change the level: level bars via `levelBar(ns, level, blocker, onChoose, focus)`,
  section-1 picks first, conflicts on this entry replace, on other entries blocked; `setEntryLevel`, twin merge); the add area `addCard`
  (`.entry-add-card`) is a full-width bar under the cards (`grid-column: 1 / -1`: Add book, Add {item}, the type box). One popover at a time (`entry_popover`, `placePopover` puts it in the grid under its card;
  outside click/Escape close; opening one moves the focus into it, `togglePopover`, since it comes after the whole grid in the tab order).
  × with the keyboard moves the focus to the next card's × (`removeEntry`). Escape cancels a line, slot or chip drag (`swallowClick` eats the
  click when the button is let go). Cards slide on change (`cardRects`/`animateCards`, grid-relative, FLIP), and `render`
  and `renderBooks` keep the scroll position across the redraw. When only the enchantments of the same entries in the same order changed, the cards don't slide: each changed tooltip animates like section 1's, never its width (`oldTooltips`/`animateLines`: a same-height swap rolls the rows with `rollLines`, otherwise `openLines`/`closeLines` and the card grows or shrinks with its lines; lines carry `data-ns`/`data-level`). A new entry (`markFresh`: Add book/item, ⧉, a typed book) is revealed once the grid has
  finished sliding open (`revealEntry`, `REVEAL_DELAY_MS`; the grid clips the picker while it slides, so scrolling earlier does nothing): the page scrolls
  just far enough to show its card (and picker), never the card off the top, and the card flashes.
  Also in Custom: `coverageStrip` (each section 1 pick the entries don't reach is an amber chip that runs `applyFix`, same as the ⚠ fixes; the reached
  ones fold into one "✓ All 7 reached ▾" chip from 3 on, `coverage_open` shows them),
  × fades out (`removeEntry`), ⧉ `duplicateEntry`, "Add book"/⧉ open the
  picker at once (`openPicker`/`focusPicker`; their buttons are `.popover-toggle` so the outside-click handler leaves it
  open), the picker lists section 1 picks first with "Show all" (`picker_all`) and highlights a tapped line's row
  (`entry_popover.ns`, `.spot`), Slots = `.entry-card.slotcell` (a third view: only the slot, glint and stack count; tooltip `.slot-tip` on hover/focus, a click opens the picker, whose foot has Duplicate/Remove there; its popover has copies and prior work together), List = `.entry-card.compact` grid rows (`BOOKS_VIEW_STORAGE_KEY`; narrow: with a mouse a row with no badge stays on one line,
  touch keeps the badges' second row; switching views runs `morphCard` from Motion.js: each card travels while its `.card-frame` (an empty box) grows or shrinks, the slot unit travels and scales on its own, a copy of the old contents (`.card-ghost`, from `cardRects(box, true)`) fades out and the new ones fade in; only children whose resting opacity is 1 are faded, or hover-only parts such as `.slot-tip` would flash; the add bar slides too). The frame holds its last look (`fill: forwards`) until the plain card replaces it, and a ghost goes in the grid beside the card, not inside it, since a List or Slots card's own rules would reach the copy. Automatic <-> Custom is `morphCard` too, in its "mode" form: `matchOldCards` pairs each new entry with the old card that held the same (`bookSignature`), parts the card already had travel instead of fading, the coverage strip opens or closes (`revealBar`/`leaveBar`), the add bar fades in, old cards with no match fade out where they were (`leaving`), and the Automatic | Custom and Cards | Slots | List highlights slide (`pillRects`/`slidePills`, `.seg-pill`). Opening "All n reached" rolls the chips out of its chip row by row (`rollChipsIn`, `toggleCoverage`); closing rolls them back first (`rollChipsOut`); the strip's height follows the chips, so what is below stays the same distance under it. When a chip changes state (amber to green or back) a copy of the old chip travels to its new place and fades out while the new one fades in (never animate a chip's width: it moves the chips after it and every slide ends off its path), the others slide, new ones fade in, gone ones fade out in place and the ring fills or empties (`chipSnapshot`/`animateChips`, `data-ns` on the chips), a type box making one book of every typed enchantment (`addTyped`, Logic.js `parseBooks` per piece: "prot 4, mending"), and dragging a tooltip line
  onto another card moves it (`lineDragStart`: mouse after 6px, touch after a 350ms hold; `moveEnchantment`). `dragGesture` is the shared drag
  (same thresholds): dragging an entry's slot onto another previews the merge (`mergeDrag`: the target is the first anvil slot; `previewMerge` in Calc.js asks a
  second worker, Calculator.js `merge_preview`, for the cost and result; the chip says levels, "Too expensive!" from 40, or that they can't merge; nothing changes),
  and dragging a coverage chip onto an entry puts that enchantment on it, onto the add bar makes a new book (`chipDrag`; conflicts outline red and refuse). The coverage
  summary chip has a ring of reached/chosen. Icons inside slots are `draggable="false"` so the browser's picture drag doesn't take over.
- Section 4 Steps view (`renderResults`): toolbar = Steps | Slots | Tree, `stepProgress` ("3 of 7 done · N levels to go" bar + ↺ untick
  all, kept together in `.step-progress-main`; Compact and Expand/Collapse all wrap as one `.step-progress-tools` group), Copy steps and Print
  (one `.result-actions` group); a
  `.rounds.timeline` rail (round labels as breaks, a `.step-node` per step). `anvilStep`: a `.step-head` (the whole
  "☐ Step N" ticks; the first unticked step is `.current`; ticking, folding and Space keep that step where it was on screen
  (`keepInPlace`), and ticking scrolls down to the next unticked step only when it is below view (`revealBelow`, never up); Space on a
  focused step ticks it), steps fold to one line (`stepLine`; done ones by default, any by a click on the head or its button: `isFolded`/
  `toggleFold`, `step_folds` overrides, dropped for a step whose tick changes via `saveTicks`), the row is an anvil-window
  panel (`--gui-*` tokens), hovering a starting input highlights its section 2 card and clicking scrolls to it (`entryHover`/`entryIndexOf`), an input
  made by a step says "From step N" (`entryRef`), the result its prior work, the cost is always the game's green, and `levelMeter` draws "Lv 30 → 28" with a bar.
- Section 4 with no valid order: the warning says why and, when the level limit was lowered, offers "Use the game's limit (39)";
  section 1's cost meter says "No valid order" (`meter_none`) instead of leaving its space blank.
- Section 4 extras (`renderResults`): the toolbar is the Steps | Slots | Tree switch (`result_view`), a Copy menu (`copyMenu`: Copy steps as text, Copy checklist as Markdown with boxes), Print, and the progress on its own row with Expand all / Collapse all (`.fold-buttons`, Steps and Tree; by default only the current step is in full
  and the rest fold to a line, hand folds win) and, in Tree, Compact (`tree_compact`). Heading summary is "N steps". Each step says Left slot / Right slot / Result (`cell-label`), has a sentence
  (`stepInstruction`: what to put where, the rename note), a cost chip with a floating breakdown (`costChip`/`showCost`: enchantments, each side's
  prior work 2^n - 1, rename), the result dims lines it didn't change and shows a raised enchantment's old level (`.mc-from`, `anvilCell` takes a Set or a
  Map to the old level), a `.level-checkpoint` when Your level is too low, and the rounds have a floating "?" (`roundTip`). The Slots view is the same markup with
  `.slots-mode` CSS (one line of slots, tooltips on hover; its steps fold like the Steps view's, with the same Expand all / Collapse all and fold state, but all start open: a folded one is its head and one-line summary only). After the steps a `.final-card` shows the finished item (green once every step is ticked). Under 900px a sticky
  `.current-bar` (`currentBar`) keeps the current step and a Done button on screen while that step is off screen (`watchCurrentStep`: an
  IntersectionObserver tucks it away, `.tucked`, while the step shows, so it never covers it). The compact tree shows a slot and a one-line caption, the tooltip on hover;
  hovering or focusing an entry lights its path (`.path-self`/`.path-up`/`.path-down`, `mergeTree`). Density, anvil count and view stay in this browser, not in links.
- All sections collapse from their heading (`.card.collapsible`, `setupCollapsing`; closed ones in
  `COLLAPSED_STORAGE_KEY`), showing a one-line summary (`renderSummaries`) while closed. Opening and closing slide the body and the gap under the heading (`slideSection` in Motion.js: sizes are fixed while it slides, `.closing` turns the arrow early, a second toggle finishes the first); `html { scrollbar-gutter: stable }` keeps room for the scrollbar so it never shifts the page. The books badge in
  the heading is excluded from the toggle click.
- App.js extras: in `localStorage` (guarded `readStorage`/`writeStorage`), never in share links: "Your level"
  (`player_level`; Logic.js `levelTrack` shows the level before/after each step), the Steps | Slots | Tree view
  (`result_view`; `mergeTree`), saved setups (`SAVED_STORAGE_KEY`: `{name, item, link}`, link = `serialize` text,
  loaded via `readLink`; × removes one), and the language. The Tree view (`mergeTree`) draws each entry as a game slot + tooltip (rarity colors, game font) and its
  step badges carry the same tick boxes as the Steps view (`stepTick`, shared ticks); hovering a starting item lights its section 2 card and a click scrolls to it (`entryHover`, as in the Steps view); each merge folds its inputs away like its step does (same `isFolded`/`toggleFold` state, ▾/▴ `.step-fold`). Ticking a step also ticks
  the steps it needs and unticking one unticks the steps that need it (Logic.js `tickStep`); "Uncheck all" clears them. Section 4's heading always shows the uses (`renderStepsSummary`) and the break risk (`anvilRisk`: an
  `.info-tip` pill with `img/anvil.svg` and the chance, colored by Logic.js `anvilBreakChance`: 12% damage per use, breaks on the 3rd), Copy (`stepsText`, `checklistText`), and Print (`@media print` in Style.css; `.print-only` lines).
  The step checklist is stored in `localStorage` (`CHECKLIST_STORAGE_KEY`) for the order on screen only,
  keyed by its steps (`orderKey`: each slot's item, enchantments and prior work, not the costs, so a rename keeps the ticks); custom entries reorder by a grip (`entryHandle`: drag or arrow keys over `.entry-card`s; order is cosmetic);
  the result tiles are also the ranking (`renderMetrics`; both drag via pointer events in `dragToReorder` so touch works; values update in place so a result arriving mid-drag does not redraw them).
- Also: the header's Copy link carries progress (`currentLink`: when steps are ticked, Logic `serialize(state, { key, done })` adds `t`
  (ticked step numbers) and `k` (`orderHash` of `orderKey`); `loadFromUrl` holds them in `carried_progress` and `applyCarriedProgress` stores
  them only if the calculated order has the same key); starting items in Steps and Tree are keyboard-reachable `[data-entry-link]` (`entryHover`: focus lights the card,
  Enter shows it); the first screen's "Try an example" (`tryExample`); "Start over" in the footer (`setupReset`/`resetEverything`: one click, clears every `enchantment-calculator-*` storage key but saved setups and language, then reloads without the link); the bar flashes once on the last tick (`level-up`, `celebrated`); the `#live`
  region (`announce`: says the progress when ticking changes it); folded tree merges stay in the DOM, hidden by CSS, so print shows them.
- `js/Calculator.js`: worker, one engine per edition. Messages in: `instantiate_metadata`, `calculate_optimal`
  (with `edition`, `rename`), `merge_preview` (one merge, for section 2's drag). Out: `progress`,
  `optimal_searched`, `calculation_failed`, `merge_previewed` (all carry `request_id`).
- `js/Logic.js` (ES module): `createLogic(meta, names)` UI helpers: rarity, display names, tooltip sort, applicable
  enchantments, `maxAll`, `buildEntries(state)`, `missing`, `extra` (result enchantments not chosen), `bestLevels`/`checkBooks`/`addBook`/`twinOf` (pre-calculation warnings: a badge on the section 2
  heading whose bubble offers one fix per enchantment, a book at the chosen level, then "Switch to Automatic" (`useAutomatic`); adding merges into an identical entry and drops books and
  items whose only enchantment is a lower level of it (any prior work; never the last item), and marks on section 1 rows; Tips.js `infoTip` builds the badge), `collectSteps(root)` (steps in rounds of independent steps, cheapest first; `stepRounds` splits them), `tickStep`, `serialize`/`deserialize`
  (share links; old `o` objective links still load). Also exports `roman`, `maxPriorWork(step_limit)` (highest usable
  prior work, from the 2^n - 1 penalty; Infinity with no limit), `MAX_STEP_LEVELS` (39),
  `CRITERIA`, `normalizePriority`, `movePriority`, `clampStepLimit`.
- `json/metadata.json`: game data only, no names (the recovery compass takes Curse of Vanishing in Bedrock only, via that curse's `bedrock.items`; the enchantment key `sweeping` is Java's `sweeping_edge`, kept so old share links load): keys `enchantments` ({incompatible, items, max_level, weight,
  optional `bedrock`}), `items` (list of item namespaces; each has `img/<item>.svg`), `rarity`, `tooltip_order`. It's long, so grep for the entry you need instead of reading it all.
- `ServiceWorker.js` (site root, since a worker only covers its folder): offline copy, network first (with `cache: "no-cache"`, so the HTTP cache never serves a stale file). Precaches the
  JS/CSS/JSON files (add new ones to `FILES`); `VERSION` is stamped on deploy so the URLs match and old caches go.
  `manifest.webmanifest` + `img/app_icon_*.png` make it installable.
- `css/Style.css`, `img/*.svg` (16x16 pixel-art items, one rect per pixel; anvil, shield and enchanting table traced from renders; only the app icons stay PNG), `font/minecraft.woff`.

## Game rules implemented (Engine.js)
Book vs. item multipliers (`weight`), prior-work penalty `2^n - 1`, level caps,
merges of 40+ levels are "Too Expensive" (the user can lower this cap or remove it). Ties break on the next-ranked criterion.
Renaming (`rename`) adds 1 level to the final step, counted during the search since it can push that step past the limit.
Java gives no result for a merge that adds nothing (an unenchanted item as the sacrifice), unless it also renames: `preview`
refuses an enchantment cost of 0 there. Bedrock is left as it was. Empty books never reach the engine (`buildEntries`), and section 2
drops a book left with no enchantments when its picker closes or its last line is dragged away (`isPlainBook`).
Editions (Minecraft Wiki, "Anvil mechanics"): Java charges each enchantment's final level x multiplier; Bedrock only the
levels it gains over the target's. A metadata enchantment's `bedrock` object overrides its fields in Bedrock
(Impaling `weight` 1; Sweeping Edge `items: []`, since Bedrock lacks it). Logic.js `editionMetadata` applies the same overrides.

## Adding an item or enchantment
Edit `metadata.json` (enchantment `items` lists, `items`, `rarity`, `tooltip_order`), add its name to
`names` in every `json/text/*.json`, add `img/<item>.svg`, then run the tests.

## Tests (run after engine/logic changes)
`node test/Engine.test.js` (includes brute-force cross-check) and `node test/Logic.test.mjs`
(loads Logic.js and Text.js through data: URLs, `moduleUrl` inlining their `./X.js` imports, and reads json/text directly).
`python test/Browser.test.py` drives the page in Chromium (Playwright: `pip install playwright`, `playwright install chromium`;
skips itself when it isn't installed): results, ticking/folding, link with progress, hover/keyboard links, Tree, print, phone and 320px widths.
It is split into independent `part_...` functions run side by side (`JOBS`, each in its own Chromium; `--serial` for one at a time), about 30s instead of 90s; add new checks to the part
of their section or as a new part, and wait with `settle(page)` (search idle: `<html data-search>` "pending" | "running" | "idle", set by Calc.js; and no finite animation running), not `wait_for_timeout`
(which is kept only where a frame sampler needs its window).

## CI and hosting
`.github/workflows/pages.yml` runs both test files on every push, pull request, and manual run (the browser test is its own job,
which doesn't gate the deploy). On `main`,
if the tests pass, it copies `index.html ServiceWorker.js manifest.webmanifest css js json img font` into `_site/` and deploys to GitHub Pages at
https://jmarcinik3.github.io/MinecraftEnchantmentCalculator/. New top-level site folders must be added to that copy step.
Deploy then runs `.github/stamp-version.sh`, which adds `?v=<commit>` to the page's references to its CSS, JS modules
(and Text.js `TEXT_VERSION` for the json/text files), worker, Engine.js and metadata, and sets ServiceWorker.js `VERSION` (in `_site` only), so cached copies (phones especially) are not reused. It fails if a
reference is missing: when renaming or adding one of those files or imports, update the script.

## Conventions
camelCase functions, PascalCase classes/filenames, snake_case variables, UPPER_CASE constants.
Keep Engine.js DOM-free and UMD. Keep UI text short, and in `json/text/*.json`.
- Section 4 additions: a goal line above the toolbar (`.result-goal`), the progress bar's segments are buttons that jump to their step
  (`jumpToStep`), "Your level" says "Need N more levels"/"Enough" beside the progress, each step's sentence is behind an "In words"
  disclosure (`.step-words`; on paper each step prints that sentence as `.step-print` instead of the slots), the Slots view adds a caption under
  each row (`.step-caption`), Up/Down/Enter move between and fold the focused step, the heading's anvil badge is labelled "Anvil wear" (wide screens),
  and phones start with the compact tree (a wide tree scrolls sideways). Hovering or focusing a merged item (an input made by an earlier step, a
  result, the finished item, a tree merge) lights every section 2 card that went into it (`leavesOf`, `sourcesHover`); a starting item lights its own.
- The Java | Bedrock switch (`editionControl`, `setEdition` in App.js) is the first row of the Game rules menu (it is not one of the rules Reset to vanilla changes).
- Mods (Game rules > Mods, Java only): `json/mods/<id>.json` (`MOD_IDS` in Logic.js; now `fancy_enchantments` and `spellbound`) holds `{ id, label, note, source, enchantments, names: {en, <language>}, descriptions }`, with
  `enchantments` shaped like metadata.json's (`weight` is the book multiplier, `max(1, anvil_cost / 2)`; keys are the mod's registry ids, e.g. `fancyenchantments:air_attack`; only the 27 item kinds the app knows). The file loads when its switch is first
  turned on or a link names it (`loadMods`, App.js; `MODS_VERSION` is stamped on deploy; the file is in ServiceWorker.js `FILES`). `state.mods` (ids) is in share links as `d` (`linkMods` reads it before the link is read), so
  `readLink` builds the helpers with the link's mods. `useEdition(edition, mods)` merges them with `withMods` (tagged `mod`, listed after the game's own in tooltips, conflicts naming enchantments the app can't show dropped) and
  `modNames` (English where a language has none); in Bedrock their `items` are emptied (known, never offered). `Store.engineMeta()` is what the workers get, and `resetWorkers()` (Calc.js) restarts them when a mod is switched. A mod's
  enchantments sit under its name in section 1 (`.mod-section`, folded until opened or one is chosen) and in the picker (behind "Show all (n more)" with the other enchantments not chosen in section 1, folded under its name; the picker always has a search box: `picker_query`); Max all and the presets never add them (`maxAll`),
  typed books can name them (the game's own win ties). Fancy Enchantments' conflicts come from its own source (checked against the 1.21.1 repo): the datapack `exclusive_set`s (its additions to the game's armor, damage and bow tags, so Advanced Sharpness also conflicts with
  Density, Breach and Impaling) plus its elemental opposites (Aer/Terra, Aqua/Ignis, Holy/Twisted; an enchantment in two elements counts as the first in that order, as `EnchUtils.elementOf` does), which the mod's `Enable Incompatibility` setting (default on) controls; Allow conflicts overrides them all. "Replaces ..." in section 1 names every chosen enchantment a pick would replace. The data came from a literature search of the mods' source (docs/mod-enchantments*.md/json, not part of the site).
- Conflict graph (prototype, `js/Graph.js`, in section 1 under the preview as a fold-away `.graph-box`): a node per enchantment the item can take that conflicts with another, a line per conflict
  (SVG, a Fruchterman-Reingold layout computed once per item and set of conflicts and kept across redraws); hover or focus lights a node's conflicts and the caption names them, click or Enter chooses (or clears) it at its top level;
  all nodes share one color (chosen ones purple, ones that would replace a pick dimmed; with a search typed, matches are ringed and the rest fade, `markSearch`). Isolated enchantments are left out, and the box is absent when nothing conflicts.
- A conflict bracket ("Some conflict (N)") folds from its label (`.group-toggle`, `folded_groups` in Wanted.js): the chosen rows stay and the rest hide; "Pick one" cards don't fold.
- Spellbound (`json/mods/spellbound.json`, Fabric 1.20.1, default config, from the repo's 1.20.1 branch: `SBConfig` for `RARITY`/`HARD_CAP`/`ENABLED`, each class's target and `canEnchant`, `SBTags` and the category tags): max level is `HARD_CAP`, weight is the
  book multiplier from `RARITY` (1 common, 2 uncommon, 3 rare, else very rare); Mounted, Monogamous and Polygamous are disabled by default and left out. Conflicts: every Spellbound enchantment conflicts with the others in its category tag(s) (and
  with the vanilla ones listed in the tag), and with any vanilla enchantment that conflicts with the category's "parent" vanilla enchantments (damage: Sharpness and Power; fortune: Fortune and Silk Touch; utility: Knockback, Punch, Riptide, Channeling,
  Frost Walker, Soul Speed and Aqua Affinity; repair: Mending; and so on, `SBTags.CATEGORY_PARENTS`). Its pages (Modrinth, CurseForge) are older than the source and list fewer enchantments.
- Section 1 rows in a conflict bracket carry a "Conflicts with N" chip (`conflictChip`, `.conflict-chip`, `logic.conflictsWith`): hovering or keyboard-focusing it lights the rows it conflicts with (`.rival`, the row itself `.rival-self`) and shows their names in a fixed game tooltip (`.conflict-tip`, the first 8 then "+N more");
  clicking or tapping it pins both (`conflict_pin`, `aria-pressed`) until a click elsewhere, Escape or a click on the chip again, like the "?" bubbles (`setupConflictTips`; the tooltip follows its chip on scroll, `restoreConflicts` after redraws). Hovering a row alone shows nothing. The Game rules Mods row shows a mod's note only while the mod is on.
- Section 4: the full Tree lists each enchantment of a tooltip on its own line on a small window or a touch screen (`.ench-sep` hidden, CSS). Switching Steps, Slots, Tree or Compact cross-fades (`rememberView` copies the old `.steps-scroll`, `crossfadeView` in Motion.js
  fades the copy out over the new one and eases the height on phones; the copy has the step/view data attributes stripped so nothing finds it), and Expand all / Collapse all ease each step's height (`easeHeight`, `fold_change`).

