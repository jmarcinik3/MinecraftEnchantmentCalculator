// Section 1: the item and the enchantments it should end up with.
import { roman } from "./Logic.js";
import { TEXT } from "./Text.js";
import { conflicts_toggled, item_menu_open, logic, setConflictsToggled, setItemMenuOpen, state } from "./Store.js";
import { $, h, icon, motionOk } from "./Dom.js";
import { last_result, running } from "./Calc.js";
import { closeLines, closeRow, growSmoothly, inertCopy, openLines, openRow, rollLevelBar, rollLines, slideWidth } from "./Motion.js";
import { anvilCell } from "./Results.js";
import { conflictGraph, markSearch } from "./Graph.js";
import { clashes, commit, selectItem, setWanted, tryExample } from "./App.js";

// What section 1's preview showed last, so a redraw can grow it smoothly and fade in
// the enchantments that are new.
let preview_shown = { item: null, enchantments: new Set() };
// Every item that can be enchanted, as a grid of buttons.
function itemGrid() {
    return h("div", { class: "item-grid", id: "items" }, logic.enchantableItems().map(item => h("button", {
        type: "button",
        class: "item-button" + (state.item === item ? " selected" : ""),
        "aria-pressed": String(state.item === item),
        "data-focus": "item-" + item,
        onclick: () => selectItem(item)
    },
        h("span", { class: "mc-slot item-slot" }, icon(item)),
        logic.itemName(item),
        // The game's tooltip on hover or focus: the item and how many enchantments it takes.
        h("span", { class: "item-tip mc-tooltip", "aria-hidden": "true" },
            h("span", { class: "mc-name rarity-common" }, logic.itemName(item)),
            h("span", { class: "mc-ench" }, TEXT.wanted.item_takes({ count: logic.applicable(item).length }))
        )
    )));
}

// Section 1: the item grid until an item is picked; then a preview of the finished item
// (its slot opens the item menu), the toolbar and presets, and one row per enchantment
// (conflict groups together).
export function renderWanted() {
    const box = $("#wanted");
    const focus = focusState(box);
    const old_preview = box.querySelector(".wanted-preview");
    const old_height = old_preview && preview_shown.item === state.item ? old_preview.getBoundingClientRect().height : null;
    // "Allow conflicts" turns each conflict group from a switch into plain rows (and
    // back): their old heights, so the new ones can slide from them.
    const old_groups = new Map();
    if (conflicts_toggled) {
        for (const group of box.querySelectorAll(".ench-group[data-group]")) old_groups.set(group.dataset.group, group.getBoundingClientRect().height);
    }
    setConflictsToggled(false);
    // The level bar of each "Pick one" group's chosen row, to roll it if the next pick has a different number of levels.
    const old_bars = new Map();
    for (const group of box.querySelectorAll(".ench-group.exclusive[data-group]")) {
        const bar = group.querySelector(".level-bar");
        if (bar) old_bars.set(group.dataset.group, { levels: bar.querySelectorAll(".level-seg").length, segments: [...bar.querySelectorAll(".level-seg")].map(seg => seg.cloneNode(true)) });
    }
    // Each "Pick one in each" section: its chosen rows (a copy, height and level bar each), selected options and border.
    const old_each = captureEach(box);
    // The cost line of the preview's tooltip, so it can fold away in place if the redraw drops it.
    const old_cost_line = box.querySelector(".wanted-preview .cost-line:not(.idle)");
    const old_cost_copy = old_cost_line ? inertCopy(old_cost_line) : null;
    // Each row's height, to ease a row that gets taller or shorter (a "not on your books" note appearing, say) instead of jumping.
    const old_rows = new Map([...box.querySelectorAll(".ench-row[data-ns]")].map(row => [row.dataset.ns, row.getBoundingClientRect().height]));
    // Each "Pick one" group before: which option was chosen, how its box looked, and a copy of its row,
    // so None <-> an enchantment can animate (the row opens or closes, the options and the border fade).
    const old_picks = new Map();
    for (const group of box.querySelectorAll(".ench-group.exclusive[data-group]")) {
        const row = group.querySelector(":scope > .ench-row");
        old_picks.set(group.dataset.group, {
            selected: group.querySelector(".switch-option.selected")?.dataset.focus || null,
            border: getComputedStyle(group).borderColor,
            row: row ? inertCopy(row) : null,
            ns: row ? row.dataset.ns : null,
            height: row ? row.getBoundingClientRect().height : null
        });
    }
    // The preview's tooltip lines, to fade out the ones about to go (closeLines).
    const old_tip = old_height != null ? old_preview.querySelector(".mc-tooltip") : null;
    const old_tip_rect = old_tip ? old_tip.getBoundingClientRect() : null;
    const old_width = old_tip_rect ? old_tip_rect.width : null;
    const old_lines = old_tip ? [...old_preview.querySelectorAll(".mc-ench[data-ns]")].map(line => {
        const rect = line.getBoundingClientRect();
        // Where the line sat inside the tooltip's padding box (for a copy laid over it).
        return {
            ns: line.dataset.ns, node: line.cloneNode(true),
            box: { left: rect.left - old_tip_rect.left - old_tip.clientLeft, top: rect.top - old_tip_rect.top - old_tip.clientTop, width: rect.width, height: rect.height }
        };
    }) : [];
    box.replaceChildren();
    if (!state.item) {
        box.append(
            h("p", { class: "hint intro" }, TEXT.wanted.intro),
            h("p", { class: "hint" }, TEXT.wanted.pick_item_first),
            itemGrid(),
            // A first look without choosing anything: a fully enchanted helmet.
            h("button", { type: "button", class: "btn small example", onclick: tryExample }, TEXT.wanted.example)
        );
        restoreFocus(box, focus);
        restoreConflicts();
        return;
    }

    const { list, mod_boxes } = wantedList();
    box.append(...[wantedHead(presetChips()), wantedSearch(), listBox(list), ...mod_boxes, conflictGraph(searchMatcher())].filter(Boolean)); // append(null) would print "null"
    if (old_height != null) {
        const preview = box.querySelector(".wanted-preview");
        const same_size = Math.abs(preview.getBoundingClientRect().height - old_height) < 1; // before it slides
        growSmoothly(preview, old_height);
        // Heights: the preview box can be held taller than the tooltip by the controls beside it,
        // so the tooltip's own height is what is compared and slid in a swap.
        slideWidth(preview.querySelector(".mc-tooltip"), old_width, same_size && old_tip_rect ? old_tip_rect.height : null);
        // A swap (same size) rolls every changed row upward together; else lines open and close.
        if (same_size) {
            rollLines(preview, old_lines);
        } else {
            openLines(preview.querySelectorAll(".mc-ench.fresh"));
            closeLines(preview, old_lines);
        }
    }
    const new_cost_line = box.querySelector(".wanted-preview .cost-line");
    if (old_cost_copy && new_cost_line && new_cost_line.classList.contains("idle")) closeRow(new_cost_line.parentElement, old_cost_copy);
    for (const group of box.querySelectorAll(".ench-group[data-group]")) {
        if (!old_groups.has(group.dataset.group)) continue;
        growSmoothly(group, old_groups.get(group.dataset.group));
        if (motionOk()) group.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
    }
    for (const group of box.querySelectorAll(".ench-group.exclusive[data-group]")) {
        const old = old_bars.get(group.dataset.group);
        const bar = group.querySelector(".level-bar");
        if (old && bar) rollLevelBar(bar, old.levels, old.segments);
        animatePick(group, old_picks.get(group.dataset.group));
    }
    for (const section of box.querySelectorAll(".pick-each[data-each]")) animateEach(section, old_each.get(section.dataset.each));
    if (motionOk() && !old_groups.size) {
        for (const row of box.querySelectorAll(".ench-row[data-ns]")) {
            const was = old_rows.get(row.dataset.ns);
            if (was == null || row.getAnimations().length) continue;
            easeRowHeight(row, was);
        }
    }
    restoreFocus(box, focus);
    restoreConflicts();
}

// Eases a row's height from `from` to its new one (the box clips while it does). A row laid out as one grid row has that row
// follow the box meanwhile, so what is in it (the level bar) moves with the box both ways: left to itself, a growing box would
// lay its content out at the final size and the bar would jump there at once.
function easeRowHeight(row, from) {
    const now = row.getBoundingClientRect().height;
    if (Math.abs(from - now) < 1) return;
    row.style.overflow = "hidden";
    if (getComputedStyle(row).gridTemplateRows.trim().split(/\s+/).length === 1) row.style.gridTemplateRows = "minmax(0, 1fr)";
    const clear = () => { row.style.overflow = ""; row.style.gridTemplateRows = ""; };
    row.animate([{ height: from + "px" }, { height: now + "px" }], { duration: 250, easing: "ease-out" }).finished.then(clear, clear);
    setTimeout(clear, 400);
}

// A "Pick one" group after a redraw: its chosen row opens or closes when the pick goes from or to
// None, the level bar rolls (rollLevelBar) and the row eases to its new height when a switch from one
// enchantment to another changes it (a longer description, a second row of levels), the option that was
// chosen fades out of its highlight and the new one fades in, and the border changes color smoothly.
function animatePick(group, old) {
    if (!old || !motionOk()) return;
    const row = group.querySelector(":scope > .ench-row");
    if (row && !old.row) openRow(row);
    else if (!row && old.row) closeRow(group, old.row);
    else if (row && old.row && row.dataset.ns !== old.ns) easeRowHeight(row, old.height);
    const now = group.querySelector(".switch-option.selected"); // None is an option too, so there always is one
    if (now && now.dataset.focus !== old.selected) {
        const look = getComputedStyle(now);
        const quiet = { backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0), 0 1px 3px rgba(0, 0, 0, 0)" };
        const was = old.selected && group.querySelector(`[data-focus="${old.selected}"]`);
        if (was) was.animate([{ backgroundColor: look.backgroundColor, boxShadow: look.boxShadow, color: look.color }, {}], { duration: 260, easing: "ease-out" });
        now.animate([quiet, {}], { duration: 260, easing: "ease-out" });
    }
    if (getComputedStyle(group).borderColor !== old.border) group.animate([{ borderColor: old.border }, {}], { duration: 300, easing: "ease-out" });
}

// The element with focus inside `box' (by its data-focus), so a redraw can put the
// focus back where it was (the level bars and switches are rebuilt on every change).
export function focusState(box) {
    const active = document.activeElement;
    return active && box.contains(active) && active.dataset.focus ? active.dataset.focus : null;
}

export function restoreFocus(box, key) {
    const again = key && box.querySelector(`[data-focus="${key}"]`);
    if (again) again.focus({ preventScroll: true });
}

// The rows: single enchantments, "Pick one" switches, and brackets around enchantments
// that only partly conflict; curses last.
function wantedList() {
    // Chosen enchantments the custom books can't reach (none in automatic mode).
    const short = new Map(logic.checkBooks(state).short.map(s => [s.ns, s]));
    // The search box: only enchantments whose name or description has the typed text. A "Pick one" card stays
    // whole when any of its options match, a bracket keeps just the matching rows, and a mod's section opens.
    const query = plain(wanted_query);
    const matches = searchMatcher() || (() => true);
    const shown = group => {
        if (!query) return group;
        const hits = group.members.filter(matches);
        if (!hits.length) return null;
        if (group.exclusive && !state.allow_incompatible) return group;
        return { ...group, members: hits, exclusive: false };
    };
    // A bracket of two groups joined by an enchantment is "Pick one in each" (not while searching: a cut-down bracket may not be that shape).
    const eachOf = group => (state.allow_incompatible || query ? null : logic.pickEach(group.members));
    const groupRow = group => {
        const members = group.members;
        if (group.exclusive && !state.allow_incompatible) return groupSwitch(members, short);
        const each = eachOf(group);
        if (each) return pickEachSection(members, each, short);
        if (members.length === 1) return wantedRow(members[0], short.get(members[0]));
        // The label folds the bracket: the chosen rows stay, the rest hide (kept in `folded_groups` across redraws).
        const key = members[0];
        const folded = folded_groups.has(key) && !query;
        return h("div", { class: "ench-group" + (members.some(ns => state.wanted[ns]) ? " has-chosen" : "") + (folded ? " folded" : ""), "data-group": key },
            h("button", {
                type: "button", class: "ench-group-label group-toggle", "data-focus": "group-" + key, "aria-expanded": String(!folded),
                onclick: event => {
                    const folded = !folded_groups.has(key);
                    if (folded) folded_groups.add(key); else folded_groups.delete(key);
                    event.currentTarget.parentElement.classList.toggle("folded", folded);
                    event.currentTarget.setAttribute("aria-expanded", String(!folded));
                }
            }, (state.allow_incompatible ? TEXT.wanted.group_allowed : TEXT.wanted.group_some_conflict) + " (" + members.length + ")"),
            members.map(ns => wantedRow(ns, short.get(ns), true))
        );
    };
    // Alone first, then the "Pick one" cards, then the brackets of partial conflicts (each kind keeps its alphabetical order).
    const kind = group => (group.members.length === 1 ? 0 : (group.exclusive && !state.allow_incompatible) || eachOf(group) ? 1 : 2);
    const byKind = groups => [...groups].sort((a, b) => kind(a) - kind(b));
    const rows = [];
    const own = [];
    const curses = [];
    const mods = new Map(); // mod name -> its groups (those with none of the game's own enchantments)
    for (const whole of logic.enchantmentGroups(state.item)) {
        const group = shown(whole);
        if (!group) continue;
        const mod = logic.modOf(whole.members[0]);
        if (mod) {
            if (!mods.has(mod)) mods.set(mod, []);
            mods.get(mod).push(group);
        } else {
            (logic.isCurse(group.members[0]) ? curses : own).push(group);
        }
    }
    rows.push(...byKind(own).map(groupRow));
    if (curses.length) rows.push(h("div", { class: "divider" }, TEXT.wanted.curses), ...byKind(curses).map(groupRow));
    // A mod's own enchantments get a fold-away box of their own, beside the list's and the graph's, folded until opened (or one is chosen).
    const mod_boxes = [];
    for (const [mod, groups] of mods) {
        const count = groups.reduce((sum, group) => sum + group.members.length, 0);
        const chosen = groups.some(group => group.members.some(ns => state.wanted[ns]));
        mod_boxes.push(h("details", {
            class: "fold-box mod-section", "data-mod": mod, open: chosen || mod_open.has(mod) || Boolean(query),
            ontoggle: event => {
                if (wanted_query.trim()) return; // opened by the search, not by the user
                if (event.target.open) mod_open.add(mod); else mod_open.delete(mod);
            }
        },
            h("summary", {}, TEXT.wanted.mod_group({ name: mod, count })),
            byKind(groups).map(groupRow)));
    }
    if (query && !rows.length && !mod_boxes.length) rows.push(h("p", { class: "hint" }, TEXT.wanted.search_none));
    return { list: h("div", { class: "wanted-list" }, rows), mod_boxes };
}

// The list of enchantments, in a fold-away box like the conflict graph's (the two ways to pick enchantments, one under the other).
let list_open = true;
function listBox(list) {
    return h("details", { class: "fold-box list-box", open: list_open, ontoggle: event => { list_open = event.target.open; } },
        h("summary", {}, TEXT.wanted.list_title),
        list);
}

// What is typed in section 1's search box (kept across redraws and items), and the text without case or accents.
let wanted_query = "";
const plain = text => text.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// The test the search applies to an enchantment (its name or description has the typed text), or null with no search.
function searchMatcher() {
    const query = plain(wanted_query);
    return query ? ns => plain(logic.enchName(ns) + " " + logic.describe(ns)).includes(query) : null;
}

// The search box above the list. Typing redraws only the list (and marks the graph), so the box keeps its focus.
function wantedSearch() {
    return h("input", {
        type: "search", class: "wanted-search", value: wanted_query, placeholder: TEXT.wanted.search, "aria-label": TEXT.wanted.search, "data-focus": "wanted-search",
        oninput: event => {
            wanted_query = event.target.value;
            const { list, mod_boxes } = wantedList();
            document.querySelector("#wanted .wanted-list").replaceWith(list);
            for (const old of document.querySelectorAll("#wanted > .mod-section")) old.remove();
            document.querySelector("#wanted > .list-box").after(...mod_boxes);
            markSearch(searchMatcher());
            restoreConflicts();
        }
    });
}

// "Conflicts with N" chips on the rows of a conflict bracket. Hovering (or keyboard-focusing) a chip lights the rows it
// conflicts with and shows their names in a game tooltip (the first TIP_CAP, then "+N more"); clicking or tapping it keeps
// both until a click elsewhere, Escape, or a click on the chip again, as the page's other tooltips close.
const TIP_CAP = 8;
let conflict_tip = null;   // the tooltip on screen
let conflict_pin = null;   // the enchantment whose chip was clicked to keep its tooltip and highlights
let conflict_shown = null; // the enchantment whose tooltip is on screen

function conflictChip(ns, count) {
    return h("button", {
        type: "button", class: "conflict-chip" + (conflict_pin === ns ? " pinned" : ""), "data-conflicts": ns, "data-focus": "conflicts-" + ns,
        "aria-pressed": String(conflict_pin === ns),
        // Not by hover on touch, where a tap would leave it lit; the click pins it there.
        onmouseenter: event => { if (matchMedia("(hover: hover)").matches) showConflicts(event.currentTarget, ns); },
        onmouseleave: restoreConflicts,
        onfocus: event => { if (event.currentTarget.matches(":focus-visible")) showConflicts(event.currentTarget, ns); },
        onblur: restoreConflicts,
        onclick: event => {
            event.stopPropagation();
            conflict_pin = conflict_pin === ns ? null : ns;
            if (conflict_pin) showConflicts(event.currentTarget, ns); else hideConflicts();
            for (const chip of document.querySelectorAll("#wanted .conflict-chip")) {
                chip.classList.toggle("pinned", chip.dataset.conflicts === conflict_pin);
                chip.setAttribute("aria-pressed", String(chip.dataset.conflicts === conflict_pin));
            }
        }
    }, TEXT.wanted.conflicts_with({ count }));
}

function chipOf(ns) {
    return document.querySelector(`#wanted .conflict-chip[data-conflicts="${ns}"]`);
}

function showConflicts(chip, ns) {
    hideConflicts();
    const names = logic.conflictsWith(ns, state.item).map(logic.enchName);
    if (!names.length) return;
    conflict_shown = ns;
    chip.closest(".ench-row").classList.add("rival-self");
    for (const row of document.querySelectorAll("#wanted .ench-row[data-ns]")) if (logic.conflicts(ns, row.dataset.ns)) row.classList.add("rival");
    const shown = names.slice(0, TIP_CAP);
    if (names.length > TIP_CAP) shown.push(TEXT.wanted.conflicts_more({ count: names.length - TIP_CAP }));
    conflict_tip = h("div", { class: "mc-tooltip conflict-tip", role: "tooltip" }, TEXT.wanted.conflicts_title({ names: shown }));
    document.body.append(conflict_tip);
    placeConflictTip(chip);
}

// Under the chip, kept on screen (above it near the window's foot).
function placeConflictTip(chip) {
    const rect = chip.getBoundingClientRect();
    const tip = conflict_tip.getBoundingClientRect();
    const below = rect.bottom + 6 + tip.height <= innerHeight;
    conflict_tip.style.left = Math.max(8, Math.min(rect.left, innerWidth - tip.width - 8)) + "px";
    conflict_tip.style.top = (below ? rect.bottom + 6 : rect.top - 6 - tip.height) + "px";
}

function hideConflicts() {
    if (conflict_tip) conflict_tip.remove();
    conflict_tip = null;
    conflict_shown = null;
    for (const row of document.querySelectorAll("#wanted .rival, #wanted .rival-self")) row.classList.remove("rival", "rival-self");
}

// Back to what is kept (the pinned chip's tooltip and highlights, if its row is still there), after a pointer leaves a chip or a redraw.
function restoreConflicts() {
    hideConflicts();
    if (!conflict_pin) return;
    const chip = chipOf(conflict_pin);
    if (chip) showConflicts(chip, conflict_pin); else conflict_pin = null;
}

// A click elsewhere or Escape lets go of the pinned chip, like the "?" bubbles; the tooltip follows its chip on scroll.
export function setupConflictTips() {
    const release = () => {
        conflict_pin = null;
        hideConflicts();
        for (const chip of document.querySelectorAll("#wanted .conflict-chip")) { chip.classList.remove("pinned"); chip.setAttribute("aria-pressed", "false"); }
    };
    document.addEventListener("click", event => { if (conflict_pin && !event.target.closest(".conflict-chip")) release(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && (conflict_pin || conflict_shown)) release(); });
    const follow = () => {
        const chip = conflict_shown && chipOf(conflict_shown);
        if (chip && conflict_tip) placeConflictTip(chip); else if (conflict_tip) hideConflicts();
    };
    document.addEventListener("scroll", follow, { capture: true, passive: true });
    addEventListener("resize", follow);
}

// The conflict brackets the user folded (by their first enchantment), in this visit.
const folded_groups = new Set();

// The mods whose section the user opened (in this visit).
const mod_open = new Set();

// The top of section 1: the preview, with `controls` (the toolbar and presets) beside it
// where the card is wide enough, else under it.
function wantedHead(...controls) {
    return h("div", { class: "wanted-head" + (item_menu_open ? " menu-open" : "") },
        wantedPreview(),
        h("div", { class: "wanted-controls" }, controls),
        item_menu_open ? h("div", { class: "item-menu", id: "item-menu" }, itemGrid()) : null
    );
}

// The finished item as the game shows it: its slot, then a tooltip with its name (in
// italics once renamed) and the chosen enchantments in the game's order. The slot is
// the button for the item menu: the item grid in a panel under it (in the card's flow
// on phones), closed by picking, a click outside, or Escape.
function wantedPreview() {
    const chosen = Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level }));
    const node = { item_namespace: state.item, enchantments: chosen, renamed: true };
    const cell = anvilCell(node, null, "preview");
    // Enchantments just added fade in (not on a new item, which redraws it all).
    if (preview_shown.item === state.item) {
        const lines = cell.querySelectorAll(".mc-ench");
        logic.tooltipSort(chosen).forEach((e, index) => {
            if (!preview_shown.enchantments.has(e.namespace)) lines[index].classList.add("fresh");
        });
    }
    preview_shown = { item: state.item, enchantments: new Set(Object.keys(state.wanted)) };
    const slot = cell.querySelector(".mc-slot");
    const button = h("button", {
        type: "button", class: "item-menu-button", "data-focus": "item-menu",
        "aria-haspopup": "true", "aria-expanded": String(item_menu_open), "aria-controls": "item-menu",
        "aria-label": TEXT.wanted.change_item_label({ item: logic.itemName(state.item) }),
        title: TEXT.wanted.change_item,
        onclick: toggleItemMenu
    });
    slot.replaceWith(button);
    button.append(slot, h("span", { class: "item-menu-caret", "aria-hidden": "true" }, "▾"));
    cell.querySelector(".mc-tooltip").append(costLine());
    return h("div", { class: "wanted-preview", role: "group", "aria-label": TEXT.wanted.preview_label }, cell);
}

// The last line of the preview's tooltip: an XP orb and the anvil levels of the best order for the books
// you have ("12 Levels"; from the last calculation, dimmed while a new one runs, folded away when there
// is none). Results.js calls updateCostMeter whenever the results change; the line opens, closes and
// changes its words smoothly.
let meter_levels = null;
let meter_none = false; // the last search found no order at all (too expensive)

function costLine() {
    const line = h("div", { class: "cost-line", title: TEXT.wanted.cost_meter_help },
        h("img", { class: "cost-line-orb", src: "img/experience_orb.svg", alt: "" }),
        h("span", { class: "cost-line-text" }));
    fillCostMeter(line);
    return line;
}

function fillCostMeter(line) {
    const before = line.getBoundingClientRect().height;
    const tooltip = line.closest(".mc-tooltip");
    const width_before = tooltip ? tooltip.getBoundingClientRect().width : null;
    line.classList.toggle("stale", running);
    // Nothing chosen means nothing to cost: the line goes at once, not when the new search finishes.
    const nothing = Object.keys(state.wanted).length === 0;
    line.classList.toggle("idle", nothing || meter_levels == null && !meter_none);
    line.classList.toggle("none", !nothing && meter_levels == null && meter_none);
    const text = line.querySelector(".cost-line-text");
    const words = nothing ? "" : meter_levels != null ? TEXT.wanted.cost_meter({ levels: meter_levels }) : meter_none ? TEXT.wanted.cost_meter_none : "";
    const changed = text.textContent !== words;
    text.textContent = words;
    if (!line.isConnected || !motionOk()) return;
    slideWidth(tooltip, width_before); // the words can make the tooltip wider or narrower
    // New words fade in instead of popping.
    if (changed && words) text.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
    // The line opens when a result arrives and folds away when there is none, so the tooltip eases to its new height.
    const after = line.getBoundingClientRect().height;
    if (Math.abs(after - before) < 1) return;
    line.style.overflow = "hidden";
    const clear = () => { line.style.overflow = ""; };
    line.animate([{ height: before + "px", opacity: before ? 1 : 0 }, { height: after + "px", opacity: after ? 1 : 0 }], { duration: 250, easing: "ease-out" }).finished.then(clear, clear);
    setTimeout(clear, 400);
}

export function updateCostMeter() {
    const ok = last_result && last_result.status === "ok";
    if (ok && last_result.node) { meter_levels = last_result.node.cumulative_levels; meter_none = false; }
    else if (!running) { meter_levels = null; meter_none = Boolean(ok); }
    const line = document.querySelector("#wanted .cost-line");
    if (line) fillCostMeter(line);
}

// Opens or closes the item menu (the slot's button).
function toggleItemMenu() {
    setItemMenuOpen(!item_menu_open);
    renderWanted();
    if (item_menu_open) {
        const current = document.querySelector(`#items [data-focus="item-${state.item}"]`);
        if (current) current.focus({ preventScroll: true });
    }
}

// The item menu closes on a click outside it (or its button) and on Escape, which puts
// the focus back on the slot.
export function setupItemMenu() {
    document.addEventListener("click", event => {
        if (!item_menu_open) return;
        const path = event.composedPath();
        if (path.some(el => el.classList && (el.classList.contains("item-menu") || el.classList.contains("item-menu-button")))) return;
        setItemMenuOpen(false);
        renderWanted();
    });
    document.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !item_menu_open) return;
        setItemMenuOpen(false);
        renderWanted();
        const button = document.querySelector(".item-menu-button");
        if (button) button.focus();
    });
}

// "Presets: Best · Silk Touch": each sets the chosen enchantments to a whole set (Logic.js
// presets); the one matching the current choice is highlighted. When the item has only
// one set of conflicting enchantments, "Best" is named after its pick from that set
// ("Fortune · Silk Touch", "Channeling + Loyalty · Riptide").
function presetChips() {
    const presets = logic.presets(state.item, state.allow_incompatible);
    if (!presets.length) return null;
    // Only the game's own enchantments count, so a mod being on never renames "God" (its conflicts add sets and link them).
    const conflict_sets = logic.enchantmentGroups(state.item, true).filter(group => group.members.length > 1);
    const bestName = wanted => {
        if (state.allow_incompatible || conflict_sets.length !== 1) return TEXT.wanted.preset_best;
        const picks = conflict_sets[0].members.filter(ns => wanted[ns]);
        return picks.length ? picks.map(ns => logic.enchName(ns)).join(" + ") : TEXT.wanted.preset_best;
    };
    const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(ns => a[ns] === b[ns]);
    // Hovering (or focusing) a preset shows what it would change, as a game tooltip: + for
    // what it adds or raises, - for what it takes away.
    let compare = null;
    const hideCompare = () => { if (compare) { compare.remove(); compare = null; } };
    const showCompare = (chip, wanted) => {
        hideCompare();
        if (matchMedia("(hover: none)").matches) return;
        const lines = [];
        for (const { namespace: ns, level } of logic.tooltipSort(Object.entries(wanted).map(([namespace, level]) => ({ namespace, level })))) {
            const changed = state.wanted[ns] !== level;
            lines.push(h("div", { class: "mc-ench" + (logic.isCurse(ns) ? " curse" : "") + (changed ? " changed" : "") }, logic.displayName(ns, level)));
        }
        for (const [ns, level] of Object.entries(state.wanted)) {
            if (!wanted[ns]) lines.push(h("div", { class: "mc-ench removed" }, logic.displayName(ns, level)));
        }
        if (!lines.some(line => line.classList.contains("changed") || line.classList.contains("removed"))) lines.splice(0, lines.length, h("div", { class: "mc-ench" }, TEXT.wanted.compare_same));
        compare = h("div", { class: "mc-tooltip compare-tip", "aria-hidden": "true" },
            h("div", { class: "mc-name rarity-common" }, logic.itemName(state.item)), lines);
        const box = chip.closest(".presets");
        box.append(compare);
        compare.style.top = chip.offsetTop + chip.offsetHeight + 4 + "px";
        compare.style.left = Math.max(0, Math.min(chip.offsetLeft, box.clientWidth - compare.offsetWidth)) + "px";
    };
    const hover = wanted => ({
        onmouseenter: event => showCompare(event.currentTarget, wanted), onmouseleave: hideCompare,
        onfocus: event => showCompare(event.currentTarget, wanted), onblur: hideCompare
    });
    return h("div", { class: "presets", role: "group", "aria-label": TEXT.wanted.presets },
        h("div", { class: "presets-label" }, TEXT.wanted.presets),
        h("div", { class: "preset-chips" },
            // "Plain": nothing chosen, the unenchanted item (this is how to clear everything).
            h("button", {
                type: "button", class: "preset" + (Object.keys(state.wanted).length === 0 ? " selected" : ""),
                "aria-pressed": String(Object.keys(state.wanted).length === 0), "data-focus": "preset-plain",
                title: TEXT.wanted.preset_plain_help, ...hover({}),
                onclick: () => { state.wanted = {}; commit(); }
            }, TEXT.wanted.preset_plain),
            presets.map(preset => {
                const selected = same(preset.wanted, state.wanted);
                const best = preset.key === "best";
                return h("button", {
                    type: "button", class: "preset" + (selected ? " selected" : ""), "aria-pressed": String(selected),
                    "data-focus": "preset-" + preset.key,
                    title: best ? TEXT.wanted.preset_best_help : TEXT.wanted.preset_swap_help({ name: logic.enchName(preset.key) }),
                    ...hover(preset.wanted),
                    onclick: () => { state.wanted = { ...preset.wanted }; commit(); }
                }, best ? bestName(preset.wanted) : logic.enchName(preset.key));
            }))
    );
}

// "Pick one in each": a conflict bracket of two groups joined by an enchantment (Logic pickEach) as one card holding a "Pick one"
// switch for each group, then the chosen rows once. The joining enchantment is an option of every group it joins (marked with an
// arrow pair) and replaces the picks of all of them; any other pick leaves the other groups alone.
function pickEachSection(members, each, short) {
    const chosen = ns => Boolean(state.wanted[ns]);
    const label_id = "pick-each-" + members[0];
    const names = list => list.map(ns => logic.enchName(ns));
    const cards = each.cards.map((set, index) => {
        const own = set.filter(ns => !each.bridges.has(ns));
        const title = TEXT.wanted.group_one_of({ names: names(own).slice(0, 3).join(", ") + (own.length > 3 ? "\u2026" : "") });
        const option = (ns, label) => {
            const selected = ns ? chosen(ns) : !set.some(chosen);
            return h("button", {
                type: "button", role: "radio", class: "switch-option" + (ns && each.bridges.has(ns) ? " bridge" : "") + (selected ? " selected" : ""),
                "aria-checked": String(selected), "data-opt": index + "|" + (ns || "none"),
                "data-focus": "each-" + members[0] + "-" + index + "-" + (ns || "none"),
                // The joining enchantment's hover text: its name with the arrow pair, what it does, and that it is in every group it joins.
                title: ns ? (each.bridges.has(ns) ? [logic.enchName(ns) + " ⇄", logic.describe(ns), TEXT.wanted.group_bridge_help].filter(Boolean).join(" ") : logic.describe(ns)) || null : null,
                onclick: () => {
                    if (ns) { if (!chosen(ns)) setWanted(ns, logic.maxLevel(ns)); return; } // (drops the ones it replaces)
                    const pick = set.find(chosen);
                    if (pick) setWanted(pick, 0);
                }
            }, label);
        };
        return h("div", { class: "each-card" },
            own.length > 1 ? h("div", { class: "each-card-title" }, title) : null, // (a group of one is named by its option)
            h("div", { class: "group-switch", role: "radiogroup", "aria-label": title },
                option(null, TEXT.wanted.none), set.map(ns => option(ns, logic.enchName(ns)))));
    });
    return h("div", { class: "ench-group exclusive pick-each" + (members.some(chosen) ? " has-chosen" : ""), "data-each": members[0] },
        h("div", { class: "ench-group-label", id: label_id }, TEXT.wanted.group_pick_each),
        h("div", { class: "each-cards" }, cards),
        h("div", { class: "each-rows" }, members.filter(chosen).map(ns => wantedRow(ns, short.get(ns)))));
}

// What a "Pick one in each" section looks like before a redraw, by its first member: its chosen rows in order (a copy to fold
// away, the height, the level bar), the options selected, and the border colour.
function captureEach(box) {
    const old = new Map();
    for (const section of box.querySelectorAll(".pick-each[data-each]")) {
        old.set(section.dataset.each, {
            rows: [...section.querySelectorAll(".each-rows > .ench-row")].map(row => ({
                ns: row.dataset.ns, copy: inertCopy(row), height: row.getBoundingClientRect().height,
                levels: row.querySelectorAll(".level-seg").length, segments: [...row.querySelectorAll(".level-seg")].map(seg => seg.cloneNode(true))
            })),
            options: new Set([...section.querySelectorAll(".switch-option.selected")].map(button => button.dataset.opt)),
            border: getComputedStyle(section).borderColor
        });
    }
    return old;
}

// The same animations as a "Pick one" group, for each case. When the number of chosen enchantments stays the same and nothing
// moves (each new row sits where the one it replaces was): the level bar rolls and the row eases to its height. Otherwise a new
// row opens in its place and a row that goes folds away as a copy where it was. The option that was selected fades out of its
// highlight while the new one fades in, and the border changes colour smoothly.
function animateEach(section, old) {
    if (!old || !motionOk()) return;
    const rows_box = section.querySelector(".each-rows");
    const rows = [...rows_box.children];
    const names = rows.map(row => row.dataset.ns);
    const before = old.rows.map(row => row.ns);
    const added = names.filter(ns => !before.includes(ns));
    const gone = old.rows.filter(row => !names.includes(row.ns));
    const source_of = new Map();
    for (const ns of added) {
        const source = gone.find(row => ![...source_of.values()].includes(row) && logic.conflicts(ns, row.ns));
        if (source) source_of.set(ns, source);
    }
    const replaced = new Map([...source_of].map(([ns, source]) => [source.ns, ns]));
    const in_place = added.length === gone.length && source_of.size === added.length && before.map(ns => replaced.get(ns) || ns).join() === names.join();
    for (const ns of added) {
        const row = rows_box.querySelector(`[data-ns="${ns}"]`);
        const source = source_of.get(ns);
        if (source && in_place) {
            rollLevelBar(row.querySelector(".level-bar"), source.levels, source.segments);
            easeRowHeight(row, source.height);
        } else {
            openRow(row);
        }
    }
    for (const row of gone) {
        if (in_place && replaced.has(row.ns)) continue;
        closeRow(rows_box, row.copy); // (it appends the copy)
        // ...but it folds where it was: before the first row that stays and came after it, or the rows below would jump up.
        const after = rows.find(other => before.includes(other.dataset.ns) && before.indexOf(other.dataset.ns) > before.indexOf(row.ns));
        if (after) rows_box.insertBefore(row.copy, after);
    }
    const selected = [...section.querySelectorAll(".switch-option.selected")];
    const keys = new Set(selected.map(button => button.dataset.opt));
    const look = selected[0] && getComputedStyle(selected[0]);
    const quiet = { backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0), 0 1px 3px rgba(0, 0, 0, 0)" };
    for (const button of selected) if (!old.options.has(button.dataset.opt)) button.animate([quiet, {}], { duration: 260, easing: "ease-out" });
    if (look) {
        for (const key of old.options) {
            const was = keys.has(key) ? null : section.querySelector(`[data-opt="${key}"]`);
            if (was) was.animate([{ backgroundColor: look.backgroundColor, boxShadow: look.boxShadow, color: look.color }, {}], { duration: 260, easing: "ease-out" });
        }
    }
    if (getComputedStyle(section).borderColor !== old.border) section.animate([{ borderColor: old.border }, {}], { duration: 300, easing: "ease-out" });
}

// A "Pick one" group (every pair conflicts): a switch for which one, or none, then the
// chosen one's row with its level bar. Switching picks the new one at its max level.
function groupSwitch(members, short) {
    const chosen = members.find(ns => state.wanted[ns]) || null;
    const label_id = "pick-" + members[0];
    const option = (ns, label) => h("button", {
        type: "button", role: "radio", class: "switch-option" + (chosen === ns ? " selected" : ""),
        "aria-checked": String(chosen === ns), "data-focus": "switch-" + members[0] + "-" + (ns || "none"),
        title: ns ? logic.describe(ns) || null : null,
        onclick: () => {
            if (chosen === ns) return;
            if (ns) setWanted(ns, logic.maxLevel(ns)); // drops the one it replaces
            else setWanted(chosen, 0);
        }
    }, label);
    return h("div", { class: "ench-group exclusive" + (chosen ? " has-chosen" : ""), "data-group": members[0] },
        h("div", { class: "ench-group-label", id: label_id }, TEXT.wanted.group_pick_one),
        h("div", { class: "group-switch", role: "radiogroup", "aria-labelledby": label_id },
            option(null, TEXT.wanted.none),
            members.map(ns => option(ns, logic.enchName(ns)))
        ),
        chosen ? wantedRow(chosen, short.get(chosen)) : null
    );
}

// One enchantment: its name (tap or hover for what it does), the rough cost once chosen,
// and its level bar. One that conflicts with a chosen enchantment is dimmed, and choosing
// it replaces that one.
// `short`: { best } when the custom books can't reach this chosen level.
function wantedRow(ns, short = null, chip = false) {
    const chosen = state.wanted[ns] || 0;
    // Choosing it replaces every chosen enchantment it conflicts with (the note names them all).
    const blockers = chosen ? [] : Object.keys(state.wanted).filter(other => clashes(other, ns));
    const blocker = blockers[0];
    const name = logic.enchName(ns);
    const help = logic.describe(ns);
    const cost = chosen ? logic.bookCost(ns, chosen) : 0;
    const replaces = blocker ? TEXT.wanted.replaces({ name: blockers.map(logic.enchName) }) : null;

    // In a conflict bracket: a chip with how many it conflicts with (hover it for which).
    const rivals = chip ? logic.conflictsWith(ns, state.item).length : 0;
    return h("div", { "data-ns": ns, class: "ench-row" + (blocker ? " conflict" : "") + (chosen ? " chosen" : "") + (logic.isCurse(ns) ? " curse" : "") },
        // Columns (CSS grid, so every row lines up): the name with what it does under it,
        // the cost once chosen, the level bar, and a × that clears it.
        h("div", { class: "ench-name" },
            // A small enchanted book that glints once the enchantment is chosen.
            h("span", { class: "ench-book" + (chosen ? " lit" : ""), "aria-hidden": "true" }, h("img", { src: "img/book.svg", alt: "" })),
            h("span", { class: "ench-title" },
                name,
                blocker ? h("span", { class: "replaces-mark", title: replaces }, replaces) : null,
                short ? h("span", { class: "short-mark", title: TEXT.wanted.short_help },
                    short.best ? TEXT.wanted.books_reach({ level: roman(short.best) }) : TEXT.wanted.not_on_books) : null,
                rivals ? conflictChip(ns, rivals) : null
            ),
            help ? h("span", { class: "ench-desc", title: help }, help) : null
        ),
        h("span", { class: "ench-cost-col" },
            chosen ? h("span", { class: "anvil-cost ench-cost", title: TEXT.wanted.cost_help({ levels: cost }) }, TEXT.wanted.cost({ levels: cost })) : null),
        levelBar(ns, chosen, blocker),
        chosen ? h("button", {
            type: "button", class: "ench-clear", "data-focus": "clear-" + ns,
            title: TEXT.wanted.clear_one({ name }), "aria-label": TEXT.wanted.clear_one({ name }),
            onclick: () => setWanted(ns, 0)
        }, "×") : h("span", { class: "ench-clear-slot" })
    );
}

// The levels as one bar of joined segments (I up to the max) that fill up to the chosen
// level: tap a segment to choose it (the chosen one again clears it), drag across them
// (off the left end clears), or use the arrow keys, Home/End and digits. Every bar is as
// wide as five segments with its own from the left, so the I segments share a column.
// `onChoose(level)` defaults to section 1's choice; `focus` is the data-focus prefix.
export function levelBar(ns, chosen, blocker, onChoose = level => setWanted(ns, level), focus = "bar-") {
    const max = logic.maxLevel(ns);
    const segments = [];
    for (let level = 1; level <= max; level++) segments.push(h("span", { class: "level-seg", "data-level": level }, roman(level)));
    const bar = h("div", {
        class: "level-bar", role: "slider", tabindex: "0", "data-focus": focus + ns,
        "aria-label": TEXT.wanted.level_label({ name: logic.enchName(ns) }),
        "aria-valuemin": "0", "aria-valuemax": String(max),
        title: blocker ? TEXT.wanted.replaces({ name: logic.enchName(blocker) }) : null,
        // Five levels to a row: a longer bar (Dullness goes to X) wraps onto more rows.
        style: `--rows: ${Math.ceil(max / 5)}`
    }, segments,
    // The levels this enchantment doesn't have in its last row: a faint empty track, so every bar is the same width.
    Array.from({ length: Math.ceil(max / 5) * 5 - max }, () => h("span", { class: "level-gap", "aria-hidden": "true" })));

    const show = level => {
        bar.setAttribute("aria-valuenow", String(level));
        bar.setAttribute("aria-valuetext", level ? logic.displayName(ns, level) : TEXT.wanted.level_none);
        for (const seg of segments) seg.classList.toggle("filled", Number(seg.dataset.level) <= level);
    };
    show(chosen);
    const choose = level => { if (level !== chosen) onChoose(level); };

    bar.addEventListener("keydown", event => {
        // Up and down pick another enchantment (the neighbouring bar); left and right change the level.
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            const bars = [...(bar.closest(".entry-popover, #wanted") || document).querySelectorAll(".level-bar")];
            const next = bars[bars.indexOf(bar) + (event.key === "ArrowUp" ? -1 : 1)];
            event.preventDefault();
            if (next) {
                next.focus({ preventScroll: true });
                next.scrollIntoView({ block: "nearest", behavior: motionOk() ? "smooth" : "auto" });
            }
            return;
        }
        const keys = { ArrowRight: chosen + 1, ArrowLeft: chosen - 1, Home: 0, End: max, Delete: 0, Backspace: 0 };
        let level = keys[event.key];
        if (level == null && /^[0-9]$/.test(event.key)) level = Number(event.key);
        if (level == null) return;
        event.preventDefault();
        choose(Math.max(0, Math.min(max, level)));
    });

    // The level under the pointer, by position, so a drag also works over the gaps. The row is picked by height,
    // then the last level in it that starts at or before the pointer.
    const levelAt = (x, y) => {
        const rects = segments.map(seg => seg.getBoundingClientRect());
        if (x < rects[0].left - 8) return 0;
        const rows = Math.ceil(max / 5);
        const top = bar.getBoundingClientRect().top;
        const row = Math.max(0, Math.min(rows - 1, Math.floor((y - top) / rects[0].height)));
        let level = row * 5 + 1;
        for (let index = row * 5; index < Math.min(max, row * 5 + 5); index++) if (x >= rects[index].left) level = index + 1;
        return level;
    };
    // The bar fills as the pointer moves and the choice is made on release (a redraw
    // mid-drag would end it). Vertical swipes still scroll the page (touch-action: pan-y).
    let drag = null;
    bar.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        const level = levelAt(event.clientX, event.clientY);
        drag = { id: event.pointerId, start: level, level, moved: false };
        try {
            bar.setPointerCapture(event.pointerId);
        } catch {
            // Some browsers refuse capture for synthetic pointers; moves over the bar still work.
        }
        bar.classList.add("dragging");
        show(level);
    });
    bar.addEventListener("pointermove", event => {
        if (!drag || event.pointerId !== drag.id) return;
        const level = levelAt(event.clientX, event.clientY);
        if (level !== drag.level) {
            drag.level = level;
            drag.moved = true;
            show(level);
        }
    });
    bar.addEventListener("pointerup", event => {
        if (!drag || event.pointerId !== drag.id) return;
        const { start, level, moved } = drag;
        drag = null;
        bar.classList.remove("dragging");
        choose(!moved && start === chosen ? 0 : level);
    });
    bar.addEventListener("pointercancel", () => {
        drag = null;
        bar.classList.remove("dragging");
        show(chosen);
    });
    return bar;
}
