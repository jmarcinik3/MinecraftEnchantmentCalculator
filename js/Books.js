// Section 2: books and items to start from (automatic or custom entries, cards and list, pickers, dragging).
import { MAX_COPIES, maxPriorWork, movePriority, roman } from "./Logic.js";
import { TEXT } from "./Text.js";
import { logic, nextBookId, state } from "./Store.js";
import { $, afterAnimation, closeOnOutside, enchLine, flash, h, icon, holdRepeat, motionOk, nameClass, plain, readStorage, roving, scrollToView, scrubber, segmented, svg, writeStorage } from "./Dom.js";
import { animateCards, animateChips, barSnapshot, chipSnapshot, cardRects, changeLines, leaveBar, pillRects, revealBar, rollChipsIn, rollChipsOut, slidePills, snapshotLines } from "./Motion.js";
import { focusState, levelBar, restoreFocus } from "./Wanted.js";
import { dragToReorder } from "./Ranking.js";
import { stepLimit } from "./Options.js";
import { previewMerge } from "./Calc.js";
import { infoTip, open_tips } from "./Tips.js";
import { addBook, clashes, commit, customizeBooks } from "./App.js";

// A small inline SVG (the page has no icon font); it takes its color from the text.
function svgIcon(view_box, shapes, attrs = {}) {
    return svg("svg", { viewBox: view_box, ...attrs }, shapes.map(([tag, shape]) => svg(tag, shape)));
}

const BOOKS_VIEW_STORAGE_KEY = "enchantment-calculator-books-view";
// Section 2: an Automatic | Custom switch, then one card per entry, drawn like the game
// (an inventory slot and a tooltip), two to a row where the section is wide enough. In
// Custom mode the cards are editable (see entryCard) and the add bar under the cards adds an entry.
// Cards slide to their new places when the list changes (animateCards).
export function renderBooks() {
    const box = $("#books");
    const focus = focusState(box);
    // Switching Cards/Slots/List morphs each card into its new shape (animateCards).
    const view_changed = box.dataset.view != null && box.dataset.view !== books_view;
    box.dataset.view = books_view;
    // Switching Automatic/Custom keeps the entries that are still there (matched by what they hold).
    const mode = state.auto_books ? "auto" : "custom";
    const mode_changed = box.dataset.mode != null && box.dataset.mode !== mode;
    box.dataset.mode = mode;
    const old_rects = cardRects(box, view_changed || mode_changed);
    const old_pills = pillRects(box);
    const old_chips = chipSnapshot(box.querySelector(":scope > .coverage"));
    const old_strip = barSnapshot(box.querySelector(":scope > .coverage"));
    const old_sigs = book_sigs;
    const old_grid = box.querySelector(".entry-grid");
    const old_keys = [...box.querySelectorAll(".entry-card[data-key]")].map(card => card.dataset.key).join();
    const old_cards = view_changed || mode_changed ? new Map() : oldTooltips(box);
    const old_height = old_grid ? old_grid.getBoundingClientRect().height : null;
    // Emptying the section shortens the page for a moment, and near its bottom the
    // browser scrolls up to fit; the scroll goes back once the cards are in again.
    const scroll = scrollY;
    box.replaceChildren();
    $("#books-alert").replaceChildren();
    if (!state.item) return;

    const books = logic.currentBooks(state);
    const custom = !state.auto_books;
    const check = custom ? logic.checkBooks(state) : null;
    if (check) renderBooksAlert(check);
    const unwanted = new Set(check ? check.unwanted : []);
    if (entry_popover && !(custom && state.books.some(book => book.id === entry_popover.id))) entry_popover = null;

    book_sigs = new Map(books.map(book => [String(book.id), bookSignature(book)]));
    const grid = h("div", { class: "entry-grid" + (books_view === "list" ? " list" : books_view === "slots" ? " slots" : "") },
        books.map((book, index) => entryCard(book, index, books.length, custom, unwanted)),
        custom ? addCard() : null
    );
    box.append(...[
        h("div", { class: "toolbar" },
            modeSwitch(),
            viewSwitch()
        ),
        custom ? coverageStrip() : null,
        grid
    ].filter(Boolean));
    if (entry_popover) placePopover(grid);
    // The same entries in the same order (only their enchantments changed): the tooltips' lines
    // animate in place, as in section 1, and the layout follows them. Otherwise the cards slide.
    const new_keys = [...box.querySelectorAll(".entry-card[data-key]")].map(card => card.dataset.key).join();
    slidePills(box, old_pills);
    const strip = box.querySelector(":scope > .coverage");
    if (mode_changed) {
        if (strip && !old_strip) revealBar(strip);
        else if (!strip && old_strip) leaveBar(box.querySelector(".toolbar"), old_strip);
    } else if (coverage_roll && strip) {
        rollChipsIn(strip, old_chips.height);
    } else if (strip && old_strip && !coverage_rolled_in) {
        animateChips(strip, old_chips);
    }
    coverage_roll = false;
    coverage_rolled_in = false;
    if (mode_changed) {
        const { matched, leaving } = matchOldCards(old_rects, books, old_sigs);
        animateCards(box, matched, old_height, "mode", leaving);
    } else if (!view_changed && old_cards.size && old_keys === new_keys) animateLines(box, old_cards);
    else animateCards(box, old_rects, old_height, view_changed ? "view" : false); // holds the old height while it slides
    if (scrollY !== scroll) scrollTo(scrollX, scroll);
    restoreFocus(box, focus);
    if (fresh_entry != null) {
        const id = fresh_entry;
        fresh_entry = null;
        // The grid clips what hangs below it (the picker) while it slides open: wait for that.
        setTimeout(() => revealEntry(id), motionOk() ? REVEAL_DELAY_MS : 0);
    }
}

// The entry just added (a new book, a copy, a typed book): once the grid has slid open,
// scroll just far enough to show its card, and its picker if one opened, and flash the
// card. On a phone the add area is at the bottom, so the new card would otherwise appear
// below the fold with nothing to say where it went. Never scrolls the card off the top.
const REVEAL_DELAY_MS = 320;
let fresh_entry = null;

export function markFresh(book) {
    fresh_entry = book.id;
}

function revealEntry(id) {
    const card = document.querySelector(`#books .entry-card[data-key="${id}"]`);
    if (!card) return;
    flash(card);
    const picker = document.querySelector("#books .entry-popover.enchant");
    const top = card.getBoundingClientRect().top;
    const bottom = (picker || card).getBoundingClientRect().bottom;
    const margin = 12;
    let move = 0;
    if (top < margin) move = top - margin;
    else if (bottom > innerHeight - margin) move = Math.min(bottom - innerHeight + margin, top - margin);
    if (Math.abs(move) > 1) scrollBy({ top: move, behavior: motionOk() ? "smooth" : "auto" });
}

// What each entry held at the last draw (by id), to find it again after a change of mode, when
// the ids change: its kind and enchantments.
let book_sigs = new Map();
function bookSignature(book) {
    return book.type + ":" + Object.entries(book.enchantments).map(([ns, level]) => ns + level).sort().join(",");
}

// After Automatic <-> Custom: each new entry takes the old card that held the same, in order;
// the old cards left over fade out where they were, the new ones left over fade in.
function matchOldCards(old_rects, books, old_sigs) {
    const old_entries = [...old_rects].filter(([key]) => key !== "add-card");
    const used = new Set();
    const matched = new Map();
    for (const book of books) {
        const sig = bookSignature(book);
        const found = old_entries.find(([key]) => !used.has(key) && old_sigs.get(key) === sig);
        if (!found) continue;
        used.add(found[0]);
        matched.set(String(book.id), found[1]);
    }
    if (old_rects.has("add-card")) matched.set("add-card", old_rects.get("add-card"));
    return { matched, leaving: old_entries.filter(([key]) => !used.has(key)).map(([, spec]) => spec) };
}

// Back to Automatic: the custom list is dropped.
function useAutomatic() {
    state.auto_books = true;
    state.books = [];
    entry_popover = null;
    commit();
}

// Automatic (one book per chosen enchantment) or Custom (your own list). Custom starts
// from the automatic list; going back to Automatic drops the custom one.
function modeSwitch() {
    const option = (auto, label, help) => ({
        selected: state.auto_books === auto, content: label,
        attrs: { "data-focus": "mode-" + (auto ? "auto" : "custom"), title: help },
        onclick: () => {
            if (state.auto_books === auto) return;
            if (auto) useAutomatic();
            else customizeBooks();
        }
    });
    return segmented("mode-switch", TEXT.books.mode_label, [option(true, TEXT.books.automatic, TEXT.books.automatic_help), option(false, TEXT.books.custom, TEXT.books.custom_help)]);
}

// One entry as the game draws it: a slot (with the stack count when there are several
// copies) and a tooltip (its name, then its enchantments; "!" on ones not chosen in
// section 1). Editable cards also have: the grip (drag to reorder), the slot as a
// book/item switch, the copies and prior work badges (they open a small popover), the
// tooltip's lines (tap: the picker, at that enchantment; drag onto another card: move
// it there) and "+ Add enchantment" (the picker), duplicate (⧉) and remove (×).
// Read-only cards (Automatic) show a badge only when it isn't the default. In the List
// view each entry is one row: a small slot, its enchantments (tap: the picker), the
// badges and the buttons. In the Slots view an entry is only its slot (slotCell).
function entryCard(book, index, count, editable, unwanted) {
    if (books_view === "slots") return slotCell(book, index, count, editable, unwanted);
    const key = String(book.id);
    const is_item = book.type === "item";
    const item_name = logic.itemName(state.item);
    const list = Object.entries(book.enchantments).map(([namespace, level]) => ({ namespace, level }));
    const enchanted = list.length > 0;
    const copies = book.copies || 1;
    const prior_work = book.prior_work || 0;
    const name = is_item ? item_name : enchanted ? TEXT.results.enchanted_book : TEXT.books.book;
    const open = entry_popover && entry_popover.id === book.id ? entry_popover.kind : null;
    const compact = books_view === "list";

    const slot = h("div", { class: "mc-slot" + (enchanted ? " glint" : "") },
        icon(is_item ? state.item : "book"),
        copies > 1 ? h("span", { class: "stack-count", "aria-hidden": "true" }, copies) : null
    );
    const switch_label = is_item ? TEXT.books.switch_to_book : TEXT.books.switch_to_item({ item: item_name });
    const slot_button = editable ? h("button", {
        type: "button", class: "entry-slot", "data-focus": "slot-" + key, title: switch_label, "aria-label": switch_label,
        onclick: () => { book.type = is_item ? "book" : "item"; commit(); },
        onpointerdown: event => mergeDrag(event, book)
    }, slot, h("span", { class: "swap-glyph", "aria-hidden": "true" }, svgIcon("0 0 12 12", [
        ["path", { d: "M1.5 4h8.5M8 2l2 2-2 2" }], ["path", { d: "M10.5 8H2M4 6l-2 2 2 2" }]
    ], { fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round", "stroke-linejoin": "round" }))) : slot;
    // The corner of the slot edits the number of copies (− and +, the wheel changes it too).
    if (!editable) slot.addEventListener("pointerdown", event => mergeDrag(event, book));
    const slot_part = editable ? h("div", { class: "entry-slot-wrap" }, slot_button, copiesControl(book, key, copies)) : slot;

    // Copies show as the stack count on the slot (its corner edits them); prior work is an
    // anvil badge only when it isn't 0. Without that badge an editable entry has a quiet ⋯
    // that opens the prior work track, shown while the entry is hovered or focused (always on touch).
    const work_open = open === "work";
    const badge = (content, label) => {
        if (!editable) return h("span", { class: "entry-badge", title: label, "aria-label": label }, content);
        return h("button", {
            type: "button", class: "entry-badge popover-toggle" + (work_open ? " open" : ""),
            "data-focus": "work-" + key, "aria-label": label, title: TEXT.books.count_help,
            "aria-expanded": String(work_open), onclick: () => togglePopover(book.id, "work", "work-" + key)
        }, content);
    };
    const work_badge = prior_work ? badge([h("img", { class: "badge-anvil", src: "img/anvil.svg", alt: "" }), prior_work], TEXT.books.work_badge({ count: prior_work })) : null;
    const more = editable && !work_badge ? h("button", {
        type: "button", class: "entry-more popover-toggle" + (work_open ? " open" : ""), "data-focus": "more-" + key,
        title: TEXT.books.count_help, "aria-label": TEXT.books.count_help, "aria-expanded": String(work_open),
        onclick: () => togglePopover(book.id, "work", "more-" + key)
    }, "⋯") : null;
    const badges = work_badge || more ? h("div", { class: "entry-badges" }, work_badge, more) : null;
    const tools = editable ? [
        h("button", {
            // popover-toggle: it opens the copy's picker, so its click isn't one "outside" it.
            type: "button", class: "entry-tool popover-toggle", "data-focus": "dup-" + key, title: TEXT.books.duplicate_help,
            "aria-label": TEXT.books.duplicate_label({ number: index + 1 }), onclick: () => duplicateEntry(book)
        }, "⧉"),
        h("button", {
            type: "button", class: "tag-remove entry-remove", "data-focus": "remove-" + key,
            "aria-label": TEXT.books.remove_entry_label({ number: index + 1 }),
            onclick: event => removeEntry(book, event.currentTarget.closest(".entry-card"))
        }, "×")
    ] : [];

    if (compact) {
        const flagged = list.some(e => unwanted.has(e.namespace));
        const text = enchanted ? logic.summary(list) : editable ? TEXT.books.add_enchantment : "";
        // The slot already says book or item, so the row shows only the enchantments.
        const content = [
            text ? h("span", { class: "entry-summary-list" + (enchanted ? "" : " no-enchantments") },
                flagged ? h("span", { class: "tag-flag", "aria-label": TEXT.books.unwanted_label, title: TEXT.books.unwanted_help }, "!") : null, text) : null
        ];
        const summary = editable ? h("button", {
            type: "button", class: "entry-summary popover-toggle" + (open === "enchant" ? " open" : ""), "data-focus": "add-" + key,
            title: TEXT.books.edit_list, "aria-label": name + ": " + (text || TEXT.books.add_enchantment), "aria-expanded": String(open === "enchant"),
            onclick: () => togglePopover(book.id, "enchant", "add-" + key)
        }, content) : h("span", { class: "entry-summary" }, content);
        return h("div", { class: "entry-card compact" + (open ? " popover-open" : "") + (pointer_in === key ? " pointer-in" : ""), "data-index": index, "data-key": key, ...pointerIn(key) },
            editable ? entryHandle(index, count) : null, slot_part, summary, badges, tools);
    }

    const lines = logic.tooltipSort(list).map(e => {
        const flagged = unwanted.has(e.namespace);
        const content = [
            flagged ? h("span", { class: "tag-flag", "aria-label": TEXT.books.unwanted_label }, "!") : null,
            logic.displayName(e.namespace, e.level)
        ];
        const cls = "mc-ench" + (logic.isCurse(e.namespace) ? " curse" : "");
        if (!editable) return h("div", { class: cls, "data-ns": e.namespace, "data-level": e.level, title: flagged ? TEXT.books.unwanted_help : null }, content);
        const focus = "line-" + key + "-" + e.namespace;
        return h("button", {
            type: "button", class: cls + " entry-line popover-toggle", "data-focus": focus, "data-ns": e.namespace, "data-level": e.level,
            title: flagged ? TEXT.books.unwanted_help : TEXT.books.edit_line,
            onpointerdown: event => lineDragStart(event, book, e.namespace),
            onclick: () => { if (Date.now() - line_drag_ended > 400) togglePopover(book.id, "enchant", focus, e.namespace); }
        }, content);
    });
    const adding = open === "enchant";
    const add_attrs = {
        type: "button", "data-focus": "add-" + key, "aria-expanded": String(adding),
        onclick: () => togglePopover(book.id, "enchant", "add-" + key)
    };
    // An entry with enchantments adds one from a small "+" in its name row (no line of its
    // own on every card); an empty one spells it out.
    let plus = null;
    if (editable && enchanted) {
        plus = h("button", { ...add_attrs, class: "entry-add-plus popover-toggle" + (adding ? " open" : ""), title: TEXT.books.add_enchantment_label, "aria-label": TEXT.books.add_enchantment_label }, "+");
    } else if (editable) {
        lines.push(h("button", { ...add_attrs, class: "mc-ench entry-add popover-toggle" + (adding ? " open" : "") }, TEXT.books.add_enchantment));
    }

    // The slot beside the tooltip; editable ones have a strip above the tooltip for the
    // grip, badges and buttons.
    const head = editable || badges ? h("div", { class: "entry-head" },
        editable ? entryHandle(index, count) : null,
        badges,
        editable ? h("div", { class: "entry-tools" }, tools) : null
    ) : null;
    // The strip's buttons (grip, prior work, copy, remove) are one tab stop; Left and Right move along them (Up and Down on the grip reorder).
    if (head && editable) roving([...head.querySelectorAll("button")], 0, { prev: ["ArrowLeft"], next: ["ArrowRight"] });
    return h("div", { class: "entry-card" + (head ? "" : " bare") + (open ? " popover-open" : "") + (pointer_in === key ? " pointer-in" : ""), "data-index": index, "data-key": key, ...pointerIn(key) },
        slot_part,
        head,
        h("div", { class: "mc-tooltip entry-tooltip" },
            h("div", { class: "entry-title" },
                h("div", { class: nameClass(logic.rarity(is_item ? state.item : "book", enchanted)) }, name),
                plus),
            lines
        )
    );
}

// × fades the card out, then removes the entry. The focus goes to the × of the entry that
// takes its place (or the one before it), else to Add book, so the keyboard keeps its spot.
function removeEntry(book, card) {
    // Only for the keyboard: after a mouse click the focus would light the next card's tools.
    const keyboard = document.activeElement && document.activeElement.matches(":focus-visible");
    const remove = () => {
        const index = state.books.indexOf(book);
        dropBook(book);
        if (entry_popover && entry_popover.id === book.id) entry_popover = null;
        commit();
        if (!keyboard) return;
        const next = state.books[Math.min(index, state.books.length - 1)];
        const target = (next && document.querySelector(`#books [data-focus="remove-${next.id}"]`)) || document.querySelector('#books [data-focus="add-book"]');
        if (target) target.focus({ preventScroll: true });
    };
    if (!card || !motionOk()) return remove();
    card.style.pointerEvents = "none";
    afterAnimation(card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.94)" }],
        { duration: 160, easing: "ease-in", fill: "forwards" }), remove, 250);
}

// ⧉ adds a copy right after the entry, with its picker open, to change it from there.
function duplicateEntry(book) {
    const copy = { ...book, id: nextBookId(), enchantments: { ...book.enchantments }, copies: 1 };
    state.books.splice(state.books.indexOf(book) + 1, 0, copy);
    openPicker(copy);
    markFresh(copy);
    commit();
    focusPicker();
}

// One of section 1's fixes (a book at the chosen level, replacing lower ones it makes
// unnecessary), from the warning badge or the coverage strip.
function applyFix(ns, wanted) {
    const adding = logic.addBook(state, ns, wanted);
    state.books = adding.books.map(book => (book.id == null ? { ...book, id: nextBookId() } : book));
    commit();
}

// Each card's tooltip before a redraw (by entry id): its height and its enchantment lines
// (text copies and boxes), for animateLines.
function oldTooltips(box) {
    const cards = new Map();
    for (const card of box.querySelectorAll(".entry-card[data-key]:not(.compact):not(.slotcell)")) {
        const tip = card.querySelector(".mc-tooltip");
        if (!tip) continue;
        const { rect, lines } = snapshotLines(tip);
        cards.set(card.dataset.key, { height: rect.height, lines });
    }
    return cards;
}

// The tooltips that changed animate like section 1's (but never slide their width): a
// swap that leaves the box the same size rolls the changed rows (rollLines), otherwise new
// lines open and removed ones fold away (openLines/closeLines), and the lines moving the
// box open or shut is what moves the cards below.
function animateLines(box, old_cards) {
    if (!motionOk()) return;
    for (const card of box.querySelectorAll(".entry-card[data-key]:not(.compact):not(.slotcell)")) {
        const old = old_cards.get(card.dataset.key);
        const tip = card.querySelector(".mc-tooltip");
        if (!old || !tip) continue;
        const lines = [...tip.querySelectorAll(".mc-ench[data-ns]")];
        const same = lines.map(line => line.dataset.ns + ":" + line.dataset.level).join() === old.lines.map(line => line.ns + ":" + line.node.dataset.level).join();
        if (same) continue;
        const before = new Set(old.lines.map(line => line.ns));
        changeLines(card, old.lines, lines.filter(line => !before.has(line.dataset.ns)), Math.abs(tip.getBoundingClientRect().height - old.height) < 1);
    }
}

// Custom mode, above the entries: each enchantment chosen in section 1 that the entries
// don't reach is an amber chip (it applies its fix); the ones they do reach are green
// with ✓, and from three of them on they fold into one "✓ All 7 reached" chip, which
// opens the list.
let coverage_open = false;
let coverage_roll = false; // the next redraw shows the chips: they roll out of the summary chip (Motion.js rollChipsIn)
let coverage_closing = false;
let coverage_rolled_in = false; // the chips have just rolled back in: the redraw that drops them must not animate them again

// Opening redraws, then the chips roll out row by row; closing rolls them back in first (last row first).
function toggleCoverage(summary) {
    if (coverage_closing) return;
    if (!coverage_open) {
        coverage_open = true;
        coverage_roll = true;
        renderBooks();
        return;
    }
    coverage_closing = true;
    summary.setAttribute("aria-expanded", "false");
    summary.querySelector(".cover-caret").textContent = "▾";
    rollChipsOut(summary.closest(".coverage"), () => {
        coverage_closing = false;
        coverage_open = false;
        coverage_rolled_in = true;
        renderBooks();
    });
}

function coverageStrip() {
    const chosen = Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level }));
    if (!chosen.length) return null;
    const best = logic.bestLevels(state);
    const sorted = logic.tooltipSort(chosen);
    const reached = sorted.filter(({ namespace: ns, level }) => (best[ns] || 0) >= level);
    const short = sorted.filter(item => !reached.includes(item));
    const okChip = ({ namespace: ns, level }) => {
        const name = logic.displayName(ns, level);
        return h("span", { "data-ns": ns, class: "cover-chip ok draggable", title: TEXT.books.cover_ok({ name }) + ". " + TEXT.books.chip_drag_hint, onpointerdown: event => chipDrag(event, ns, level) }, "✓ ", name);
    };
    const folded = reached.length >= 3;
    const summary_text = short.length ? TEXT.books.cover_some({ count: reached.length, total: sorted.length }) : TEXT.books.cover_all({ count: reached.length });
    // A ring filled by the share of chosen enchantments the entries reach.
    const CIRCLE = 2 * Math.PI * 6;
    const ring = svgIcon("0 0 16 16", [
        ["circle", { cx: "8", cy: "8", r: "6", class: "ring-track" }],
        ["circle", { cx: "8", cy: "8", r: "6", class: "ring-fill", "stroke-dasharray": `${(reached.length / sorted.length) * CIRCLE} ${CIRCLE}`, transform: "rotate(-90 8 8)" }]
    ], { fill: "none", "stroke-width": "2.5", class: "cover-ring", "aria-hidden": "true" });
    const summary = folded ? h("button", {
        type: "button", class: "cover-chip ok summary", "data-focus": "cover-summary", "aria-expanded": String(coverage_open),
        title: TEXT.books.cover_toggle, "aria-label": summary_text + ". " + TEXT.books.cover_toggle,
        onclick: event => toggleCoverage(event.currentTarget)
    }, ring, summary_text, h("span", { class: "cover-caret", "aria-hidden": "true" }, coverage_open ? "▴" : "▾")) : null;
    return h("div", { class: "coverage", role: "group", "aria-label": TEXT.books.coverage_label },
        short.map(({ namespace: ns, level }) => {
            const name = logic.displayName(ns, level);
            const reach = best[ns] || 0;
            const fix = TEXT.books.fix_new_book({ name });
            return h("button", {
                type: "button", class: "cover-chip short draggable", "data-focus": "cover-" + ns, "data-ns": ns, title: fix + ". " + TEXT.books.chip_drag_hint, "aria-label": fix,
                onclick: () => applyFix(ns, level), onpointerdown: event => chipDrag(event, ns, level)
            }, "+ ", name, h("span", { class: "cover-best" }, reach ? TEXT.books.fix_best({ level: roman(reach) }) : TEXT.wanted.not_on_books));
        }),
        summary,
        !folded || coverage_open ? reached.map(okChip) : null
    );
}

// Cards (two to a row where there is room), Slots (only the slot) or List (one row per entry); remembered here.
const stored_view = readStorage(BOOKS_VIEW_STORAGE_KEY, "cards");
let books_view = ["list", "slots"].includes(stored_view) ? stored_view : "cards";

function viewSwitch() {
    const icons = {
        cards: () => svgIcon("0 0 16 16", [["rect", { x: "2", y: "2", width: "5", height: "5", rx: "1" }], ["rect", { x: "9", y: "2", width: "5", height: "5", rx: "1" }],
            ["rect", { x: "2", y: "9", width: "5", height: "5", rx: "1" }], ["rect", { x: "9", y: "9", width: "5", height: "5", rx: "1" }]], { fill: "currentColor" }),
        slots: () => svgIcon("0 0 16 16", [2, 6, 10].flatMap(y => [2, 6, 10].map(x => ["rect", { x: String(x), y: String(y), width: "4", height: "4", rx: "0.6" }])), { fill: "currentColor" }),
        list: () => svgIcon("0 0 16 16", [["rect", { x: "2", y: "3", width: "12", height: "2", rx: "1" }], ["rect", { x: "2", y: "7", width: "12", height: "2", rx: "1" }],
            ["rect", { x: "2", y: "11", width: "12", height: "2", rx: "1" }]], { fill: "currentColor" })
    };
    const option = (view, label) => ({
        selected: books_view === view, content: icons[view](),
        attrs: { "data-focus": "view-" + view, title: label, "aria-label": label },
        onclick: () => {
            if (books_view === view) return;
            books_view = view;
            writeStorage(BOOKS_VIEW_STORAGE_KEY, view);
            renderBooks();
        }
    });
    return segmented("view-switch", TEXT.books.view_label, [option("cards", TEXT.books.view_cards), option("slots", TEXT.books.view_slots), option("list", TEXT.books.view_list)]);
}

// The grid's last cell in Custom mode: add a book or another copy of the item, or type
// a book's enchantments ("prot 4, mending"; Logic.js parseBooks). What it couldn't add stays in the box,
// with a note saying why.
let typed_text = "";
let typed_note = "";
// The copies a field holds: a whole number from 1 to MAX_COPIES (anything else is 1).
function copiesOf(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) ? Math.max(1, Math.min(MAX_COPIES, number)) : 1;
}

function addCard() {
    const item_name = logic.itemName(state.item);
    return h("div", { class: "entry-add-card" },
        h("div", { class: "entry-add-buttons" },
            h("button", { type: "button", class: "btn small popover-toggle", "data-focus": "add-book", onclick: () => addBook("book") }, icon("book", true), TEXT.books.add_book),
            h("button", { type: "button", class: "btn small", "data-focus": "add-item", onclick: () => addBook("item") }, icon(state.item, true), TEXT.books.add_item({ item: item_name.toLowerCase() }))
        ),
        h("form", { class: "type-add", onsubmit: event => { event.preventDefault(); addTyped(typed_text); } },
            h("input", {
                type: "text", class: "type-add-input", value: typed_text, "data-focus": "type-add", autocomplete: "off",
                placeholder: TEXT.books.type_placeholder, "aria-label": TEXT.books.type_label, title: TEXT.books.type_label,
                oninput: event => { typed_text = event.target.value; }
            }),
            h("button", { type: "submit", class: "btn small" }, TEXT.books.type_add)
        ),
        typed_note ? h("p", { class: "type-note", role: "status" }, typed_note) : null
    );
}

// Adds one book with every typed enchantment (commas or "+" between them). One that
// can't be read, or that conflicts with an enchantment already on the anvil or typed
// before it, is left out and stays in the box. A book identical to an entry becomes
// another copy of it.
function addTyped(text) {
    const skipped = [];
    const kept = [];
    const enchantments = {};
    const taken = state.books.flatMap(book => Object.keys(book.enchantments));
    // "x3" (or "3x", "×3") beside any piece sets the copies of the whole book.
    let copies = null;
    for (const original of text.split(/[,;+]+/).map(part => part.trim()).filter(Boolean)) {
        let piece = original;
        const alone = piece.match(/^(?:[x×]\s*(\d+)|(\d+)\s*[x×])$/i);
        if (alone) {
            copies = copiesOf(alone[1] || alone[2]);
            continue;
        }
        const times = piece.match(/^(\d+)\s*[x×]\s*(.+)$/i) || piece.match(/^(.+?)(?:\s+|(?<=\d))[x×]\s*(\d+)$/i);
        if (times) {
            const prefix = /^\d+$/.test(times[1]);
            copies = copiesOf(prefix ? times[1] : times[2]);
            piece = prefix ? times[2] : times[1];
        }
        const result = logic.parseBooks(piece, state.item);
        if (result.unknown.length || !result.books.length) {
            skipped.push(piece);
            kept.push(original);
            continue;
        }
        for (const [ns, level] of Object.entries(result.books[0])) {
            const other = [...taken, ...Object.keys(enchantments)].find(existing => clashes(existing, ns));
            if (other) {
                skipped.push(TEXT.books.type_conflict({ name: logic.enchName(ns), other: logic.enchName(other) }));
                kept.push(original);
                continue;
            }
            enchantments[ns] = Math.max(enchantments[ns] || 0, level);
        }
    }
    if (Object.keys(enchantments).length) {
        addOrStack({ id: nextBookId(), type: "book", enchantments, prior_work: 0, copies: copies || 1 });
    }
    typed_text = kept.join(", ");
    typed_note = skipped.length ? TEXT.books.type_skipped({ names: skipped }) : "";
    commit();
}

// A new book joins the list, or, when an identical one is there, its copies join that one's; the entry shows.
function addOrStack(book) {
    const twin = logic.twinOf(state.books, book);
    if (twin) twin.copies = Math.min(MAX_COPIES, (twin.copies || 1) + (book.copies || 1));
    else state.books.push(book);
    markFresh(twin || book);
}

// Dragging an enchantment line onto another card moves it there (keeping the higher level
// if that card has it already); a card whose enchantments conflict with it shows a red
// outline and won't take it. Mouse: drag once it has moved a few pixels. Touch: press
// and hold first, so a swipe over a card still scrolls the page. A plain tap opens the
// picker as usual.
let dragging_any = false;
let line_drag_ended = 0; // when the last drag ended: the click that follows it isn't a tap

function lineDragStart(event, book, ns) {
    const source = event.currentTarget.closest(".entry-card");
    let target = null;
    const canTake = other => !Object.keys(other.enchantments).some(existing => existing !== ns && clashes(existing, ns));
    const mark = card => {
        for (const other of document.querySelectorAll("#books .entry-card")) other.classList.remove("drop-ok", "drop-no");
        target = null;
        if (!card || card === source) return;
        const other = state.books.find(entry => String(entry.id) === card.dataset.key);
        if (!other) return;
        const ok = canTake(other);
        card.classList.add(ok ? "drop-ok" : "drop-no");
        if (ok) target = other;
    };
    dragGesture(event, {
        make() {
            source.classList.add("drag-source");
            return enchantGhost(ns, book.enchantments[ns]);
        },
        over: found => mark(found && found.closest("#books .entry-card[data-key]")),
        end(dropped, ghost) {
            ghost.remove();
            source.classList.remove("drag-source");
            const drop = dropped ? target : null;
            mark(null);
            if (drop) moveEnchantment(book, drop, ns);
        }
    });
}

// Takes an entry off the list.
function dropBook(book) {
    state.books = state.books.filter(other => other !== book);
}

// A book whose last enchantment moved away is a plain book, and goes (an item stays).
function moveEnchantment(from, to, ns) {
    const level = from.enchantments[ns];
    delete from.enchantments[ns];
    to.enchantments[ns] = Math.max(to.enchantments[ns] || 0, level);
    if (isPlainBook(from)) dropBook(from);
    entry_popover = null;
    commit();
}

// The click that ends a drag isn't a tap on what is under the pointer. A drag that Escape
// ended still has the button down: the click comes when it is let go.
function swallowClick(done) {
    const swallow = click => { click.stopPropagation(); click.preventDefault(); };
    addEventListener("click", swallow, { capture: true, once: true });
    const forget = () => setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
    if (done && done.type === "cancel") addEventListener("pointerup", forget, { capture: true, once: true });
    else forget();
}

// The little tooltip that follows the pointer while an enchantment is dragged.
function enchantGhost(ns, level) {
    return h("div", { class: "mc-tooltip line-ghost", "aria-hidden": "true" },
        enchLine(logic.displayName(ns, level), logic.isCurse(ns)));
}

// Where a drag's ghost goes: beside the pointer (below right of it; above, or to its left, when that would cover `keep`, the title row
// of the card under the pointer), always inside the window.
function ghostSpot(ghost, x, y, keep) {
    const width = ghost.offsetWidth;
    const height = ghost.offsetHeight;
    const margin = 8;
    const clamp = (value, size, limit) => Math.max(margin, Math.min(value, limit - size - margin));
    const covered = (left, top) => {
        if (!keep) return 0;
        const across = Math.min(left + width, keep.right) - Math.max(left, keep.left);
        const down = Math.min(top + height, keep.bottom) - Math.max(top, keep.top);
        return across > 0 && down > 0 ? across * down : 0;
    };
    const spots = [[x + 14, y + 10], [x + 14, y - height - 10], [x - width - 14, y + 10], [x - width - 14, y - height - 10]]
        .map(([left, top]) => ({ left: clamp(left, width, innerWidth), top: clamp(top, height, innerHeight) }));
    let best = spots[0];
    for (const spot of spots) {
        if (covered(spot.left, spot.top) < covered(best.left, best.top)) best = spot;
    }
    return best;
}

// A drag that starts on `event`'s target: with a mouse once it has moved a few pixels, on touch
// after a 350ms hold (so a swipe still scrolls). `make()` returns the ghost that follows the
// pointer, `over(element)` is told what is under it, and `end(dropped, ghost)` runs when it
// stops (the click that ends a drag is swallowed). A plain click never starts one.
function dragGesture(event, { make, over, end }) {
    if (!event.isPrimary || event.button > 0) return;
    const touch = event.pointerType !== "mouse";
    const start = { x: event.clientX, y: event.clientY };
    let ghost = null;
    let hold = null;
    const place = (x, y) => {
        const under = document.elementFromPoint(x, y);
        over(under); // (it may change what the ghost shows, so its size is read after)
        const card = under && under.closest(".entry-card");
        const title = card && card.querySelector(".entry-title, .entry-summary, .mc-name");
        const spot = ghostSpot(ghost, x, y, title ? title.getBoundingClientRect() : null);
        ghost.style.left = spot.left + "px";
        ghost.style.top = spot.top + "px";
    };
    const begin = () => {
        dragging_any = true;
        getSelection().removeAllRanges();
        ghost = make();
        document.body.append(ghost);
        document.body.classList.add("dragging");
        place(start.x, start.y);
    };
    const move = moved => {
        if (moved.pointerId !== event.pointerId) return;
        const far = Math.hypot(moved.clientX - start.x, moved.clientY - start.y) > 6;
        if (!dragging_any) {
            if (!far) return;
            if (touch) return finish(); // a swipe: let the page scroll
            begin();
        }
        place(moved.clientX, moved.clientY);
    };
    const finish = done => {
        clearTimeout(hold);
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", finish);
        removeEventListener("pointercancel", finish);
        removeEventListener("keydown", escape, true);
        if (!dragging_any) return;
        dragging_any = false;
        line_drag_ended = Date.now();
        document.body.classList.remove("dragging");
        swallowClick(done);
        end(Boolean(done && done.type === "pointerup"), ghost);
    };
    if (touch) hold = setTimeout(begin, 350);
    // Escape drops the drag where it is: nothing moves.
    const escape = key => {
        if (key.key !== "Escape" || !dragging_any) return;
        key.stopPropagation();
        finish({ type: "cancel" });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", finish);
    addEventListener("pointercancel", finish);
    addEventListener("keydown", escape, true);
}

// Drag an entry's slot onto another entry to see what putting it on that one would cost on the
// anvil (the target is the first slot, the dragged one the second): the levels, or "Too
// expensive!", or that they can't be merged, and what comes out. Nothing changes.
function mergeDrag(event, book) {
    const source = event.currentTarget.closest(".entry-card");
    const entryOf = other => [other.type === "item" ? state.item : "book", Object.entries(other.enchantments), other.prior_work || 0];
    let target = null;
    let chip = null;
    let token = 0;
    const clear = () => { for (const card of document.querySelectorAll("#books .entry-card.merge-target")) card.classList.remove("merge-target"); };
    const show = result => {
        if (!result.ok) {
            chip.className = "merge-chip bad";
            chip.replaceChildren(TEXT.books.merge_impossible);
            return;
        }
        const too_much = result.levels > stepLimit(); // the game allows 39, "Too Expensive!" from 40
        chip.className = "merge-chip " + (too_much ? "bad" : "ok");
        chip.replaceChildren(
            h("div", {}, too_much ? TEXT.books.merge_too_expensive + " " : "", TEXT.books.merge_levels({ levels: result.levels })),
            result.enchantments.length ? h("div", { class: "merge-result" }, logic.summary(result.enchantments)) : null
        );
    };
    dragGesture(event, {
        make() {
            chip = h("div", { class: "merge-chip" });
            source.classList.add("drag-source");
            return h("div", { class: "merge-ghost", "aria-hidden": "true" }, source.querySelector(".mc-slot").cloneNode(true), chip);
        },
        over(element) {
            const card = element && element.closest("#books .entry-card[data-key]");
            const next = card && card !== source ? card : null;
            if (next === target) return;
            clear();
            target = next;
            token++;
            chip.className = "merge-chip";
            chip.replaceChildren();
            const other = next && logic.currentBooks(state).find(entry => String(entry.id) === next.dataset.key);
            if (!other) return;
            next.classList.add("merge-target");
            chip.replaceChildren("…");
            // A book with no enchantments is a plain book: the anvil does nothing with it.
            if (isPlainBook(other) || isPlainBook(book)) { show({ ok: false }); return; }
            const mine = token;
            previewMerge(entryOf(other), entryOf(book)).then(result => { if (mine === token) show(result); });
        },
        end(dropped, ghost) {
            clear();
            source.classList.remove("drag-source");
            // Let go over a card: the answer stays a moment, then fades.
            if (dropped && target && chip.textContent) {
                ghost.classList.add("done");
                setTimeout(() => ghost.remove(), 1600);
            } else {
                ghost.remove();
            }
        }
    });
}

// Drag a coverage chip onto an entry to put that enchantment, at the chosen level, on it, or onto
// the add bar to make a new book of it. An entry that has a conflicting enchantment, or one
// that conflicts with an enchantment on another entry, is outlined red and won't take it.
function chipDrag(event, ns, level) {
    let target = null;
    const clear = () => { for (const card of document.querySelectorAll("#books .drop-ok, #books .drop-no")) card.classList.remove("drop-ok", "drop-no"); };
    dragGesture(event, {
        make: () => enchantGhost(ns, level),
        over(element) {
            clear();
            target = null;
            const card = element && element.closest("#books .entry-card[data-key], #books .entry-add-card");
            if (!card) return;
            const book = card.dataset.key ? state.books.find(entry => String(entry.id) === card.dataset.key) : null;
            if (card.dataset.key && !book) return;
            const elsewhere = state.books.filter(entry => entry !== book).flatMap(entry => Object.keys(entry.enchantments));
            const blocked = elsewhere.some(other => other !== ns && clashes(other, ns));
            card.classList.add(blocked ? "drop-no" : "drop-ok");
            if (!blocked) target = { book };
        },
        end(dropped, ghost) {
            ghost.remove();
            clear();
            if (!dropped || !target) return;
            if (target.book) {
                setEntryLevel(target.book, ns, level);
                markFresh(target.book);
                return;
            }
            addOrStack({ id: nextBookId(), type: "book", enchantments: { [ns]: level }, prior_work: 0, copies: 1 });
            commit();
        }
    });
}

// The open popover in section 2: { id: the entry's id, kind: "work" | "enchant",
// toggle: the data-focus of the button that opened it, ns: an enchantment to show and
// highlight in the picker (once) }, or null. `picker_all`: the picker also lists the
// enchantments not chosen in section 1.
let entry_popover = null;
let picker_all = false;
let picker_query = "";              // what is typed in the picker's search box
const picker_mods_open = new Set(); // the mods whose group is open in the picker

function togglePopover(id, kind, toggle, ns = null) {
    const here = entry_popover && entry_popover.id === id && entry_popover.kind === kind;
    const previous = entry_popover && entry_popover.id;
    if (here && !ns) {
        entry_popover = null;
    } else {
        if (!here) { picker_all = false; picker_query = ""; }
        entry_popover = { id, kind, toggle, ns };
    }
    // Leaving a book that got no enchantments drops it, as closing its picker does.
    const left = previous != null && (!entry_popover || entry_popover.id !== previous)
        ? state.books.find(other => other.id === previous) : null;
    if (left && isPlainBook(left)) {
        dropBook(left);
        commit();
    } else renderBooks();
    // The picker goes after the whole grid, so the focus moves into it (the keys then work
    // there at once); Escape brings it back to the button that opened it.
    if (entry_popover && entry_popover.kind === "enchant") focusPicker(entry_popover.ns);
    else if (entry_popover) {
        const first = document.querySelector("#books .entry-popover.count button:not(:disabled)");
        if (first) first.focus({ preventScroll: true });
    }
    if (entry_popover && entry_popover.ns) entry_popover.ns = null; // highlighted once, not on every redraw
}

// The caller commits. A plain book whose picker was open (Add book twice) goes.
export function openPicker(book) {
    const open = entry_popover && entry_popover.id !== book.id && state.books.find(other => other.id === entry_popover.id);
    if (open && isPlainBook(open)) dropBook(open);
    picker_all = false;
    picker_query = "";
    entry_popover = { id: book.id, kind: "enchant", toggle: "add-" + book.id, ns: null };
}

// Brings the picker into view and puts the focus on a level bar: `ns`'s, or the first.
export function focusPicker(ns = null) {
    const picker = document.querySelector("#books .entry-popover.enchant");
    if (!picker) return;
    const row = ns && picker.querySelector(`.picker-row[data-ns="${ns}"]`);
    const bar = (row || picker).querySelector(".level-bar");
    if (bar) bar.focus({ preventScroll: true });
    scrollToView(row || picker);
}

// The popover goes in the grid (so it can be as wide as the grid) just under its card.
// "count" is the copies and prior work steppers, lined up with its card; "enchant" is
// the enchantment picker, the grid's full width.
function placePopover(grid) {
    const book = state.books.find(other => other.id === entry_popover.id);
    const card = grid.querySelector(`.entry-card[data-key="${book.id}"]`);
    const popover = entry_popover.kind === "enchant" ? enchantPicker(book) : countPopover(book);
    grid.append(popover);
    popover.style.top = card.offsetTop + card.offsetHeight + 6 + "px";
    // The copies and prior work popovers line up with their card (kept inside the grid).
    if (entry_popover.kind !== "enchant") popover.style.left = Math.max(0, Math.min(card.offsetLeft, grid.clientWidth - popover.offsetWidth)) + "px";
}

// "work": the anvil track, one icon per use.
function countPopover(book) {
    return h("div", { class: "entry-popover count", role: "group", "aria-label": TEXT.books.prior_work_help }, workRow(book, book.id));
}

function setCopies(book, value) {
    book.copies = Math.max(1, Math.min(MAX_COPIES, value));
}

// Prior work as anvils, like a level bar: tap the nth for n uses (the last one again takes one
// off, the 0 clears) or press and drag across them (the choice is made on release), with what
// it costs under them. The keyboard presses them one by one.
function workRow(book, key) {
    const prior_work = book.prior_work || 0;
    const max = Math.max(prior_work, Math.min(8, maxPriorWork(stepLimit())));
    const penalty = 2 ** prior_work - 1;
    const set = value => { book.prior_work = value; commit(); };
    const pips = [h("button", {
        type: "button", class: "anvil-pip zero", "data-focus": "pop-work-" + key + "-0", "aria-label": TEXT.books.work_badge({ count: 0 }),
        "aria-pressed": String(prior_work === 0), onclick: event => { if (event.detail === 0) set(0); }
    }, "0")];
    for (let uses = 1; uses <= max; uses++) {
        pips.push(h("button", {
            type: "button", class: "anvil-pip" + (uses <= prior_work ? " on" : ""), "data-focus": "pop-work-" + key + "-" + uses,
            "aria-label": TEXT.books.work_badge({ count: uses }), "aria-pressed": String(uses <= prior_work),
            onclick: event => { if (event.detail === 0) set(prior_work === uses ? uses - 1 : uses); }
        }, h("img", { src: "img/anvil.svg", alt: "", draggable: "false" })));
    }
    const show = value => pips.forEach((pip, index) => {
        pip.classList.toggle("on", index > 0 && index <= value);
        pip.setAttribute("aria-pressed", String(index === 0 ? value === 0 : index <= value));
    });
    // The count under the pointer, by position, so a drag also works over the gaps.
    const at = x => {
        let value = 0;
        pips.forEach((pip, index) => { if (x >= pip.getBoundingClientRect().left) value = index; });
        return value;
    };
    const track = h("div", { class: "anvil-pips" }, pips);
    scrubber(track, {
        at: event => at(event.clientX), show, prevent: true,
        done: (start, value, moved) => set(moved ? value : start > 0 && start === prior_work ? start - 1 : start),
        cancel: () => show(prior_work)
    });
    return h("div", { class: "work-row" },
        h("span", { class: "stepper-label", title: TEXT.books.prior_work_help }, TEXT.books.prior_work),
        track,
        h("p", { class: "popover-note" }, penalty ? TEXT.books.prior_work_cost({ levels: penalty }) : TEXT.books.prior_work_none)
    );
}

// The card under the pointer, kept across redraws: a card drawn anew under a still pointer isn't
// :hover until the pointer moves, so − and + (and the Slots view's tooltip) would vanish after each
// click. The redrawn card gets .pointer-in, which the CSS treats like :hover.
let pointer_in = null;
function pointerIn(key) {
    return {
        onpointerenter: event => { if (event.pointerType === "mouse") pointer_in = key; },
        onpointerleave: event => { if (pointer_in === key) pointer_in = null; event.currentTarget.classList.remove("pointer-in"); }
    };
}

// The slot's bottom-right corner: − and + under the stack count (which is inside the slot, as in the game), (shown on hover or
// focus, always on touch). Holding a button repeats (the cards redraw on each step, the
// results once when it is let go); scrolling over the corner adds or takes one off.
function copiesControl(book, key, copies) {
    const step = (delta, label, disabled, text) => h("button", {
        type: "button", class: "copies-step", "aria-label": label, "data-focus": "copies-" + key + (delta < 0 ? "-minus" : "-plus"), disabled,
        onpointerdown: event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            holdRepeat(event, () => { setCopies(book, (book.copies || 1) + delta); renderBooks(); }, { done: commit });
        },
        // A keyboard press (no pointer) steps once.
        onclick: event => { if (event.detail === 0) { setCopies(book, copies + delta); commit(); } }
    }, text);
    return h("span", {
        class: "copies-control" + (copies > 1 ? " has" : ""), role: "group", title: TEXT.books.copies_edit({ count: copies }),
        "aria-label": TEXT.books.copies_edit({ count: copies }),
        onwheel: event => { event.preventDefault(); setCopies(book, copies + (event.deltaY < 0 ? 1 : -1)); commit(); }
    },
        step(-1, TEXT.books.decrease_label({ label: TEXT.books.copies }), copies <= 1, "−"),
        step(1, TEXT.books.increase_label({ label: TEXT.books.copies }), copies >= MAX_COPIES, "+"));
}

// The slots view: an entry is only its slot (glint, stack count); its tooltip shows on hover
// or focus and a click opens the picker. Copies are on the slot's corner; Duplicate, Remove and
// prior work are in the picker.
function slotCell(book, index, count, editable, unwanted) {
    const key = String(book.id);
    const is_item = book.type === "item";
    const list = Object.entries(book.enchantments).map(([namespace, level]) => ({ namespace, level }));
    const enchanted = list.length > 0;
    const copies = book.copies || 1;
    const prior_work = book.prior_work || 0;
    const name = is_item ? logic.itemName(state.item) : enchanted ? TEXT.results.enchanted_book : TEXT.books.book;
    const open = entry_popover && entry_popover.id === book.id ? entry_popover.kind : null;
    const flagged = list.some(e => unwanted.has(e.namespace));
    const label = name + (enchanted ? ": " + logic.summary(list) : "");
    const slot = h("div", { class: "mc-slot" + (enchanted ? " glint" : "") },
        icon(is_item ? state.item : "book"),
        copies > 1 ? h("span", { class: "stack-count", "aria-hidden": "true" }, copies) : null,
        flagged ? h("span", { class: "slot-flag", "aria-hidden": "true" }, "!") : null
    );
    const tip = h("div", { class: "slot-tip mc-tooltip", "aria-hidden": "true" },
        h("div", { class: nameClass(logic.rarity(is_item ? state.item : "book", enchanted)) }, name),
        logic.tooltipSort(list).map(e => enchLine(logic.displayName(e.namespace, e.level), logic.isCurse(e.namespace))),
        prior_work ? h("div", { class: "mc-ench" }, TEXT.books.work_badge({ count: prior_work })) : null
    );
    const main = editable ? h("button", {
        type: "button", class: "slot-cell-button popover-toggle", "data-focus": "add-" + key, "aria-label": label,
        "aria-expanded": String(open === "enchant"),
        onclick: () => togglePopover(book.id, "enchant", "add-" + key),
        onpointerdown: event => mergeDrag(event, book)
    }, slot) : h("div", { class: "slot-cell-button", role: "img", "aria-label": label, onpointerdown: event => mergeDrag(event, book) }, slot);
    return h("div", { class: "entry-card slotcell" + (open ? " popover-open" : "") + (pointer_in === key ? " pointer-in" : ""), "data-index": index, "data-key": key, ...pointerIn(key) },
        main, tip, editable ? copiesControl(book, key, copies) : null,
        // The grip in the corner reorders (drag it onto another slot, or use the arrow keys); the slot itself drags to preview a merge.
        editable ? entryHandle(index, count) : null);
}

// The enchantments this entry can take, each with a level bar (0 takes it off): the ones
// chosen in section 1, then (after "Show all", or when nothing is chosen there) the
// rest; the rest it already has show either way. One that conflicts with an enchantment
// on this entry is dimmed and replaces it; one that conflicts with another entry can't
// be added. The row of an enchantment tapped on the card is highlighted.
function enchantPicker(book) {
    const key = book.id;
    const others = state.books.filter(other => other !== book).flatMap(other => Object.keys(other.enchantments));
    const options = logic.applicable(state.item);
    const wanted = options.filter(ns => ns in state.wanted);
    // A mod's enchantments (the ones not chosen in section 1) are with the others behind "Show all", folded under its name.
    const modded = options.filter(ns => logic.modOf(ns) && !(ns in state.wanted));
    const rest = options.filter(ns => !(ns in state.wanted) && !logic.modOf(ns));
    const query = plain(picker_query);
    const rest_shown = picker_all || !wanted.length ? rest : rest.filter(ns => book.enchantments[ns]);
    const modded_shown = picker_all || !wanted.length ? modded : modded.filter(ns => book.enchantments[ns]);
    const hidden = rest.length - rest_shown.length + modded.length - modded_shown.length;
    const spot = entry_popover && entry_popover.ns;
    const row = ns => {
        const level = book.enchantments[ns] || 0;
        const elsewhere = !level && others.find(other => clashes(other, ns));
        const here = !level && Object.keys(book.enchantments).find(other => clashes(other, ns));
        return h("div", {
            class: "picker-row" + (level ? " chosen" : "") + (elsewhere ? " blocked" : here ? " conflict" : "") +
                (logic.isCurse(ns) ? " curse" : "") + (spot === ns ? " spot" : ""),
            "data-ns": ns
        },
            h("span", { class: "picker-name" }, logic.enchName(ns),
                elsewhere ? h("span", { class: "note" }, TEXT.books.on_other_entry({ name: logic.enchName(elsewhere) })) : null),
            elsewhere ? null : levelBar(ns, level, here ? [here] : [], value => setEntryLevel(book, ns, value), "pick-" + key + "-")
        );
    };
    const more = wanted.length && (rest.length || modded.length) && (picker_all || hidden) ? h("button", {
        type: "button", class: "picker-more", "data-focus": "pick-more-" + key,
        onclick: () => { picker_all = !picker_all; renderBooks(); }
    }, picker_all ? TEXT.books.show_fewer : TEXT.books.show_all({ count: hidden })) : h("span");
    const search = h("input", {
        type: "search", class: "picker-search", value: picker_query, "data-focus": "pick-search", placeholder: TEXT.books.picker_search,
        "aria-label": TEXT.books.picker_search,
        oninput: event => {
            picker_query = event.target.value;
            renderBooks();
            const again = document.querySelector('#books [data-focus="pick-search"]');
            if (again) again.setSelectionRange(picker_query.length, picker_query.length);
        }
    });
    if (query) {
        const found = options.filter(ns => plain(logic.enchName(ns) + " " + logic.describe(ns)).includes(query));
        return h("div", { class: "entry-popover enchant", role: "group", "aria-label": TEXT.books.picker_label },
            search, found.length ? found.map(row) : h("p", { class: "hint" }, TEXT.books.picker_no_match),
            h("div", { class: "popover-foot" }, h("span"), pickerButtons(book, key)));
    }
    const mod_rows = new Map();
    for (const ns of modded_shown) {
        if (!mod_rows.has(logic.modOf(ns))) mod_rows.set(logic.modOf(ns), []);
        mod_rows.get(logic.modOf(ns)).push(ns);
    }
    return h("div", { class: "entry-popover enchant", role: "group", "aria-label": TEXT.books.picker_label },
        search,
        wanted.length && (rest_shown.length || modded_shown.length) ? h("div", { class: "picker-head" }, TEXT.books.picker_chosen) : null,
        wanted.map(row),
        wanted.length && (rest_shown.length || modded_shown.length) ? h("div", { class: "picker-head" }, TEXT.books.picker_other) : null,
        rest_shown.map(row),
        [...mod_rows].map(([mod, list]) => h("details", {
            class: "mod-section", open: list.some(ns => book.enchantments[ns]) || picker_mods_open.has(mod),
            ontoggle: event => { if (event.target.open) picker_mods_open.add(mod); else picker_mods_open.delete(mod); }
        }, h("summary", {}, TEXT.wanted.mod_group({ name: mod, count: list.length })), list.map(row))),
        books_view === "slots" ? workRow(book, key) : null,
        h("div", { class: "popover-foot" }, more, pickerButtons(book, key))
    );
}

// The picker's foot buttons: (in the Slots view) switch kind, duplicate and remove, then Done.
function pickerButtons(book, key) {
    return [
        books_view === "slots" ? h("span", { class: "foot-actions" },
            h("button", { type: "button", class: "btn small", "data-focus": "pick-type-" + key,
                onclick: () => { book.type = book.type === "item" ? "book" : "item"; commit(); } },
                book.type === "item" ? TEXT.books.switch_to_book : TEXT.books.switch_to_item({ item: logic.itemName(state.item) })),
            h("button", { type: "button", class: "btn small", "data-focus": "pick-dup-" + key, onclick: () => duplicateEntry(book) }, TEXT.books.duplicate_short),
            h("button", { type: "button", class: "btn small", "data-focus": "pick-remove-" + key,
                onclick: () => removeEntry(book, document.querySelector(`#books .entry-card[data-key="${key}"]`)) }, TEXT.books.remove_short)) : null,
        h("button", { type: "button", class: "btn small", "data-focus": "pick-done-" + key, onclick: () => closePopover(true) }, TEXT.books.done)
    ];
}

// A level for `ns` on an entry (0 takes it off). It replaces a conflicting enchantment
// on the same entry. Only when a new, empty book gets its first enchantment does it
// become one more copy of an identical entry: changing an entry later never makes it
// disappear into another.
function setEntryLevel(book, ns, level) {
    if (level) {
        const was_empty = Object.keys(book.enchantments).length === 0;
        for (const other of Object.keys(book.enchantments)) if (clashes(other, ns)) delete book.enchantments[other];
        book.enchantments[ns] = level;
        const twin = was_empty ? logic.twinOf(state.books, book) : null;
        if (twin) {
            twin.copies = Math.min(MAX_COPIES, (twin.copies || 1) + (book.copies || 1));
            dropBook(book);
            entry_popover = null;
        }
    } else {
        delete book.enchantments[ns];
    }
    commit();
}

// Closes the popover; `refocus` puts the focus back on the button that opened it. A book
// left with no enchantments (Add book, then nothing picked) is a plain book that does
// nothing on the anvil, so it goes.
function closePopover(refocus) {
    const toggle = entry_popover && entry_popover.toggle;
    const book = entry_popover && state.books.find(other => other.id === entry_popover.id);
    entry_popover = null;
    if (book && isPlainBook(book)) {
        dropBook(book);
        commit();
        const add = refocus && document.querySelector('#books [data-focus="add-book"]');
        if (add) add.focus();
        return;
    }
    renderBooks();
    const again = refocus && toggle && document.querySelector(`#books [data-focus="${toggle}"]`);
    if (again) again.focus();
}

function isPlainBook(book) {
    return book.type === "book" && Object.keys(book.enchantments).length === 0;
}

// The popover closes on a click outside it (and the buttons that open one) or on Escape.
export function setupEntryPopover() {
    closeOnOutside({
        open: () => entry_popover,
        inside: event => event.composedPath().some(el => el.classList && (el.classList.contains("entry-popover") || el.classList.contains("popover-toggle"))),
        close: () => closePopover(false),
        escape: () => closePopover(true)
    });
    // While a line is dragged by touch, the page must not scroll under it.
    document.addEventListener("touchmove", event => { if (dragging_any) event.preventDefault(); }, { passive: false });
}

// "⚠ 1" next to the section heading when chosen enchantments can't be reached; it
// opens the details. It sits in the heading's empty space, so it never moves anything.
function renderBooksAlert(check) {
    const box = $("#books-alert");
    if (!check.short.length) {
        open_tips.delete("books-alert-tip");
        box.replaceChildren();
        return;
    }
    // After the fixes, a way out: let Automatic make the books.
    const details = [...check.short.map(fixSuggestion), h("div", { class: "fix" },
        h("div", { class: "fix-title" }, TEXT.books.automatic),
        h("button", { type: "button", class: "fix-option", onclick: useAutomatic },
            h("span", { class: "fix-action" }, TEXT.books.alert_auto),
            h("span", { class: "fix-replaces" }, TEXT.books.alert_auto_note)))];
    box.replaceChildren(infoTip("books-alert-tip", TEXT.books.alert({ count: check.short.length }),
        TEXT.books.alert_label({ count: check.short.length }), details, "alert"));
}

// One chosen enchantment the list can't reach, and the fix: a single book at the chosen
// level, replacing the lower books of it that are then unnecessary. The button says what
// it replaces before it is clicked.
function fixSuggestion({ ns, wanted, best }) {
    const adding = logic.addBook(state, ns, wanted);
    const replaced = adding.removed.map(book => {
        const name = logic.displayName(ns, book.enchantments[ns]);
        const entry = book.type === "item" ? TEXT.books.replaced_item({ item: logic.itemName(state.item), enchantment: name }) : name;
        return book.copies > 1 ? TEXT.books.copies_of({ count: book.copies, name: entry }) : entry;
    }).concat(adding.dropped.map(other => logic.displayName(other.ns, other.level)));
    const fix = h("button", {
        type: "button", class: "fix-option",
        onclick: event => {
            // The list redraws, so this click would look like one outside the bubble.
            event.stopPropagation();
            // Stay open for the remaining warnings, also when it was opened by hovering:
            // the redrawn bubble is new, so hover alone would not keep it up. It closes
            // by itself once nothing is short (renderBooksAlert forgets it then).
            open_tips.add("books-alert-tip");
            applyFix(ns, wanted);
        }
    },
        h("span", { class: "fix-action" }, TEXT.books.fix_new_book({ name: logic.displayName(ns, wanted) })),
        replaced.length ? h("span", { class: "fix-replaces" }, TEXT.books.fix_replaces({ names: replaced })) : null
    );
    return h("div", { class: "fix" },
        h("div", { class: "fix-title" }, logic.displayName(ns, wanted),
            h("span", { class: "fix-best" }, best ? TEXT.books.fix_best({ level: roman(best) }) : TEXT.wanted.not_on_books)),
        fix
    );
}

// Moves custom entry `from` to position `to`. The order is only for the user: the
// search tries every order anyway.
function moveEntry(from, to) {
    state.books = movePriority(state.books, from, to - from);
    commit();
}

// The grip for reordering an entry: drag it (mouse or touch), or focus it and use the
// up/down arrow keys. Only the grip takes over touch, so the page still scrolls by
// swiping on the rest of the entry.
function entryHandle(index, count) {
    return h("button", {
        type: "button",
        class: "drag-handle",
        "aria-label": TEXT.books.reorder_label({ number: index + 1 }),
        title: TEXT.books.reorder_help,
        onpointerdown: event => dragToReorder(event, event.currentTarget.closest(".entry-card"), index, ".entry-card",
            moveEntry, renderBooks),
        onkeydown: event => {
            const offset = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            const to = index + offset;
            if (!offset || to < 0 || to >= count) return;
            event.preventDefault();
            moveEntry(index, to);
            // The list was redrawn: keep the keyboard on the entry that moved.
            const handles = document.querySelectorAll("#books .drag-handle");
            if (handles[to]) handles[to].focus();
        }
    }, "⠿");
}
