// Section 2: books and items to start from (automatic or custom entries, cards and list, pickers, dragging).
import { MAX_COPIES, maxPriorWork, movePriority, roman } from "./Logic.js";
import { TEXT } from "./Text.js";
import { logic, nextBookId, state } from "./Store.js";
import { $, h, icon, motion_ok, readStorage, writeStorage } from "./Dom.js";
import { animateCards, cardRects, closeLines, openLines, rollLines } from "./Motion.js";
import { focusState, levelBar, restoreFocus } from "./Wanted.js";
import { dragToReorder } from "./Ranking.js";
import { stepLimit, stepper } from "./Options.js";
import { infoTip, open_tips } from "./Tips.js";
import { addBook, clashes, commit, customizeBooks } from "./App.js";

// A small inline SVG (the page has no icon font); it takes its color from the text.
function svgIcon(view_box, shapes, attrs = {}) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", view_box);
    for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
    for (const [tag, shape] of shapes) {
        const node = document.createElementNS(NS, tag);
        for (const [key, value] of Object.entries(shape)) node.setAttribute(key, value);
        svg.append(node);
    }
    return svg;
}

const BOOKS_VIEW_STORAGE_KEY = "enchantment-calculator-books-view";
// Section 2: an Automatic | Custom switch, then one card per entry, drawn like the game
// (an inventory slot and a tooltip), two to a row where the section is wide enough. In
// Custom mode the cards are editable (see entryCard) and the last cell adds an entry.
// Cards slide to their new places when the list changes (animateCards).
export function renderBooks() {
    const box = $("#books");
    const focus = focusState(box);
    // Switching Cards/List morphs each card into its new shape (animateCards).
    const view_changed = box.dataset.view != null && box.dataset.view !== books_view;
    box.dataset.view = books_view;
    const old_rects = cardRects(box);
    const old_grid = box.querySelector(".entry-grid");
    const old_keys = [...box.querySelectorAll(".entry-card[data-key]")].map(card => card.dataset.key).join();
    const old_cards = view_changed ? new Map() : oldTooltips(box);
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

    const grid = h("div", { class: "entry-grid" + (books_view === "list" ? " list" : "") },
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
    if (!view_changed && old_cards.size && old_keys === new_keys) animateLines(box, old_cards);
    else animateCards(box, old_rects, old_height, view_changed); // holds the old height while it slides
    if (scrollY !== scroll) scrollTo(scrollX, scroll);
    restoreFocus(box, focus);
    if (fresh_entry != null) {
        const id = fresh_entry;
        fresh_entry = null;
        // The grid clips what hangs below it (the picker) while it slides open: wait for that.
        setTimeout(() => revealEntry(id), motion_ok() ? REVEAL_DELAY_MS : 0);
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
    card.classList.remove("flash");
    void card.offsetWidth; // restart the flash
    card.classList.add("flash");
    const picker = document.querySelector("#books .entry-popover.enchant");
    const top = card.getBoundingClientRect().top;
    const bottom = (picker || card).getBoundingClientRect().bottom;
    const margin = 12;
    let move = 0;
    if (top < margin) move = top - margin;
    else if (bottom > innerHeight - margin) move = Math.min(bottom - innerHeight + margin, top - margin);
    if (Math.abs(move) > 1) scrollBy({ top: move, behavior: motion_ok() ? "smooth" : "auto" });
}

// Automatic (one book per chosen enchantment) or Custom (your own list). Custom starts
// from the automatic list; going back to Automatic drops the custom one.
function modeSwitch() {
    const option = (auto, label, help) => h("button", {
        type: "button", class: state.auto_books === auto ? "selected" : "", "aria-pressed": String(state.auto_books === auto),
        "data-focus": "mode-" + (auto ? "auto" : "custom"), title: help,
        onclick: () => {
            if (state.auto_books === auto) return;
            if (auto) {
                state.auto_books = true;
                state.books = [];
                entry_popover = null;
                commit();
            } else {
                customizeBooks();
            }
        }
    }, label);
    return h("div", { class: "segmented mode-switch", role: "group", "aria-label": TEXT.books.mode_label },
        option(true, TEXT.books.automatic, TEXT.books.automatic_help),
        option(false, TEXT.books.custom, TEXT.books.custom_help)
    );
}

// One entry as the game draws it: a slot (with the stack count when there are several
// copies) and a tooltip (its name, then its enchantments; "!" on ones not chosen in
// section 1). Editable cards also have: the grip (drag to reorder), the slot as a
// book/item switch, the copies and prior work badges (they open a small popover), the
// tooltip's lines (tap: the picker, at that enchantment; drag onto another card: move
// it there) and "+ Add enchantment" (the picker), duplicate (⧉) and remove (×).
// Read-only cards (Automatic) show a badge only when it isn't the default. In the List
// view each entry is one row: a small slot, its enchantments (tap: the picker), the
// badges and the buttons.
function entryCard(book, index, count, editable, unwanted) {
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
    const slot_part = editable ? h("button", {
        type: "button", class: "entry-slot", "data-focus": "slot-" + key, title: switch_label, "aria-label": switch_label,
        onclick: () => { book.type = is_item ? "book" : "item"; commit(); }
    }, slot, h("span", { class: "swap-glyph", "aria-hidden": "true" }, svgIcon("0 0 12 12", [
        ["path", { d: "M1.5 4h8.5M8 2l2 2-2 2" }], ["path", { d: "M10.5 8H2M4 6l-2 2 2 2" }]
    ], { fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round", "stroke-linejoin": "round" }))) : slot;

    // Copies show as the stack count on the slot; prior work is a badge only when it isn't 0.
    // Without that badge an editable entry has a quiet ⋯ that opens the steppers for both,
    // shown while the entry is hovered or focused (always on touch).
    const count_open = open === "count";
    const badge = (kind, content, label) => {
        if (!editable) return h("span", { class: "entry-badge", title: label, "aria-label": label }, content);
        return h("button", {
            type: "button", class: "entry-badge popover-toggle" + (count_open ? " open" : ""),
            "data-focus": kind + "-" + key, "aria-label": label, title: TEXT.books.count_help,
            "aria-expanded": String(count_open), onclick: () => togglePopover(book.id, "count", kind + "-" + key)
        }, content);
    };
    const set_badges = [
        prior_work ? badge("work", [h("img", { class: "badge-anvil", src: "img/anvil.png", alt: "" }), prior_work], TEXT.books.work_badge({ count: prior_work })) : null
    ].filter(Boolean);
    const more = editable && !set_badges.length ? h("button", {
        type: "button", class: "entry-more popover-toggle" + (count_open ? " open" : ""), "data-focus": "more-" + key,
        title: TEXT.books.count_help, "aria-label": TEXT.books.count_help, "aria-expanded": String(count_open),
        onclick: () => togglePopover(book.id, "count", "more-" + key)
    }, "⋯") : null;
    const badges = set_badges.length || more ? h("div", { class: "entry-badges" }, set_badges, more) : null;
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
        return h("div", { class: "entry-card compact" + (open ? " popover-open" : ""), "data-index": index, "data-key": key },
            editable ? entryHandle(index, count) : null, slot_part, summary, badges, tools);
    }

    const lines = logic.tooltipSort(list).map(e => {
        const flagged = unwanted.has(e.namespace);
        const content = [
            flagged ? h("span", { class: "tag-flag", "aria-label": TEXT.books.unwanted_label }, "!") : null,
            logic.displayName(e.namespace, e.level)
        ];
        const cls = "mc-ench" + (logic.isCurse(e.namespace) ? " curse" : "") + (flagged ? " unwanted" : "");
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
    return h("div", { class: "entry-card" + (head ? "" : " bare") + (open ? " popover-open" : ""), "data-index": index, "data-key": key },
        slot_part,
        head,
        h("div", { class: "mc-tooltip entry-tooltip" },
            h("div", { class: "entry-title" },
                h("div", { class: "mc-name rarity-" + logic.rarity(is_item ? state.item : "book", enchanted) }, name),
                plus),
            lines
        )
    );
}

// × fades the card out, then removes the entry.
function removeEntry(book, card) {
    const remove = () => {
        state.books = state.books.filter(other => other !== book);
        if (entry_popover && entry_popover.id === book.id) entry_popover = null;
        commit();
    };
    if (!card || !motion_ok()) return remove();
    card.style.pointerEvents = "none";
    // The timer covers a fade that never ends (a hidden tab), so the entry still goes.
    let done = false;
    const once = () => { if (!done) { done = true; remove(); } };
    card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.94)" }],
        { duration: 160, easing: "ease-in", fill: "forwards" }).finished.then(once, once);
    setTimeout(once, 250);
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
    for (const card of box.querySelectorAll(".entry-card[data-key]:not(.compact)")) {
        const tip = card.querySelector(".mc-tooltip");
        if (!tip) continue;
        const rect = tip.getBoundingClientRect();
        const lines = [...tip.querySelectorAll(".mc-ench[data-ns]")].map(line => {
            const box = line.getBoundingClientRect();
            const copy = line.cloneNode(true);
            // A copy that is only for show: nothing in it may take focus or be found by data-focus.
            copy.removeAttribute("data-focus");
            copy.setAttribute("tabindex", "-1");
            copy.classList.remove("popover-toggle");
            return { ns: line.dataset.ns, node: copy, box: { left: box.left - rect.left - tip.clientLeft, top: box.top - rect.top - tip.clientTop, width: box.width, height: box.height } };
        });
        cards.set(card.dataset.key, { height: rect.height, lines });
    }
    return cards;
}

// The tooltips that changed animate like section 1's (but never slide their width): a
// swap that leaves the box the same size rolls the changed rows (rollLines), otherwise new
// lines open and removed ones fold away (openLines/closeLines), and the lines moving the
// box open or shut is what moves the cards below.
function animateLines(box, old_cards) {
    if (!motion_ok()) return;
    for (const card of box.querySelectorAll(".entry-card[data-key]:not(.compact)")) {
        const old = old_cards.get(card.dataset.key);
        const tip = card.querySelector(".mc-tooltip");
        if (!old || !tip) continue;
        const lines = [...tip.querySelectorAll(".mc-ench[data-ns]")];
        const same = lines.map(line => line.dataset.ns + ":" + line.dataset.level).join() === old.lines.map(line => line.ns + ":" + line.node.dataset.level).join();
        if (same) continue;
        if (Math.abs(tip.getBoundingClientRect().height - old.height) < 1) {
            rollLines(card, old.lines);
        } else {
            const before = new Set(old.lines.map(line => line.ns));
            openLines(lines.filter(line => !before.has(line.dataset.ns)));
            closeLines(card, old.lines);
        }
    }
}

// Custom mode, above the entries: each enchantment chosen in section 1 that the entries
// don't reach is an amber chip (it applies its fix); the ones they do reach are green
// with ✓, and from three of them on they fold into one "✓ All 7 reached" chip, which
// opens the list.
let coverage_open = false;

function coverageStrip() {
    const chosen = Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level }));
    if (!chosen.length) return null;
    const best = logic.bestLevels(state);
    const sorted = logic.tooltipSort(chosen);
    const reached = sorted.filter(({ namespace: ns, level }) => (best[ns] || 0) >= level);
    const short = sorted.filter(item => !reached.includes(item));
    const okChip = ({ namespace: ns, level }) => {
        const name = logic.displayName(ns, level);
        return h("span", { class: "cover-chip ok", title: TEXT.books.cover_ok({ name }) }, "✓ ", name);
    };
    const folded = reached.length >= 3;
    const summary_text = short.length ? TEXT.books.cover_some({ count: reached.length }) : TEXT.books.cover_all({ count: reached.length });
    const summary = folded ? h("button", {
        type: "button", class: "cover-chip ok summary", "data-focus": "cover-summary", "aria-expanded": String(coverage_open),
        title: TEXT.books.cover_toggle, "aria-label": summary_text + ". " + TEXT.books.cover_toggle,
        onclick: () => { coverage_open = !coverage_open; renderBooks(); }
    }, summary_text, h("span", { class: "cover-caret", "aria-hidden": "true" }, coverage_open ? "▴" : "▾")) : null;
    return h("div", { class: "coverage", role: "group", "aria-label": TEXT.books.coverage_label },
        short.map(({ namespace: ns, level }) => {
            const name = logic.displayName(ns, level);
            const reach = best[ns] || 0;
            const fix = TEXT.books.fix_new_book({ name });
            return h("button", {
                type: "button", class: "cover-chip short", "data-focus": "cover-" + ns, title: fix, "aria-label": fix,
                onclick: () => applyFix(ns, level)
            }, "+ ", name, h("span", { class: "cover-best" }, reach ? TEXT.books.fix_best({ level: roman(reach) }) : TEXT.wanted.not_on_books));
        }),
        summary,
        !folded || coverage_open ? reached.map(okChip) : null
    );
}

// Cards (two to a row where there is room) or List (one row per entry); remembered here.
let books_view = readStorage(BOOKS_VIEW_STORAGE_KEY, "cards") === "list" ? "list" : "cards";

function viewSwitch() {
    const icons = {
        cards: () => svgIcon("0 0 16 16", [["rect", { x: "2", y: "2", width: "5", height: "5", rx: "1" }], ["rect", { x: "9", y: "2", width: "5", height: "5", rx: "1" }],
            ["rect", { x: "2", y: "9", width: "5", height: "5", rx: "1" }], ["rect", { x: "9", y: "9", width: "5", height: "5", rx: "1" }]], { fill: "currentColor" }),
        list: () => svgIcon("0 0 16 16", [["rect", { x: "2", y: "3", width: "12", height: "2", rx: "1" }], ["rect", { x: "2", y: "7", width: "12", height: "2", rx: "1" }],
            ["rect", { x: "2", y: "11", width: "12", height: "2", rx: "1" }]], { fill: "currentColor" })
    };
    const option = (view, label) => h("button", {
        type: "button", class: books_view === view ? "selected" : "", "aria-pressed": String(books_view === view),
        "data-focus": "view-" + view, title: label, "aria-label": label,
        onclick: () => {
            if (books_view === view) return;
            books_view = view;
            writeStorage(BOOKS_VIEW_STORAGE_KEY, view);
            renderBooks();
        }
    }, icons[view]());
    return h("div", { class: "segmented view-switch", role: "group", "aria-label": TEXT.books.view_label },
        option("cards", TEXT.books.view_cards), option("list", TEXT.books.view_list));
}

// The grid's last cell in Custom mode: add a book or another copy of the item, or type
// a book's enchantments ("prot 4, mending"; Logic.js parseBooks). What it couldn't add stays in the box,
// with a note saying why.
let typed_text = "";
let typed_note = "";

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
    for (const piece of text.split(/[,;+]+/).map(part => part.trim()).filter(Boolean)) {
        const result = logic.parseBooks(piece, state.item);
        if (result.unknown.length || !result.books.length) {
            skipped.push(piece);
            kept.push(piece);
            continue;
        }
        for (const [ns, level] of Object.entries(result.books[0])) {
            const other = [...taken, ...Object.keys(enchantments)].find(existing => clashes(existing, ns));
            if (other) {
                skipped.push(TEXT.books.type_conflict({ name: logic.enchName(ns), other: logic.enchName(other) }));
                kept.push(piece);
                continue;
            }
            enchantments[ns] = Math.max(enchantments[ns] || 0, level);
        }
    }
    if (Object.keys(enchantments).length) {
        const book = { id: nextBookId(), type: "book", enchantments, prior_work: 0, copies: 1 };
        const twin = logic.twinOf(state.books, book);
        if (twin) twin.copies = Math.min(MAX_COPIES, (twin.copies || 1) + 1);
        else state.books.push(book);
        markFresh(twin || book);
    }
    typed_text = kept.join(", ");
    typed_note = skipped.length ? TEXT.books.type_skipped({ names: skipped }) : "";
    commit();
}

// Dragging an enchantment line onto another card moves it there (keeping the higher level
// if that card has it already); a card whose enchantments conflict with it shows a red
// outline and won't take it. Mouse: drag once it has moved a few pixels. Touch: press
// and hold first, so a swipe over a card still scrolls the page. A plain tap opens the
// picker as usual.
let line_dragging = false;
let line_drag_ended = 0; // when the last drag ended: the click that follows it isn't a tap

function lineDragStart(event, book, ns) {
    if (!event.isPrimary || event.button > 0) return;
    const line = event.currentTarget;
    const source = line.closest(".entry-card");
    const touch = event.pointerType !== "mouse";
    const start = { x: event.clientX, y: event.clientY };
    let ghost = null;
    let target = null;
    let hold = null;

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
    const place = (x, y) => {
        ghost.style.left = x + 14 + "px";
        ghost.style.top = y + 10 + "px";
        const found = document.elementFromPoint(x, y);
        mark(found && found.closest("#books .entry-card[data-key]"));
    };
    const begin = () => {
        line_dragging = true;
        ghost = h("div", { class: "mc-tooltip line-ghost", "aria-hidden": "true" },
            h("div", { class: "mc-ench" + (logic.isCurse(ns) ? " curse" : "") }, logic.displayName(ns, book.enchantments[ns])));
        document.body.append(ghost);
        source.classList.add("drag-source");
        document.body.classList.add("dragging-line");
        place(start.x, start.y);
    };
    const move = moved => {
        if (moved.pointerId !== event.pointerId) return;
        const far = Math.hypot(moved.clientX - start.x, moved.clientY - start.y) > 6;
        if (!line_dragging) {
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
        if (!line_dragging) return;
        line_dragging = false;
        line_drag_ended = Date.now();
        ghost.remove();
        source.classList.remove("drag-source");
        document.body.classList.remove("dragging-line");
        const drop = done && done.type === "pointerup" ? target : null;
        mark(null);
        // The click that ends a drag isn't a tap on the line.
        const swallow = click => { click.stopPropagation(); click.preventDefault(); };
        addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
        if (drop) moveEnchantment(book, drop, ns);
    };
    if (touch) hold = setTimeout(begin, 350);
    addEventListener("pointermove", move);
    addEventListener("pointerup", finish);
    addEventListener("pointercancel", finish);
}

function moveEnchantment(from, to, ns) {
    const level = from.enchantments[ns];
    delete from.enchantments[ns];
    to.enchantments[ns] = Math.max(to.enchantments[ns] || 0, level);
    entry_popover = null;
    commit();
}

// The open popover in section 2: { id: the entry's id, kind: "count" | "enchant",
// toggle: the data-focus of the button that opened it, ns: an enchantment to show and
// highlight in the picker (once) }, or null. `picker_all`: the picker also lists the
// enchantments not chosen in section 1.
let entry_popover = null;
let picker_all = false;

function togglePopover(id, kind, toggle, ns = null) {
    const here = entry_popover && entry_popover.id === id && entry_popover.kind === kind;
    if (here && !ns) {
        entry_popover = null;
    } else {
        if (!here) picker_all = false;
        entry_popover = { id, kind, toggle, ns };
    }
    renderBooks();
    if (entry_popover && entry_popover.ns) {
        focusPicker(entry_popover.ns);
        entry_popover.ns = null; // highlighted once, not on every redraw
    }
}

export function openPicker(book) {
    picker_all = false;
    entry_popover = { id: book.id, kind: "enchant", toggle: "add-" + book.id, ns: null };
}

// Brings the picker into view and puts the focus on a level bar: `ns`'s, or the first.
export function focusPicker(ns = null) {
    const picker = document.querySelector("#books .entry-popover.enchant");
    if (!picker) return;
    const row = ns && picker.querySelector(`.picker-row[data-ns="${ns}"]`);
    const bar = (row || picker).querySelector(".level-bar");
    if (bar) bar.focus({ preventScroll: true });
    (row || picker).scrollIntoView({ block: "nearest", behavior: motion_ok() ? "smooth" : "auto" });
}

// The popover goes in the grid (so it can be as wide as the grid) just under its card.
// "count" is the copies and prior work steppers, lined up with its card; "enchant" is
// the enchantment picker, the grid's full width.
function placePopover(grid) {
    const book = state.books.find(other => other.id === entry_popover.id);
    const card = grid.querySelector(`.entry-card[data-key="${book.id}"]`);
    const popover = entry_popover.kind === "count" ? countPopover(book) : enchantPicker(book);
    grid.append(popover);
    popover.style.top = card.offsetTop + card.offsetHeight + 6 + "px";
    if (entry_popover.kind === "count") popover.style.left = card.offsetLeft + "px";
}

function countPopover(book) {
    const key = book.id;
    const prior_work = book.prior_work || 0;
    const penalty = 2 ** prior_work - 1;
    return h("div", { class: "entry-popover count", role: "group", "aria-label": TEXT.books.count_help },
        stepper(TEXT.books.copies, book.copies || 1, 1, MAX_COPIES, value => { book.copies = value; commit(); }, TEXT.books.copies_help, "pop-copies-" + key),
        stepper(TEXT.books.prior_work, prior_work, 0, maxPriorWork(stepLimit()), value => { book.prior_work = value; commit(); }, TEXT.books.prior_work_help, "pop-work-" + key),
        h("p", { class: "popover-note" }, penalty ? TEXT.books.prior_work_cost({ levels: penalty }) : TEXT.books.prior_work_none)
    );
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
    const rest = options.filter(ns => !(ns in state.wanted));
    const rest_shown = picker_all || !wanted.length ? rest : rest.filter(ns => book.enchantments[ns]);
    const hidden = rest.length - rest_shown.length;
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
            elsewhere ? null : levelBar(ns, level, here, value => setEntryLevel(book, ns, value), "pick-" + key + "-")
        );
    };
    const more = wanted.length && rest.length && (picker_all || hidden) ? h("button", {
        type: "button", class: "picker-more", "data-focus": "pick-more-" + key,
        onclick: () => { picker_all = !picker_all; renderBooks(); }
    }, picker_all ? TEXT.books.show_fewer : TEXT.books.show_all({ count: hidden })) : h("span");
    return h("div", { class: "entry-popover enchant", role: "group", "aria-label": TEXT.books.picker_label },
        wanted.length && rest_shown.length ? h("div", { class: "picker-head" }, TEXT.books.picker_chosen) : null,
        wanted.map(row),
        wanted.length && rest_shown.length ? h("div", { class: "picker-head" }, TEXT.books.picker_other) : null,
        rest_shown.map(row),
        h("div", { class: "popover-foot" }, more,
            h("button", { type: "button", class: "btn small", "data-focus": "pick-done-" + key, onclick: () => closePopover(true) }, TEXT.books.done))
    );
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
            state.books = state.books.filter(other => other !== book);
            entry_popover = null;
        }
    } else {
        delete book.enchantments[ns];
    }
    commit();
}

// Closes the popover; `refocus` puts the focus back on the button that opened it.
function closePopover(refocus) {
    const toggle = entry_popover && entry_popover.toggle;
    entry_popover = null;
    renderBooks();
    const again = refocus && toggle && document.querySelector(`#books [data-focus="${toggle}"]`);
    if (again) again.focus();
}

// The popover closes on a click outside it (and the buttons that open one) or on Escape.
export function setupEntryPopover() {
    document.addEventListener("click", event => {
        if (!entry_popover) return;
        const path = event.composedPath();
        if (path.some(el => el.classList && (el.classList.contains("entry-popover") || el.classList.contains("popover-toggle")))) return;
        closePopover(false);
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && entry_popover) closePopover(true);
    });
    // While a line is dragged by touch, the page must not scroll under it.
    document.addEventListener("touchmove", event => { if (line_dragging) event.preventDefault(); }, { passive: false });
}

// A: "⚠ 1" next to the section heading when chosen enchantments can't be reached; it
// opens the details. It sits in the heading's empty space, so it never moves anything.
function renderBooksAlert(check) {
    const box = $("#books-alert");
    if (!check.short.length) {
        open_tips.delete("books-alert-tip");
        box.replaceChildren();
        return;
    }
    const details = check.short.map(fixSuggestion);
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
    });
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
