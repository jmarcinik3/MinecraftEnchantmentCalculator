// Section 1: the item and the enchantments it should end up with.
import { EDITIONS, roman } from "./Logic.js";
import { TEXT, localeOf } from "./Text.js";
import { conflicts_toggled, item_menu_open, language, logic, setConflictsToggled, setItemMenuOpen, state } from "./Store.js";
import { $, closeOnOutside, enchLine, h, icon, motionOk, nameClass, plain, readStorage, roving, scrollToView, scrubber, writeStorage } from "./Dom.js";
import { last_result, running } from "./Calc.js";
import { changeLines, closeRow, easeHeight, foldClick, foldDetails, foldTarget, growSmoothly, inertCopy, openRow, rollLevelBar, slideWidth, snapshotLines } from "./Motion.js";
import { anvilCell, foldIcon } from "./Results.js";
import { nameField } from "./Options.js";
import { floatBubble, infoTip } from "./Tips.js";
import { conflictGraph, markGraphSearch } from "./Graph.js";
import { applySetup, clashes, commit, defaultSetupName, deleteSetup, loadSavedMods, MAX_SETUP_NAME, openSection, readSaved, resetEverything, saveSetup, selectItem, setEdition, setupFit, setWanted, tryExample } from "./App.js";

// What section 1's preview showed last, so a redraw can grow it smoothly and fade in
// the enchantments that are new.
let preview_shown = { item: null, enchantments: new Set() };
// Keeps an item button's tooltip inside the window: it sits centred under the button, shifted
// (--tip-shift) just far enough when that would pass the window's edge.
const TIP_MARGIN = 6;
function placeTip(button) {
    const tip = button.querySelector(".item-tip");
    if (!tip) return;
    tip.style.setProperty("--tip-shift", "0px");
    tip.style.display = "block"; // measured while shown (CSS shows it on hover or focus too)
    const box = tip.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    let shift = 0;
    if (box.left < TIP_MARGIN) shift = TIP_MARGIN - box.left;
    else if (box.right > width - TIP_MARGIN) shift = width - TIP_MARGIN - box.right;
    tip.style.display = "";
    tip.style.setProperty("--tip-shift", shift + "px");
}

// Every item that can be enchanted, as a grid of buttons.
function itemGrid() {
    return h("div", { class: "item-grid", id: "items" }, logic.enchantableItems().map(item => h("button", {
        type: "button",
        class: "item-button" + (state.item === item ? " selected" : ""),
        "aria-pressed": String(state.item === item),
        "data-focus": "item-" + item,
        onclick: () => selectItem(item),
        onpointerenter: event => placeTip(event.currentTarget),
        onfocus: event => placeTip(event.currentTarget)
    },
        h("span", { class: "mc-slot item-slot" }, icon(item)),
        logic.itemName(item),
        // The game's tooltip on hover or focus: the item and how many enchantments it takes.
        h("span", { class: "item-tip mc-tooltip", "aria-hidden": "true" },
            h("span", { class: nameClass("common") }, logic.itemName(item)),
            h("span", { class: "mc-ench" }, TEXT.wanted.item_takes({ count: logic.applicable(item).length }))
        )
    )));
}

// The item (not a section): a floating card beside the sections on wide windows, a sticky bar over them on narrow ones (condensed to one line once
// the page has scrolled). The preview of the finished item (its slot opens the item menu) and the presets; hidden until an item is picked, and
// the item grid is section 1's until then.
export function renderItem() {
    const dock = $("#item-dock");
    const box = $("#item");
    document.querySelector(".layout").classList.toggle("has-item", Boolean(state.item));
    dock.hidden = !state.item;
    const focus = focusState(box);
    requestAnimationFrame(() => syncDock()); // once the card is drawn, so the height it keeps is the full card's
    const old_preview = box.querySelector(".wanted-preview");
    const old_height = old_preview && preview_shown.item === state.item ? old_preview.getBoundingClientRect().height : null;
    // The cost line of the preview's tooltip, so it can fold away in place if the redraw drops it.
    const old_cost_line = box.querySelector(".wanted-preview .cost-line:not(.idle)");
    const old_cost_copy = old_cost_line ? inertCopy(old_cost_line) : null;
    // The preview's tooltip lines, to fade out the ones about to go (closeLines).
    const old_tip = old_height != null ? old_preview.querySelector(".mc-tooltip") : null;
    const old_tip_rect = old_tip ? old_tip.getBoundingClientRect() : null;
    const old_width = old_tip_rect ? old_tip_rect.width : null;
    const old_lines = old_tip ? snapshotLines(old_tip).lines : [];
    box.replaceChildren();
    $("#presets-menu > summary")?.classList.remove("active"); // (presetChips lights the header's star again if a preset is the setup on screen)
    for (const tip of document.querySelectorAll("body > .compare-tip")) tip.remove(); // (a preset's tooltip lives on the page, not in the card)
    if (!state.item) return;
    // Section 1, with its number like the others (it has no collapse arrow, and is one line in the condensed bar).
    box.append(h("h2", { class: "item-heading", "aria-labelledby": "item-title item-state" }, h("span", { class: "step-badge done", "aria-hidden": "true" }, "✓"), h("span", { class: "sr-only", id: "item-state" }, TEXT.page.badge_done), h("span", { class: "section-title", id: "item-title" }, TEXT.page.item_heading)),
        wantedHead(presetChips()),
        h("div", { class: "item-foot" }, h("button", { type: "button", class: "btn small reset-button", title: TEXT.page.reset_help, onclick: resetEverything }, h("span", { class: "reset-label" }, TEXT.page.reset), restartIcon()),
            h("button", { type: "button", class: "mini-steps foot-steps", title: TEXT.wanted.item_mini_steps_help, "aria-label": TEXT.wanted.item_mini_steps_help, onclick: goToSteps }, TEXT.wanted.item_mini_steps)),
        itemMini());
    if (old_height != null) {
        const preview = box.querySelector(".wanted-preview");
        const same_size = Math.abs(preview.getBoundingClientRect().height - old_height) < 1; // before it slides
        growSmoothly(preview, old_height);
        // Heights: the preview box can be held taller than the tooltip by the controls beside it,
        // so the tooltip's own height is what is compared and slid in a swap.
        slideWidth(preview.querySelector(".mc-tooltip"), old_width, same_size && old_tip_rect ? old_tip_rect.height : null);
        changeLines(preview, old_lines, preview.querySelectorAll(".mc-ench.fresh"), same_size);
    }
    const new_cost_line = box.querySelector(".wanted-preview .cost-line");
    if (old_cost_copy && new_cost_line && new_cost_line.classList.contains("idle")) closeRow(new_cost_line.parentElement, old_cost_copy);
    restoreFocus(box, focus);
}

// Until an item is picked this section is the item picker, so it is "1 Item"; then the item has its own card (1) and this is
// "2 Enchantments". The heading's data-text changes too, so a language switch fills in the right title.
function sectionHeading() {
    const card = document.querySelector('[data-section="wanted"]');
    const key = state.item ? "enchantments_heading" : "item_heading";
    const title = card.querySelector("#wanted-title");
    title.dataset.text = "page." + key;
    title.textContent = TEXT.page[key];
}

// The restart arrow (Start over).
function restartIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "reset-icon"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    for (const d of ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5"]) { const path = document.createElementNS(ns, "path"); path.setAttribute("d", d); svg.append(path); }
    return svg;
}

// Down to the steps (Anvil uses), opening the section if it is closed: the card's foot and the condensed bar both have the button.
function goToSteps() {
    openSection("steps");
    reserveDock(); // from the tall card the bar is not there yet: the scroll's target keeps clear of the bar it will end under
    scrollToView(document.querySelector('[data-section="steps"]'), "start");
}

// The one-line form of the item shown in the sticky bar once the page has scrolled (narrow windows): its slot, name and enchantments, and the cost;
// clicking it goes back to the top.
function itemMini() {
    const chosen = Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level }));
    // A tap (or Enter/Space) on the bar scrolls back to the top of the page.
    const top = () => window.scrollTo({ top: 0, behavior: motionOk() ? "smooth" : "auto" });
    const restart = h("button", {
        type: "button", class: "mini-reset", title: TEXT.page.reset_help, "aria-label": TEXT.page.reset,
        onclick: event => { event.stopPropagation(); resetEverything(); },
        onkeydown: event => event.stopPropagation()
    }, restartIcon());
    return h("div", { class: "item-mini-row" }, restart, h("div", {
        class: "item-mini", role: "button", tabindex: "0", title: TEXT.wanted.item_mini_top, "aria-label": TEXT.wanted.item_mini_top,
        onclick: top,
        onkeydown: event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); top(); } }
    },
        h("span", { class: "mc-slot" + (chosen.length ? " glint" : "") }, icon(state.item)),
        h("div", { class: "mini-text" },
            h("div", { class: nameClass(logic.rarity(state.item, chosen.length > 0), " mini-name") }, logic.itemName(state.item)), // in its rarity colour, as in the tooltip
            // One span per enchantment, so each can be met by its tooltip line in the morph (setupItemDock).
            h("div", { class: "mini-list" }, chosen.length ? logic.tooltipSort(chosen).flatMap((e, i) => [
                i ? h("span", { class: "mini-sep" }, ", ") : null,
                h("span", { class: "mini-ench" + (logic.isCurse(e.namespace) ? " curse" : ""), "data-ns": e.namespace }, logic.displayName(e.namespace, e.level))
            ]) : TEXT.wanted.item_mini_none)),
        costLine()),
        // Down to the steps (Anvil uses), from anywhere on the page.
        h("button", {
            type: "button", class: "mini-steps", title: TEXT.wanted.item_mini_steps_help, "aria-label": TEXT.wanted.item_mini_steps_help,
            onclick: event => { event.stopPropagation(); goToSteps(); },
            onkeydown: event => event.stopPropagation()
        }, TEXT.wanted.item_mini_steps));
}

// Narrow windows: the card morphs into the one-line bar as the page scrolls past the top of the sections (a sentinel there), over DOCK_RANGE px, following the
// scroll: the slot travels and shrinks to the bar's slot, the tooltip's name and cost travel toward the bar's while the rest of the card fades out over the first
// half, the bar's parts fade in over the second, and the card's box shrinks to the bar's (`.morphing`: `--morph-h`, a clip on the dock). Only transforms,
// opacity and that clip change per frame. The dock keeps the full card's height throughout (clicks pass through its empty part), so the page's length never
// changes with the scroll. The shown progress chases the scroll's (time constant DOCK_FOLLOW_MS), so a wheel's jumps glide, eased in and out (smoothstep).
// Without motion the bar switches at half way. The results column and the browser's scrolling keep clear of the bar (`--dock-h`, `scroll-padding-top`).
const DOCK_RANGE = 160;
const DOCK_FOLLOW_MS = 90;
let syncDock = () => {};
let reserveDock = () => {};
export function setupItemDock() {
    const layout = document.querySelector(".layout");
    const dock = $("#item-dock");
    const root = document.documentElement;
    const sentinel = h("div", { class: "dock-sentinel", "aria-hidden": "true" });
    layout.prepend(sentinel);
    const narrow = matchMedia("(max-width: 1359px)");
    let geo = null, shown = 0, following = false, last_frame = 0;
    const past = () => -sentinel.getBoundingClientRect().top;
    const target = () => {
        const p = Math.min(1, Math.max(0, past() / DOCK_RANGE));
        return motionOk() ? p : (p >= 0.5 ? 1 : 0);
    };
    const parts = () => {
        const item = $("#item");
        return {
            item,
            slot: item.querySelector(".wanted-preview .item-menu-button"), // the slot with its menu caret, which fades
            name: item.querySelector(".wanted-preview .mc-name"),
            cost: item.querySelector(".wanted-preview .cost-line:not(.idle)"),
            row: item.querySelector(".item-mini-row"),
            mini_slot: item.querySelector(".item-mini .mc-slot"),
            mini_name: item.querySelector(".item-mini .mini-name"),
            mini_cost: item.querySelector(".item-mini .cost-line"),
            reset: item.querySelector(".item-foot .reset-button"),
            reset_label: item.querySelector(".item-foot .reset-label"),
            mini_reset: item.querySelector(".mini-reset"),
            steps: item.querySelector(".foot-steps"),
            mini_steps: item.querySelector(".item-mini-row > .mini-steps"),
            fade_out: [...item.querySelectorAll(":scope > .item-heading, .anvil-name, .wanted-controls, .wanted-preview .mc-tooltip, .item-menu-caret")],
            fade_in: [...item.querySelectorAll(".mini-list")]
        };
    };
    const styled = P => [P.slot, P.name, P.cost, P.mini_slot, P.mini_name, P.mini_cost, P.reset, P.reset_label, P.mini_reset, P.steps, P.mini_steps, ...P.fade_out, ...P.fade_in].filter(Boolean);
    // Start over and Steps morph their box: two frames (each button's look) share one box that eases from the full button's place and size to the bar's,
    // crossfading, while the two buttons' contents (their own box hidden, `.morph-travel`) ride its centre and crossfade too.
    let frames = null;
    // The item's name and the cost travel as one copy each (laid over the card, since their tooltip fades): from their place in the tooltip to the bar's,
    // their size following (a scale from one font size to the other); the originals hide meanwhile and the bar's show at the end.
    let flyers = null;
    const makeFlyers = P => {
        flyers = [];
        // The tooltip's box, between the tall card's and the bar's.
        const tip = P.item.querySelector(".wanted-preview .mc-tooltip"), mini_tip = P.item.querySelector(".item-mini .mini-text");
        if (tip && mini_tip) {
            const card = P.item.getBoundingClientRect();
            const box = node => { const r = node.getBoundingClientRect(); return { x: r.left - card.left, y: r.top - card.top, w: r.width, h: r.height }; };
            const frame = h("div", { class: "tip-frame", "aria-hidden": "true" });
            P.item.append(frame);
            flyers.unshift({ flyer: frame, tip: { from: box(tip), to: box(mini_tip), pad: parseFloat(getComputedStyle(mini_tip).paddingRight) + parseFloat(getComputedStyle(mini_tip).borderRightWidth) } /* to the list's own right edge */ });
        }
        // The words that travel: the name, the cost, and each enchantment's line in the tooltip to its place in the bar's list (by `data-ns`).
        const list = P.item.querySelector(".item-mini .mini-list");
        const pairs = [[P.name, P.mini_name], [P.cost, P.mini_cost]];
        for (const line of P.item.querySelectorAll(".wanted-preview .mc-tooltip .mc-ench[data-ns]")) pairs.push([line, list && list.querySelector(`.mini-ench[data-ns="${line.dataset.ns}"]`)]);
        for (const [el, to_el] of pairs) {
            // (no cost line with nothing chosen: the pair is skipped before anything reads it)
            if (!el || !to_el || !el.getClientRects().length || !to_el.getClientRects().length) continue;
            const in_tip = el.classList.contains("mc-ench"); // an enchantment line: kept inside the tooltip's box on the way
            // Its colour (and shadow) go from the tooltip's to the bar's too (the words' own element: the cost line's text span).
            const words = node => node.querySelector(".cost-line-text") || node;
            const from_look = getComputedStyle(words(el)), to_look = getComputedStyle(words(to_el));
            const colors = { from: from_look.color, to: to_look.color, shadow_from: from_look.textShadow, shadow_to: to_look.textShadow };
            // The scale is the ratio of the font sizes (the boxes' heights also hold line spacing and the orb, so they over- or undershoot).
            const scale = parseFloat(to_look.fontSize) / parseFloat(from_look.fontSize);
            // Where the words start (past the cost's orb), relative to the card, in both forms: those are what line up.
            const card = P.item.getBoundingClientRect();
            // The text itself (a range over it: an element's box also holds its line spacing, which differs between a tooltip line and a span), so the
            // glyphs land exactly where the bar's are.
            const text = node => { const range = document.createRange(); range.selectNodeContents(words(node)); const r = range.getBoundingClientRect(); return { x: r.left - card.left, cy: r.top + r.height / 2 - card.top }; };
            const text_from = text(el), text_to = text(to_el);
            const words_from = text_from.x, words_to = text_to.x;
            const box = node => { const r = node.getBoundingClientRect(); return { x: r.left - card.left, y: r.top - card.top, w: r.width, h: r.height }; };
            const look = getComputedStyle(el), at = box(el), to = box(to_el);
            const flyer = el.cloneNode(true);
            flyer.removeAttribute("id");
            flyer.setAttribute("aria-hidden", "true");
            flyer.classList.add("morph-flyer");
            for (const prop of ["font-family", "font-size", "font-weight", "line-height", "color", "text-shadow", "letter-spacing"]) flyer.style.setProperty(prop, look.getPropertyValue(prop));
            Object.assign(flyer.style, { left: at.x - geo.border + "px", top: at.y - geo.border + "px", width: at.w + "px", height: at.h + "px" });
            for (const inner of flyer.querySelectorAll("*")) { inner.style.color = "inherit"; inner.style.textShadow = "inherit"; }
            // The comma after an enchantment in the bar's list rides with it, fading in (the tooltip has none).
            const sep = in_tip && to_el.nextElementSibling && to_el.nextElementSibling.classList.contains("mini-sep") ? to_el.nextElementSibling : null;
            const comma = sep ? h("span", { class: "morph-comma" }, sep.textContent) : null;
            if (comma) flyer.append(comma);
            // An enchantment's copy is as wide as its words and comma (a tooltip line's box is the tooltip's width and would end before the comma: its
            // clip and fade, which only reach the box, cut the comma off).
            if (in_tip) flyer.style.width = "max-content";
            P.item.append(flyer);
            el.style.visibility = "hidden";
            to_el.style.visibility = "hidden";
            if (sep) sep.style.visibility = "hidden";
            const box_w = flyer.offsetWidth;
            flyers.push({ flyer, a: at, b: to, box_w, colors, scale, words_from, words_to, cy_from: text_from.cy, cy_to: text_to.cy, comma, in_tip, hidden: [el, to_el, sep].filter(Boolean) });
            // The cost's XP orb travels on its own, from its box to the bar's (its size is its own, not the words'): the one in the words' copy hides.
            const orb = el.querySelector(".cost-line-orb"), to_orb = to_el.querySelector(".cost-line-orb");
            if (orb && to_orb) {
                const from = box(orb), to = box(to_orb);
                flyer.querySelector(".cost-line-orb").style.visibility = "hidden";
                const orb_flyer = orb.cloneNode(true);
                orb_flyer.classList.add("morph-flyer");
                orb_flyer.setAttribute("aria-hidden", "true");
                Object.assign(orb_flyer.style, { left: from.x - geo.border + "px", top: from.y - geo.border + "px", width: from.w + "px", height: from.h + "px" });
                P.item.append(orb_flyer);
                flyers.push({ flyer: orb_flyer, orb: { from, to } });
            }
        }
    };
    const clear = P => {
        for (const el of styled(P)) { el.style.transform = el.style.transformOrigin = el.style.opacity = el.style.clipPath = el.style.visibility = ""; el.classList.remove("morph-travel"); }
        if (frames) for (const pair of frames) for (const frame of pair.frames) frame.remove();
        frames = null;
        if (flyers) for (const { flyer, hidden } of flyers) { flyer.remove(); if (hidden) for (const el of hidden) el.style.visibility = ""; }
        flyers = null;
        dock.classList.remove("morphing");
    };
    const frameLike = el => {
        const look = getComputedStyle(el);
        return h("div", { class: "morph-frame", "aria-hidden": "true", style: `border: ${look.borderTopWidth} solid ${look.borderTopColor}; background: ${look.backgroundColor}; border-radius: ${look.borderTopLeftRadius}` });
    };
    const makeFrames = P => {
        frames = [];
        for (const [from_el, to_el, key] of [[P.reset, P.mini_reset, "reset"], [P.steps, P.mini_steps, "steps"]]) {
            if (!from_el || !to_el || !geo.full[key] || !geo.cond[key]) continue;
            const pair = { from_el, to_el, key, frames: [frameLike(from_el), frameLike(to_el)] };
            P.item.append(...pair.frames);
            from_el.classList.add("morph-travel");
            to_el.classList.add("morph-travel");
            frames.push(pair);
        }
    };
    // The bar's height while it sticks over the page (narrow windows only; beside the sections it covers nothing); set only when it changes,
    // since App.js setupResultsColumn watches <html>'s style.
    const setDockHeight = height => {
        const value = height && narrow.matches && !dock.hidden ? height + 8 + "px" : "0px";
        if (root.style.getPropertyValue("--dock-h") !== value) root.style.setProperty("--dock-h", value);
    };
    // The two forms' boxes, relative to the card: measured with the classes switched back and forth in one go (nothing is painted between).
    const measure = () => {
        if (!state.item || dock.hidden || !narrow.matches) {
            // (a window widened past the narrow layout mid-morph: everything the morph moved, hid or laid over the card goes back first)
            if ($("#item")) clear(parts());
            geo = null; dock.style.height = ""; return;
        }
        const P = parts();
        clear(P);
        dock.classList.remove("condensed");
        dock.style.height = "";
        const base = () => P.item.getBoundingClientRect();
        const rel = el => {
            if (!el || !el.getClientRects().length) return null; // (not offsetWidth: an <svg> has none)
            const r = el.getBoundingClientRect(), b = base();
            return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
        };
        const full = { dock_h: dock.offsetHeight, item_h: P.item.offsetHeight, slot: rel(P.slot), name: rel(P.name), cost: rel(P.cost), reset: rel(P.reset), reset_icon: rel(P.reset && P.reset.querySelector(".reset-icon")), steps: rel(P.steps) };
        dock.classList.add("condensed");
        const row = rel(P.row);
        const cond = { item_h: P.item.offsetHeight, slot: rel(P.mini_slot), name: rel(P.mini_name), cost: rel(P.mini_cost), reset: rel(P.mini_reset), reset_icon: rel(P.mini_reset && P.mini_reset.querySelector(".reset-icon")), steps: rel(P.mini_steps), row, row_w: P.row.offsetWidth };
        dock.classList.remove("condensed");
        dock.style.height = full.dock_h + "px";
        geo = { full, cond, border: P.item.clientLeft };
    };
    const move = (el, from, to, s) => {
        if (!el || !from || !to) return;
        el.style.transformOrigin = "0 0";
        el.style.transform = `translate(${(to.x - from.x) * s}px, ${(to.y - from.y) * s}px) scale(${1 + (to.h / from.h - 1) * s})`;
    };
    const apply = e => {
        if (!geo) {
            dock.classList.toggle("condensed", Boolean(state.item) && past() > 0);
            setDockHeight(0);
            return;
        }
        const P = parts();
        if (e <= 0 || e >= 1) {
            clear(P);
            dock.classList.toggle("condensed", e >= 1);
            setDockHeight(e >= 1 ? geo.cond.item_h : 0);
            return;
        }
        const s = e * e * (3 - 2 * e);
        const { full, cond } = geo;
        dock.classList.remove("condensed");
        dock.classList.add("morphing");
        dock.style.setProperty("--morph-h", full.item_h + (cond.item_h - full.item_h) * s + "px");
        dock.style.setProperty("--mini-x", cond.row.x - geo.border + "px");
        dock.style.setProperty("--mini-y", cond.row.y - geo.border + "px");
        dock.style.setProperty("--mini-w", cond.row_w + "px");
        move(P.slot, full.slot, cond.slot, s);
        if (!flyers) makeFlyers(P);
        let tip_box = null;
        for (const { flyer, a, b, box_w, colors, scale, words_from, words_to, cy_from, cy_to, comma, in_tip, orb, tip } of flyers) {
            if (orb) { move(flyer, orb.from, orb.to, s); continue; }
            if (tip) {
                const lerp_box = prop => tip.from[prop] + (tip.to[prop] - tip.from[prop]) * s;
                Object.assign(flyer.style, { left: lerp_box("x") - geo.border + "px", top: lerp_box("y") - geo.border + "px", width: lerp_box("w") + "px", height: lerp_box("h") + "px" });
                tip_box = { x: lerp_box("x"), y: lerp_box("y"), w: lerp_box("w"), h: lerp_box("h"), pad: tip.pad * s };
                continue;
            }
            flyer.style.transformOrigin = "0 0";
            // The words' left edge and the vertical middle travel to the bar's.
            const k = 1 + (scale - 1) * s;
            const tx = words_from + (words_to - words_from) * s - a.x - k * (words_from - a.x);
            const ty = cy_from + (cy_to - cy_from) * s - a.y - k * (cy_from - a.y);
            if (comma) comma.style.opacity = s;
            flyer.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
            // An enchantment line is clipped to the tooltip's box (inside its right padding, where the bar's list cuts off with "…"), in the copy's own
            // coordinates, so the ones the bar has no room for slide out of sight under its edge instead of over the cost and Steps.
            if (in_tip && tip_box) {
                const lx = (tip_box.x - a.x - tx) / k, ly = (tip_box.y - a.y - ty) / k, lw = (tip_box.w - tip_box.pad) / k, lh = tip_box.h / k;
                flyer.style.clipPath = `inset(${ly}px ${box_w - lx - lw}px ${a.h - ly - lh}px ${lx}px)`;
                // The bar's list fades out over its last FADE px instead of a "…": the copies fade the same way at the clip's edge, growing in from
                // no fade, so the morph ends exactly as the bar looks.
                const fade = 24 * s / k, edge = lx + lw;
                flyer.style.maskImage = flyer.style.webkitMaskImage = `linear-gradient(to right, #000 ${edge - fade}px, transparent ${edge}px)`;
            }
            flyer.style.color = `color-mix(in srgb, ${colors.from} ${(1 - s) * 100}%, ${colors.to})`;
            flyer.style.textShadow = s < 0.5 ? colors.shadow_from : colors.shadow_to;
        }
        for (const el of P.fade_out) el.style.opacity = Math.max(0, 1 - 2 * s);
        for (const el of P.fade_in) el.style.opacity = Math.max(0, 2 * s - 1);
        if (P.mini_slot) P.mini_slot.style.opacity = 0;
        if (!frames) makeFrames(P);
        const lerp = (a, b) => a + (b - a) * s;
        for (const { from_el, to_el, key, frames: pair } of frames) {
            const a = full[key], b = cond[key];
            const box = { x: lerp(a.x, b.x), y: lerp(a.y, b.y), w: lerp(a.w, b.w), h: lerp(a.h, b.h) };
            const icon_a = full[key + "_icon"], icon_b = cond[key + "_icon"];
            // With an arrow in both, the box's right edge keeps its padding beside the travelling arrow, so the arrow is always inside it.
            if (icon_a && icon_b) box.x = lerp(icon_a.x + icon_a.w, icon_b.x + icon_b.w) + lerp(a.x + a.w - icon_a.x - icon_a.w, b.x + b.w - icon_b.x - icon_b.w) - box.w;
            pair.forEach((frame, i) => {
                Object.assign(frame.style, { left: box.x - geo.border + "px", top: box.y - geo.border + "px", width: box.w + "px", height: box.h + "px", opacity: i ? s : 1 - s });
            });
            // One copy of the contents rides the whole way, no fade; the bar's own shows at the end. Steps (the same words in both) rides the box's
            // centre. Start over's arrow (in both) travels and resizes from its place to the bar's; the words beside it fade out over the first half (and are
            // clipped by the box as it closes round the arrow).
            const ia = full[key + "_icon"], ib = cond[key + "_icon"];
            const k = ia && ib ? lerp(1, ib.h / ia.h) : 1;
            const anchor = ia && ib ? [ia.x + ia.w / 2 - a.x, ia.y + ia.h / 2 - a.y] : [a.w / 2, a.h / 2];
            const goal = ia && ib ? [lerp(ia.x + ia.w / 2, ib.x + ib.w / 2), lerp(ia.y + ia.h / 2, ib.y + ib.h / 2)] : [box.x + box.w / 2, box.y + box.h / 2];
            const tx = goal[0] - a.x - k * anchor[0], ty = goal[1] - a.y - k * anchor[1];
            from_el.style.transformOrigin = "0 0";
            from_el.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
            // The box in the button's own (unscaled) coordinates, as its clip.
            const lx = (box.x - a.x - tx) / k, ly = (box.y - a.y - ty) / k, lw = box.w / k, lh = box.h / k;
            from_el.style.clipPath = `inset(${ly}px ${a.w - lx - lw}px ${a.h - ly - lh}px ${lx}px)`;
            from_el.style.opacity = 1;
            to_el.style.opacity = 0;
            if (key === "reset" && P.reset_label) P.reset_label.style.opacity = Math.max(0, 1 - 2 * s); // the words fade as the box closes round the arrow
        }
        setDockHeight(cond.item_h);
    };
    const follow = now => {
        const dt = last_frame ? now - last_frame : 16;
        last_frame = now;
        const goal = target();
        shown += (goal - shown) * (1 - Math.exp(-dt / DOCK_FOLLOW_MS));
        if (Math.abs(goal - shown) < 0.001) shown = goal;
        apply(shown);
        if (shown !== goal) requestAnimationFrame(follow);
        else { following = false; last_frame = 0; }
    };
    // Picking an item while the page is already scrolled (Try an example, under the long item grid) and every redraw of the card (renderItem) re-measure
    // and jump to the scroll's state.
    syncDock = () => { measure(); shown = target(); apply(shown); };
    reserveDock = () => { if (geo) setDockHeight(geo.cond.item_h); };
    addEventListener("scroll", () => {
        if (!geo || !motionOk()) { shown = target(); apply(shown); return; }
        if (!following) { following = true; requestAnimationFrame(follow); }
    }, { passive: true });
    narrow.addEventListener("change", syncDock);
    // The card's own size changes (a redraw's eases, the window's width): measured again once it has settled for the frame. The morph itself never
    // changes the card's layout size, and the condensed form's change is measured back to the same values, so this does not feed itself.
    let resize_pending = false;
    new ResizeObserver(() => {
        if (resize_pending) return;
        resize_pending = true;
        requestAnimationFrame(() => { resize_pending = false; measure(); apply(shown); });
    }).observe($("#item"));
}

// Section 1: the item grid until an item is picked; then a search box and one box
// of enchantments (conflict groups together), a box for each mod, and the conflict graph.
export function renderWanted() {
    const box = $("#wanted");
    const focus = focusState(box);
    // "Allow conflicts" turns each conflict group from a switch into plain rows (and
    // back): their old heights, so the new ones can slide from them.
    const old_groups = new Map();
    if (conflicts_toggled) {
        for (const group of box.querySelectorAll(".ench-group[data-group]")) old_groups.set(group.dataset.group, group.getBoundingClientRect().height);
    }
    setConflictsToggled(false);
    // Each "Pick a side" section: its chosen rows (a copy, height and level bar each), selected options and border.
    const old_each = captureEach(box);
    // Each row's height, to ease a row that gets taller or shorter (a "not on your books" note appearing, say) instead of jumping.
    const old_rows = new Map([...box.querySelectorAll(".ench-row[data-ns]")].map(row => [row.dataset.ns, row.getBoundingClientRect().height]));
    // Each "Pick one" group before: which option was chosen, how its box looked, and a copy of its row,
    // so None <-> an enchantment can animate (the row opens or closes, the options and the border fade), and its level bar
    // (rolled if the next pick has a different number of levels).
    const old_picks = new Map();
    for (const group of box.querySelectorAll(".ench-group.exclusive[data-group]")) {
        const row = group.querySelector(":scope > .ench-row");
        const bar = group.querySelector(".level-bar");
        old_picks.set(group.dataset.group, {
            bar: bar && { levels: bar.querySelectorAll(".level-seg").length, segments: [...bar.querySelectorAll(".level-seg")].map(seg => seg.cloneNode(true)) },
            selected: group.querySelector(".switch-option.selected")?.dataset.focus || null,
            border: getComputedStyle(group).borderColor,
            row: row ? inertCopy(row) : null,
            ns: row ? row.dataset.ns : null,
            height: row ? row.getBoundingClientRect().height : null
        });
    }
    box.replaceChildren();
    sectionHeading();
    if (!state.item) {
        box.append(
            h("p", { class: "hint intro" }, TEXT.wanted.intro),
            h("p", { class: "hint" }, TEXT.wanted.pick_item_first),
            itemGrid(),
            // A first look without choosing anything: a fully enchanted helmet.
            h("button", { type: "button", class: "btn small example", onclick: tryExample }, TEXT.wanted.example)
        );
        // Your saved setups, under the grid: one click loads one's item and enchantments.
        const saved = readSaved();
        if (saved.length) {
            askSavedMods();
            box.append(h("div", { class: "saved-first", "data-presets-fold": "first" }, ...presetsFold("first", TEXT.wanted.saved_first, savedList(saved))));
        }
        restoreFocus(box, focus);
        restoreConflicts();
        return;
    }

    // An item this edition gives nothing (a recovery compass takes Curse of Vanishing in Bedrock only): it says so, with the way to the edition that does.
    if (!logic.applicable(state.item).length) {
        const other = EDITIONS.find(edition => edition !== state.edition);
        box.append(h("p", { class: "hint takes-none" }, TEXT.wanted.takes_none({ item: logic.itemName(state.item), edition: TEXT.page.editions[state.edition].label }), " ",
            h("button", { type: "button", class: "btn small", "data-focus": "takes-none-switch", onclick: () => setEdition(other) }, TEXT.wanted.use_edition({ edition: TEXT.page.editions[other].label }))));
        restoreFocus(box, focus);
        syncFoldToggle();
        return;
    }
    const { list, mod_boxes } = wantedList();
    box.append(...[wantedSearch(), list, ...mod_boxes].filter(Boolean)); // append(null) would print "null"
    const graph = state.allow_incompatible ? null : conflictGraph(searchMatcher()); // (with conflicts allowed nothing conflicts)
    if (graph) box.append(graph); // the last box of the section, at every width
    for (const group of box.querySelectorAll(".ench-group[data-group]")) {
        if (!old_groups.has(group.dataset.group)) continue;
        growSmoothly(group, old_groups.get(group.dataset.group));
        if (motionOk()) group.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
    }
    for (const group of box.querySelectorAll(".ench-group.exclusive[data-group]")) {
        const old = old_picks.get(group.dataset.group);
        const bar = group.querySelector(".level-bar");
        if (old && old.bar && bar) rollLevelBar(bar, old.bar.levels, old.bar.segments);
        animatePick(group, old);
    }
    for (const section of box.querySelectorAll(".pick-side[data-side]")) animateEach(section, old_each.get(section.dataset.side));
    if (motionOk() && !old_groups.size) {
        for (const row of box.querySelectorAll(".ench-row[data-ns]")) {
            const was = old_rows.get(row.dataset.ns);
            if (was == null || row.getAnimations().length) continue;
            easeRowHeight(row, was);
        }
    }
    restoreFocus(box, focus);
    restoreConflicts();
    syncFoldToggle();
}

const FOLDS = "#wanted details"; // every fold-away box of section 2

// Eases a row's height from `from` to its new one (the box clips while it does). A row laid out as one grid row has that row
// follow the box meanwhile, so what is in it (the level bar) moves with the box both ways: left to itself, a growing box would
// lay its content out at the final size and the bar would jump there at once.
function easeRowHeight(row, from) {
    easeHeight(row, from, {
        duration: 250, easing: "ease-out",
        during() {
            if (getComputedStyle(row).gridTemplateRows.trim().split(/\s+/).length === 1) row.style.gridTemplateRows = "minmax(0, 1fr)";
            return () => { row.style.gridTemplateRows = ""; };
        }
    });
}

// A "Pick one" group after a redraw: its chosen row opens or closes when the pick goes from or to
// None, the level bar rolls (rollLevelBar) and the row eases to its new height when a switch from one
// enchantment to another changes it (a longer description, a second row of levels), the option that was
// chosen fades out of its highlight and the new one fades in, and the border changes color smoothly.
// A Pick option's look as the selected one (colours), and as a quiet one (nothing): the option that becomes or stops being selected
// fades between them.
const QUIET_OPTION = { backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0), 0 1px 3px rgba(0, 0, 0, 0)" };
const selectedLook = look => ({ backgroundColor: look.backgroundColor, boxShadow: look.boxShadow, color: look.color });
const fadeOption = (button, from) => button.animate([from, {}], { duration: 260, easing: "ease-out" });

function animatePick(group, old) {
    if (!old || !motionOk()) return;
    const row = group.querySelector(":scope > .ench-row");
    if (row && !old.row) openRow(row);
    else if (!row && old.row) closeRow(group, old.row);
    else if (row && old.row && row.dataset.ns !== old.ns) easeRowHeight(row, old.height);
    const now = group.querySelector(".switch-option.selected"); // None is an option too, so there always is one
    if (now && now.dataset.focus !== old.selected) {
        const look = getComputedStyle(now);
        const was = old.selected && group.querySelector(`[data-focus="${old.selected}"]`);
        if (was) fadeOption(was, selectedLook(look));
        fadeOption(now, QUIET_OPTION);
    }
    if (getComputedStyle(group).borderColor !== old.border) group.animate([{ borderColor: old.border }, {}], { duration: 300, easing: "ease-out" });
}

// The element with focus inside `box` (by its data-focus), so a redraw can put the
// focus back where it was (the level bars and switches are rebuilt on every change).
export function focusState(box) {
    const active = document.activeElement;
    return active && box.contains(active) && active.dataset.focus ? active.dataset.focus : null;
}

export function restoreFocus(box, key) {
    const again = key && box.querySelector(`[data-focus="${key}"]`);
    if (again) again.focus({ preventScroll: true });
}

// What a whole group is, by the first level of its conflict tree: "one" (every pair conflicts), "side" (the first level is a Pick a side: its
// sides are parts that all conflict with each other, whatever is nested inside them) or "any" (the first level is parts that never conflict:
// pick from any of them; a connected bracket never has this at the top, so it is only here for completeness).
function groupKind(tree) {
    if (tree.kind === "each") return "any";
    return tree.children.every(child => child.kind === "leaf") ? "one" : "side";
}

// The rows: single enchantments, "Pick one" switches, and brackets around enchantments
// that only partly conflict; curses last.
function wantedList() {
    // Chosen enchantments the custom books can't reach (none in automatic mode).
    const short = new Map(logic.checkBooks(state).short.map(s => [s.ns, s]));
    // The search box: only enchantments whose name or description has the typed text. A "Pick one" or "Pick a
    // side" card stays whole when any of its options match, a bracket keeps just the matching rows, and a mod's section opens.
    const query = plain(wanted_query);
    const matches = searchMatcher() || (() => true);
    const shown = group => {
        if (!query) return group;
        const hits = group.members.filter(matches);
        if (!hits.length) return null;
        if (!state.allow_incompatible && (group.exclusive || logic.conflictTree(group.members))) return group;
        return { ...group, members: hits, exclusive: false, reduced: true };
    };
    // Any other bracket that splits again and again (Logic conflictTree, a few strays set apart if it takes them) is drawn as nested sections:
    // Pick one, Pick a side, Pick any (not a bracket the search cut down: it may not be that shape).
    const severalOf = group => (state.allow_incompatible || group.reduced || group.exclusive ? null : logic.conflictTree(group.members));
    // Each Pick one / nested group is a fold-away subsection named by its type and how many enchantments it holds: "Pick a side (25)".
    const groupRow = (group, bare = false) => {
        const fold = (title, key, content) => (bare ? content : groupFold(title, key, content)); // bare: the section has this one group only
        const members = group.members;
        if (group.exclusive && !state.allow_incompatible) {
            return fold(TEXT.wanted.group_titled({ label: TEXT.wanted.group_pick_one, count: members.length }), members[0], groupSwitch(members, short, TEXT.wanted.group_pick_one));
        }
        const several = severalOf(group);
        if (several) {
            const label = { one: TEXT.wanted.group_pick_one, side: TEXT.wanted.group_pick_side, any: TEXT.wanted.group_pick_part }[groupKind(several.tree)];
            return fold(TEXT.wanted.group_titled({ label, count: members.length }), members[0], pickGroupsSection(members, several, short, label));
        }
        if (members.length === 1) return wantedRow(members[0], short.get(members[0]));
        // The label folds the bracket: the chosen rows stay, the rest hide (kept in `folded_groups` across redraws).
        const key = members[0];
        const folded = folded_groups.has(key) && !query;
        return h("div", { class: "ench-group" + (members.some(ns => state.wanted[ns]) ? " has-chosen" : "") + (folded ? " folded" : ""), "data-group": key },
            h("button", {
                type: "button", class: "ench-group-label group-toggle", "data-focus": "group-" + key, "aria-expanded": String(!folded),
                onclick: event => {
                    const group = event.currentTarget.parentElement;
                    const from = group.getBoundingClientRect().height;
                    setBracket(group, !folded_groups.has(key));
                    easeHeight(group, from);
                }
            }, TEXT.wanted.group_some_conflict + " (" + members.length + ")"),
            members.map(ns => wantedRow(ns, short.get(ns), true))
        );
    };
    // Sorted by depth (a lone enchantment 0; a Pick one or a Pick any 1; a section made of such sections 2, and so on; a plain bracket last),
    // then by type (Pick any, Pick one, then the rest), then by how many enchantments the section holds (fewer first), then by its
    // alphabetically first name.
    const treeDepth = node => (node.kind === "leaf" ? 0 : 1 + Math.max(...node.children.map(treeDepth)));
    const sectionOf = group => (group.members.length === 1 || state.allow_incompatible || group.reduced ? null : group.exclusive ? { tree: { kind: "side", children: group.members.map(ns => ({ kind: "leaf", ns })) } } : logic.conflictTree(group.members));
    const depth = group => (group.members.length === 1 ? 0 : sectionOf(group) ? treeDepth(sectionOf(group).tree) : Infinity);
    const type = group => {
        const tree = sectionOf(group)?.tree;
        if (!tree) return 4;
        return { one: 1, side: 2, any: 3 }[groupKind(tree)];
    };
    const firstName = group => group.members.map(ns => logic.enchName(ns)).sort((x, y) => x.localeCompare(y))[0];
    const byKind = groups => [...groups].sort((a, b) => (depth(a) === depth(b) ? 0 : depth(a) < depth(b) ? -1 : 1) || type(a) - type(b) || a.members.length - b.members.length || firstName(a).localeCompare(firstName(b)));
    const rows = [];
    const own = [];
    const curses = [];
    const mods = new Map(); // mod name -> its groups (those with none of the game's own enchantments)
    // With Allow conflicts every enchantment can go with every other, so none is shown as conflicting: each is a group of its own, and they all
    // end up in the one "No conflicts (N)" subsection, alphabetical (the curses and each mod's still keep their own).
    const all_groups = state.allow_incompatible
        ? logic.enchantmentGroups(state.item).flatMap(group => group.members.map(ns => ({ members: [ns], exclusive: false })))
        : logic.enchantmentGroups(state.item);
    for (const whole of all_groups) {
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
    // The enchantments with no conflicts go in one fold-away "Pick any (N)" subsection per section, ahead of its groups.
    // A section with only one group (Flint & Steel in the game's own list) shows it without a subsection around it.
    const withPickAny = (groups, key) => {
        const sorted = byKind(groups);
        const alone = sorted.filter(group => group.members.length === 1);
        const others = sorted.filter(group => group.members.length !== 1);
        const single = (alone.length ? 1 : 0) + others.length === 1;
        if (single && !alone.length) return [groupRow(others[0], true)];
        const rest = others.map(group => groupRow(group));
        if (!alone.length) return rest;
        const lone = alone.map(group => groupRow(group));
        if (single && !state.allow_incompatible) return lone; // (with conflicts allowed they are still the one "No conflicts (N)" group)
        const title = TEXT.wanted.group_titled({ label: TEXT.wanted.group_no_conflicts, count: alone.length });
        return [groupFold(title, key, h("div", { class: "pick-any-list", role: "group", "aria-label": TEXT.wanted.group_no_conflicts }, lone)), ...rest];
    };
    rows.push(...withPickAny(own, "pick-any"));
    // The curses are a fold-away group like the others (its own closed state).
    if (curses.length) {
        const total = curses.reduce((sum, group) => sum + group.members.length, 0);
        rows.push(groupFold(TEXT.wanted.group_titled({ label: TEXT.wanted.curses, count: total }), "curses", h("div", { class: "curse-list" }, byKind(curses).map(groupRow))));
    }
    // A mod's own enchantments get a fold-away box of their own, beside the list's and the graph's, folded until opened (or one is chosen).
    const mod_boxes = [];
    for (const [mod, groups] of mods) {
        const count = groups.reduce((sum, group) => sum + group.members.length, 0);
        const chosen = groups.some(group => group.members.some(ns => state.wanted[ns]));
        mod_boxes.push(h("details", {
            // A box the user closed stays closed through redraws (choosing a curse, say), even while one of its enchantments is chosen; a search opens it.
            class: "fold-box mod-section", "data-mod": mod, open: (!mod_closed.has(mod) && (chosen || mod_open.has(mod))) || Boolean(query),
            ontoggle: event => {
                if (wanted_query.trim()) return; // opened by the search, not by the user
                setModOpen(mod, event.target.open);
            }
        },
            h("summary", {
                onclick: foldClick(open => {
                    if (wanted_query.trim()) return;
                    setModOpen(mod, open);
                })
            }, TEXT.wanted.mod_group({ name: mod, count })),
            withPickAny(groups, "pick-any-" + mod)));
    }
    if (query && !rows.length && !mod_boxes.length) rows.push(h("p", { class: "hint" }, TEXT.wanted.search_none));
    return { list: h("div", { class: "wanted-list" }, rows), mod_boxes };
}

// What is typed in section 1's search box (kept across redraws and items), and the text without case or accents.
let wanted_query = "";

// The test the search applies to an enchantment (its name or description has the typed text), or null with no search.
function searchMatcher() {
    const query = plain(wanted_query);
    return query ? ns => plain(logic.enchName(ns) + " " + logic.describe(ns)).includes(query) : null;
}

// The search box above the list. Typing redraws only the list (and marks the graph), so the box keeps its focus.
// Folds or unfolds a plain conflict bracket (no animation: the caller eases its height).
function setBracket(group, folded) {
    const key = group.dataset.group;
    if (folded) folded_groups.add(key); else folded_groups.delete(key);
    group.classList.toggle("folded", folded);
    group.querySelector(":scope > .group-toggle").setAttribute("aria-expanded", String(!folded));
    syncFoldToggle();
}

// Expand all / Collapse all is one icon that shows what it would do: fold while anything in the section is open (a box, a group, a plain
// bracket; a box mid-slide counts where it is heading), and unfold once everything is folded. So it starts as Collapse, as the list opens open.
// It follows each fold by hand too (a `toggle` of any box, setBracket).
// Like section 4's: Expand while most of the boxes, subsections and brackets are folded, else Collapse.
function mostFolded() {
    const states = [...[...document.querySelectorAll(FOLDS)].map(details => foldTarget(details)),
        ...[...document.querySelectorAll("#wanted .ench-group[data-group]")].filter(group => group.querySelector(":scope > .group-toggle")).map(group => !group.classList.contains("folded"))];
    const open = states.filter(Boolean).length;
    return open < states.length - open;
}
function syncFoldToggle() {
    const button = document.querySelector("#wanted .fold-toggle");
    if (!button) return;
    const expand = mostFolded();
    const label = expand ? TEXT.wanted.expand_groups_label : TEXT.wanted.collapse_groups_label;
    button.dataset.action = expand ? "expand" : "collapse";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren(foldIcon(expand));
}
let fold_sync_ready = false;
function watchFolds() {
    if (fold_sync_ready) return;
    fold_sync_ready = true;
    // `toggle` doesn't bubble, so the listener captures it on its way to each box.
    document.querySelector("#wanted").addEventListener("toggle", syncFoldToggle, true);
}

// Expand all / Collapse all for section 1: every fold-away box and group subsection, and the folds of the plain conflict brackets.
// Each box that changes eases like a section does (foldDetails, easeHeight); ones inside another that changes just follow it.
function foldWanted(open) {
    const changing = new Set([...document.querySelectorAll(FOLDS)].filter(details => details.open !== open));
    const outer = node => { let up = node.parentElement.closest("details"); while (up && !changing.has(up)) up = up.parentElement.closest("details"); return up; };
    const tops = [...changing].filter(details => !outer(details));
    const brackets = [...document.querySelectorAll("#wanted .ench-group[data-group]")].filter(group => group.classList.contains("folded") === open && group.querySelector(":scope > .group-toggle"));
    const free = brackets.filter(group => !outer(group)).map(group => [group, group.getBoundingClientRect().height]);
    const run = () => { for (const [group, from] of free) easeHeight(group, from); };
    if (open) {
        for (const details of changing) if (outer(details)) details.open = true;
        for (const group of brackets) setBracket(group, false);
        for (const details of tops) foldDetails(details, true);
        run();
    } else {
        for (const details of tops) foldDetails(details, false, [...changing].filter(nested => nested !== details && details.contains(nested)));
        for (const group of brackets) setBracket(group, true);
        run();
    }
    syncFoldToggle();
}

// The "?" beside the fold buttons: what each kind of group means (a bubble that floats over the page, like the other tips).
function groupLegend() {
    const item = (term, text) => h("span", { class: "legend-item" }, h("strong", {}, term), " ", text);
    const tip = infoTip("groups-legend", "?", TEXT.wanted.legend_label, [
        item(TEXT.wanted.group_pick_one, TEXT.wanted.legend_one),
        item(TEXT.wanted.group_pick_side, TEXT.wanted.legend_side),
        item(TEXT.wanted.group_pick_part, TEXT.wanted.legend_part),
        item(TEXT.wanted.group_pick_any, TEXT.wanted.legend_any),
        item("⇄", TEXT.wanted.legend_stray),
        item(TEXT.wanted.group_side_n({ n: 1 }) + ", " + TEXT.wanted.group_part_n({ n: 2 }), TEXT.wanted.legend_badges)
    ], "group-legend");
    tip.querySelector(".info-tip-bubble").setAttribute("role", "tooltip");
    floatBubble(tip);
    return tip;
}

// The search box with the fold toggle and the groups "?" beside it (below it when the card is too narrow for both).
function wantedSearch() {
    watchFolds();
    const toggle = h("button", { type: "button", class: "icon-btn fold-toggle", "data-focus": "wanted-fold", onclick: () => foldWanted(mostFolded()) });
    // Remove all: clears every chosen enchantment (the plain item), disabled while nothing is chosen.
    const none = Object.keys(state.wanted).length === 0;
    const clear = h("button", {
        type: "button", class: "icon-btn clear-all", "data-focus": "wanted-clear-all", disabled: none,
        title: TEXT.wanted.clear_all, "aria-label": TEXT.wanted.clear_all,
        onclick: () => { state.wanted = {}; commit(); }
    }, clearIcon());
    return h("div", { class: "search-row" }, searchInput(),
        h("span", { class: "fold-buttons" }, clear, toggle, groupLegend()));
}

// A small × in a circle: Remove all.
function clearIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "clear-icon");
    for (const d of ["M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13", "M5.5 5.5l5 5M10.5 5.5l-5 5"]) {
        const path = document.createElementNS(ns, "path"); path.setAttribute("d", d); svg.append(path);
    }
    return svg;
}

function searchInput() {
    return h("input", {
        type: "search", class: "wanted-search", value: wanted_query, placeholder: TEXT.wanted.search, "aria-label": TEXT.wanted.search, "data-focus": "wanted-search",
        oninput: event => {
            wanted_query = event.target.value;
            const { list, mod_boxes } = wantedList();
            document.querySelector("#wanted .wanted-list").replaceWith(list);
            for (const old of document.querySelectorAll("#wanted > .mod-section")) old.remove();
            list.after(...mod_boxes);
            markGraphSearch(searchMatcher());
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
    closeOnOutside({
        open: () => conflict_pin || conflict_shown,
        inside: event => !conflict_pin || event.target.closest(".conflict-chip"), // a click only lets go of a pinned chip
        close: release
    });
    const follow = () => {
        const chip = conflict_shown && chipOf(conflict_shown);
        if (chip && conflict_tip) placeConflictTip(chip); else if (conflict_tip) hideConflicts();
    };
    document.addEventListener("scroll", follow, { capture: true, passive: true });
    addEventListener("resize", follow);
}

// The conflict brackets the user folded (by their first enchantment), in this visit.
const folded_groups = new Set();
// A Pick one or nested group is a subsection under its section (Enchantments, a mod's), folded away by its header (kept across redraws).
const closed_groups = new Set();
function groupFold(title, key, content) {
    const remember = open => {
        if (wanted_query.trim()) return; // opened by the search, not by the user
        if (open) closed_groups.delete(key); else closed_groups.add(key);
    };
    return h("details", { class: "group-fold", "data-fold": key, open: !closed_groups.has(key) || Boolean(wanted_query.trim()), ontoggle: event => remember(event.target.open) },
        h("summary", { onclick: foldClick(remember) }, title), content);
}

// The mods whose section the user opened (in this visit).
const mod_open = new Set();
const mod_closed = new Set(); // the mod boxes the user closed (they stay closed while one of their enchantments is chosen)
function setModOpen(mod, open) {
    if (open) { mod_open.add(mod); mod_closed.delete(mod); } else { mod_open.delete(mod); mod_closed.add(mod); }
}

// The top of the item card: the rename box (the anvil's name bar, Options.js nameField), `controls` (the presets), then the preview.
function wantedHead(...controls) {
    return h("div", { class: "wanted-head" + (item_menu_open ? " menu-open" : "") },
        nameField(),
        h("div", { class: "wanted-controls" }, controls),
        wantedPreview()
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
        "aria-haspopup": "true", "aria-expanded": String(item_menu_open), "aria-controls": item_menu_open ? "item-menu" : null,
        "aria-label": TEXT.wanted.change_item_label({ item: logic.itemName(state.item) }),
        title: TEXT.wanted.change_item,
        onclick: toggleItemMenu
    });
    slot.replaceWith(button);
    button.append(slot, h("span", { class: "item-menu-caret", "aria-hidden": "true" }, "▾"));
    cell.querySelector(".mc-tooltip").append(costLine());
    return h("div", { class: "wanted-preview", role: "group", "aria-label": TEXT.wanted.preview_label },
        cell,
        // The menu belongs to the slot: it opens under it wherever the card puts the preview (the name box and presets may be above).
        item_menu_open ? h("div", { class: "item-menu", id: "item-menu" }, itemGrid()) : null);
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
    // In the condensed bar the line sits beside the name's tooltip box, which gives up (or takes back) its width as the line comes or goes.
    const mini_text = line.closest(".item-dock.condensed .item-mini") ? line.closest(".item-mini").querySelector(".mini-text") : null;
    const mini_before = mini_text ? mini_text.getBoundingClientRect().width : null;
    line.classList.toggle("stale", running);
    // Nothing chosen means nothing to cost: the line goes at once, not when the new search finishes.
    const nothing = Object.keys(state.wanted).length === 0;
    line.classList.toggle("idle", nothing || meter_levels == null && !meter_none);
    line.classList.toggle("none", !nothing && meter_levels == null && meter_none);
    const text = line.querySelector(".cost-line-text");
    const words = nothing ? "" : meter_levels != null ? TEXT.wanted.cost_meter({ levels: meter_levels }) : meter_none ? TEXT.wanted.cost_meter_none : "";
    const old_words = text.textContent;
    const old_box = old_words && words && old_words !== words && line.isConnected ? text.getBoundingClientRect() : null;
    text.textContent = words;
    if (!line.isConnected || !motionOk()) return;
    slideWidth(tooltip, width_before); // the words can make the tooltip wider or narrower
    if (mini_text) {
        const after = mini_text.getBoundingClientRect().width;
        if (Math.abs(after - mini_before) > 0.5) {
            const fixed = width => ({ flexBasis: width + "px", flexGrow: 0, flexShrink: 0 });
            mini_text.animate([fixed(mini_before), fixed(after)], { duration: 250, easing: "ease-out" });
        }
    }
    // New words flip in like the tooltip's rows (rollLines): the old ones leave through one edge of the row while the new come in
    // from the other, up for more levels, down for fewer.
    if (old_box) flipWords(line, text, old_words, words, old_box);
    // The line opens when a result arrives and folds away when there is none, so the tooltip eases to its new height.
    easeHeight(line, before, { duration: 250, easing: "ease-out", fade: true });
}

function flipWords(line, text, old_words, words, old_box) {
    const number = value => Number((value.match(/\d+/) || [])[0]);
    const up = !(number(words) < number(old_words)); // "No valid order" and the like flip up
    const sign = up ? 1 : -1;
    const options = { duration: 240, easing: "ease-in-out" };
    const line_box = line.getBoundingClientRect();
    const ghost = text.cloneNode(false);
    ghost.textContent = old_words;
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, { position: "absolute", left: old_box.left - line_box.left + "px", top: old_box.top - line_box.top + "px", margin: "0", pointerEvents: "none" });
    line.style.position = "relative";
    line.append(ghost);
    text.animate([{ transform: `translateY(${100 * sign}%)`, clipPath: up ? "inset(0 0 100% 0)" : "inset(100% 0 0 0)" }, { transform: "translateY(0)", clipPath: "inset(0 0 0 0)" }],
        { ...options, fill: "backwards" });
    ghost.animate([{ transform: "translateY(0)", clipPath: "inset(0 0 0 0)" }, { transform: `translateY(${-100 * sign}%)`, clipPath: up ? "inset(100% 0 0 0)" : "inset(0 0 100% 0)" }],
        { ...options, fill: "forwards" }).finished.then(() => { ghost.remove(); line.style.position = ""; }, () => ghost.remove());
}

// The preview's name follows Rename as the results' tooltips do (renderResults calls updateCostMeter): typing a name redraws the results, not the item card.
function updatePreviewName() {
    const name = document.querySelector("#item .wanted-preview .mc-tooltip > :first-child");
    if (!name || !state.item) return;
    const renamed = Boolean(state.rename_to.trim());
    const text = renamed ? state.rename_to : logic.itemName(state.item);
    if (name.textContent === text && name.classList.contains("renamed") === renamed) return;
    const tooltip = name.parentElement;
    const width_before = tooltip.getBoundingClientRect().width;
    name.textContent = text;
    name.classList.toggle("renamed", renamed);
    slideWidth(tooltip, width_before);
}

export function updateCostMeter() {
    updatePreviewName();
    const ok = last_result && last_result.status === "ok";
    if (ok && last_result.node) { meter_levels = last_result.node.cumulative_levels; meter_none = false; }
    else if (!running) { meter_levels = null; meter_none = Boolean(ok); }
    for (const line of document.querySelectorAll("#item .cost-line")) fillCostMeter(line);
}

// Opens or closes the item menu (the slot's button).
function toggleItemMenu() {
    setItemMenuOpen(!item_menu_open);
    renderItem();
    if (item_menu_open) {
        const current = document.querySelector(`#items [data-focus="item-${state.item}"]`);
        if (current) current.focus({ preventScroll: true });
    }
}

// The item menu closes on a click outside it (or its button) and on Escape, which puts
// the focus back on the slot.
export function setupItemMenu() {
    const close = () => { setItemMenuOpen(false); renderItem(); };
    closeOnOutside({
        open: () => item_menu_open,
        inside: event => event.composedPath().some(el => el.classList && (el.classList.contains("item-menu") || el.classList.contains("item-menu-button"))),
        close,
        escape() {
            close();
            const button = document.querySelector(".item-menu-button");
            if (button) button.focus();
        }
    });
}

// "Presets: Best · Silk Touch": each sets the chosen enchantments to a whole set (Logic.js
// presets); the one matching the current choice is highlighted. When the item has only
// one set of conflicting enchantments, "Best" is named after its pick from that set
// ("Fortune · Silk Touch", "Channeling + Loyalty · Riptide"); with several, from the one the other presets swap a member of ("Depth Strider · Frost Walker").
function presetChips() {
    // An item this edition gives nothing has no presets (section 1 says so), but a saved setup that left everything out still says what.
    if (!logic.applicable(state.item).length) return savedWarning();
    const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(ns => a[ns] === b[ns]);
    // Hovering (or focusing) a preset shows what it would change, as a game tooltip: + for
    // what it adds or raises, - for what it takes away.
    let compare = null;
    const hideCompare = () => { if (compare) { compare.remove(); compare = null; removeEventListener("scroll", hideCompare); } };
    const showCompare = (chip, wanted, warning = null) => {
        hideCompare();
        if (matchMedia("(hover: none)").matches) return;
        const lines = [];
        for (const { namespace: ns, level } of logic.tooltipSort(Object.entries(wanted).map(([namespace, level]) => ({ namespace, level })))) {
            const changed = state.wanted[ns] !== level;
            lines.push(enchLine(logic.displayName(ns, level), logic.isCurse(ns), changed ? " changed" : ""));
        }
        for (const [ns, level] of Object.entries(state.wanted)) {
            if (!wanted[ns]) lines.push(h("div", { class: "mc-ench removed" }, logic.displayName(ns, level)));
        }
        if (!lines.some(line => line.classList.contains("changed") || line.classList.contains("removed"))) lines.splice(0, lines.length, h("div", { class: "mc-ench" }, TEXT.wanted.compare_same));
        compare = h("div", { class: "mc-tooltip compare-tip", "aria-hidden": "true" },
            h("div", { class: nameClass("common") }, logic.itemName(state.item)), lines,
            warning ? h("div", { class: "compare-warn" }, warning) : null);
        // On the page itself, fixed under the chip: inside the card it would sit under the item's tooltip and be clipped while the card morphs into the
        // sticky bar (Wanted.js setupItemDock). The chip moves when the page scrolls, so the tooltip goes then.
        document.body.append(compare);
        const at = chip.getBoundingClientRect();
        compare.style.top = at.bottom + 4 + "px";
        compare.style.left = Math.max(8, Math.min(at.left, innerWidth - compare.offsetWidth - 8)) + "px";
        addEventListener("scroll", hideCompare, { passive: true });
    };
    const hover = (wanted, warning = null) => ({
        onmouseenter: event => showCompare(event.currentTarget, wanted, warning), onmouseleave: hideCompare,
        onfocus: event => showCompare(event.currentTarget, wanted, warning), onblur: hideCompare
    });
    // Your saved setups for this item, after Plain (the game's Best and swap presets are gone: your own are the presets): one click loads it (`loadSaved`); hovering shows what changes, and the game rules
    // it would set too. Then "+ Save" (a name box opens under the row). Every preset, for any item, is in the header's Presets menu.
    const saved = readSaved();
    if (saved.length) askSavedMods();
    const mine = saved.filter(setup => setup.item === state.item).map(setup => ({ setup, fit: setupFit(setup) })).filter(entry => entry.fit);
    // The header's Presets star is solid while one of these is the setup on screen (its chip lit), outlined otherwise.
    const button = $("#presets-menu > summary");
    if (button) button.classList.toggle("active", mine.some(({ fit }) => Object.keys(fit.wanted).length > 0 && same(fit.wanted, state.wanted)));
    const savedChip = ({ setup, fit }) => {
        const also = fit.changes.length ? TEXT.wanted.saved_also({ list: fit.changes }) : null;
        const selected = Object.keys(fit.wanted).length > 0 && same(fit.wanted, state.wanted);
        return h("span", { class: "saved-chip" + (selected ? " selected" : "") },
            h("button", {
                type: "button", class: "preset mine" + (selected ? " selected" : ""), "aria-pressed": String(selected), "data-focus": "saved-" + setup.name,
                title: TEXT.wanted.saved_load_help({ name: setup.name }), ...hover(fit.wanted, also), onclick: () => { hideCompare(); loadSaved(setup); }
            }, setup.name),
            h("button", {
                type: "button", class: "saved-chip-x", title: TEXT.page.delete_saved, "aria-label": TEXT.page.delete_saved_label({ name: setup.name }),
                onclick: () => { hideCompare(); deleteSetup(setup.name, setup.item); renderItem(); renderPresetsMenu(); }
            }, "×"));
    };
    return h("div", { class: "presets", role: "group", "aria-label": TEXT.wanted.presets, "data-presets-fold": "card" },
        ...presetsFold("card", TEXT.wanted.presets, [h("div", { class: "preset-chips" },
            mine.map(savedChip),
            h("button", {
                type: "button", class: "preset add", "data-focus": "saved-add", "aria-expanded": String(saving_setup), title: TEXT.wanted.saved_save_help,
                onclick: () => { saving_setup = !saving_setup; renderItem(); const box = document.querySelector("#item .saved-form input"); if (box) box.focus(); }
            }, TEXT.wanted.saved_save),
        ),
        saving_setup ? saveForm() : null]),
        savedWarning()
    );
}

// The Presets row (item card) and Your saved setups (first screen) fold away from their label, a button with the page's fold chevron; which are
// closed is kept in this browser. The box eases to its new height (Motion.js easeHeight).
const PRESETS_FOLD_KEY = "enchantment-calculator-presets-closed";
const closed_presets = new Set((() => { const list = readStorage(PRESETS_FOLD_KEY, []); return Array.isArray(list) ? list : []; })());
function presetsFold(key, label, body) {
    const open = !closed_presets.has(key);
    return [
        h("button", {
            type: "button", class: "presets-label presets-toggle", "aria-expanded": String(open), "data-focus": "presets-fold-" + key,
            onclick: () => {
                const box = document.querySelector(`[data-presets-fold="${key}"]`);
                const from = box ? box.getBoundingClientRect().height : null;
                if (open) closed_presets.add(key); else closed_presets.delete(key);
                writeStorage(PRESETS_FOLD_KEY, [...closed_presets]);
                if (key === "first") renderWanted(); else renderItem();
                const again = document.querySelector(`[data-presets-fold="${key}"]`);
                if (again && from != null && motionOk()) easeHeight(again, from);
            }
        }, h("span", { class: "fold-chevron", "aria-hidden": "true" }), label),
        open ? h("div", { class: "presets-body" }, body) : null
    ];
}

// Which game rules the last saved setup loaded changed (edition, mods, Allow conflicts), until dismissed or another preset is chosen; only for its item.
function savedWarning() {
    if (!saved_warning || saved_warning.item !== state.item) return null;
    return h("div", { class: "saved-warning", role: "status" },
        h("span", {}, TEXT.wanted.saved_rules({ name: saved_warning.name, list: saved_warning.changes })),
        h("button", { type: "button", class: "saved-warning-x", title: TEXT.wanted.dismiss, "aria-label": TEXT.wanted.dismiss, onclick: () => { saved_warning = null; renderItem(); } }, "×"));
}

// The header's Presets menu (`#presets-menu`, a <details>): every preset in one list:
// saved setup, for any item (`savedList`), and "Save current…" (the same name box as the item card's + Save). Choosing one closes the menu.
export function renderPresetsMenu() {
    const panel = $("#presets-panel");
    if (!panel) return;
    // A redraw (a group opening or closing, a preset removed) keeps the list where it was scrolled and the focus on the control that had it.
    const old_list = panel.querySelector(".presets-menu-groups");
    const scroll = old_list ? old_list.scrollTop : 0;
    const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    const saved = readSaved();
    if (saved.length) askSavedMods();
    panel.replaceChildren(...h("div", {},
        h("div", { class: "presets-menu-title" }, TEXT.page.saved),
        saved.length ? savedGroups(saved) : h("p", { class: "hint" }, TEXT.page.saved_empty),
        state.item ? (menu_saving ? saveForm(() => { menu_saving = false; renderPresetsMenu(); }) : h("button", {
            type: "button", class: "btn small", "data-focus": "menu-save", onclick: () => { menu_saving = true; renderPresetsMenu(); const box = $("#presets-panel .saved-form input"); if (box) box.focus(); }
        }, TEXT.wanted.save_current)) : null
    ).childNodes);
    const list = panel.querySelector(".presets-menu-groups");
    if (list) list.scrollTop = scroll;
    const again = focused && panel.querySelector(`[data-focus="${CSS.escape(focused)}"]`);
    if (again) again.focus({ preventScroll: true });
}
let menu_saving = false; // the Presets menu's name box is open

// A group just opened that runs past the bottom of the menu's list: the list scrolls down just far enough to show its last preset, or, when the group is
// taller than the list, brings its heading to the top.
function revealMenuGroup(item) {
    const list = document.querySelector("#presets-panel .presets-menu-groups");
    const head = list && list.querySelector(`[data-focus="menu-item-${CSS.escape(item)}"]`);
    if (!head) return;
    const group = head.closest(".presets-menu-group");
    const box = list.getBoundingClientRect(), at = group.getBoundingClientRect();
    if (at.bottom <= box.bottom + 0.5) return; // (all of it shows already)
    const top = list.scrollTop + (at.height > list.clientHeight ? at.top - box.top : at.bottom - box.bottom);
    list.scrollTo({ top, behavior: motionOk() ? "smooth" : "auto" });
}

// The menu's saved presets, one group per item under its icon and name, the items in alphabetical order (in the page's language). Each group folds from its
// heading (the page's fold chevron, and how many presets it holds); all start folded, and the ones opened stay open while the page is open.
const open_menu_items = new Set();
function savedGroups(saved) {
    const items = [...new Set(saved.map(setup => setup.item))]
        .sort((a, b) => logic.itemName(a).localeCompare(logic.itemName(b), localeOf(language)));
    return h("div", { class: "presets-menu-groups" }, items.map(item => {
        const open = open_menu_items.has(item);
        const list = saved.filter(setup => setup.item === item);
        return h("div", { class: "presets-menu-group" },
            h("button", {
                type: "button", class: "presets-menu-item", "aria-expanded": String(open), "data-focus": "menu-item-" + item,
                onclick: () => { if (open) open_menu_items.delete(item); else { open_menu_items.add(item); } renderPresetsMenu(); if (!open) revealMenuGroup(item); }
            }, h("span", { class: "fold-chevron", "aria-hidden": "true" }), logic.isItem(item) ? icon(item, true) : null, logic.itemName(item),
                h("span", { class: "saved-count" }, String(list.length))),
            open ? savedList(list, "grouped") : null);
    }));
}

// ---------- Saved setups (the item card's presets row and the first screen) ----------
let saving_setup = false;     // the name box under the presets row is open
let saved_warning = null;     // { item, name, changes }: the game rules the last loaded setup changed, shown in the item card until dismissed or another preset
let saved_mods_asked = false;

// Loads a saved setup (its item, enchantments and the game rules they need); the item card says which rules changed.
async function loadSaved(setup) {
    const fit = setupFit(setup);
    if (!fit || !fit.usable) return;
    saving_setup = false;
    const menu = $("#presets-menu");
    if (menu) menu.open = false;
    saved_warning = fit.changes.length ? { item: fit.item, name: setup.name, changes: fit.changes } : null;
    if (!(await applySetup(setup))) { saved_warning = null; renderItem(); }
}

// The name box: Enter (or Save) saves the current setup under the name typed (or the item and its enchantments), Escape closes it. Refused, with the
// box staying open and saying why: a name this item already has a setup under (another item's may share it), or a setup already saved (same item,
// enchantments and rules) under any name.
function saveForm(done = () => { saving_setup = false; renderItem(); }) {
    const error = h("p", { class: "saved-form-error", role: "alert", hidden: true });
    const input = h("input", {
        type: "text", class: "rename-input", maxlength: MAX_SETUP_NAME, placeholder: defaultSetupName(), "aria-label": TEXT.page.save_name_label,
        onkeydown: event => { if (event.key === "Escape") { event.stopPropagation(); done(); } },
        oninput: () => { error.hidden = true; input.removeAttribute("aria-invalid"); }
    });
    return h("div", { class: "saved-form-box" },
        h("form", {
            class: "saved-form",
            onsubmit: event => {
                event.preventDefault();
                const name = input.value.trim() || defaultSetupName();
                const saved = saveSetup(name);
                if (!saved.ok) {
                    error.textContent = saved.error === "exists" ? TEXT.wanted.saved_exists({ name: saved.name })
                        : TEXT.wanted.saved_name_taken({ name, item: logic.itemName(state.item) });
                    error.hidden = false;
                    input.setAttribute("aria-invalid", "true");
                    input.focus();
                    return;
                }
                done(); renderItem(); renderPresetsMenu();
            }
        }, input, h("button", { type: "submit", class: "btn small primary" }, TEXT.page.save)),
        error);
}

// A list of saved setups (all of them, in the header's Presets menu and on the first screen): its item, name, how many enchantments, and × to
// remove it. A setup whose item isn't offered here can't be chosen and says why.
function savedList(list, extra_class = "") {
    return h("ul", { class: "saved-list " + extra_class }, list.map(setup => {
        const fit = setupFit(setup);
        const usable = Boolean(fit && fit.usable);
        return h("li", {},
            h("button", {
                type: "button", class: "saved-load", disabled: !usable, "data-focus": "saved-load-" + setup.item + "-" + setup.name, // (names repeat across items)
                title: usable ? TEXT.wanted.saved_load_help({ name: setup.name }) : TEXT.wanted.saved_unusable({ name: setup.name }),
                onclick: () => loadSaved(setup)
            },
                logic.isItem(setup.item) ? icon(setup.item, true) : null,
                h("span", { class: "saved-name" }, setup.name),
                usable ? h("span", { class: "saved-count" }, TEXT.wanted.saved_count({ count: Object.keys(fit.wanted).length })) : null),
            h("button", {
                type: "button", class: "saved-delete", title: TEXT.page.delete_saved, "aria-label": TEXT.page.delete_saved_label({ name: setup.name }),
                onclick: () => { deleteSetup(setup.name, setup.item); renderItem(); renderWanted(); renderPresetsMenu(); }
            }, "×"));
    }));
}

// The files of mods a saved setup names load once (not switched on), so its enchantments can be named; the lists redraw when they arrive.
function askSavedMods() {
    if (saved_mods_asked) return;
    saved_mods_asked = true;
    loadSavedMods().then(any => { if (any) { renderItem(); renderWanted(); renderPresetsMenu(); } });
}

// The conflict tree of a bracket (Logic conflictTree) drawn as nested sections: one code for Pick a side, Pick any and their mixtures, nested or not. A "side" node is a Pick one
// (all leaves) or a Pick a side (a lane for each part, holding that part's own groups); an "each" node is its loose enchantments in one
// lane and its other parts as blocks. A stray (set apart so the rest splits) shows in every lane holding something it conflicts with,
// marked with an arrow pair; its tooltip names everything it conflicts with, the lane's own first. Then the chosen rows once.
function pickGroupsSection(members, found, short, label) {
    const { tree, strays } = found;
    const chosen = ns => Boolean(state.wanted[ns]);
    const names = list => list.map(ns => logic.enchName(ns));
    const leavesOf = node => (node.kind === "leaf" ? [node.ns] : node.children.flatMap(leavesOf));
    const chip = (ns, lane_ids = null, radio = false) => {
        const rivals = chosen(ns) ? [] : members.filter(other => chosen(other) && logic.conflicts(ns, other));
        const stray = lane_ids !== null;
        const all = members.filter(other => logic.conflicts(ns, other));
        const here = stray ? lane_ids.filter(other => logic.conflicts(ns, other)) : [];
        const also = stray ? TEXT.wanted.group_stray_conflicts({ name: names([...here, ...all.filter(other => !here.includes(other))]) }) : null;
        // The tooltip is what the enchantment does; a stray adds everything it conflicts with. (No "Replaces ..." note.)
        const title = [logic.describe(ns), also].filter(Boolean).join("\n\n") || null;
        // A stray fades while something it conflicts with is chosen (and the reverse is shown by that pick's own chip).
        const faded = strays.includes(ns) && rivals.length > 0;
        return h("button", {
            type: "button", class: "switch-option" + (stray ? " bridge" : "") + (chosen(ns) ? " selected" : "") + (faded ? " blocked" : ""),
            // A lane where exactly one can be taken is a set of radios; several (Pick any, a stray) are toggles.
            ...(radio ? { role: "radio", "aria-checked": String(chosen(ns)) } : { "aria-pressed": String(chosen(ns)) }),
            "data-opt": ns, "data-focus": "group-" + (stray ? "stray-" : "") + ns + (stray ? "-" + lane_ids[0] : ""),
            title,
            onclick: () => setWanted(ns, chosen(ns) ? 0 : logic.maxLevel(ns)) // (a pick that conflicts drops the ones it replaces)
        }, logic.enchName(ns), stray ? [h("span", { class: "bridge-mark", "aria-hidden": "true" }, "⇄"), h("span", { class: "sr-only" }, " (" + TEXT.wanted.group_stray_also + ")")] : null);
    };
    const list = ids => names(ids).slice(0, 3).join(", ") + (ids.length > 3 ? "\u2026" : "");
    // The chips of a lane, then the strays that conflict with something in it.
    // `one`: exactly one of them can be taken (a Pick one), so they are radios; the strays beside them are toggles.
    const chips = (ids, title, one = false) => {
        const radios = one && ids.length > 1;
        const stray_chips = strays.filter(ns => !ids.includes(ns) && ids.some(other => logic.conflicts(ns, other))).map(ns => chip(ns, ids));
        // Radios alone are the radiogroup; with strays beside them, the radios are one inside the group.
        const radio_chips = () => roving(ids.map(ns => chip(ns, null, true)), ids.findIndex(chosen)); // one tab stop: the chosen one
        if (radios && !stray_chips.length) return h("div", { class: "group-switch", role: "radiogroup", "aria-label": title }, radio_chips());
        return h("div", { class: "group-switch", role: "group", "aria-label": title },
            radios ? h("div", { class: "radios", role: "radiogroup", "aria-label": title }, radio_chips()) : ids.map(ns => chip(ns)),
            stray_chips);
    };
    // `side`: the number of a side of a Pick a side (a badge and an accent bar mark the sides); `label`: the title is the section's own label.
    const card = (title, children, ids, { side = 0, label = false, of = 0 } = {}) => h("div", {
        class: "each-card" + (ids.some(chosen) ? " active" : "") + (side ? " side-lane" : ""),
        ...(side ? { role: "group", "aria-label": TEXT.wanted.group_side_of({ n: side, total: of }) } : {})
    },
        title || side ? h("div", { class: "each-card-title" + (label ? " label-title" : "") }, side ? h("span", { class: "side-badge" }, TEXT.wanted.group_side_n({ n: side })) : null, title) : null,
        children);
    const block = (label, children) => h("div", { class: "cluster" }, label ? h("div", { class: "cluster-label" }, label) : null, h("div", { class: "each-cards" }, children));
    // What fills a lane: a leaf is a chip, an "each" its own sections, a "side" a section.
    const inside = node => (node.kind === "leaf" ? chips([node.ns], logic.enchName(node.ns)) : node.kind === "each" ? eachBlocks(node) : sideBlock(node));
    // The loose enchantments of an "each" are a section labelled Pick any (as a Pick one is labelled Pick one), its other parts sections too.
    // `top`: the parts are the group's first level, so each is marked "Part N" (a part is its loose Pick any, or one of its other sections).
    function eachBlocks(node, top = false) {
        const loose = node.children.filter(child => child.kind === "leaf").map(child => child.ns);
        const parts = [
            loose.length ? h("div", { class: "cluster" }, card(TEXT.wanted.group_pick_any, chips(loose, TEXT.wanted.group_pick_any), loose, { label: true })) : null,
            ...node.children.filter(child => child.kind !== "leaf").map(part => sideBlock(part))
        ].filter(Boolean);
        return h("div", { class: "cluster-list" }, top
            ? parts.map((part, index) => h("div", { class: "part-box", role: "group", "aria-label": TEXT.wanted.group_part_of({ n: index + 1, total: parts.length }) }, h("div", { class: "part-badge" }, TEXT.wanted.group_part_n({ n: index + 1 })), part))
            : parts);
    }
    // `top`: the section is the whole group, whose header already names it ("Pick a side (25)"), so it has no label of its own.
    function sideBlock(node, top = false) {
        const ids = leavesOf(node);
        if (node.children.every(child => child.kind === "leaf")) {
            // A Pick one is one lane whose title is its label.
            return h("div", { class: "cluster" }, card(top ? null : TEXT.wanted.group_pick_one, chips(ids, TEXT.wanted.group_pick_one, true), ids, { label: !top }));
        }
        // The lone enchantments of a side all conflict with each other and the rest: one lane for them, then a lane for each other part.
        const lone = node.children.filter(child => child.kind === "leaf").map(child => child.ns);
        // Each side is marked by its badge alone; what is inside says how to pick from it (a Pick one, a Pick any, or a single chip).
        let side = 0;
        const rest = node.children.filter(child => child.kind !== "leaf");
        const total = (lone.length ? 1 : 0) + rest.length;
        return block(top ? null : TEXT.wanted.group_pick_side, [
            lone.length ? card(null, lone.length > 1 ? inside({ kind: "side", children: lone.map(ns => ({ kind: "leaf", ns })) }) : chips(lone, logic.enchName(lone[0])), lone, { side: ++side, of: total }) : null,
            rest.map(child => card(null, inside(child), leavesOf(child), { side: ++side, of: total }))
        ]);
    }
    return h("div", { class: "ench-group exclusive pick-side pick-groups" + (members.some(chosen) ? " has-chosen" : ""), "data-side": members[0], role: "group", "aria-label": label },
        h("div", { class: "cluster-list" }, tree.kind === "each" ? eachBlocks(tree, true) : sideBlock(tree, true)),
        h("div", { class: "each-rows" }, members.filter(chosen).map(ns => wantedRow(ns, short.get(ns)))));
}

// What a section of nested groups looks like before a redraw, by its first member: its chosen rows in order (a copy to fold
// away, the height, the level bar), the options selected, and the border colour.
function captureEach(box) {
    const old = new Map();
    for (const section of box.querySelectorAll(".pick-side[data-side]")) {
        old.set(section.dataset.side, {
            rows: [...section.querySelectorAll(".each-rows > .ench-row")].map(row => ({
                ns: row.dataset.ns, copy: inertCopy(row), height: row.getBoundingClientRect().height,
                levels: row.querySelectorAll(".level-seg").length, segments: [...row.querySelectorAll(".level-seg")].map(seg => seg.cloneNode(true))
            })),
            options: new Set([...section.querySelectorAll(".switch-option.selected")].map(button => button.dataset.opt)),
            blocked: new Set([...section.querySelectorAll(".switch-option.blocked")].map(button => button.dataset.opt)),
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
    // A stray conflict (Fire Aspect with Advanced Fire Aspect) that begins or stops fades down or back up.
    for (const button of section.querySelectorAll(".switch-option[data-opt]")) {
        const blocked = button.classList.contains("blocked");
        if (blocked !== old.blocked.has(button.dataset.opt) && old.options && !(old.options.has(button.dataset.opt) || button.classList.contains("selected"))) {
            button.animate([{ opacity: blocked ? 1 : 0.55 }, {}], { duration: 260, easing: "ease-out" });
        }
    }
    const selected = [...section.querySelectorAll(".switch-option.selected")];
    const keys = new Set(selected.map(button => button.dataset.opt));
    const look = selected[0] && getComputedStyle(selected[0]);
    for (const button of selected) if (!old.options.has(button.dataset.opt)) fadeOption(button, QUIET_OPTION);
    if (look) {
        for (const key of old.options) {
            const was = keys.has(key) ? null : section.querySelector(`[data-opt="${key}"]`);
            if (was) fadeOption(was, selectedLook(look));
        }
    }
    if (getComputedStyle(section).borderColor !== old.border) section.animate([{ borderColor: old.border }, {}], { duration: 300, easing: "ease-out" });
}

// A "Pick one" group (every pair conflicts): a switch for which one, or none, then the
// chosen one's row with its level bar. Switching picks the new one at its max level.
function groupSwitch(members, short, label) {
    const chosen = members.find(ns => state.wanted[ns]) || null;
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
        h("div", { class: "group-switch", role: "radiogroup", "aria-label": label },
            roving([option(null, TEXT.wanted.none), ...members.map(ns => option(ns, logic.enchName(ns)))], chosen ? members.indexOf(chosen) + 1 : 0) // one tab stop: the chosen one
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
        levelBar(ns, chosen, blockers),
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
export function levelBar(ns, chosen, blockers, onChoose = level => setWanted(ns, level), focus = "bar-") {
    const max = logic.maxLevel(ns);
    const segments = [];
    for (let level = 1; level <= max; level++) segments.push(h("span", { class: "level-seg", "data-level": level }, roman(level)));
    const bar = h("div", {
        class: "level-bar", role: "slider", tabindex: "0", "data-focus": focus + ns,
        "aria-label": TEXT.wanted.level_label({ name: logic.enchName(ns) }),
        "aria-valuemin": "0", "aria-valuemax": String(max),
        title: blockers.length ? TEXT.wanted.replaces({ name: blockers.map(logic.enchName) }) : null,
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
            // Only bars that show: not those in a folded group, a closed box or a hidden row.
            const shown = other => other === bar || (other.checkVisibility ? other.checkVisibility({ visibilityProperty: true }) : other.offsetParent !== null);
            const bars = [...(bar.closest(".entry-popover, #wanted") || document).querySelectorAll(".level-bar")].filter(shown);
            const next = bars[bars.indexOf(bar) + (event.key === "ArrowUp" ? -1 : 1)];
            event.preventDefault();
            if (next) {
                next.focus({ preventScroll: true });
                scrollToView(next);
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
    scrubber(bar, {
        at: event => levelAt(event.clientX, event.clientY), show, press_class: "dragging",
        done: (start, level, moved) => choose(!moved && start === chosen ? 0 : level),
        cancel: () => show(chosen)
    });
    return bar;
}
