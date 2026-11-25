// Section 4: the steps and the tree, ticking and folding, progress, and the text of the steps.
import { updateCostMeter } from "./Wanted.js";
import { MAX_GROUPS, MAX_STEP_LEVELS, anvilBreakChance, levelTrack, roman, searchSize } from "./Logic.js";
import { TEXT } from "./Text.js";
import { SLOW_SPLITS, language, logic, state } from "./Store.js";
import { $, copyText, h, icon, motionOk, readStorage, writeStorage } from "./Dom.js";
import { keepInPlace, revealBelow } from "./Motion.js";
import { renderMetrics } from "./Ranking.js";
import { activeLevel, remainingLevels, updateLevelMeter } from "./Options.js";
import { cancelCalculation, last_result, progressLabel, runCalculation, running, show_progress } from "./Calc.js";
import { floatBubble, infoTip } from "./Tips.js";
import { commit, renderOrderSummary, renderStepsSummary } from "./App.js";

const CHECKLIST_STORAGE_KEY = "enchantment-calculator-checklist";
const VIEW_STORAGE_KEY = "enchantment-calculator-view";
const COMPACT_STORAGE_KEY = "enchantment-calculator-tree-compact";
// "steps": a card per step; "slots": one line of slots per step; "tree".
let result_view = ["tree", "slots"].includes(readStorage(VIEW_STORAGE_KEY, "steps")) ? readStorage(VIEW_STORAGE_KEY, "steps") : "steps";
// Tree view: only the slots, with the details on hover.
let tree_compact = readStorage(COMPACT_STORAGE_KEY, false) === true;
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

function isFolded(order_key, number, done, by_default = false) {
    const folds = foldsFor(order_key);
    return folds.has(number) ? folds.get(number) : done.has(number) || by_default;
}

// Saves new ticks, forgetting the hand folding of the steps whose tick changed.
function saveTicks(order_key, steps, done, next) {
    if (step_folds.key === order_key) {
        for (const step of steps) if (done.has(step.number) !== next.has(step.number)) step_folds.folded.delete(step.number);
    }
    saveChecklist(order_key, next);
}

export function renderResults() {
    updateCostMeter();
    renderMetrics();
    renderOrderSummary();
    renderStepsSummary();
    updateLevelMeter();
    const box = $("#results");
    const old_scroll = box.querySelector(".steps-scroll");
    if (old_scroll) steps_scroll.top = old_scroll.scrollTop;
    box.replaceChildren();
    const entries = logic.buildEntries(state);

    // Only while it runs: once the result is in, the wait is over.
    const size = searchSize(entries);
    if (running && size.groups <= MAX_GROUPS && size.splits > SLOW_SPLITS) {
        box.append(h("div", { class: "warning" }, TEXT.results.slow_search({ count: entries.length })));
    }

    if (running && show_progress) {
        box.append(h("div", { class: "progress" },
            h("div", { class: "progress-track" }, h("div", { class: "progress-fill", id: "progress-fill" })),
            h("span", { class: "progress-text", id: "progress-text" }, progressLabel()),
            h("button", { type: "button", class: "btn small", onclick: cancelCalculation }, TEXT.results.cancel)
        ));
    }

    const result = last_result;
    if (!result) return;

    if (result.status === "empty") {
        const message = !state.item ? TEXT.results.pick_item : TEXT.results.choose_enchantments;
        box.append(h("div", { class: "empty" }, h("img", { src: "img/enchanting_table.png", alt: "" }), h("p", {}, message)));
        return;
    }
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
            }, TEXT.results.use_game_limit({ limit: MAX_STEP_LEVELS })) : null));
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
    // Only on paper: the anvil wear (on screen it is in the heading, which isn't printed).
    content.append(h("p", { class: "print-only" }, TEXT.results.anvil_uses({ uses: steps.length }) + " · " + anvilRiskText(steps.length)));

    const order_key = orderKey(steps);
    const done = loadChecklist(order_key);

    const left = steps.map(step => step.number).filter(number => !done.has(number));
    const current = left.length ? Math.min(...left) : null;
    const setView = view => { result_view = view; writeStorage(VIEW_STORAGE_KEY, view); renderResults(); };
    // Tree: a button for showing only the slots. Steps and Tree: Expand all / Collapse all.
    const compact = result_view === "tree" ? h("button", {
        type: "button", class: "btn small density", "aria-pressed": String(tree_compact), title: TEXT.results.compact_help,
        onclick: () => { tree_compact = !tree_compact; writeStorage(COMPACT_STORAGE_KEY, tree_compact); renderResults(); }
    }, TEXT.results.compact) : null;
    const foldAll = fold => {
        for (const step of steps) foldsFor(order_key).set(step.number, fold);
        renderResults();
    };
    const fold_buttons = result_view === "slots" ? null : h("span", { class: "fold-buttons" },
        h("button", { type: "button", class: "btn small", onclick: () => foldAll(false) }, TEXT.results.expand_all),
        h("button", { type: "button", class: "btn small", onclick: () => foldAll(true) }, TEXT.results.collapse_all));

    content.append(h("div", { class: "toolbar result-tools" },
        h("div", { class: "segmented", role: "group", "aria-label": TEXT.results.view_label },
            [["steps", TEXT.results.view_steps], ["slots", TEXT.results.view_slots], ["tree", TEXT.results.view_tree]].map(([view, label]) => h("button", {
                type: "button", class: result_view === view ? "selected" : "", "aria-pressed": String(result_view === view),
                "data-view": view, onclick: () => setView(view)
            }, label))),
        stepProgress(steps, done, remaining.needed, order_key, [compact, fold_buttons]),
        // Copy steps and Print go to the next row together, never one without the other.
        h("div", { class: "result-actions" },
            h("button", {
                type: "button", class: "btn small copy-steps", title: TEXT.results.copy_steps_help,
                onclick: event => copyText(event.currentTarget, stepsText(node, steps), TEXT.results.copy_steps)
            }, TEXT.results.copy_steps),
            h("button", { type: "button", class: "btn small", title: TEXT.results.print_help, onclick: () => window.print() }, TEXT.results.print))
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
        // hand (Expand all / Collapse all). The Slots view shows each step as one line of slots.
        const slots = result_view === "slots";
        const rounds = logic.stepRounds(steps);
        const timeline = h("div", { class: "rounds timeline" + (slots ? " slots-mode" : "") }, rounds.map((round, index) => h("section", { class: "round" },
            h("div", { class: "round-label" },
                TEXT.results.round({ number: index + 1, steps: round.length }),
                round.length > 1 ? roundTip(index) : null),
            h("ol", { class: "anvil-steps" }, round.map(step =>
                anvilStep(step, done, order_key, steps,
                    track && !done.has(step.number) ? track.steps[step.number - 1] : null,
                    step.number === current, !slots && isFolded(order_key, step.number, done, step.number !== current))))
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
        // The finished item, after the last step.
        scroller.append(h("section", { class: "final-card" + (current == null ? " done" : "") },
            h("div", { class: "final-title" }, current == null ? TEXT.results.final_done : TEXT.results.final_title),
            anvilCell(node, null, "final")));
        // Phones: the current step and a Done button stay at the bottom while scrolling.
        if (current != null) scroller.append(currentBar(steps, done, order_key, current));
        watchCurrentStep();
    }

    const scroll_key = result_view + "|" + order_key;
    if (steps_scroll.key === scroll_key) scroller.scrollTop = steps_scroll.top;
    steps_scroll = { key: scroll_key, top: scroller.scrollTop };
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

// The break risk in section 4's heading: the anvil and the chance ("4%"), colored by risk
// (green unlikely or impossible, amber possible, red likely). Tap or hover for the
// sentence and how wear works; its bubble floats over the page, like the other tips.
export function anvilRisk(uses) {
    const chance = anvilBreakChance(uses);
    const risk = chance === 0 ? "none" : chance < ANVIL_RISK_MEDIUM ? "low" : chance < ANVIL_RISK_HIGH ? "medium" : "high";
    const tip = infoTip("anvil-risk-tip",
        [h("img", { class: "anvil-risk-icon", src: "img/anvil.png", alt: "" }), chance === 0 ? TEXT.results.anvil_safe_short : percentText(chance)],
        anvilRiskText(uses),
        h("span", {}, h("strong", {}, anvilRiskText(uses)), " ", TEXT.results.anvil_wear_help),
        "anvil-risk risk-" + risk);
    tip.querySelector(".info-tip-bubble").setAttribute("role", "tooltip");
    floatBubble(tip);
    return tip;
}

function anvilRiskText(uses) {
    const chance = anvilBreakChance(uses);
    return chance === 0 ? TEXT.results.anvil_safe : TEXT.results.anvil_break({ chance: percentText(chance) });
}

// 0.04 as "4%" in the page's language; tiny chances as "under 1%" rather than "0%".
function percentText(chance) {
    if (chance > 0 && chance < 0.01) return TEXT.results.under_one_percent;
    return new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(chance);
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
            index ? ", " : null,
            h("span", {
                class: "mc-ench" + (logic.isCurse(e.namespace) ? " curse" : "") +
                    (before && before.get(e.namespace) !== e.level ? " changed" : "")
            }, logic.displayName(e.namespace, e.level))
        ]);
        // A merge folds and unfolds like its step in the Steps view (the same fold state):
        // done ones start folded, hiding what went into them; a click on the line (but
        // the tick) or its ▾/▴ button switches it.
        const folded = Boolean(number) && isFolded(order_key, number, done);
        const fold_label = folded ? TEXT.results.expand_step : TEXT.results.collapse_step;
        // Folded merges keep their inputs in the page, hidden (CSS), so printing can show them.
        return h("li", { class: "tree-node" + (folded ? " folded" : "") },
            h("div", {
                class: "tree-line" + (number ? " merge" : "") + (number && done.has(number) ? " done" : ""),
                "data-step-card": number || null, title: number ? fold_label : null,
                onclick: number ? event => { if (!event.target.closest(".tree-step, .step-fold")) toggleFold(order_key, number, !folded); } : null,
                // A starting item lights its card in section 2 and scrolls to it on a click (entryHover).
                ...(node.left ? {} : entryHover(node))
            },
                h("span", { class: "tree-slot" + (enchanted ? " glint" : "") }, icon(node.item_namespace, true)),
                // Compact: a one-line caption next to the slot; the tooltip shows on hover.
                h("span", { class: "tree-caption" }, enchanted ? logic.summary(node.enchantments) : nodeName(node)),
                h("span", { class: "mc-tooltip tree-tooltip" },
                    h("span", { class: "mc-name rarity-" + logic.rarity(node.item_namespace, enchanted) + (renamed ? " renamed" : "") }, nodeName(node)),
                    enchanted ? h("span", { class: "mc-ench" }, enchantments) : null),
                number ? h("label", { class: "tree-step", title: TEXT.results.step_done_help },
                    stepTick(number, done, order_key, steps),
                    TEXT.results.tree_step({ number, levels: node.merge_levels })) : null,
                number ? h("button", {
                    type: "button", class: "step-fold", "aria-expanded": String(!folded), "aria-label": fold_label, title: fold_label,
                    onclick: () => toggleFold(order_key, number, !folded)
                }, folded ? "▾" : "▴") : null
            ),
            node.left ? h("ul", { class: "tree-children" }, branch(node.left), branch(node.right)) : null
        );
    };
    const tree = h("ul", { class: "merge-tree" + (tree_compact ? " compact" : "") }, branch(root));
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
function stepsText(root, steps) {
    const text = TEXT.results;
    const part = side => side.kind === "step"
        ? text.text_result_of({ number: side.index })
        : side.node.enchantments.length
            ? text.text_entry({ name: nodeName(side.node), enchantments: logic.summary(side.node.enchantments) })
            : nodeName(side.node);
    const lines = [
        text.text_wanted({ item: logic.itemName(state.item), enchantments: logic.summary(root.enchantments) }),
        text.text_totals({ levels: root.cumulative_levels, xp: Math.round(root.cumulative_xp).toLocaleString(language), max_step: root.max_step })
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
    try {
        const saved = JSON.parse(localStorage.getItem(CHECKLIST_STORAGE_KEY));
        if (saved && saved.key === order_key && Array.isArray(saved.done)) return new Set(saved.done);
    } catch {
        // No storage: start unticked.
    }
    return new Set();
}

export function saveChecklist(order_key, done) {
    try {
        localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify({ key: order_key, done: [...done] }));
    } catch {
        // No storage: ticks last until the page reloads.
    }
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
            keepInPlace(selector, () => {
                saveTicks(order_key, steps, done, logic.tickStep(steps, done, number, checked));
                renderResults();
            });
            const again = document.querySelector(selector);
            if (again) again.focus({ preventScroll: true }); // keyboard users keep their place
            // Ticking brings the next unticked step after this one into view (in the Steps
            // view), only if it isn't already: never back up to an earlier one left unticked.
            if (!checked) return;
            const later = [...document.querySelectorAll("#results .anvil-step[data-step-card]:not(.done)")]
                .find(card => Number(card.dataset.stepCard) > number);
            if (later) revealBelow(later);
        }
    });
}

// One anvil step drawn like the game's anvil: [left] + [right] -> [result], with a box to tick it off.
// `level`: { before, after, short } with "Your level" filled in, else null.
// `folded`: shown as its head only (isFolded).
function anvilStep(step, done, order_key, steps, level = null, current = false, folded = false) {
    const number = step.number;
    const is_done = done.has(number);
    const tick = stepTick(number, done, order_key, steps);
    const left_levels = new Map(step.left.node.enchantments.map(e => [e.namespace, e.level]));
    // What this step adds or raises over its first slot, with the level it had (undefined: new).
    const changed = new Map(step.node.enchantments
        .filter(e => left_levels.get(e.namespace) !== e.level)
        .map(e => [e.namespace, left_levels.get(e.namespace)]));

    // The cost in the game's green, amber within 5 levels of the level limit, red at it
    // (with no limit, measured against the game's own 39).
    const limit = state.no_step_limit ? MAX_STEP_LEVELS : state.max_step;
    const cost = step.node.merge_levels;
    const cost_class = cost >= limit ? " at-limit" : limit - cost <= 5 ? " near-limit" : "";

    // Every step folds and unfolds the same way: a click anywhere on its head (but the
    // tick) or its ▾/▴ button. Folded, the head says what the step does.
    const fold_label = folded ? TEXT.results.expand_step : TEXT.results.collapse_step;
    const head = h("div", {
        class: "step-head", title: fold_label,
        onclick: event => { if (!event.target.closest(".step-tick, .step-fold")) toggleFold(order_key, number, !folded); }
    },
        h("label", { class: "step-tick", title: TEXT.results.step_done_help }, tick, h("span", {}, TEXT.results.step_title({ number }))),
        h("span", { class: "step-summary" }, folded ? stepLine(step) : null),
        h("button", {
            type: "button", class: "step-fold", "aria-expanded": String(!folded), "aria-label": fold_label, title: fold_label,
            onclick: () => toggleFold(order_key, number, !folded)
        }, folded ? "▾" : "▴")
    );

    return h("li", {
        class: "anvil-step" + (is_done ? " done" : "") + (folded ? " folded" : "") + (current ? " current" : ""),
        "data-step-card": number, tabindex: "0", "aria-keyshortcuts": "Space",
        // Space ticks (or unticks) the focused step.
        onkeydown: event => {
            if (event.key !== " " || event.target !== event.currentTarget) return;
            event.preventDefault();
            keepInPlace(`[data-step-card="${number}"]`, () => {
                saveTicks(order_key, steps, done, logic.tickStep(steps, done, number, !is_done));
                renderResults();
            });
            const again = document.querySelector(`[data-step-card="${number}"]`);
            if (again) again.focus({ preventScroll: true });
        }
    },
        h("span", { class: "step-node", "aria-hidden": "true" }, is_done ? "✓" : number),
        head,
        // With "Your level" filled in and too low: how many levels to gain before this step.
        level && level.short ? h("div", { class: "level-checkpoint" }, TEXT.results.checkpoint({ count: level.short, level: cost })) : null,
        h("p", { class: "step-instruction" }, stepInstruction(step)),
        h("div", { class: "anvil-row" },
            anvilCell(step.left.node, null, "left", entryRef(step.left), step.left.kind === "step" ? {} : entryHover(step.left.node), TEXT.results.slot_left),
            h("div", { class: "anvil-op", "aria-hidden": "true" }, "+"),
            anvilCell(step.right.node, null, "right", entryRef(step.right), step.right.kind === "step" ? {} : entryHover(step.right.node), TEXT.results.slot_right),
            h("div", { class: "anvil-arrow" },
                h("span", { class: "arrow-glyph", "aria-hidden": "true" }, "➔"),
                costChip(step, cost_class),
                // A step you can't afford says so in the checkpoint above, not here too.
                level && !level.short ? levelMeter(level) : null
            ),
            anvilCell(step.node, changed, "result", h("span", { class: "cell-meta" }, TEXT.results.result_work({ count: step.node.prior_work })), {}, TEXT.results.slot_result)
        )
    );
}

// What goes in each slot, in words: "Put Boots in the left slot and Enchanted Book (Mending) in
// the right slot. Take the result: it costs 2 levels."
function slotWords(side) {
    if (side.kind === "step") return TEXT.results.words_result_of({ number: side.index });
    return side.node.enchantments.length ? `${nodeName(side.node)} (${logic.summary(side.node.enchantments)})` : nodeName(side.node);
}

function stepInstruction(step) {
    const text = TEXT.results.step_instruction({ left: slotWords(step.left), right: slotWords(step.right), levels: step.node.merge_levels });
    return step.node.renamed && state.rename_to.trim() ? text + " " + TEXT.results.step_rename_note({ name: state.rename_to.trim() }) : text;
}

// The cost in the game's green; hovering, focusing or tapping it shows where the levels come
// from: the enchantments, each side's prior work (2^n - 1) and the rename, as numbers and a bar.
function costChip(step, cost_class) {
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
        class: "anvil-cost has-breakdown" + cost_class, tabindex: "0",
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
// is on screen (above the bar's own spot), the bar tucks away so it never covers the step.
let current_watch = null;
function watchCurrentStep() {
    if (current_watch) current_watch.disconnect();
    current_watch = null;
    const bar = document.querySelector("#results .current-bar");
    const step = document.querySelector("#results .anvil-step.current");
    if (!bar || !step || typeof IntersectionObserver !== "function") return;
    current_watch = new IntersectionObserver(([entry]) => bar.classList.toggle("tucked", entry.isIntersecting),
        { rootMargin: "0px 0px -90px 0px" });
    current_watch.observe(step);
}

// Phones: the current step's line and a Done button, kept at the bottom of the screen while
// the steps scroll (CSS shows it under 900px).
function currentBar(steps, done, order_key, current) {
    const step = steps.find(entry => entry.number === current);
    const card = () => document.querySelector(`#results .anvil-step[data-step-card="${current}"]`);
    return h("div", { class: "current-bar" },
        h("div", { class: "current-bar-text" },
            h("strong", {}, TEXT.results.bar_step({ number: current, total: steps.length })),
            h("span", {}, stepLine(step))),
        h("button", {
            type: "button", class: "btn small", title: TEXT.results.bar_show,
            onclick: () => { const el = card(); if (el) el.scrollIntoView({ block: "center", behavior: motionOk() ? "smooth" : "auto" }); }
        }, "↑"),
        h("button", {
            type: "button", class: "btn small primary",
            onclick: () => {
                saveTicks(order_key, steps, done, logic.tickStep(steps, done, current, true));
                renderResults();
                const next = document.querySelector("#results .anvil-step.current");
                if (next) next.scrollIntoView({ block: "nearest", behavior: motionOk() ? "smooth" : "auto" });
            }
        }, TEXT.results.bar_done));
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
    return TEXT.results.step_line({ left: stepPart(step.left), right: stepPart(step.right), levels: step.node.merge_levels });
}

// What goes in a slot, in words: an entry's enchantments (or its name), or "result of step 2".
function stepPart(side) {
    return side.kind === "step"
        ? TEXT.results.text_result_of({ number: side.index })
        : side.node.enchantments.length ? logic.summary(side.node.enchantments) : nodeName(side.node);
}

function toggleFold(order_key, number, fold) {
    foldsFor(order_key).set(number, fold);
    keepInPlace(`[data-step-card="${number}"]`, renderResults);
    const again = document.querySelector(`[data-step-card="${number}"] .step-fold`);
    if (again) again.focus({ preventScroll: true });
}

// Under a step's input: which step made it (a starting item has no line; hovering it
// highlights its section 2 card instead, see entryHover).
function entryRef(side) {
    return side.kind === "step" ? h("span", { class: "cell-meta" }, TEXT.results.from_step({ number: side.index })) : null;
}

// Attributes for a starting slot (in Steps or Tree): hovering it highlights its section 2
// card, and a click or tap scrolls to the card and flashes it (useful on phones).
function entryHover(leaf) {
    const index = entryIndexOf(leaf);
    if (index < 0) return {};
    const card = () => document.querySelector(`#books .entry-card[data-index="${index}"]`);
    const light = on => { const el = card(); if (el) el.classList.toggle("highlight", on); };
    const show = () => {
        const el = card();
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: motionOk() ? "smooth" : "auto" });
        el.classList.remove("flash");
        void el.offsetWidth; // restart the flash
        el.classList.add("flash");
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

// The section 2 entry a starting slot is (by what it is, its enchantments and prior work;
// copies of one entry are interchangeable, so the first match is the one), or -1.
function entryIndexOf(leaf) {
    const same = (enchantments, list) => list.length === Object.keys(enchantments).length && list.every(e => enchantments[e.namespace] === e.level);
    return logic.currentBooks(state).findIndex(book =>
        (book.type === "item" ? state.item : "book") === leaf.item_namespace &&
        (book.prior_work || 0) === (leaf.prior_work || 0) && same(book.enchantments, leaf.enchantments));
}

// The bar flashes once when the last step is ticked (like gaining a level); `celebrated`
// remembers which order it flashed for, so redraws don't repeat it. Unticking resets it.
let celebrated = null;

// Says `text` to screen readers (the #live region) when ticking changes the number done
// in the order on screen. Redraws, and a different order appearing, say nothing.
let announced = { key: null, count: 0 };
function announce(text, order_key, count) {
    const same_order = announced.key === order_key;
    const changed = announced.count !== count;
    announced = { key: order_key, count };
    if (same_order && changed) $("#live").textContent = text;
}

// In the toolbar: "3 of 7 done · 18 levels to go" over a bar that fills as steps are
// ticked, and ↺ to untick them all; `extra` are more buttons for the same row (some may be null).
function stepProgress(steps, done, levels, order_key, extra) {
    const total = steps.length;
    const count = steps.filter(step => done.has(step.number)).length;
    const level_up = total > 0 && count === total && celebrated !== order_key;
    celebrated = count === total ? order_key : null;
    const summary = count === total ? TEXT.results.progress_done({ total }) : TEXT.results.progress({ done: count, total, levels });
    announce(summary, order_key, count);
    // The bar, its text and ↺ stay together; the extra buttons (Compact, Expand all /
    // Collapse all) wrap to their own row as one group when there is no room beside them.
    const tools = extra.filter(Boolean);
    return h("div", { class: "step-progress" },
        h("div", { class: "step-progress-main" },
            h("div", { class: "step-progress-track" + (level_up ? " level-up" : ""), role: "progressbar", "aria-valuetext": summary, "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(count) },
                // Drawn like the game's experience bar: one segment per step, filling from the left.
                steps.map((step, index) => h("span", { class: "step-progress-cell" + (index < count ? " filled" : "") }))),
            h("span", { class: "step-progress-text" }, summary),
            h("button", {
                type: "button", class: "step-reset", title: TEXT.results.uncheck_all_help, "aria-label": TEXT.results.uncheck_all,
                disabled: count === 0, onclick: () => { saveTicks(order_key, steps, done, new Set()); renderResults(); }
            }, "↺")),
        tools.length ? h("div", { class: "step-progress-tools" }, tools) : null
    );
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
    const name_class = "mc-name rarity-" + logic.rarity(node.item_namespace, enchanted) + (renamed ? " renamed" : "");
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
        h("div", { class: "mc-slot" + (enchanted ? " glint" : "") }, icon(node.item_namespace)),
        h("div", { class: "mc-tooltip" }, h("div", { class: name_class }, name), lines),
        meta
    );
}
