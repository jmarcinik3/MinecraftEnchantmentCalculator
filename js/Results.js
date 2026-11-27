// Section 4: the steps and the tree, ticking and folding, progress, and the text of the steps.
import { updateCostMeter } from "./Wanted.js";
import { MAX_GROUPS, MAX_STEP_LEVELS, anvilBreakChance, levelTrack, roman, searchSize } from "./Logic.js";
import { TEXT, localeOf } from "./Text.js";
import { SLOW_SPLITS, language, logic, state } from "./Store.js";
import { $, closeOnOutside, copyText, enchLine, flash, h, icon, motionOk, nameClass, readStorage, roving, scrollToView, segmented, writeStorage } from "./Dom.js";
import { svgIcon } from "./Books.js";
import { easeHeight, FOLD_MS, foldDetails, foldTarget, keepInPlace, morphView, revealBelow, viewSnapshot } from "./Motion.js";
import { renderMetrics } from "./Ranking.js";
import { activeLevel, spendLevels, levelChip, placeLevelPop, remainingLevels, updateLevelMeter } from "./Options.js";
import { cancelCalculation, last_break, last_result, runCalculation, running, show_progress } from "./Calc.js";
import { floatBubble, infoTip } from "./Tips.js";
import { commit, renderStepsSummary } from "./App.js";
import { currentLink } from "./Link.js";

const CHECKLIST_STORAGE_KEY = "enchantment-calculator-checklist";
const VIEW_STORAGE_KEY = "enchantment-calculator-view";
const COMPACT_STORAGE_KEY = "enchantment-calculator-compact";
// "steps": a card per step; "tree". (The old "slots" view is Steps in Compact mode.)
const stored_result_view = readStorage(VIEW_STORAGE_KEY, "steps");
let result_view = stored_result_view === "tree" ? "tree" : "steps";
// Compact mode, one setting for both views: Steps shows one line of slots per step (what the Slots view was) and the Tree a slot and a caption per entry, the
// details on hover. Until it is chosen (null) a phone starts compact (full tooltips are too wide there) and anything wider does not, in both views alike.
let compact_choice = readStorage(COMPACT_STORAGE_KEY, stored_result_view === "slots" ? true : null);
const isCompact = () => compact_choice ?? matchMedia("(max-width: 600px)").matches;
// Whether the "In words" lines under the steps are open (they all follow the last one toggled).
let words_open = false;
// Each redraw (a tick, a new name, a new level) rebuilds the steps; their scroll position
// is kept when the same view of the same order comes back.
export let steps_scroll = { key: null, top: 0 };
// Steps fold to one line: done ones by default, others when folded by hand. `folded`
// holds the steps folded or unfolded by hand (number -> folded?), for the order on
// screen; ticking or unticking a step drops its entry, so it follows its new state.
let step_folds = { key: null, folded: new Map() };

// The hand-folded steps of this order (a different order starts with none).
function foldsFor(order_key) {
    if (step_folds.key !== order_key) step_folds = { key: order_key, folded: new Map() };
    return step_folds.folded;
}

// The first step not done in the order on screen (set by renderResults), the one the Steps and Slots views leave open.
let current_step = null;

// Steps and Slots show the same steps open and folded: one rule (a done step, or any but the current one, is folded) and one record (the hand folds above),
// never a default of each view's own (Steps used to start with only the current one open and Slots with all, so they differed until every step was folded by hand).
const foldedByDefault = number => number !== current_step;

function isFolded(order_key, number, done, by_default = false) {
    const folds = foldsFor(order_key);
    return folds.has(number) ? folds.get(number) : done.has(number) || by_default;
}

// Saves new ticks, forgetting the hand folding of the steps whose tick changed. With "Track my level" on, a step ticked spends its levels from
// the tracked level and one unticked gives them back (`spendLevels`), as the anvil does.
function saveTicks(order_key, steps, done, next) {
    if (step_folds.key === order_key) {
        for (const step of steps) if (done.has(step.number) !== next.has(step.number)) step_folds.folded.delete(step.number);
    }
    let spent = 0;
    for (const step of steps) if (done.has(step.number) !== next.has(step.number)) spent += (next.has(step.number) ? 1 : -1) * step.node.merge_levels;
    if (spent) spendLevels(spent);
    saveChecklist(order_key, next);
}

// Set just before a redraw that changes the view (Steps, Slots, Tree, Compact) or folds every step, so the redraw
// can animate the change; renderResults takes it (and clears it) at once.
let view_change = null;
let fold_change = null;

// The steps and tree as they are, before the view changes: what the steps will travel from (Motion.js viewSnapshot).
function rememberView() {
    const scroller = document.querySelector("#results .steps-scroll");
    view_change = scroller && motionOk() ? viewSnapshot(scroller) : null;
}

// The box of each step (its card, or its tree node), by step number.
const stepBoxes = () => new Map([...document.querySelectorAll("#results [data-step-card]")]
    .map(el => [el.dataset.stepCard, el.classList.contains("tree-line") ? el.parentElement : el]));

// Changes the steps (`change` redraws them) while the one at `selector` stays where it is on screen, and every step that folds, unfolds or
// is ticked eases to its new height the way a section does (renderResults reads `fold_change`).
function easedChange(selector, change) {
    fold_change = new Map([...stepBoxes()].map(([number, el]) => [number, el.getBoundingClientRect().height]));
    keepInPlace(selector, change, true);
}

// An id for each item in the order (the same across redraws of the same result), so an icon is the same icon in every view (Motion.js morphView).
const node_ids = new WeakMap();
let next_node_id = 1;
function nodeId(node) {
    if (!node_ids.has(node)) node_ids.set(node, next_node_id++);
    return node_ids.get(node);
}

// The icon of a view in the switch (the words are its title and name), drawn like Section 2's: Steps a list of numbered boxes, Tree a trunk with branches.
function viewIcon(view) {
    if (view === "steps") {
        return svgIcon("0 0 16 16", [2, 6.5, 11].flatMap(y => [["rect", { x: "2", y: String(y), width: "3.5", height: "3.5", rx: "0.8" }], ["rect", { x: "7.5", y: String(y + 0.75), width: "6.5", height: "2", rx: "1" }]]), { fill: "currentColor" });
    }
    return svgIcon("0 0 16 16", [["rect", { x: "2", y: "2", width: "5", height: "3", rx: "0.8" }], ["rect", { x: "3.6", y: "5", width: "1.2", height: "7.2", rx: "0.6" }],
        ["rect", { x: "4.6", y: "7.4", width: "3", height: "1.2", rx: "0.6" }], ["rect", { x: "4.6", y: "11", width: "3", height: "1.2", rx: "0.6" }],
        ["rect", { x: "8.5", y: "6.2", width: "5.5", height: "3", rx: "0.8" }], ["rect", { x: "8.5", y: "9.8", width: "5.5", height: "3", rx: "0.8" }]], { fill: "currentColor" });
}

export function renderResults() {
    drawResults();
    placeLevelPop(); // (the Your level popover follows the chip in the progress row, and goes when it is gone)
}

function drawResults() {
    const change = view_change;
    const folding = fold_change;
    view_change = null;
    fold_change = null;
    updateCostMeter();
    renderMetrics();
    renderStepsSummary();
    updateLevelMeter();
    const box = $("#results");
    const old_scroll = box.querySelector(".steps-scroll");
    if (old_scroll) steps_scroll.top = old_scroll.scrollTop;
    box.replaceChildren();
    // The slots that lit a card in Books and items are gone (a removed element never gets its blur or mouseleave), so the card goes dark.
    for (const card of document.querySelectorAll("#books .entry-card.highlight")) card.classList.remove("highlight");
    const entries = logic.buildEntries(state);

    // Only while it runs: once the result is in, the wait is over.
    const size = searchSize(entries);
    if (running && size.groups <= MAX_GROUPS && size.splits > SLOW_SPLITS) {
        box.append(h("div", { class: "warning" }, TEXT.results.slow_search({ count: entries.length })));
    }

    if (running && show_progress) {
        // (How far it has got is on the section's number: its ring fills, and hovering it says the percent and the time left. Calc.js showProgress.)
        box.append(h("div", { class: "progress" },
            h("button", { type: "button", class: "btn small", onclick: cancelCalculation }, TEXT.results.cancel)
        ));
    }

    const result = last_result;
    // Nothing to show yet (no item, or no enchantment chosen): the card is just its heading and one muted line, its number greyed.
    const idle = result ? result.status === "empty" : !state.item;
    box.closest(".card").classList.toggle("idle", idle);
    if (idle) {
        box.append(h("p", { class: "idle-line" }, !state.item ? TEXT.page.pick_item_first : TEXT.results.choose_enchantments));
        return;
    }
    if (!result) return;

    if (result.status === "cancelled") {
        box.append(h("p", { class: "hint" }, TEXT.results.cancelled,
            h("button", { type: "button", class: "link", onclick: runCalculation }, TEXT.results.run_again)));
        return;
    }
    if (result.status === "error") {
        box.append(h("div", { class: "error" }, result.error));
        return;
    }

    const content = h("div", { class: "results-content" + (running ? " stale" : "") });
    box.append(content);
    const node = result.node;

    if (!node) {
        // What to try: a lowered limit can go back to the game's own; at the game's limit,
        // every order has a "Too expensive!" step, and fewer or cheaper books may help.
        const lowered = !state.no_step_limit && state.max_step < MAX_STEP_LEVELS;
        content.append(h("div", { class: "warning no-order" },
            h("p", {}, state.no_step_limit ? TEXT.results.no_valid_order : TEXT.results.no_valid_order_within({ limit: state.max_step })),
            state.no_step_limit ? null : h("p", { class: "no-order-hint" }, lowered ? TEXT.results.limit_lowered_hint : TEXT.results.too_expensive_hint),
            lowered ? h("button", {
                type: "button", class: "btn small",
                onclick: () => { state.max_step = MAX_STEP_LEVELS; commit(); }
            }, TEXT.results.use_game_limit({ limit: MAX_STEP_LEVELS })) : null,
            whereItBreaks()));
        return;
    }
    if (!node.left) {
        content.append(h("p", { class: "hint" }, TEXT.results.nothing_to_combine));
        return;
    }

    const steps = logic.collectSteps(node);

    const missing = logic.missing(state, node);
    if (missing.length) {
        content.append(h("div", { class: "warning" }, TEXT.results.missing({ names: missing })));
    }
    const extra = logic.extra(state, node);
    if (extra.length) {
        content.append(h("div", { class: "note-box", title: TEXT.results.extra_help }, TEXT.results.extra({ names: extra })));
    }

    // Only on paper: what is being made, since the inputs are not printed.
    content.append(h("p", { class: "print-only" }, TEXT.results.text_wanted({ item: logic.itemName(state.item), enchantments: logic.summary(node.enchantments) })));

    // With "Your level" filled in: the level before and after each step, in step order.
    // Ticked steps are already paid for, so the level follows only the ones left.
    const remaining = remainingLevels(steps);
    const track = activeLevel() == null ? null : levelTrack(remaining.costs, activeLevel());
    // Only on paper: the anvil wear (on screen it is in the receipt above the toolbar, which isn't printed).
    content.append(h("p", { class: "print-only" }, TEXT.results.anvil_uses({ uses: steps.length }) + " · " + anvilRiskText(steps.length)));

    const order_key = orderKey(steps);
    const done = loadChecklist(order_key);

    const left = steps.map(step => step.number).filter(number => !done.has(number));
    const current = left.length ? Math.min(...left) : null;
    current_step = current;
    const setView = view => {
        if (view === result_view) return;
        rememberView();
        result_view = view;
        writeStorage(VIEW_STORAGE_KEY, view);
        renderResults();
    };
    // Compact (one setting for Steps and Tree): only the slots, with the details on hover. A density icon, lit while on.
    const compact = h("button", {
        type: "button", class: "icon-btn density", "aria-pressed": String(isCompact()), title: TEXT.results.compact_help, "aria-label": TEXT.results.compact,
        onclick: () => {
            rememberView();
            compact_choice = !isCompact();
            writeStorage(COMPACT_STORAGE_KEY, compact_choice);
            renderResults();
        }
    }, densityIcon());
    const foldSteps = (numbers, fold) => {
        const was = new Map([...stepBoxes()].map(([number, el]) => [number, el.getBoundingClientRect().height]));
        for (const number of numbers) foldsFor(order_key).set(number, fold);
        fold_change = was;
        renderResults();
    };
    const foldAll = fold => foldSteps(steps.map(step => step.number), fold);
    // Whether a step is folded on screen now (the Tree opens every merge by default; Steps only the current step).
    const foldedNow = number => isFolded(order_key, number, done, result_view === "tree" ? false : foldedByDefault(number));
    // One button for Expand all / Collapse all: it shows what it would do (unfold while most steps are folded, else fold).
    const mostly_folded = steps.filter(step => foldedNow(step.number)).length * 2 >= steps.length;
    const fold_label = mostly_folded ? TEXT.results.expand_steps_label : TEXT.results.collapse_steps_label;
    const fold_toggle = h("button", {
        type: "button", class: "icon-btn fold-toggle", title: fold_label, "aria-label": fold_label, onclick: () => foldAll(!mostly_folded)
    }, foldIcon(mostly_folded));

    // One row: the progress on the left; how the order is shown (Steps | Tree, Compact, fold all) and Share on the right, as quiet icons.
    content.append(h("div", { class: "toolbar result-tools" },
        stepProgress(steps, done, remaining.needed, order_key),
        h("div", { class: "result-icons" },
            h("div", { class: "view-group", role: "group", "aria-label": TEXT.results.view_label },
                segmented("view-icons", TEXT.results.view_label, [["steps", TEXT.results.view_steps], ["tree", TEXT.results.view_tree]].map(([view, label]) => ({
                    selected: result_view === view, content: viewIcon(view), onclick: () => setView(view), attrs: { "data-view": view, title: label, "aria-label": label }
                }))),
                compact, fold_toggle),
            shareMenu(node, steps, done))
    ));

    // Only the steps (or the tree) scroll, under the Steps/Tree row; on desktop they fill
    // what is left of the window. See .steps-scroll.
    const scroller = h("div", { class: "steps-scroll" });
    content.append(scroller);

    if (result_view === "tree") {
        scroller.append(mergeTree(node, steps, done, order_key));
    } else {
        // A timeline: one group per round (its steps don't depend on each other, so any
        // order works), a node per step on the rail. The first step not done is the one
        // "you are here" (highlighted, and open); the others fold to one line unless unfolded by
        // hand (Expand all / Collapse all). Compact shows each step as one line of slots.
        const slots = isCompact();
        const rounds = logic.stepRounds(steps);
        const timeline = h("div", { class: "rounds timeline" + (slots ? " slots-mode" : "") }, rounds.map((round, index) => h("section", { class: "round" },
            h("div", { class: "round-label" },
                roundToggle(round, index, foldedNow, foldSteps),
                round.length > 1 ? roundTip(index) : null),
            h("ol", { class: "anvil-steps" }, round.map(step =>
                anvilStep(step, done, order_key, steps,
                    track && !done.has(step.number) ? track.steps[step.number - 1] : null,
                    // Both views start with only the current step in full (the same steps, whichever view; see foldedByDefault).
                    step.number === current, isFolded(order_key, step.number, done, foldedByDefault(step.number)))))
        )));
        // Slots view on touch: a tap on a slot shows its tooltip (there is no hover); another tap, or one elsewhere, hides it.
        if (slots) {
            timeline.addEventListener("click", event => {
                if (!matchMedia("(hover: none)").matches) return;
                const cell = event.target.closest(".anvil-cell");
                for (const open of timeline.querySelectorAll(".anvil-cell.tip-open")) if (open !== cell) open.classList.remove("tip-open");
                if (cell) cell.classList.toggle("tip-open");
            });
        }
        scroller.append(timeline);
        // Done steps fold by themselves; one toggle under the list shows them all again (or folds them back).
        const done_steps = steps.filter(step => done.has(step.number)).map(step => step.number);
        if (done_steps.length) {
            const hidden = done_steps.some(number => foldedNow(number));
            scroller.append(h("button", {
                type: "button", class: "btn small show-done", "aria-pressed": String(!hidden),
                onclick: () => foldSteps(done_steps, !hidden)
            }, hidden ? TEXT.results.show_done({ count: done_steps.length }) : TEXT.results.hide_done({ count: done_steps.length })));
        }
        // The current step and a Done button stay at the bottom while scrolling (a bar on phones, a "Next step" card on wide windows).
        if (current != null) scroller.append(currentBar(steps, done, order_key, current));
        watchCurrentStep();
    }

    const scroll_key = (result_view === "steps" && isCompact() ? "slots" : result_view) + "|" + order_key;
    if (steps_scroll.key === scroll_key) scroller.scrollTop = steps_scroll.top;
    steps_scroll = { key: scroll_key, top: scroller.scrollTop };

    if (change) morphView(scroller, content, change);
    // Expand all / Collapse all: each step that opens or folds eases its height, so what is below moves with it.
    if (folding) {
        // A tree merge or step that folds keeps its contents on show while its box shrinks, so it is unfolding played backwards (the box clips them); then it hides them.
        const keepBranch = el => el.matches("li.tree-node.folded, li.anvil-step.folded") ? () => { el.classList.add("folding"); return () => el.classList.remove("folding"); } : undefined;
        for (const [number, el] of stepBoxes()) if (folding.has(number)) easeHeight(el, folding.get(number), { during: keepBranch(el), overhang: el.matches(".anvil-step") ? 40 : 0 }); // (a step's circle sits on the rail, outside its box)
    }
}

// The "?" in a round's label: why its steps can go in any order (a bubble that floats over the page).
function roundTip(index) {
    const tip = infoTip("round-tip-" + index, "?", TEXT.results.round_tip_label, TEXT.results.round_help);
    tip.querySelector(".info-tip-bubble").setAttribute("role", "tooltip");
    floatBubble(tip);
    return tip;
}

// The chances at which the break-risk badge turns amber (medium) and red (high); see anvilRisk.
const ANVIL_RISK_MEDIUM = 0.1;
const ANVIL_RISK_HIGH = 0.5;

// The break risk in section 4's receipt: the anvil and the chance ("4%"), colored by risk
// (green unlikely or impossible, amber possible, red likely). Tap or hover for the
// sentence and how wear works; its bubble floats over the page, like the other tips.
export function anvilRisk(uses) {
    const chance = anvilBreakChance(uses);
    const risk = chance === 0 ? "none" : chance < ANVIL_RISK_MEDIUM ? "low" : chance < ANVIL_RISK_HIGH ? "medium" : "high";
    const tip = infoTip("anvil-risk-tip",
        [h("img", { class: "anvil-risk-icon", src: "img/anvil.svg", alt: "" }), h("span", { class: "anvil-risk-label" }, TEXT.results.anvil_wear_label),
            chance === 0 ? TEXT.results.anvil_safe_short : percentText(chance)],
        anvilRiskText(uses),
        h("span", {}, h("strong", {}, anvilRiskText(uses)), " ", TEXT.results.anvil_wear_help),
        "anvil-risk risk-" + risk);
    tip.querySelector(".info-tip-bubble").setAttribute("role", "tooltip");
    floatBubble(tip);
    return tip;
}

// With no order within the limit: the step that breaks it, in the order with the smallest biggest step
// (from a search with no limit), with the cheapest way out: raise the limit to what it needs, or, when
// even the game's limit would stop it, remove the limit (for mods).
function whereItBreaks() {
    if (state.no_step_limit || !last_break) return null;
    if (last_break.status === "running") return h("p", { class: "hint" }, TEXT.results.break_looking);
    const node = last_break.node;
    if (last_break.status !== "done" || !node || !node.left) return null;
    const steps = logic.collectSteps(node);
    const worst = steps.reduce((most, step) => (step.node.merge_levels > most.node.merge_levels ? step : most));
    const levels = worst.node.merge_levels;
    const fits = levels <= MAX_STEP_LEVELS;
    return h("div", { class: "break-down" },
        h("div", { class: "break-title" }, TEXT.results.break_title),
        h("p", {}, fits
            ? TEXT.results.break_step({ steps: steps.length, number: worst.number, levels, limit: state.max_step })
            : TEXT.results.break_beyond({ number: worst.number, levels, game: MAX_STEP_LEVELS })),
        h("div", { class: "break-step slots-mode" },
            anvilCell(worst.left.node, null, "left"), h("span", { class: "break-op" }, "+"),
            anvilCell(worst.right.node, null, "right"), h("span", { class: "break-op" }, "→"),
            anvilCell(worst.node, null, "result"),
            h("span", { class: "anvil-cost" }, TEXT.results.cost({ levels }))),
        fits
            ? h("button", { type: "button", class: "btn small primary", onclick: () => { state.max_step = levels; state.no_step_limit = false; commit(); } }, TEXT.results.break_raise({ limit: levels }))
            : h("button", { type: "button", class: "btn small", onclick: () => { state.no_step_limit = true; commit(); } }, TEXT.results.break_remove));
}

function anvilRiskText(uses) {
    const chance = anvilBreakChance(uses);
    return chance === 0 ? TEXT.results.anvil_safe : TEXT.results.anvil_break({ chance: percentText(chance) });
}

// 0.04 as "4%" in the page's language; tiny chances as "under 1%" rather than "0%".
function percentText(chance) {
    if (chance > 0 && chance < 0.01) return TEXT.results.under_one_percent;
    return new Intl.NumberFormat(localeOf(language), { style: "percent", maximumFractionDigits: 0 }).format(chance);
}

// The name an anvil slot shows: the new name on a renamed result, "Enchanted Book" for
// a book with enchantments, otherwise the item's name.
function nodeName(node) {
    if (node.renamed && state.rename_to.trim()) return state.rename_to;
    return node.item_namespace === "book" && node.enchantments.length ? TEXT.results.enchanted_book : logic.itemName(node.item_namespace);
}

// The order as a tree: the finished item on top, and under each merge the two things
// that went into it (first slot first), down to the books and items you start with.
// Each entry is drawn like the game: an inventory slot and a tooltip, the name colored
// by rarity (italic once renamed) and the enchantments in gray (curses in red), in the
// game's font. On a merge, enchantments it adds or raises over its first-slot item are
// white with a green "+", as in the Steps view. A merge's badge ("Step 9 · 19 levels") has the same tick box as the Steps
// view, and a ticked merge fades.
function mergeTree(root, steps, done, order_key) {
    const numbers = new Map(steps.map(step => [step.node, step.number]));
    const branch = node => {
        const number = numbers.get(node);
        const enchanted = node.enchantments.length > 0;
        const renamed = Boolean(node.renamed && state.rename_to.trim());
        const before = node.left ? new Map(node.left.enchantments.map(e => [e.namespace, e.level])) : null;
        const enchantments = logic.tooltipSort(node.enchantments).flatMap((e, index) => [
            index ? h("span", { class: "ench-sep" }, ", ") : null,
            h("span", {
                class: "mc-ench" + (logic.isCurse(e.namespace) ? " curse" : "") +
                    (before && before.get(e.namespace) !== e.level ? " changed" : "")
            }, logic.displayName(e.namespace, e.level))
        ]);
        // A merge folds and unfolds like its step in the Steps view (the same fold state):
        // done ones start folded, hiding what went into them; a click on the line (but
        // the tick) or its chevron button switches it.
        const folded = Boolean(number) && isFolded(order_key, number, done);
        const fold_label = folded ? TEXT.results.expand_step : TEXT.results.collapse_step;
        // Folded merges keep their inputs in the page, hidden (CSS), so printing can show them.
        return h("li", { class: "tree-node" + (folded ? " folded" : "") },
            h("div", {
                class: "tree-line" + (number ? " merge" : "") + (number && done.has(number) ? " done" : ""),
                "data-step-card": number || null, title: number ? fold_label : null,
                onclick: number ? event => { if (!event.target.closest(".tree-step, .step-fold")) toggleFold(order_key, number, !folded); } : null,
                // A starting item lights its card in section 2 and scrolls to it on a click (entryHover).
                ...entryHover(node)
            },
                h("span", { class: "tree-slot" + (enchanted ? " glint" : ""), "data-node": nodeId(node) }, icon(node.item_namespace, true)),
                // Compact: a one-line caption next to the slot; the tooltip shows on hover.
                h("span", { class: "tree-caption" }, enchanted ? logic.summary(node.enchantments) : nodeName(node)),
                h("span", { class: "mc-tooltip tree-tooltip", "data-fly": "tip:" + nodeId(node) },
                    h("span", { class: nameClass(logic.rarity(node.item_namespace, enchanted), renamed ? " renamed" : "") }, nodeName(node)),
                    enchanted ? h("span", { class: "mc-ench" }, enchantments) : null),
                number ? h("label", { class: "tree-step", title: TEXT.results.step_done_help, "data-fly": "step:" + number },
                    stepTick(number, done, order_key, steps),
                    TEXT.results.tree_step({ number, levels: node.merge_levels })) : null,
                number ? h("button", {
                    type: "button", class: "step-fold", "aria-expanded": String(!folded), "aria-label": fold_label, title: fold_label,
                    onclick: () => toggleFold(order_key, number, !folded)
                }) : null
            ),
            node.left ? h("ul", { class: "tree-children" }, branch(node.left), branch(node.right)) : null
        );
    };
    const tree = h("ul", { class: "merge-tree" + (isCompact() ? " compact" : "") }, branch(root));
    // Hovering or focusing an entry lights the path it takes: the merges it goes into (up to the
    // finished item) and what went into it.
    const light = line => {
        for (const el of tree.querySelectorAll(".path-self, .path-up, .path-down")) el.classList.remove("path-self", "path-up", "path-down");
        if (!line) return;
        const node = line.parentElement;
        line.classList.add("path-self");
        for (let up = node.parentElement.closest("li.tree-node"); up; up = up.parentElement.closest("li.tree-node")) up.querySelector(":scope > .tree-line").classList.add("path-up");
        for (const down of node.querySelectorAll("li.tree-node")) down.querySelector(":scope > .tree-line").classList.add("path-down");
    };
    // Only with a mouse or the keyboard: on touch the emulated hover would stay lit after a tap.
    const hovering = () => matchMedia("(hover: hover)").matches;
    tree.addEventListener("mouseover", event => { if (hovering()) light(event.target.closest(".tree-line")); });
    tree.addEventListener("mouseleave", () => light(null));
    tree.addEventListener("focusin", event => { if (event.target.matches(":focus-visible")) light(event.target.closest(".tree-line")); });
    tree.addEventListener("focusout", () => light(null));
    return tree;
}

// The steps as plain text, for pasting in a chat: what is made, the totals, then each
// round's steps, and the link to this setup.
// One side of a step (an input, or the result of an earlier step) in words. `mode`: "text" (copied steps: "Name: enchantments"),
// "words" (the sentence: "Name (enchantments)") or "line" (a folded step's line: the enchantments alone).
function sideText(side, mode) {
    if (side.kind === "step") return (mode === "words" ? TEXT.results.words_result_of : TEXT.results.text_result_of)({ number: side.index });
    const enchantments = side.node.enchantments.length ? logic.summary(side.node.enchantments) : "";
    if (!enchantments) return nodeName(side.node);
    if (mode === "text") return TEXT.results.text_entry({ name: nodeName(side.node), enchantments });
    return mode === "words" ? `${nodeName(side.node)} (${enchantments})` : enchantments;
}

function stepsText(root, steps) {
    const text = TEXT.results;
    const part = side => sideText(side, "text");
    const lines = [
        text.text_wanted({ item: logic.itemName(state.item), enchantments: logic.summary(root.enchantments) }),
        text.text_totals({ levels: root.cumulative_levels, xp: Math.round(root.cumulative_xp).toLocaleString(localeOf(language)), max_step: root.max_step })
    ];
    logic.stepRounds(steps).forEach((round, index) => {
        lines.push("", text.round({ number: index + 1, steps: round.length }));
        for (const step of round) {
            const rename = step.node.renamed ? " (" + text.text_rename_to({ name: state.rename_to.trim() }) + ")" : "";
            lines.push(text.text_step({ number: step.number, left: part(step.left), right: part(step.right), levels: step.node.merge_levels }) + rename);
        }
    });
    lines.push("", location.href);
    return lines.join("\n");
}

// The steps as a Markdown checklist (a box for each, ticked for the ones done), for a chat or notes.
function checklistText(root, steps, done) {
    const text = TEXT.results;
    const part = side => sideText(side, "text");
    const lines = [text.text_wanted({ item: logic.itemName(state.item), enchantments: logic.summary(root.enchantments) }), ""];
    for (const step of steps) {
        const rename = step.node.renamed ? " (" + text.text_rename_to({ name: state.rename_to.trim() }) + ")" : "";
        lines.push("- [" + (done.has(step.number) ? "x" : " ") + "] " + text.text_step({ number: step.number, left: part(step.left), right: part(step.right), levels: step.node.merge_levels }) + rename);
    }
    lines.push("", location.href);
    return lines.join("\n");
}

// ---------- Step checklist ----------
// Steps can be ticked off while following along in-game. Ticks are kept in this browser
// for the order on screen only: a different order starts unticked. Storage can be
// unavailable (private windows, blocked site data), so every access is guarded.

// Identifies an order by its steps, so ticks survive changes that leave it the same.
// What goes in each slot (item, enchantments, prior work), not what it costs: a rename
// only adds a level to the last step, and must not clear the ticks of the same order.
export function orderKey(steps) {
    return JSON.stringify(steps.map(step => [
        step.left.node.item_namespace, step.left.node.enchantments, step.left.node.prior_work || 0,
        step.right.node.item_namespace, step.right.node.enchantments, step.right.node.prior_work || 0
    ]));
}

export function loadChecklist(order_key) {
    const saved = readStorage(CHECKLIST_STORAGE_KEY, null);
    return saved && saved.key === order_key && Array.isArray(saved.done) ? new Set(saved.done.filter(Number.isInteger)) : new Set();
}

export function saveChecklist(order_key, done) {
    writeStorage(CHECKLIST_STORAGE_KEY, { key: order_key, done: [...done] });
}

// The box for ticking off step `number`, in the Steps view and the Tree view alike (both
// keep the same ticks). Ticking a step also ticks the steps it needs, and unticking one
// unticks the steps that need it (Logic.js tickStep), so the redraw shows all of them;
// it also updates what "Your level" has left.
function stepTick(number, done, order_key, steps) {
    return h("input", {
        type: "checkbox",
        checked: done.has(number),
        "data-step": number,
        "aria-label": TEXT.results.step_done_label({ number }),
        onchange: event => {
            const checked = event.target.checked;
            const selector = `input[data-step="${number}"]`;
            easedChange(selector, () => {
                saveTicks(order_key, steps, done, logic.tickStep(steps, done, number, checked));
                renderResults();
            });
            const again = document.querySelector(selector);
            if (again) again.focus({ preventScroll: true }); // keyboard users keep their place
            // Ticking brings the next unticked step after this one into view (in the Steps
            // view), only if it isn't already: never back up to an earlier one left unticked.
            if (!checked) return;
            const reveal = () => {
                const later = [...document.querySelectorAll("#results .anvil-step[data-step-card]:not(.done)")]
                    .find(card => Number(card.dataset.stepCard) > number);
                if (later) revealBelow(later);
            };
            // Once the folds have settled (the steps above hold the ticked one in place until then).
            if (motionOk()) setTimeout(reveal, FOLD_MS + 80); else reveal();
        }
    });
}

// One anvil step drawn like the game's anvil: [left] + [right] -> [result], with a box to tick it off.
// `level`: { before, after, short } with "Your level" filled in, else null.
// `folded`: shown as its head only (isFolded), in the Steps and Slots views alike.
function anvilStep(step, done, order_key, steps, level = null, current = false, folded = false) {
    const number = step.number;
    const is_done = done.has(number);
    const tick = stepTick(number, done, order_key, steps);
    const left_levels = new Map(step.left.node.enchantments.map(e => [e.namespace, e.level]));
    // What this step adds or raises over its first slot, with the level it had (undefined: new).
    const changed = new Map(step.node.enchantments
        .filter(e => left_levels.get(e.namespace) !== e.level)
        .map(e => [e.namespace, left_levels.get(e.namespace)]));

    const cost = step.node.merge_levels;

    // Every step folds and unfolds the same way: a click anywhere on its head or its chevron button. Folded, the head says what the step does.
    // The step's circle on the rail ticks it (its checkbox is inside, hidden: the keyboard and screen readers use it).
    const fold_label = folded ? TEXT.results.expand_step : TEXT.results.collapse_step;
    // Keys on the head's two controls (the tick, the chevron button), which are the step's tab stops: Space ticks and Enter or Space folds
    // as for any checkbox or button, and Up and Down move the focus to the same control of the neighbouring step.
    const keys = event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const control = event.target.closest("input[data-step], .step-fold");
        if (!control) return;
        event.preventDefault();
        const cards = [...document.querySelectorAll("#results .anvil-step")];
        const next = cards[cards.indexOf(event.currentTarget.closest(".anvil-step")) + (event.key === "ArrowDown" ? 1 : -1)];
        const target = next && next.querySelector(control.matches(".step-fold") ? ".step-fold" : "input[data-step]");
        if (target) { target.focus({ preventScroll: true }); scrollToView(target); }
    };
    const head = h("div", {
        class: "step-head", title: fold_label,
        onclick: event => { if (!event.target.closest(".step-fold")) toggleFold(order_key, number, !folded); }
    },
        h("span", { class: "step-title", "data-fly": "step:" + number }, TEXT.results.step_title({ number })),
        h("span", { class: "step-summary" }, folded ? stepLine(step) : null),
        h("button", {
            type: "button", class: "step-fold", "aria-expanded": String(!folded), "aria-label": fold_label, title: fold_label,
            onclick: () => toggleFold(order_key, number, !folded)
        })
    );

    return h("li", {
        class: "anvil-step" + (is_done ? " done" : "") + (folded ? " folded" : "") + (current ? " current" : ""),
        "data-step-card": number, onkeydown: keys
    },
        h("label", { class: "step-node", title: TEXT.results.step_done_help }, tick, h("span", { class: "step-node-mark", "aria-hidden": "true" }, is_done ? "✓" : number)),
        head,
        // With "Your level" filled in and too low: how many levels to gain before this step.
        level && level.short ? h("div", { class: "level-checkpoint" }, TEXT.results.checkpoint({ count: level.short, level: cost })) : null,
        h("details", { class: "step-words", open: words_open, ontoggle: event => { words_open = event.target.open; } },
            // Opens and closes with the same slide as Section 1's boxes (Motion.js foldDetails), not the browser's jump.
            h("summary", {
                onclick: event => {
                    event.preventDefault();
                    const details = event.currentTarget.parentElement;
                    words_open = !foldTarget(details);
                    foldDetails(details, words_open);
                }
            }, TEXT.results.step_words),
            h("p", { class: "step-instruction" }, stepInstruction(step))),
        h("p", { class: "print-only step-print" }, stepInstruction(step)),
        h("div", { class: "anvil-row" },
            anvilCell(step.left.node, null, "left", entryRef(step.left), entryHover(step.left.node), TEXT.results.slot_left),
            h("div", { class: "anvil-op", "aria-hidden": "true" }, "+"),
            anvilCell(step.right.node, null, "right", entryRef(step.right), entryHover(step.right.node), TEXT.results.slot_right),
            h("div", { class: "anvil-arrow" },
                h("span", { class: "arrow-glyph", "aria-hidden": "true" }, "➔"),
                costChip(step),
                // A step you can't afford says so in the checkpoint above, not here too.
                level && !level.short ? levelMeter(level) : null
            ),
            anvilCell(step.node, changed, "result", h("span", { class: "cell-meta" }, TEXT.results.result_work({ count: step.node.prior_work })), entryHover(step.node), TEXT.results.slot_result)
        ),
        // Compact Steps' one-line caption, since the slots alone look alike.
        h("p", { class: "step-caption" }, stepLine(step))
    );
}

// What goes in each slot, in words: "Put Boots in the left slot and Enchanted Book (Mending) in
// the right slot. Take the result: it costs 2 levels."

function stepInstruction(step) {
    const text = TEXT.results.step_instruction({ left: sideText(step.left, "words"), right: sideText(step.right, "words"), levels: step.node.merge_levels });
    return step.node.renamed && state.rename_to.trim() ? text + " " + TEXT.results.step_rename_note({ name: state.rename_to.trim() }) : text;
}

// The cost in the game's green; hovering, focusing or tapping it shows where the levels come
// from: the enchantments, each side's prior work (2^n - 1) and the rename, as numbers and a bar.
function costChip(step) {
    const cost = step.node.merge_levels;
    const penalty = work => 2 ** (work || 0) - 1;
    const renamed = step.node.renamed ? 1 : 0;
    const parts = [
        [TEXT.results.cost_part_left, penalty(step.left.node.prior_work), "work"],
        [TEXT.results.cost_part_right, penalty(step.right.node.prior_work), "work2"],
        [TEXT.results.cost_part_rename, renamed, "rename"]
    ];
    const enchants = Math.max(0, cost - parts.reduce((sum, part) => sum + part[1], 0));
    const rows = [[TEXT.results.cost_part_enchants, enchants, "enchants"], ...parts].filter(([, value]) => value > 0);
    const bubble = h("span", { class: "cost-breakdown", role: "tooltip" },
        h("strong", {}, TEXT.results.cost_breakdown_title({ levels: cost })),
        h("span", { class: "cost-bar", "aria-hidden": "true" }, rows.map(([, value, kind]) => h("span", { class: "cost-seg " + kind, style: `flex: ${value}` }))),
        rows.map(([label, value, kind]) => h("span", { class: "cost-row" }, h("i", { class: "cost-dot " + kind }), label, h("b", {}, "+" + value))));
    const chip = h("span", {
        class: "anvil-cost has-breakdown", tabindex: "0",
        onmouseenter: () => showCost(chip, bubble), onfocus: () => showCost(chip, bubble),
        onmouseleave: () => chip.classList.remove("open"), onblur: () => chip.classList.remove("open"),
        onclick: () => (chip.classList.contains("open") ? chip.classList.remove("open") : showCost(chip, bubble))
    }, step.node.renamed ? TEXT.results.cost_renamed({ levels: cost }) : TEXT.results.cost({ levels: cost }), bubble);
    return chip;
}

// The breakdown floats over the page (fixed), so the steps' scrolling box never clips it.
function showCost(chip, bubble) {
    chip.classList.add("open");
    const box = chip.getBoundingClientRect();
    bubble.style.left = Math.max(8, Math.min(box.left + box.width / 2 - 100, innerWidth - 216)) + "px";
    bubble.style.top = box.bottom + 6 + "px";
}

// The bar stands in for the current step while that step is off screen; while any of it
// is on screen, the bar tucks away so it never covers the step (it is sticky inside the steps' box, so with the
// step just peeking in at the bottom edge it would sit right over the step's head).
let current_watch = [];
const BAR_ROOM_PX = 110; // the bar's height and its gap from the bottom edge, with some to spare
function watchCurrentStep() {
    for (const watch of current_watch) watch.disconnect();
    current_watch = [];
    const bar = document.querySelector("#results .current-bar");
    const step = document.querySelector("#results .anvil-step.current");
    const list = document.querySelector("#results .steps-scroll");
    if (!bar || !step || !list || typeof IntersectionObserver !== "function") return;
    // Tucked while the step shows, and while the list's top is still in the bottom BAR_ROOM_PX of the window: the bar is sticky inside the
    // list, so there it would be held at the list's top, over the first step's head.
    let step_shown = false;
    let list_in_reach = false;
    const update = () => bar.classList.toggle("tucked", step_shown || !list_in_reach);
    const stepWatch = new IntersectionObserver(([entry]) => { step_shown = entry.isIntersecting; update(); });
    const listWatch = new IntersectionObserver(([entry]) => { list_in_reach = entry.isIntersecting; update(); }, { rootMargin: `0px 0px -${BAR_ROOM_PX}px 0px` });
    stepWatch.observe(step);
    listWatch.observe(list);
    current_watch = [stepWatch, listWatch];
}

// Ticks a step (and the ones it needs) and brings the next step into view.
function markStepDone(steps, done, order_key, number) {
    fold_change = new Map([...stepBoxes()].map(([key, el]) => [key, el.getBoundingClientRect().height]));
    saveTicks(order_key, steps, done, logic.tickStep(steps, done, number, true));
    renderResults();
    const show = () => {
        const next = document.querySelector("#results .anvil-step.current");
        if (next) scrollToView(next);
    };
    if (motionOk()) setTimeout(show, FOLD_MS + 40); else show();
}

// The current step and a Done button, kept at the bottom of the screen while the steps scroll: on phones a bar with the step's line
// (in flow, sticky), on wide windows a "Next step" card with its three slots over the bottom of the steps column (a zero-high sticky
// wrapper, so it adds nothing to the scroller's size). Either way it is tucked while its step shows (watchCurrentStep).
function currentBar(steps, done, order_key, current) {
    const step = steps.find(entry => entry.number === current);
    const card = () => document.querySelector(`#results .anvil-step[data-step-card="${current}"]`);
    const mini = node => h("span", { class: "mini-slot" + (node.enchantments.length ? " glint" : ""), title: nodeName(node) }, icon(node.item_namespace));
    // It starts as the bar on screen was (tucked when there was none): its observers answer only after the first frame, and an untucked start
    // flashed the card in and out each time a search finished.
    const shown = document.querySelector("#results .current-bar:not(.tucked)");
    return h("div", { class: "current-bar" + (shown ? "" : " tucked") }, h("div", { class: "current-bar-card" },
        h("div", { class: "current-bar-text" },
            h("small", { class: "current-bar-eyebrow" }, TEXT.results.bar_next),
            h("strong", {}, TEXT.results.bar_step({ number: current, total: steps.length })),
            h("span", {}, stepLine(step))),
        // Wide windows show the step as its three slots instead of the sentence (CSS).
        h("span", { class: "current-bar-slots", "aria-hidden": "true" }, mini(step.left.node), h("i", {}, "+"), mini(step.right.node), h("i", {}, "➔"), mini(step.node)),
        h("button", {
            type: "button", class: "btn small", title: TEXT.results.bar_show, "aria-label": TEXT.results.bar_show,
            onclick: () => { const el = card(); if (el) scrollToView(el, "center"); }
        }, "↑"),
        h("button", {
            type: "button", class: "btn small primary",
            onclick: () => markStepDone(steps, done, order_key, current)
        }, TEXT.results.bar_done)));
}

// "Lv 30 → 28" with a small XP-style bar of what is left after the step. (A step you
// can't afford gets the checkpoint above it instead.)
function levelMeter(level) {
    const share = level.before ? level.after / level.before : 0;
    return h("span", { class: "level-track" },
        h("span", { class: "level-meter", "aria-hidden": "true" }, h("span", { class: "level-meter-fill", style: `width: ${(share * 100).toFixed(1)}%` })),
        TEXT.results.level_track({ before: level.before, after: level.after }));
}

// A folded step's line: "Thorns III + Mending · 2 levels".
function stepLine(step) {
    return TEXT.results.step_line({ left: sideText(step.left, "line"), right: sideText(step.right, "line"), levels: step.node.merge_levels });
}

// What goes in a slot, in words: an entry's enchantments (or its name), or "result of step 2".

function toggleFold(order_key, number, fold) {
    foldsFor(order_key).set(number, fold);
    easedChange(`[data-step-card="${number}"]`, renderResults);
    const again = document.querySelector(`[data-step-card="${number}"] .step-fold`);
    if (again) again.focus({ preventScroll: true });
}

// Under a step's input: which step made it (a starting item has no line; hovering it
// highlights its section 2 card instead, see entryHover).
function entryRef(side) {
    return side.kind === "step" ? h("span", { class: "cell-meta" }, TEXT.results.from_step({ number: side.index })) : null;
}

// The books and items you start with that went into `node` (itself, when it is one).
function leavesOf(node) {
    return node.left ? [...leavesOf(node.left), ...leavesOf(node.right)] : [node];
}

// Attributes for a slot (in Steps, Slots or Tree). A starting slot: hovering it highlights its
// section 2 card, and a click or tap scrolls to the card and flashes it (useful on phones). A merged
// item: hovering or focusing it highlights every section 2 card that went into it (only with a mouse
// or the keyboard: on touch the emulated hover would stay lit).
function entryHover(node) {
    if (node.left) return sourcesHover(node);
    const leaf = node;
    const index = entryIndexOf(leaf);
    if (index < 0) return {};
    const card = () => document.querySelector(`#books .entry-card[data-index="${index}"]`);
    const light = on => { const el = card(); if (el) el.classList.toggle("highlight", on); };
    const show = () => {
        const el = card();
        if (!el) return;
        scrollToView(el, "center");
        flash(el);
    };
    const what = nodeName(leaf) + (leaf.enchantments.length ? ": " + logic.summary(leaf.enchantments) : "");
    return {
        "data-entry-link": "",
        // Reachable by keyboard: Tab to it lights its card, Enter shows it.
        tabindex: "0", role: "button", "aria-label": TEXT.results.entry_link_label({ name: what }),
        onmouseenter: () => light(true), onmouseleave: () => light(false),
        onfocus: () => light(true), onblur: () => light(false),
        onclick: show,
        onkeydown: event => {
            if (event.key !== "Enter" || event.target !== event.currentTarget) return;
            event.preventDefault();
            show();
        }
    };
}

function sourcesHover(node) {
    const cards = () => [...new Set(leavesOf(node).map(entryIndexOf))].filter(index => index >= 0)
        .map(index => document.querySelector(`#books .entry-card[data-index="${index}"]`)).filter(Boolean);
    const light = on => { if (!on || matchMedia("(hover: hover)").matches) for (const card of cards()) card.classList.toggle("highlight", on); };
    return { onmouseenter: () => light(true), onmouseleave: () => light(false), onfocusin: () => light(true), onfocusout: () => light(false) };
}

// The section 2 entry a starting slot is (by what it is, its enchantments and prior work;
// copies of one entry are interchangeable, so the first match is the one), or -1.
function entryIndexOf(leaf) {
    const same = (enchantments, list) => list.length === Object.keys(enchantments).length && list.every(e => enchantments[e.namespace] === e.level);
    return logic.currentBooks(state).findIndex(book =>
        (book.type === "item" ? state.item : "book") === leaf.item_namespace &&
        (book.prior_work || 0) === (leaf.prior_work || 0) && same(book.enchantments, leaf.enchantments));
}

// The hotbar flashes once when the last step is ticked (like gaining a level); `celebrated`
// remembers which order it flashed for, so redraws don't repeat it. Unticking resets it.
let celebrated = null;

// A few experience orbs that pop out of the hotbar (rising, drifting sideways, fading) when the last step is ticked, then remove themselves.
const ORB_COUNT = 7;
function orbBurst() {
    const orbs = Array.from({ length: ORB_COUNT }, (_, index) => {
        const across = index / (ORB_COUNT - 1); // 0..1 along the hotbar
        return h("img", {
            class: "pop-orb", src: "img/experience_orb.svg", alt: "", draggable: "false",
            style: `left: ${(8 + across * 84).toFixed(1)}%; --dx: ${Math.round((across - 0.5) * 70)}px; --dy: ${-(22 + (index % 3) * 9)}px; animation-delay: ${index * 45}ms`
        });
    });
    const burst = h("span", { class: "orb-burst", "aria-hidden": "true" }, orbs);
    setTimeout(() => burst.remove(), 1400);
    return burst;
}

// Says `text` to screen readers (the #live region) when ticking changes the number done
// in the order on screen. Redraws, and a different order appearing, say nothing.
let announced = { key: null, count: 0 };
function announce(text, order_key, count) {
    const same_order = announced.key === order_key;
    const changed = announced.count !== count;
    announced = { key: order_key, count };
    if (same_order && changed) $("#live").textContent = text;
}

// "Copy": a small menu of the two ways to take the steps along: as plain text, or as a checklist.
// A round's label folds its round: every step of it, or unfolds them all when they are all folded.
function roundToggle(round, index, foldedNow, foldSteps) {
    const all_folded = round.every(step => foldedNow(step.number));
    const label = all_folded ? TEXT.results.round_unfold : TEXT.results.round_fold;
    return h("button", {
        type: "button", class: "round-toggle", "aria-expanded": String(!all_folded), title: label,
        onclick: () => foldSteps(round.map(step => step.number), !all_folded)
    }, TEXT.results.round({ number: index + 1, steps: round.length }));
}

// Share: everything that hands the order on (copy it as text or a checklist, the link with your progress, print).
function shareMenu(node, steps, done) {
    const menu = h("details", { class: "copy-menu share-menu" },
        h("summary", { class: "icon-btn", title: TEXT.results.share_help, "aria-label": TEXT.results.share }, shareIcon()));
    const copy = (name, label, title, text) => h("button", {
        type: "button", class: "btn small " + name, title,
        onclick: event => {
            copyText(event.currentTarget, text(), label);
            setTimeout(() => { menu.open = false; }, 900); // after the "Copied" it says
        }
    }, label);
    menu.append(h("div", { class: "copy-panel" },
        copy("copy-steps", TEXT.results.copy_steps, TEXT.results.copy_steps_help, () => stepsText(node, steps)),
        copy("copy-checklist", TEXT.results.copy_checklist, TEXT.results.copy_checklist_help, () => checklistText(node, steps, done)),
        copy("copy-link", TEXT.results.copy_link, TEXT.results.copy_link_help, () => currentLink()),
        h("button", { type: "button", class: "btn small print-button", title: TEXT.results.print_help, onclick: () => { menu.open = false; window.print(); } }, TEXT.results.print)));
    return menu;
}

// The toolbar's icons: Compact (list density), fold all (chevrons apart or together) and Share.
export const ICON_STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" };
function densityIcon() {
    return svgIcon("0 0 16 16", [["path", { d: "M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h11" }]], ICON_STROKE);
}
export function foldIcon(expand) {
    return svgIcon("0 0 16 16", expand ? [["path", { d: "M5 5.5 8 2.5l3 3M5 10.5l3 3 3-3" }]] : [["path", { d: "M5 2.5l3 3 3-3M5 13.5l3-3 3 3" }]], ICON_STROKE);
}
function shareIcon() {
    return svgIcon("0 0 16 16", [["path", { d: "M8 10V2.5M5 5.5l3-3 3 3" }], ["path", { d: "M3.5 8.5v4.5h9V8.5" }]], ICON_STROKE);
}

// Unticking every step can be undone for a few seconds (a toast with Undo) instead of asking first.
let undo_toast = null;
function undoToast(text, undo) {
    if (undo_toast) undo_toast.remove();
    const toast = h("div", { class: "toast", role: "status" },
        h("span", {}, text),
        h("button", { type: "button", class: "link", onclick: () => { toast.remove(); undo(); } }, TEXT.results.undo));
    document.body.append(toast);
    undo_toast = toast;
    setTimeout(() => { toast.remove(); if (undo_toast === toast) undo_toast = null; }, 4000);
}

// The menu closes on a click outside it, or on Escape (one listener for the menu of every redraw).
closeOnOutside({
    open: () => document.querySelector(".copy-menu[open]"),
    close(event) { for (const open of document.querySelectorAll(".copy-menu[open]")) if (!event || !open.contains(event.target)) open.open = false; }
});

// Brings a step into view (unfolding it, in the Steps view) and flashes it.
function jumpToStep(order_key, number) {
    if (result_view !== "tree" && isFolded(order_key, number, loadChecklist(order_key), foldedByDefault(number))) {
        foldsFor(order_key).set(number, false);
        renderResults();
    }
    const card = document.querySelector(`#results [data-step-card="${number}"]`);
    if (!card) return;
    scrollToView(card, "center");
    (card.querySelector("input[data-step]") || card).focus({ preventScroll: true }); // (a step is not itself a tab stop)
    flash(card);
}

// In the toolbar: the step hotbar (the progress), "3 of 7 done", Set level and ↺ to untick them all (shown once something is ticked; a toast's Undo brings the ticks back).
function stepProgress(steps, done, levels, order_key) {
    const total = steps.length;
    const count = steps.filter(step => done.has(step.number)).length;
    const level_up = total > 0 && count === total && celebrated !== order_key;
    celebrated = count === total ? order_key : null;
    const summary = count === total ? TEXT.results.progress_done({ total }) : TEXT.results.progress({ done: count, total });
    announce(summary, order_key, count);
    // With "Your level" tracked: enough for what is left, or how many levels are missing.
    const level = activeLevel();
    const level_status = level != null && levels > 0
        ? h("span", { class: "level-status " + (level >= levels ? "enough" : "short") },
            level >= levels ? TEXT.ranking.level_enough_now : TEXT.ranking.level_need_more({ short: levels - level })) : null;
    return h("div", { class: "step-progress" },
        stepHotbar(steps, done, order_key, level_up),
        h("div", { class: "step-progress-main" },
            h("span", { class: "step-progress-text" }, summary),
            levelChip(),
            count ? h("button", {
                type: "button", class: "step-reset", title: TEXT.results.uncheck_all_help, "aria-label": TEXT.results.uncheck_all,
                onclick: () => {
                    const before = new Set(done);
                    saveTicks(order_key, steps, done, new Set());
                    renderResults();
                    undoToast(TEXT.results.unticked({ count: before.size }), () => { saveTicks(order_key, steps, new Set(), before); renderResults(); });
                }
            }, "↺") : null),
        level_status // (on its own row under the bar when there is a level to compare)
    );
}

// The inventory hotbar: one game slot per step showing its result (a glint when enchanted), the current step in the selection frame, done steps
// dimmed with a check; a click goes to the step. One tab stop (the current step's slot), Left and Right move along. It shows in every view (Steps, Compact,
// Tree) and is the progress display. Its slots are not `.mc-slot`s, so the view morphs never take them.
function stepHotbar(steps, done, order_key, level_up = false) {
    const current = steps.findIndex(step => !done.has(step.number));
    const slots = steps.map((step, index) => {
        const is_done = done.has(step.number);
        const label = (is_done ? TEXT.results.hotbar_slot_done : TEXT.results.hotbar_slot)({ number: step.number, name: nodeName(step.node) });
        // The game's tooltip on hover or focus: the result's name (rarity colour, italic once renamed), its enchantments, then which step makes it.
        const enchanted = step.node.enchantments.length > 0;
        const renamed = Boolean(step.node.renamed && state.rename_to.trim());
        const tip = h("div", { class: "hotbar-tip mc-tooltip", "aria-hidden": "true" },
            h("div", { class: nameClass(logic.rarity(step.node.item_namespace, enchanted), renamed ? " renamed" : "") }, nodeName(step.node)),
            logic.tooltipSort(step.node.enchantments).map(e => enchLine(logic.displayName(e.namespace, e.level), logic.isCurse(e.namespace))),
            h("div", { class: "hotbar-tip-step" }, TEXT.results.step_title({ number: step.number }) + (is_done ? " ✓" : "")));
        return h("button", {
            type: "button", "aria-label": label, "aria-current": index === current ? "step" : null,
            class: "hotbar-slot" + (enchanted ? " glint" : "") + (is_done ? " done" : "") + (index === current ? " current" : ""),
            onclick: () => jumpToStep(order_key, step.number),
            onpointerenter: event => placeHotbarTip(event.currentTarget), onfocus: event => placeHotbarTip(event.currentTarget),
            // Hovering or focusing it lights the Section 3 cards that went into this step's result, as a merged item does in Steps and Tree.
            ...sourcesHover(step.node)
        }, icon(step.node.item_namespace), h("span", { class: "hotbar-number", "aria-hidden": "true" }, step.number), is_done ? h("span", { class: "hotbar-check", "aria-hidden": "true" }, "✓") : null, tip);
    });
    return h("div", { class: "step-hotbar" + (level_up ? " level-up" : ""), role: "group", "aria-label": TEXT.results.hotbar_label },
        roving(slots, Math.max(0, current), { prev: ["ArrowLeft"], next: ["ArrowRight"] }),
        level_up && motionOk() ? orbBurst() : null);
}

// Places a hotbar slot's tooltip: fixed to the window (so no box around the hotbar, such as the card, can cut it off), under the slot and centred on it,
// moved left or right to stay inside the window, and above the slot when there is no room below.
function placeHotbarTip(slot) {
    const tip = slot.querySelector(".hotbar-tip");
    if (!tip) return;
    const place = () => {
        const at = slot.getBoundingClientRect();
        const box = tip.getBoundingClientRect();
        const margin = 8;
        const left = Math.max(margin, Math.min(at.left + at.width / 2 - box.width / 2, innerWidth - margin - box.width));
        const below = at.bottom + 8;
        const top = below + box.height > innerHeight - margin && at.top - 8 - box.height >= margin ? at.top - 8 - box.height : below;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
    };
    place();
    requestAnimationFrame(place); // (once the :hover / :focus rule has shown it, its size is known)
}

// An inventory slot with a game-style tooltip underneath. The name is colored by rarity.
// `role` is "left", "right" or "result", for the layout.
// `meta`: an optional small line under the tooltip (the step it came from, prior work...).
// `attrs`: extra attributes for the cell (hover handlers).
export function anvilCell(node, changed, role, meta = null, attrs = {}, label = null) {
    const enchanted = node.enchantments.length > 0;
    // A renamed item shows its new name in italics, as in the game.
    const renamed = Boolean(node.renamed && state.rename_to.trim());
    const name = nodeName(node);
    const name_class = nameClass(logic.rarity(node.item_namespace, enchanted), renamed ? " renamed" : "");
    // `changed`: the enchantments to mark (a Set, or a Map to the level they had, shown as "← III").
    const lines = logic.tooltipSort(node.enchantments).map(e => {
        const from = changed && changed.get ? changed.get(e.namespace) : undefined;
        return h("div", {
            class: "mc-ench" + (logic.isCurse(e.namespace) ? " curse" : "") + (changed && changed.has(e.namespace) ? " changed" : ""),
            "data-ns": e.namespace, "data-level": e.level
        }, logic.displayName(e.namespace, e.level), from ? h("span", { class: "mc-from" }, " ← " + roman(from)) : null);
    });

    return h("div", { class: "anvil-cell " + role, ...attrs },
        label ? h("span", { class: "cell-label" }, label) : null,
        h("div", { class: "mc-slot" + (enchanted ? " glint" : ""), "data-node": nodeId(node) }, icon(node.item_namespace)),
        h("div", { class: "mc-tooltip", "data-fly": "tip:" + nodeId(node) }, h("div", { class: name_class }, name), lines),
        meta
    );
}
