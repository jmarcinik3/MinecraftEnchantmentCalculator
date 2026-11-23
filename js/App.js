import { createLogic, editionMetadata, levelTrack, anvilBreakChance, cleanName, MAX_NAME_LENGTH, MAX_COPIES, roman, movePriority, clampStepLimit, maxPriorWork, searchSize, CRITERIA, EDITIONS, MAX_STEP_LEVELS, MAX_GROUPS } from "./Logic.js";
import { TEXT, LANGUAGES, loadLanguage } from "./Text.js";

const META_URL = "json/metadata.json";
const WORKER_URL = "js/Calculator.js";
// Warn when a search tries more left/right splits than this: about a second or more.
// (12 all-different entries is ~520,000 splits; repeated entries add far fewer.)
const SLOW_SPLITS = 1000000;
const CALC_DELAY_MS = 250;      // wait for the user to stop clicking
const PROGRESS_DELAY_MS = 300;  // only show the progress bar for slow runs
const CHECKLIST_STORAGE_KEY = "enchantment-calculator-checklist";
// Kept in this browser only (not in share links): they are about the viewer, not the setup.
const LEVEL_STORAGE_KEY = "enchantment-calculator-level";
const LEVEL_ON_STORAGE_KEY = "enchantment-calculator-level-on";
const VIEW_STORAGE_KEY = "enchantment-calculator-view";
const SAVED_STORAGE_KEY = "enchantment-calculator-saved";
const LANGUAGE_STORAGE_KEY = "enchantment-calculator-language";
const COLLAPSED_STORAGE_KEY = "enchantment-calculator-collapsed";
const BOOKS_VIEW_STORAGE_KEY = "enchantment-calculator-books-view";
const THEME_STORAGE_KEY = "enchantment-calculator-theme"; // also read by index.html before the page draws
const MAX_PLAYER_LEVEL = 24791; // the highest level in either edition
const MAX_SETUP_NAME = 100;
const COPIED_MS = 1500; // how long "Copied" shows on a copy button

let meta = null;
let logic = null;
let state = defaultState();
let next_book_id = 1;
let undo_books = null; // the custom list before the last fix or removal in section 2
let undo_label = null; // the removed entry's name ("Put back …"), or null after a fix
let item_menu_open = false; // section 1's item menu (on the item's slot)
// What section 1's preview showed last, so a redraw can grow it smoothly and fade in
// the enchantments that are new.
let preview_shown = { item: null, enchantments: new Set() };
let conflicts_toggled = false; // the next redraw follows "Allow conflicts" changing, so it animates the groups

let worker = null;
let request_id = 0;
let running = false;
let show_progress = false;
let calc_timer = null;
let progress_timer = null;
let last_result = null; // { status: "ok" | "empty" | "cancelled" | "error", node?, error? }

let language = "en";
let player_level = readStorage(LEVEL_STORAGE_KEY, null); // "Your level", or null when blank
// Whether the steps follow "Your level". Off keeps the number for when it is turned on again.
let level_on = readStorage(LEVEL_ON_STORAGE_KEY, player_level != null) === true;
let result_view = readStorage(VIEW_STORAGE_KEY, "steps") === "tree" ? "tree" : "steps";
let saved_name = ""; // what is typed in the Saved menu's name box
let removed_setup = null; // { setup, index } of the last setup removed, until Undo or the menu closes

function defaultState() {
    return {
        item: null,
        wanted: {},        // enchantments the user wants on the final item
        auto_books: true,  // derive entries from `wanted`
        books: [],         // custom entries: { id, type: "book" | "item", enchantments: {ns: level}, prior_work }
        priority: [...CRITERIA],     // ranking for the best order, most important first
        max_step: MAX_STEP_LEVELS,   // no single step may cost more levels than this
        no_step_limit: false,        // ignore max_step and "Too Expensive!" (for mods that remove it)
        allow_incompatible: false,   // let conflicting enchantments go together (for mods that allow it)
        edition: "java",             // "java" | "bedrock": their anvil rules differ
        rename: false,               // rename the item in the last step (+1 level)
        rename_to: ""                // the new name shown on the result (optional)
    };
}

// ---------- DOM helper ----------

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
        else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        el.append(child instanceof Node ? child : String(child));
    }
    return el;
}

const $ = selector => document.querySelector(selector);

function icon(item_ns, small = false) {
    return h("img", {
        class: "item-icon" + (small ? " small" : ""),
        src: "img/" + ((meta.icons && meta.icons[item_ns]) || `${item_ns}.png`),
        alt: "",
        "aria-hidden": "true"
    });
}

// Storage can be unavailable (private windows, blocked site data), so every access is
// guarded and falls back to `fallback`.
function readStorage(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value == null ? fallback : value;
    } catch {
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // No storage: the value lasts until the page reloads.
    }
}

// Copies `text`, showing "Copied" in `target` for a moment, then `label` again.
// `button` gets the class "copied" meanwhile (an icon-only button shows its text then).
async function copyText(target, text, label, button = target) {
    try {
        await navigator.clipboard.writeText(text);
        target.textContent = TEXT.results.copied;
    } catch {
        target.textContent = TEXT.results.copy_failed;
    }
    button.classList.add("copied");
    setTimeout(() => { target.textContent = label; button.classList.remove("copied"); }, COPIED_MS);
}

// ---------- State changes ----------

// `keep_undo` is only for applying a suggestion: any other change ends the chance to undo it.
function commit(keep_undo = false) {
    if (!keep_undo) {
        undo_books = null;
        undo_label = null;
    }
    saveToUrl();
    render();
    scheduleCalculation();
}

// Switching item drops the enchantments the new one can't take.
function selectItem(item) {
    item_menu_open = false;
    if (state.item === item) { renderWanted(); return; }
    state.item = item;
    sanitizeAll();
    commit();
}

// Re-checks every chosen enchantment against the current item and conflict setting.
function sanitizeAll() {
    state.wanted = logic.sanitizeEnchantments(state.wanted, state.item, state.allow_incompatible);
    state.books = logic.sanitizeBooks(state.books, state.item, state.allow_incompatible);
}

// Whether two enchantments may not go together under the current setting.
function clashes(a, b) {
    return !state.allow_incompatible && logic.conflicts(a, b);
}

// Turning conflicts back off drops the later of each conflicting pair.
function setAllowIncompatible(allowed) {
    state.allow_incompatible = allowed;
    conflicts_toggled = true;
    sanitizeAll();
    commit();
}

// Each edition offers different enchantments (Bedrock has no Sweeping Edge), so the
// helpers are rebuilt for it and anything it does not have is dropped.
function useEdition(edition) {
    logic = createLogic(editionMetadata(meta, edition), TEXT.names);
}

function setEdition(edition) {
    if (state.edition === edition) return;
    state.edition = edition;
    state.rename_to = cleanName(state.rename_to, edition); // Bedrock names are shorter
    syncRename();
    useEdition(edition);
    if (state.item) sanitizeAll();
    commit();
}

function setWanted(ns, level) {
    if (level) {
        for (const other of Object.keys(state.wanted)) {
            if (clashes(other, ns)) delete state.wanted[other];
        }
        state.wanted[ns] = level;
    } else {
        delete state.wanted[ns];
    }
    commit();
}

function customizeBooks() {
    state.books = logic.currentBooks(state).map(book => ({
        id: next_book_id++,
        type: book.type,
        enchantments: { ...book.enchantments },
        prior_work: 0,
        copies: 1
    }));
    state.auto_books = false;
    commit();
}

// `type` is "book" or "item" (another copy of the item being enchanted).
// A new book opens its enchantment picker straight away (it needs some to be of use).
function addBook(type) {
    const book = { id: next_book_id++, type: type, enchantments: {}, prior_work: 0, copies: 1 };
    state.books.push(book);
    if (type === "book") openPicker(book);
    commit();
    if (type === "book") focusPicker();
}

// ---------- Rendering ----------

function render() {
    const scroll = scrollY; // redrawn sections are emptied first, which can pull the page up
    renderSummaries();
    renderLanguage();
    renderTheme();
    renderSaved();
    renderWanted();
    renderBooks();
    renderEdition();
    renderRanking();
    renderResults();
    if (scrollY !== scroll) scrollTo(scrollX, scroll);
}

// ---------- Collapsing sections ----------
// Sections 1-3 close from their heading (the arrow, or anywhere on the heading but its
// badge), so the results are easier to reach once things are set. Closed sections are
// remembered in this browser, and their heading says what is chosen inside.

let collapsed = new Set(readStorage(COLLAPSED_STORAGE_KEY, []));

function setCollapsed(section, closed) {
    closed ? collapsed.add(section) : collapsed.delete(section);
    writeStorage(COLLAPSED_STORAGE_KEY, [...collapsed]);
    applyCollapsed();
}

function applyCollapsed() {
    for (const card of document.querySelectorAll(".card.collapsible")) {
        const section = card.dataset.section;
        const closed = collapsed.has(section);
        card.classList.toggle("collapsed", closed);
        const button = card.querySelector(".collapse-toggle");
        const title = card.querySelector(".section-title").textContent;
        button.setAttribute("aria-expanded", String(!closed));
        button.setAttribute("aria-label", closed ? TEXT.page.expand_label({ section: title }) : TEXT.page.collapse_label({ section: title }));
        button.title = button.getAttribute("aria-label");
        card.querySelector(".section-body").hidden = closed;
    }
}

function setupCollapsing() {
    for (const card of document.querySelectorAll(".card.collapsible")) {
        const toggle = () => setCollapsed(card.dataset.section, !collapsed.has(card.dataset.section));
        card.querySelector("h2").addEventListener("click", event => {
            if (event.target.closest(".info-tip")) return; // the badge and ? have their own bubbles
            toggle();
        });
        // Section 3's arrow sits beside its heading (with the Options menu between them).
        const arrow = card.querySelector(".collapse-toggle");
        if (!card.querySelector("h2").contains(arrow)) arrow.addEventListener("click", toggle);
    }
    applyCollapsed();
}

// What each section holds, shown in its heading while it is closed.
function renderSummaries() {
    const chosen = Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level }));
    const entries = state.books.reduce((total, book) => total + (book.copies || 1), 0);
    $("#wanted-summary").textContent = state.item
        ? TEXT.page.summary_item({ item: logic.itemName(state.item), count: chosen.length })
        : TEXT.page.summary_none;
    $("#books-summary").textContent = state.auto_books ? TEXT.page.summary_automatic : TEXT.page.summary_entries({ count: entries });
    renderOrderSummary();
}

// Section 4's summary while closed: how many steps the order takes.
// Shown in the heading open or closed, with the anvil's break risk beside it (anvilRisk).
function renderStepsSummary() {
    const node = resultNode();
    const uses = node ? logic.collectSteps(node).length : 0;
    $("#steps-summary").textContent = node ? TEXT.page.summary_steps({ count: uses }) : TEXT.ranking.no_value;
    $("#anvil-risk").replaceChildren(...(node ? [anvilRisk(uses)] : []));
}

// Section 3's summary while closed: all four results in ranking order, e.g.
// "66 levels · 1,246 XP · Max level 16 · Prior work 4".
function renderOrderSummary() {
    const node = resultNode();
    const summaries = {
        levels: () => TEXT.page.summary_levels({ levels: node.cumulative_levels }),
        xp: () => TEXT.page.summary_xp({ xp: Math.round(node.cumulative_xp).toLocaleString(language) }),
        max_step: () => TEXT.page.summary_max_step({ level: node.max_step }),
        prior_work: () => TEXT.page.summary_prior_work({ count: node.prior_work })
    };
    $("#order-summary").textContent = node ? state.priority.map(criterion => summaries[criterion]()).join(" · ") : TEXT.ranking.no_value;
}

// ---------- Language ----------

function renderLanguage() {
    // Short codes ("EN"), so the picker stays small; each option's full name is its tooltip
    // and what screen readers announce.
    $("#language").replaceChildren(h("select", {
        class: "language-select header-control",
        "aria-label": TEXT.page.language_label,
        title: TEXT.page.language_label + ": " + LANGUAGES[language],
        onchange: event => switchLanguage(event.target.value)
    }, Object.entries(LANGUAGES).map(([code, label]) => h("option", {
        value: code, selected: code === language, title: label, "aria-label": label
    }, code.toUpperCase()))));
}

// The saved choice, else the browser's language if there is text for it, else English.
function startingLanguage() {
    const saved = readStorage(LANGUAGE_STORAGE_KEY, null);
    if (LANGUAGES[saved]) return saved;
    const browser = (navigator.language || "en").slice(0, 2).toLowerCase();
    return LANGUAGES[browser] ? browser : "en";
}

// Loads a language's text (json/text/<code>.json), falling back to English if it
// can't be loaded. Throws only when English can't be loaded either.
async function applyLanguage(code) {
    try {
        language = await loadLanguage(code);
    } catch (error) {
        console.warn(error);
        language = await loadLanguage("en");
    }
    document.documentElement.lang = language;
    fillPageText();
    applyCollapsed(); // the toggles' labels
}

async function switchLanguage(code) {
    await applyLanguage(code);
    writeStorage(LANGUAGE_STORAGE_KEY, language);
    useEdition(state.edition); // item and enchantment names
    renderMetrics(true);
    render();
}

// ---------- Saved setups ----------
// Setups saved in this browser under a name, from the header's Saved menu. Each is a
// share link's text, so loading one works like opening its link.

function readSaved() {
    const list = readStorage(SAVED_STORAGE_KEY, []);
    return Array.isArray(list) ? list.filter(setup => setup && typeof setup.name === "string" && typeof setup.link === "string") : [];
}

// "Boots: Protection IV, Mending" for the current setup.
function defaultSetupName() {
    if (!state.item) return "";
    const chosen = logic.summary(Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level })));
    return [...(logic.itemName(state.item) + (chosen ? ": " + chosen : ""))].slice(0, MAX_SETUP_NAME).join("");
}

function renderSaved() {
    const list = readSaved();
    // Through h(), which skips the missing Undo row (replaceChildren would print "null").
    $("#saved-panel").replaceChildren(...h("div", {},
        h("form", {
            class: "saved-form",
            onsubmit: event => { event.preventDefault(); saveSetup(saved_name.trim() || defaultSetupName()); }
        },
            h("input", {
                type: "text", class: "rename-input", maxlength: MAX_SETUP_NAME, value: saved_name,
                placeholder: defaultSetupName(), "aria-label": TEXT.page.save_name_label,
                oninput: event => { saved_name = event.target.value; }
            }),
            h("button", { type: "submit", class: "btn small primary", disabled: !state.item }, TEXT.page.save)
        ),
        list.length
            ? h("ul", { class: "saved-list" }, list.map((setup, index) => h("li", {},
                h("button", { type: "button", class: "saved-load", title: setup.name, onclick: () => loadSetup(setup.link) },
                    logic.isItem(setup.item) ? icon(setup.item, true) : null,
                    h("span", { class: "saved-name" }, setup.name)),
                h("button", {
                    type: "button", class: "saved-delete", title: TEXT.page.delete_saved,
                    "aria-label": TEXT.page.delete_saved_label({ name: setup.name }),
                    onclick: () => deleteSetup(index)
                }, "×")
            )))
            : h("p", { class: "hint" }, TEXT.page.saved_empty),
        removed_setup ? h("div", { class: "saved-removed" },
            h("span", { class: "saved-name" }, TEXT.page.removed_saved({ name: removed_setup.setup.name })),
            h("button", { type: "button", class: "link", onclick: undoRemoveSetup }, TEXT.page.undo_remove)
        ) : null
    ).childNodes);
}

// Saving under a name already in the list replaces that setup; the newest is first.
function saveSetup(name) {
    if (!state.item || !name) return;
    const list = readSaved().filter(setup => setup.name !== name);
    list.unshift({ name, item: state.item, link: logic.serialize(state) });
    writeStorage(SAVED_STORAGE_KEY, list);
    saved_name = "";
    removed_setup = null;
    renderSaved();
}

// Removing asks nothing first; Undo below the list puts it back where it was.
function deleteSetup(index) {
    const list = readSaved();
    const [setup] = list.splice(index, 1);
    if (!setup) return;
    removed_setup = { setup, index };
    writeStorage(SAVED_STORAGE_KEY, list);
    renderSaved();
}

function undoRemoveSetup() {
    if (!removed_setup) return;
    const { setup, index } = removed_setup;
    const list = readSaved().filter(other => other.name !== setup.name);
    list.splice(Math.min(index, list.length), 0, setup);
    removed_setup = null;
    writeStorage(SAVED_STORAGE_KEY, list);
    renderSaved();
}

function loadSetup(link) {
    const loaded = readLink(link);
    if (!loaded) return;
    state = loaded;
    syncRename();
    useEdition(state.edition);
    if (state.item) sanitizeAll();
    $("#saved").open = false;
    commit();
}

// The header's Saved menu closes on a click outside it or on Escape.
function setupMenuClosing(menu) {
    document.addEventListener("click", event => {
        // The path, not contains(): a click on a button the menu then redraws is still inside.
        if (menu.open && !event.composedPath().includes(menu)) menu.open = false;
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape") menu.open = false; });
}

function setupSavedMenu() {
    const menu = $("#saved");
    $("#saved > summary").title = TEXT.page.saved_help;
    setupMenuClosing(menu);
    // Undo is offered until the menu closes.
    menu.addEventListener("toggle", () => {
        if (!menu.open && removed_setup) { removed_setup = null; renderSaved(); }
    });
}

// ---------- Rendering ----------

function renderEdition() {
    $("#edition").replaceChildren(...EDITIONS.map(edition => h("button", {
        type: "button",
        class: state.edition === edition ? "selected" : "",
        "aria-pressed": String(state.edition === edition),
        title: TEXT.page.editions[edition].help,
        onclick: () => setEdition(edition)
    }, TEXT.page.editions[edition].label)));
}

// Every item that can be enchanted, as a grid of buttons.
function itemGrid() {
    return h("div", { class: "item-grid", id: "items" }, logic.enchantableItems().map(item => h("button", {
        type: "button",
        class: "item-button" + (state.item === item ? " selected" : ""),
        "aria-pressed": String(state.item === item),
        "data-focus": "item-" + item,
        onclick: () => selectItem(item)
    }, icon(item), logic.itemName(item))));
}

// Section 1: the item grid until an item is picked; then a preview of the finished item
// (its slot opens the item menu), the toolbar and presets, and one row per enchantment
// (conflict groups together).
function renderWanted() {
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
    conflicts_toggled = false;
    box.replaceChildren();
    if (!state.item) {
        box.append(h("p", { class: "hint" }, TEXT.wanted.pick_item_first), itemGrid());
        restoreFocus(box, focus);
        return;
    }

    box.append(wantedHead(
        h("div", { class: "toolbar" },
            h("button", { type: "button", class: "btn small", onclick: () => { state.wanted = logic.maxAll(state.item, state.wanted, state.allow_incompatible); commit(); } }, TEXT.wanted.max_all),
            h("button", { type: "button", class: "btn small ghost", onclick: () => { state.wanted = {}; commit(); } }, TEXT.wanted.clear)
        ),
        presetChips()
    ), wantedList());
    if (old_height != null) {
        growSmoothly(box.querySelector(".wanted-preview"), old_height);
        openLines(box.querySelectorAll(".wanted-preview .mc-ench.fresh"));
    }
    for (const group of box.querySelectorAll(".ench-group[data-group]")) {
        if (!old_groups.has(group.dataset.group)) continue;
        growSmoothly(group, old_groups.get(group.dataset.group));
        if (motion_ok()) group.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
    }
    restoreFocus(box, focus);
}

// The element with focus inside `box` (by its data-focus), so a redraw can put the
// focus back where it was (the level bars and switches are rebuilt on every change).
function focusState(box) {
    const active = document.activeElement;
    return active && box.contains(active) && active.dataset.focus ? active.dataset.focus : null;
}

function restoreFocus(box, key) {
    const again = key && box.querySelector(`[data-focus="${key}"]`);
    if (again) again.focus({ preventScroll: true });
}

// The rows: single enchantments, "Pick one" switches, and brackets around enchantments
// that only partly conflict; curses last.
function wantedList() {
    // B: chosen enchantments the custom books can't reach (none in automatic mode).
    const short = new Map(logic.checkBooks(state).short.map(s => [s.ns, s]));
    const rows = [];
    let curses_shown = false;
    for (const group of logic.enchantmentGroups(state.item)) {
        const members = group.members;
        const switchable = group.exclusive && !state.allow_incompatible;
        if (logic.isCurse(members[0]) && !curses_shown) {
            rows.push(h("div", { class: "divider" }, TEXT.wanted.curses));
            curses_shown = true;
        }
        if (switchable) {
            rows.push(groupSwitch(members, short));
        } else if (members.length === 1) {
            rows.push(wantedRow(members[0], short.get(members[0])));
        } else {
            rows.push(h("div", { class: "ench-group" + (members.some(ns => state.wanted[ns]) ? " has-chosen" : ""), "data-group": members[0] },
                h("div", { class: "ench-group-label" }, state.allow_incompatible ? TEXT.wanted.group_allowed : TEXT.wanted.group_some_conflict),
                members.map(ns => wantedRow(ns, short.get(ns)))
            ));
        }
    }
    return h("div", { class: "wanted-list" }, rows);
}

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
        onclick: () => {
            item_menu_open = !item_menu_open;
            renderWanted();
            if (item_menu_open) {
                const current = document.querySelector(`#items [data-focus="item-${state.item}"]`);
                if (current) current.focus({ preventScroll: true });
            }
        }
    });
    slot.replaceWith(button);
    button.append(slot, h("span", { class: "item-menu-caret", "aria-hidden": "true" }, "▾"));
    return h("div", { class: "wanted-preview", role: "group", "aria-label": TEXT.wanted.preview_label }, cell);
}

// Section 1's preview changes height as enchantments come and go, and its conflict
// groups as "Allow conflicts" changes: each slides from its old height to the new one,
// so what is below moves smoothly instead of jumping. A redraw mid-slide starts from
// wherever it had got to.
const motion_ok = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;

function growSmoothly(element, from) {
    const to = element.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1 || !motion_ok()) return;
    element.classList.add("resizing");
    element.style.height = from + "px";
    element.getBoundingClientRect(); // apply the old height before the transition starts
    element.style.height = to + "px";
    // Back to its natural height once done. The timer covers a slide that never ends
    // (the section closed mid-slide, or a hidden tab), so it can never stay stuck.
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        element.classList.remove("resizing");
        element.style.height = "";
    };
    // Only its own height transition (the level bars inside have short ones of their own).
    const own = event => { if (event.target === element && event.propertyName === "height") finish(); };
    element.addEventListener("transitionend", own);
    element.addEventListener("transitioncancel", own);
    setTimeout(finish, 400);
}

// New tooltip lines open from no height in their own place (and fade in), so the lines
// below them slide down with the box, wherever in the list they were added. Same
// duration and easing as growSmoothly, so the lines and the box move together.
function openLines(lines) {
    if (!motion_ok()) return;
    for (const line of lines) {
        const height = line.getBoundingClientRect().height;
        line.style.overflow = "hidden";
        line.animate([{ height: "0px" }, { height: height + "px" }], { duration: 250, easing: "ease-out" })
            .finished.then(() => { line.style.overflow = ""; }, () => {});
        line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: "ease-out" });
    }
}

// The item menu closes on a click outside it (or its button) and on Escape, which puts
// the focus back on the slot.
function setupItemMenu() {
    document.addEventListener("click", event => {
        if (!item_menu_open) return;
        const path = event.composedPath();
        if (path.some(el => el.classList && (el.classList.contains("item-menu") || el.classList.contains("item-menu-button")))) return;
        item_menu_open = false;
        renderWanted();
    });
    document.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !item_menu_open) return;
        item_menu_open = false;
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
    const conflict_sets = logic.enchantmentGroups(state.item).filter(group => group.members.length > 1);
    const best_name = wanted => {
        if (state.allow_incompatible || conflict_sets.length !== 1) return TEXT.wanted.preset_best;
        const picks = conflict_sets[0].members.filter(ns => wanted[ns]);
        return picks.length ? picks.map(ns => logic.enchName(ns)).join(" + ") : TEXT.wanted.preset_best;
    };
    const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(ns => a[ns] === b[ns]);
    return h("div", { class: "presets" },
        h("span", { class: "presets-label" }, TEXT.wanted.presets),
        presets.map(preset => {
            const selected = same(preset.wanted, state.wanted);
            const best = preset.key === "best";
            return h("button", {
                type: "button", class: "preset" + (selected ? " selected" : ""), "aria-pressed": String(selected),
                "data-focus": "preset-" + preset.key,
                title: best ? TEXT.wanted.preset_best_help : TEXT.wanted.preset_swap_help({ name: logic.enchName(preset.key) }),
                onclick: () => { state.wanted = { ...preset.wanted }; commit(); }
            }, best ? best_name(preset.wanted) : logic.enchName(preset.key));
        })
    );
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
function wantedRow(ns, short = null) {
    const chosen = state.wanted[ns] || 0;
    const blocker = !chosen && Object.keys(state.wanted).find(other => clashes(other, ns));
    const name = logic.enchName(ns);
    const help = logic.describe(ns);
    const cost = chosen ? logic.bookCost(ns, chosen) : 0;

    return h("div", { class: "ench-row" + (blocker ? " conflict" : "") + (chosen ? " chosen" : "") + (logic.isCurse(ns) ? " curse" : "") },
        h("div", { class: "ench-name" },
            // The mark shares the name's line, so rows never get taller.
            h("span", { class: "ench-title" },
                help ? infoTip("ench-info-" + ns, name, name, help, "ench-info") : name,
                short ? h("span", { class: "short-mark", title: TEXT.wanted.short_help },
                    short.best ? TEXT.wanted.books_reach({ level: roman(short.best) }) : TEXT.wanted.not_on_books) : null
            )
        ),
        chosen ? h("span", { class: "anvil-cost ench-cost", title: TEXT.wanted.cost_help({ levels: cost }) }, TEXT.wanted.cost({ levels: cost })) : null,
        levelBar(ns, chosen, blocker)
    );
}

// The levels as one bar of joined segments (I up to the max) that fill up to the chosen
// level: tap a segment to choose it (the chosen one again clears it), drag across them
// (off the left end clears), or use the arrow keys, Home/End and digits. Every bar is as
// wide as five segments with its own from the left, so the I segments share a column.
// `onChoose(level)` defaults to section 1's choice; `focus` is the data-focus prefix.
function levelBar(ns, chosen, blocker, onChoose = level => setWanted(ns, level), focus = "bar-") {
    const max = logic.maxLevel(ns);
    const segments = [];
    for (let level = 1; level <= max; level++) segments.push(h("span", { class: "level-seg", "data-level": level }, roman(level)));
    const bar = h("div", {
        class: "level-bar", role: "slider", tabindex: "0", "data-focus": focus + ns,
        "aria-label": TEXT.wanted.level_label({ name: logic.enchName(ns) }),
        "aria-valuemin": "0", "aria-valuemax": String(max),
        title: blocker ? TEXT.wanted.replaces({ name: logic.enchName(blocker) }) : null,
        style: `--levels: ${max}`
    }, segments);

    const show = level => {
        bar.setAttribute("aria-valuenow", String(level));
        bar.setAttribute("aria-valuetext", level ? logic.displayName(ns, level) : TEXT.wanted.level_none);
        for (const seg of segments) seg.classList.toggle("filled", Number(seg.dataset.level) <= level);
    };
    show(chosen);
    const choose = level => { if (level !== chosen) onChoose(level); };

    bar.addEventListener("keydown", event => {
        const keys = { ArrowRight: chosen + 1, ArrowUp: chosen + 1, ArrowLeft: chosen - 1, ArrowDown: chosen - 1, Home: 0, End: max, Delete: 0, Backspace: 0 };
        let level = keys[event.key];
        if (level == null && /^[0-9]$/.test(event.key)) level = Number(event.key);
        if (level == null) return;
        event.preventDefault();
        choose(Math.max(0, Math.min(max, level)));
    });

    // The level under the pointer, by position, so a drag also works over the gaps.
    const levelAt = x => {
        const rects = segments.map(seg => seg.getBoundingClientRect());
        if (x < rects[0].left - 8) return 0;
        let level = 1;
        rects.forEach((rect, index) => { if (x >= rect.left) level = index + 1; });
        return level;
    };
    // The bar fills as the pointer moves and the choice is made on release (a redraw
    // mid-drag would end it). Vertical swipes still scroll the page (touch-action: pan-y).
    let drag = null;
    bar.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        const level = levelAt(event.clientX);
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
        const level = levelAt(event.clientX);
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

// `focus`: a data-focus prefix, so its buttons keep the focus across redraws.
function stepper(label, value, min, max, onSet, help, focus = null) {
    return h("span", { class: "stepper", title: help },
        h("span", { class: "stepper-label" }, label),
        h("button", { type: "button", class: "btn tiny", "aria-label": TEXT.books.decrease_label({ label }), "data-focus": focus && focus + "-minus", disabled: value <= min, onclick: () => onSet(value - 1) }, "−"),
        h("span", { class: "stepper-value" }, value),
        h("button", { type: "button", class: "btn tiny", "aria-label": TEXT.books.increase_label({ label }), "data-focus": focus && focus + "-plus", disabled: value >= max, onclick: () => onSet(value + 1) }, "+")
    );
}

// The step limit in effect, or Infinity when it is turned off.
function stepLimit() {
    return state.no_step_limit ? Infinity : state.max_step;
}

// Section 2: an Automatic | Custom switch, then one card per entry, drawn like the game
// (an inventory slot and a tooltip), two to a row where the section is wide enough. In
// Custom mode the cards are editable (see entryCard) and the last cell adds an entry.
// Cards slide to their new places when the list changes (animateCards).
function renderBooks() {
    const box = $("#books");
    const focus = focusState(box);
    // Switching Cards/List morphs each card into its new shape (animateCards).
    const view_changed = box.dataset.view != null && box.dataset.view !== books_view;
    box.dataset.view = books_view;
    const old_rects = cardRects(box);
    const old_grid = box.querySelector(".entry-grid");
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
            viewSwitch(),
            // In the toolbar's row, so it appearing does not move the entries.
            undo_books ? h("button", {
                type: "button", class: "btn small undo", "data-focus": "undo-books",
                title: undo_label ? TEXT.books.undo_remove_help : TEXT.books.undo_help,
                onclick: () => { state.books = undo_books; commit(); }
            }, undo_label ? TEXT.books.undo_remove({ name: undo_label }) : TEXT.books.undo) : null
        ),
        custom ? coverageStrip() : null,
        grid
    ].filter(Boolean));
    if (entry_popover) placePopover(grid);
    animateCards(box, old_rects, old_height, view_changed); // holds the old height while it slides
    if (scrollY !== scroll) scrollTo(scrollX, scroll);
    restoreFocus(box, focus);
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
    }, slot) : slot;

    const badge = (kind, content, label, is_default) => {
        if (!editable) return is_default ? null : h("span", { class: "entry-badge", title: label, "aria-label": label }, content);
        return h("button", {
            type: "button", class: "entry-badge popover-toggle" + (is_default ? " muted" : "") + (open === "count" ? " open" : ""),
            "data-focus": kind + "-" + key, "aria-label": label, title: TEXT.books.count_help,
            "aria-expanded": String(open === "count"), onclick: () => togglePopover(book.id, "count", kind + "-" + key)
        }, content);
    };
    const badges = h("div", { class: "entry-badges" },
        badge("copies", "×" + copies, TEXT.books.copies_badge({ count: copies }), copies === 1),
        badge("work", [h("img", { class: "badge-anvil", src: "img/anvil.png", alt: "" }), prior_work], TEXT.books.work_badge({ count: prior_work }), prior_work === 0)
    );
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
        if (!editable) return h("div", { class: cls, title: flagged ? TEXT.books.unwanted_help : null }, content);
        const focus = "line-" + key + "-" + e.namespace;
        return h("button", {
            type: "button", class: cls + " entry-line popover-toggle", "data-focus": focus,
            title: flagged ? TEXT.books.unwanted_help : TEXT.books.edit_line,
            onpointerdown: event => lineDragStart(event, book, e.namespace),
            onclick: () => { if (Date.now() - line_drag_ended > 400) togglePopover(book.id, "enchant", focus, e.namespace); }
        }, content);
    });
    if (editable) {
        lines.push(h("button", {
            type: "button", class: "mc-ench entry-add popover-toggle" + (open === "enchant" ? " open" : ""),
            "data-focus": "add-" + key, "aria-expanded": String(open === "enchant"),
            onclick: () => togglePopover(book.id, "enchant", "add-" + key)
        }, TEXT.books.add_enchantment));
    }

    return h("div", { class: "entry-card" + (open ? " popover-open" : ""), "data-index": index, "data-key": key },
        h("div", { class: "entry-top" },
            editable ? entryHandle(index, count) : null,
            slot_part,
            badges,
            // ⧉ above ×, in the corner, so the badges keep their row.
            editable ? h("div", { class: "entry-tools" }, tools) : null
        ),
        h("div", { class: "mc-tooltip entry-tooltip" },
            h("div", { class: "mc-name rarity-" + logic.rarity(is_item ? state.item : "book", enchanted) }, name),
            lines
        )
    );
}

// How an entry is named in "Put back …": its enchantments, or what it is.
function entryName(book) {
    const list = Object.entries(book.enchantments).map(([namespace, level]) => ({ namespace, level }));
    const summary = list.length ? logic.summary(list) : "";
    if (book.type === "item") return summary ? `${logic.itemName(state.item)} (${summary})` : logic.itemName(state.item);
    return summary || TEXT.books.book;
}

// × fades the card out, then removes the entry; "Put back …" in the toolbar undoes it
// until the next change.
function removeEntry(book, card) {
    const remove = () => {
        undo_books = state.books.map(other => ({ ...other }));
        undo_label = entryName(book);
        state.books = state.books.filter(other => other !== book);
        if (entry_popover && entry_popover.id === book.id) entry_popover = null;
        commit(true);
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
    const copy = { ...book, id: next_book_id++, enchantments: { ...book.enchantments }, copies: 1 };
    state.books.splice(state.books.indexOf(book) + 1, 0, copy);
    openPicker(copy);
    commit();
    focusPicker();
}

// One of section 1's fixes (a book at the chosen level, replacing lower ones it makes
// unnecessary), from the warning badge or the coverage strip; Undo takes it back.
function applyFix(ns, wanted) {
    const adding = logic.addBook(state, ns, wanted);
    undo_books = state.books.map(book => ({ ...book }));
    undo_label = null;
    state.books = adding.books.map(book => (book.id == null ? { ...book, id: next_book_id++ } : book));
    commit(true);
}

// Custom mode, above the entries: each enchantment chosen in section 1, green with ✓ when
// the entries reach its level, amber when they don't; an amber one applies its fix.
function coverageStrip() {
    const chosen = Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level }));
    if (!chosen.length) return null;
    const best = logic.bestLevels(state);
    return h("div", { class: "coverage", role: "group", "aria-label": TEXT.books.coverage_label },
        logic.tooltipSort(chosen).map(({ namespace: ns, level }) => {
            const name = logic.displayName(ns, level);
            const reach = best[ns] || 0;
            if (reach >= level) return h("span", { class: "cover-chip ok", title: TEXT.books.cover_ok({ name }) }, "✓ ", name);
            const fix = TEXT.books.fix_new_book({ name });
            return h("button", {
                type: "button", class: "cover-chip short", "data-focus": "cover-" + ns, title: fix, "aria-label": fix,
                onclick: () => applyFix(ns, level)
            }, "+ ", name, h("span", { class: "cover-best" }, reach ? TEXT.books.fix_best({ level: roman(reach) }) : TEXT.wanted.not_on_books));
        })
    );
}

// Cards (two to a row where there is room) or List (one row per entry); remembered here.
let books_view = readStorage(BOOKS_VIEW_STORAGE_KEY, "cards") === "list" ? "list" : "cards";

function viewSwitch() {
    const option = (view, label) => h("button", {
        type: "button", class: books_view === view ? "selected" : "", "aria-pressed": String(books_view === view),
        "data-focus": "view-" + view,
        onclick: () => {
            if (books_view === view) return;
            books_view = view;
            writeStorage(BOOKS_VIEW_STORAGE_KEY, view);
            renderBooks();
        }
    }, label);
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
        const book = { id: next_book_id++, type: "book", enchantments, prior_work: 0, copies: 1 };
        const twin = logic.twinOf(state.books, book);
        if (twin) twin.copies = Math.min(MAX_COPIES, (twin.copies || 1) + 1);
        else state.books.push(book);
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

function openPicker(book) {
    picker_all = false;
    entry_popover = { id: book.id, kind: "enchant", toggle: "add-" + book.id, ns: null };
}

// Brings the picker into view and puts the focus on a level bar: `ns`'s, or the first.
function focusPicker(ns = null) {
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
function setupEntryPopover() {
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

// Where each card was before a redraw (by entry id), for animateCards: relative to the
// grid, so only moves inside it animate (not the whole section moving with the page).
function cardRects(box) {
    const rects = new Map();
    const grid = box.querySelector(".entry-grid");
    if (!grid) return rects;
    const base = grid.getBoundingClientRect();
    for (const card of grid.querySelectorAll(".entry-card[data-key]")) {
        const rect = card.getBoundingClientRect();
        rects.set(card.dataset.key, { left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height });
    }
    return rects;
}

// After a redraw, each card slides from where it was to where it is now (reordering,
// or the cards after an added or removed one), new cards fade in, and the grid's height
// slides too (growSmoothly), so nothing jumps.
// `morph` (Cards <-> List): each card also grows or shrinks from its old size to its new
// one, its contents fading in as it does, so nothing is seen stretched.
function animateCards(box, old_rects, old_height, morph = false) {
    if (!motion_ok() || !old_rects.size) return;
    const grid = box.querySelector(".entry-grid");
    if (!grid) return;
    if (old_height != null) growSmoothly(grid, old_height);
    const now_rects = cardRects(box);
    for (const card of grid.querySelectorAll(".entry-card[data-key]")) {
        const old = old_rects.get(card.dataset.key);
        if (!old) {
            card.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 250, easing: "ease-out" });
            continue;
        }
        const now = now_rects.get(card.dataset.key);
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (morph) {
            const scale = `scale(${old.width / now.width}, ${old.height / now.height})`;
            card.animate([{ transform: `translate(${dx}px, ${dy}px) ${scale}`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }],
                { duration: 320, easing: "ease-out" });
            for (const child of card.children) child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
            continue;
        }
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 250, easing: "ease-out" });
    }
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
// it replaces before it is clicked, and Undo in the toolbar takes it back.
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

function setPriority(priority) {
    state.priority = priority;
    commit();
}

// Drag to reorder, for the ranking tiles and the custom entries. Pointer events cover
// mouse, pen and touch alike (the HTML drag-and-drop API does not work on touch screens).
// `event` starts on the grabbed element (the tile, or an entry's handle); `item` is what
// moves, found again under the pointer by `selector` among its siblings. The item under
// the pointer is outlined, and `reorder(from, to)` runs when the pointer is released over
// it; otherwise `restore()` clears the drag styling.
function dragToReorder(event, item, from_index, selector, reorder, restore) {
    if (!event.isPrimary || event.button > 0) return;
    const grabbed = event.currentTarget;
    const list = item.parentElement;
    let target_index = from_index;
    try {
        grabbed.setPointerCapture(event.pointerId); // keep getting moves after leaving it
    } catch {
        // Some browsers refuse capture for synthetic pointers; moves over it still work.
    }
    item.classList.add("dragging");

    const itemAt = (x, y) => {
        const found = document.elementFromPoint(x, y);
        const over = found && found.closest(selector);
        return over && list.contains(over) ? over : null;
    };
    const onMove = move => {
        const over = itemAt(move.clientX, move.clientY);
        if (!over) return;
        target_index = Number(over.dataset.index);
        for (const other of list.querySelectorAll(selector)) other.classList.toggle("drop-target", other === over && other !== item);
    };
    const finish = drop => {
        grabbed.removeEventListener("pointermove", onMove);
        grabbed.removeEventListener("pointerup", finish);
        grabbed.removeEventListener("pointercancel", finish);
        if (drop.type === "pointerup" && target_index !== from_index) reorder(from_index, target_index);
        else restore();
    };
    grabbed.addEventListener("pointermove", onMove);
    grabbed.addEventListener("pointerup", finish);
    grabbed.addEventListener("pointercancel", finish);
}

// Starts dragging a ranking tile (not from its arrow buttons).
function startRankDrag(event, from_index) {
    if (event.target.closest("button")) return;
    dragToReorder(event, event.currentTarget, from_index, ".rank-tile",
        (from, to) => setPriority(movePriority(state.priority, from, to - from)),
        () => renderMetrics(true));
}

// The result tiles double as the ranking for the best order: most important first,
// highlighted, and later ones break ties. Drag a tile or use its arrows to reorder.
// They stay on screen (showing "-") when there is no result, so the ranking can always
// be changed. While the order is unchanged the values are updated in place, so a result
// arriving mid-drag or mid-tap does not redraw the tiles under the pointer.
function renderMetrics(rebuild = false) {
    const box = $("#metrics");
    const order = state.priority.join(",");
    if (rebuild || box.dataset.order !== order) {
        box.dataset.order = order;
        box.replaceChildren(h("ol", { class: "metrics" }, state.priority.map(rankTile)));
    }

    const result = last_result && last_result.status === "ok" ? last_result.node : null;
    const node = result && result.left ? result : null; // nothing to show without a step
    const values = node && {
        levels: node.cumulative_levels,
        xp: Math.round(node.cumulative_xp).toLocaleString(language),
        max_step: node.max_step,
        prior_work: node.prior_work
    };
    for (const tile of box.querySelectorAll(".rank-tile")) {
        tile.querySelector(".metric-value").textContent = values ? values[tile.dataset.criterion] : TEXT.ranking.no_value;
    }
    // A new result is on its way: fade the old numbers.
    box.classList.toggle("updating", running);
}

function rankTile(criterion, index) {
    const label = TEXT.ranking.criteria[criterion].label;
    const last = index === state.priority.length - 1;
    return h("li", {
        class: "metric rank-tile" + (index === 0 ? " primary" : ""),
        "data-index": index,
        "data-criterion": criterion,
        title: TEXT.ranking.criteria[criterion].help,
        onpointerdown: event => startRankDrag(event, index)
    },
        // The name gets the whole top line, so longer ones ("Trabajo anterior") stay on one
        // line; the arrows sit beside the value below.
        h("div", { class: "rank-tile-head" },
            h("span", { class: "rank-num" }, index + 1),
            h("span", { class: "metric-label" }, label)
        ),
        h("div", { class: "rank-tile-body" },
            h("div", { class: "metric-value" }),
            h("button", {
                type: "button", class: "rank-move", disabled: index === 0,
                "aria-label": TEXT.ranking.rank_higher_label({ label }), onclick: () => setPriority(movePriority(state.priority, index, -1))
            }, "‹"),
            h("button", {
                type: "button", class: "rank-move", disabled: last,
                "aria-label": TEXT.ranking.rank_lower_label({ label }), onclick: () => setPriority(movePriority(state.priority, index, 1))
            }, "›")
        )
    );
}

// ---------- Options above the results ----------
// One aligned panel: level limit, your level, rename. Each label sits in the first
// column and its control in the second, every control 32px tall. The panel is redrawn
// on every change; the control that had focus gets it back, so keyboard users keep
// their place while stepping a slider or a stepper.

const ENCHANTING_TABLE_LEVEL = 30; // the enchanting table's top offer
const HOLD_DELAY_MS = 400;          // holding − / +: wait this long, then repeat
const HOLD_REPEAT_MS = 70;

// The level limit opens from the settings button in section 3's heading; Rename and Your
// level sit under the tiles, one row each, your level with what it means for this order
// beside it.
function renderRanking() {
    const box = $("#ranking");
    const panel = $("#limit-panel");
    const active = document.activeElement;
    const focused = active && (box.contains(active) || panel.contains(active)) ? active.dataset.focus : null;

    // The game rules menu: the level limit and whether conflicting enchantments may go
    // together (both for mods; they apply everywhere). The menu stays open while they change.
    panel.replaceChildren(
        h("div", { class: "options-panel-title" }, TEXT.ranking.options),
        h("div", { class: "options" },
            // No hover titles on these labels: the "?" beside each says what it is for.
            optionRow([TEXT.ranking.level_limit, helpTip("limit-help", TEXT.ranking.level_limit_help_label, TEXT.ranking.level_limit_help)], null, limitControl()),
            optionRow([TEXT.ranking.allow_conflicts, helpTip("conflicts-help", TEXT.ranking.allow_conflicts_help_label, TEXT.ranking.allow_conflicts_help)], null, conflictsSwitch())
        )
    );
    const summary = optionsSummary();
    $("#options-summary").textContent = summary;
    // On phones the button is the gear alone: a dot on it says a rule isn't the game's own,
    // and the label still says how they are set.
    const button = $("#options-menu > summary");
    button.classList.toggle("changed", state.no_step_limit || state.max_step !== MAX_STEP_LEVELS || state.allow_incompatible);
    button.setAttribute("aria-label", TEXT.ranking.options + ": " + summary);
    button.title = TEXT.ranking.options + ": " + summary;

    // Under the tiles: one grid, so the labels share a column.
    box.replaceChildren(h("div", { class: "options" },
        optionRow(TEXT.ranking.rename, TEXT.ranking.rename_help, nameField()),
        optionRow(TEXT.ranking.your_level, TEXT.ranking.your_level_help,
            levelControl())
    ));

    if (focused) {
        const again = document.querySelector(`#ranking [data-focus="${focused}"], #limit-panel [data-focus="${focused}"]`);
        if (again) again.focus();
    }
    updateLevelMeter();
}

// "Level limit 39" (or "No level limit"), plus "· Conflicts allowed" when they are, on
// the game rules button, so a rule that isn't the game's own is seen with the menu closed.
function optionsSummary() {
    const limit = state.no_step_limit ? TEXT.ranking.options_no_limit : TEXT.ranking.options_limit({ limit: state.max_step });
    return state.allow_incompatible ? limit + " · " + TEXT.ranking.options_conflicts : limit;
}

// What a game rule is for, in a "?" tip beside its label (tap on phones). Its bubble
// floats over the page, like the Best order one.
function helpTip(id, label, text) {
    const tip = infoTip(id, "?", label, text, "option-help");
    floatBubble(tip);
    return tip;
}

// Allow conflicts: an on/off switch.
function conflictsSwitch() {
    const on = state.allow_incompatible;
    return h("div", { class: "rule-control" },
        h("button", {
            type: "button", class: "rule-switch" + (on ? " on" : ""), role: "switch", "aria-checked": String(on),
            "data-focus": "allow-conflicts", "aria-label": TEXT.ranking.allow_conflicts,
            onclick: () => setAllowIncompatible(!on)
        }, h("span", { class: "rule-switch-track", "aria-hidden": "true" }, h("span", { class: "rule-switch-thumb" })),
            h("span", { class: "rule-switch-text" }, on ? TEXT.ranking.switch_on : TEXT.ranking.switch_off))
    );
}

// The panel is position: fixed, placed under the button whenever it opens and as the
// page or the right column scrolls: inside the right column it would count as the
// column's content, and stick out of (or add a scrollbar to) a short column, such as
// with Best order closed. It ends at the button's right edge, kept on screen.
function setupOptionsMenu() {
    const menu = $("#options-menu");
    const panel = $("#limit-panel");
    setupMenuClosing(menu); // its title and label come from renderRanking
    const place = () => {
        if (!menu.open) return;
        const button = menu.querySelector("summary").getBoundingClientRect();
        const width = panel.offsetWidth;
        panel.style.top = button.bottom + 6 + "px";
        panel.style.left = Math.max(8, Math.min(button.right - width, innerWidth - width - 8)) + "px";
    };
    menu.addEventListener("toggle", place);
    menu.querySelector("summary").addEventListener("click", () => requestAnimationFrame(place));
    document.addEventListener("scroll", place, { capture: true, passive: true });
    addEventListener("resize", place);
}

function optionRow(label, help, control) {
    return [
        h("span", { class: "option-label", title: help }, label),
        h("div", { class: "option-control" }, control)
    ];
}

// Level limit: a slider from 1 to 39 that ends in an ∞ stop (no limit, for mods that
// remove "Too Expensive!"). The number on the right can be tapped to type a value.
// Dragging only redraws the number; the new limit is used when the slider is let go.
function limitControl() {
    const unlimited = state.no_step_limit;
    const shown = value => (unlimited && value === state.max_step ? TEXT.ranking.unlimited : String(value));
    const value_button = h("button", {
        type: "button", class: "limit-value" + (unlimited ? " unlimited" : ""), "data-focus": "limit-value",
        title: TEXT.ranking.level_limit_edit_label, "aria-label": TEXT.ranking.level_limit_edit_label,
        onclick: () => editLimit(value_button)
    }, shown(state.max_step));
    const slider = h("input", {
        type: "range", class: "limit-slider" + (unlimited ? " off" : ""), min: 1, max: MAX_STEP_LEVELS, step: 1,
        value: state.max_step, "data-focus": "limit-slider", "aria-label": TEXT.ranking.level_limit_label,
        oninput: event => {
            value_button.textContent = event.target.value;
            value_button.classList.remove("unlimited");
            event.target.classList.remove("off");
            paintSlider(event.target);
        },
        onchange: event => setLimit(event.target.value)
    });
    paintSlider(slider);
    return h("div", { class: "limit" },
        h("span", { class: "limit-end", "aria-hidden": "true" }, "1"),
        slider,
        h("button", {
            type: "button", class: "limit-infinity" + (unlimited ? " on" : ""), "data-focus": "limit-infinity",
            "aria-pressed": String(unlimited), "aria-label": TEXT.ranking.no_limit, title: TEXT.ranking.no_limit_help,
            onclick: () => { state.no_step_limit = !state.no_step_limit; commit(); }
        }, TEXT.ranking.unlimited),
        value_button
    );
}

// The filled part of the track, up to the handle.
function paintSlider(slider) {
    const share = (slider.value - slider.min) / (slider.max - slider.min);
    slider.style.setProperty("--fill", (share * 100).toFixed(1) + "%");
}

// Moving the slider or typing a number always means "use this limit".
function setLimit(value) {
    state.max_step = clampStepLimit(value);
    state.no_step_limit = false;
    commit();
}

// Swaps the number for a box to type in: Enter or leaving it uses the value, Escape
// puts the number back.
function editLimit(button) {
    let done = false;
    const finish = use => {
        if (done) return;
        done = true;
        if (use && input.value.trim() !== "") setLimit(input.value);
        else renderRanking();
    };
    const input = h("input", {
        type: "number", class: "limit-edit", min: 1, max: MAX_STEP_LEVELS, inputmode: "numeric",
        value: state.max_step, "data-focus": "limit-value", "aria-label": TEXT.ranking.level_limit_label,
        onkeydown: event => {
            if (event.key === "Enter") finish(true);
            if (event.key === "Escape") { event.stopPropagation(); finish(false); }
        },
        onblur: () => finish(true)
    });
    button.replaceWith(input);
    input.focus();
    input.select();
}

// Your level: − / + around a game-style green number with an XP bar under it, which
// fills toward the levels the current order needs. Holding − or + repeats. The XP orb
// button turns following your level on or off. Off, the number shows ∞ (as the level
// limit does with no limit), and tapping it, typing or − / + turns it back on. It only
// changes what the steps show, so it redraws just the results.
function levelControl() {
    const input = h("input", {
        type: "number", class: "xp-value", id: "player-level", "data-focus": "player-level",
        min: 0, max: MAX_PLAYER_LEVEL, inputmode: "numeric", value: player_level, placeholder: "–",
        "aria-label": TEXT.ranking.your_level_label,
        oninput: event => setPlayerLevel(event.target.value.trim() === "" ? null : Number(event.target.value), false)
    });
    const step = (delta, sign, label) => holdButton({
        class: "xp-step", "data-focus": "level-" + (delta < 0 ? "down" : "up"), "aria-label": label
    }, sign, () => setPlayerLevel((player_level == null ? 0 : player_level) + delta, true));
    return h("div", { class: "level-control" },
        h("div", { class: "xp-box" + (level_on ? "" : " off") },
            step(-1, "−", TEXT.ranking.level_down_label),
            h("div", { class: "xp-field" },
                input,
                h("div", { class: "xp-bar", id: "xp-bar" }, h("div", { class: "xp-fill" })),
                // Off: ∞ in place of the number; the number is kept for turning it on.
                h("button", {
                    type: "button", class: "xp-infinity", "data-focus": "xp-infinity", tabindex: level_on ? "-1" : null,
                    "aria-label": TEXT.ranking.use_level, title: TEXT.ranking.use_level_help,
                    onclick: () => { setLevelOn(true); $("#player-level").focus(); }
                }, TEXT.ranking.unlimited)
            ),
            step(1, "+", TEXT.ranking.level_up_label)
        ),
        h("button", {
            type: "button", class: "level-toggle" + (level_on ? " on" : ""), "data-focus": "level-toggle",
            "aria-pressed": String(level_on), "aria-label": TEXT.ranking.use_level, title: TEXT.ranking.use_level_help,
            onclick: () => setLevelOn(!level_on)
        }, xpOrb()),
        // "Set to 61": exactly the levels the unticked steps still need (filled in by
        // updateLevelMeter, which knows the order).
        h("button", {
            type: "button", class: "level-set", id: "level-set", "data-focus": "level-set",
            title: TEXT.ranking.set_needed_help,
            onclick: () => {
                const node = resultNode();
                if (node) setPlayerLevel(remainingLevels(logic.collectSteps(node)).needed, true);
            }
        })
    );
}

// The game's experience orb (img/experience_orb.png).
function xpOrb() {
    return h("img", { class: "xp-orb", src: "img/experience_orb.png", alt: "", "aria-hidden": "true" });
}

// Turning it on with no number yet starts at 30 (the enchanting table's top level).
function setLevelOn(on) {
    level_on = on;
    writeStorage(LEVEL_ON_STORAGE_KEY, level_on);
    if (on && player_level == null) {
        player_level = ENCHANTING_TABLE_LEVEL;
        writeStorage(LEVEL_STORAGE_KEY, player_level);
    }
    renderRanking();
    renderResults();
}

// The level the steps follow, or null when "Your level" is off or blank.
function activeLevel() {
    return level_on ? player_level : null;
}

// A button that acts once when pressed and keeps acting while held. Keyboard presses
// (Enter, Space) act once through the click.
function holdButton(attrs, text, act) {
    let delay = null, repeat = null;
    const stop = () => { clearTimeout(delay); clearInterval(repeat); };
    return h("button", {
        type: "button", ...attrs,
        onpointerdown: event => {
            if (event.button > 0) return;
            act();
            delay = setTimeout(() => { repeat = setInterval(act, HOLD_REPEAT_MS); }, HOLD_DELAY_MS);
        },
        onpointerup: stop, onpointerleave: stop, onpointercancel: stop,
        onclick: event => { if (event.detail === 0) act(); }
    }, text);
}

// `null` clears it. `update_input`: also show the new value in the box (not while
// typing in it, which would move the cursor).
function setPlayerLevel(value, update_input) {
    player_level = value == null || Number.isNaN(value) ? null : Math.min(MAX_PLAYER_LEVEL, Math.max(0, Math.floor(value)));
    writeStorage(LEVEL_STORAGE_KEY, player_level);
    if (update_input) $("#player-level").value = player_level == null ? "" : player_level;
    // Changing the number means using it.
    if (!level_on && player_level != null) {
        level_on = true;
        writeStorage(LEVEL_ON_STORAGE_KEY, true);
        $(".xp-box").classList.remove("off");
        $(".xp-infinity").tabIndex = -1;
        const toggle = $(".level-toggle");
        toggle.classList.add("on");
        toggle.setAttribute("aria-pressed", "true");
    }
    renderResults();
}

// What is still to spend, for "Your level": ticked steps are done, so their levels are
// already gone from the player's level and count as 0 here. (The Levels tile keeps the
// whole order's total.) Returns { costs: per step in step order, needed: their sum, done }.
function remainingLevels(steps) {
    const done = loadChecklist(orderKey(steps));
    const costs = steps.map(step => (done.has(step.number) ? 0 : step.node.merge_levels));
    return { costs, needed: costs.reduce((total, cost) => total + cost, 0), done };
}

// The finished order, or null while there is none.
function resultNode() {
    const node = last_result && last_result.status === "ok" ? last_result.node : null;
    return node && node.left ? node : null;
}

// The XP bar under "Your level": how far the level goes toward what the order needs.
function updateLevelMeter() {
    const bar = $("#xp-bar");
    if (!bar) return;
    const node = resultNode();
    const levels = node ? remainingLevels(logic.collectSteps(node)) : null;
    const needed = levels ? levels.needed : 0;
    const active = activeLevel();
    const level = active == null ? 0 : active;
    const share = needed && active != null ? Math.min(1, level / needed) : 0;
    bar.firstChild.style.width = (share * 100).toFixed(1) + "%";
    bar.classList.toggle("enough", Boolean(needed) && active != null && level >= needed);
    bar.title = !needed || active == null ? ""
        : level >= needed ? TEXT.ranking.level_enough({ needed })
            : TEXT.ranking.level_short_of({ short: needed - level, needed });

    const set = $("#level-set");
    set.textContent = TEXT.ranking.set_needed({ levels: levels ? needed : TEXT.ranking.no_value });
    set.disabled = !levels;
}

// Rename: one box drawn like the anvil's name field. Empty means no rename, and shows the
// item's own name in gray as a hint; any typed name (even the item's own) renames the item
// in the last step (+1 level), in white italics as the game shows renamed items. Inside:
// the name tag (lit while renaming), the name, a "+1 level" badge while renaming, and a
// count against the edition's limit.
function nameField() {
    const limit = MAX_NAME_LENGTH[state.edition];
    const original = state.item ? logic.itemName(state.item) : "";
    const count = h("span", { class: "name-count" });
    const input = h("input", {
        type: "text", class: "anvil-name-input", value: state.rename_to, maxlength: limit, "data-focus": "rename-to",
        placeholder: original || TEXT.ranking.rename_placeholder, "aria-label": TEXT.ranking.rename_label,
        oninput: event => {
            state.rename_to = cleanName(event.target.value, state.edition);
            const renaming = syncRename();
            showState();
            saveToUrl();
            // Starting or ending a rename changes the cost (+1 level), so search again;
            // otherwise only the name on the result changes. This box is never redrawn
            // while typing, which would move the cursor.
            if (renaming !== was_renaming) { was_renaming = renaming; scheduleCalculation(); }
            renderResults();
        }
    });
    const box = h("div", { class: "anvil-name" },
        nameTagIcon(),
        input,
        h("span", { class: "rename-cost" }, TEXT.ranking.rename_cost),
        count
    );
    let was_renaming = state.rename;
    const showState = () => {
        const used = [...input.value].length;
        count.textContent = TEXT.ranking.name_count({ count: used, max: limit });
        count.title = TEXT.ranking.name_count_label({ count: used, max: limit });
        box.classList.toggle("renaming", state.rename);
    };
    showState();
    return box;
}

// The game's name tag (img/name_tag.png).
function nameTagIcon() {
    return h("img", { class: "name-tag-icon", src: "img/name_tag.png", alt: "", "aria-hidden": "true" });
}

// Renaming is on exactly when a name is typed. Returns whether it is.
function syncRename() {
    state.rename = state.rename_to.trim() !== "";
    return state.rename;
}

// Each redraw (a tick, a new name, a new level) rebuilds the steps; their scroll position
// is kept when the same view of the same order comes back.
let steps_scroll = { key: null, top: 0 };

function renderResults() {
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
            h("span", { class: "progress-text", id: "progress-text" }, "0%"),
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
        content.append(h("div", { class: "warning" },
            state.no_step_limit
                ? TEXT.results.no_valid_order
                : TEXT.results.no_valid_order_within({ limit: state.max_step })));
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

    content.append(h("div", { class: "toolbar result-tools" },
        h("div", { class: "segmented", role: "group", "aria-label": TEXT.results.view_label },
            [["steps", TEXT.results.view_steps], ["tree", TEXT.results.view_tree]].map(([view, label]) => h("button", {
                type: "button", class: result_view === view ? "selected" : "", "aria-pressed": String(result_view === view),
                onclick: () => { result_view = view; writeStorage(VIEW_STORAGE_KEY, view); renderResults(); }
            }, label))),
        h("button", {
            type: "button", class: "btn small ghost", title: TEXT.results.uncheck_all_help,
            disabled: loadChecklist(orderKey(steps)).size === 0,
            onclick: () => { saveChecklist(orderKey(steps), new Set()); renderResults(); }
        }, TEXT.results.uncheck_all),
        h("button", {
            type: "button", class: "btn small copy-steps", title: TEXT.results.copy_steps_help,
            onclick: event => copyText(event.currentTarget, stepsText(node, steps), TEXT.results.copy_steps)
        }, TEXT.results.copy_steps),
        h("button", { type: "button", class: "btn small", title: TEXT.results.print_help, onclick: () => window.print() }, TEXT.results.print)
    ));

    // Only the steps (or the tree) scroll, under the Steps/Tree row; on desktop they fill
    // what is left of the window. See .steps-scroll.
    const order_key = orderKey(steps);
    const scroller = h("div", { class: "steps-scroll" });
    content.append(scroller);

    const done = loadChecklist(order_key);
    if (result_view === "tree") {
        scroller.append(mergeTree(node, steps, done, order_key));
    } else {
        // One group per round: its steps don't depend on each other, so any order works.
        const rounds = logic.stepRounds(steps);
        scroller.append(h("div", { class: "rounds" }, rounds.map((round, index) => h("section", { class: "round" },
            h("div", { class: "round-label", title: round.length > 1 ? TEXT.results.round_help : null },
                TEXT.results.round({ number: index + 1, steps: round.length })),
            h("ol", { class: "anvil-steps" }, round.map(step =>
                anvilStep(step, done, order_key, steps, track && !done.has(step.number) ? track.steps[step.number - 1] : null)))
        ))));
    }

    const scroll_key = result_view + "|" + order_key;
    if (steps_scroll.key === scroll_key) scroller.scrollTop = steps_scroll.top;
    steps_scroll = { key: scroll_key, top: scroller.scrollTop };
}

// [anvil] 7 anvil uses · (4% chance a new anvil breaks). The chance is a badge colored
// by how likely the break is; under 3 uses a new anvil can't break.
const ANVIL_RISK_MEDIUM = 0.1;
const ANVIL_RISK_HIGH = 0.5;

// The break risk in section 4's heading: the anvil and the chance ("4%"), colored by risk
// (green unlikely or impossible, amber possible, red likely). Tap or hover for the
// sentence and how wear works; its bubble floats over the page, like the other tips.
function anvilRisk(uses) {
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
        return h("li", { class: "tree-node" },
            h("div", { class: "tree-line" + (number ? " merge" : "") + (number && done.has(number) ? " done" : "") },
                h("span", { class: "tree-slot" + (enchanted ? " glint" : "") }, icon(node.item_namespace, true)),
                h("span", { class: "mc-tooltip tree-tooltip" },
                    h("span", { class: "mc-name rarity-" + logic.rarity(node.item_namespace, enchanted) + (renamed ? " renamed" : "") }, nodeName(node)),
                    enchanted ? h("span", { class: "mc-ench tree-ench" }, enchantments) : null),
                number ? h("label", { class: "tree-step", title: TEXT.results.step_done_help },
                    stepTick(number, done, order_key, steps),
                    TEXT.results.tree_step({ number, levels: node.merge_levels })) : null
            ),
            node.left ? h("ul", { class: "tree-children" }, branch(node.left), branch(node.right)) : null
        );
    };
    return h("ul", { class: "merge-tree" }, branch(root));
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
function orderKey(steps) {
    return JSON.stringify(steps.map(step => [
        step.left.node.item_namespace, step.left.node.enchantments,
        step.right.node.item_namespace, step.right.node.enchantments, step.node.merge_levels
    ]));
}

function loadChecklist(order_key) {
    try {
        const saved = JSON.parse(localStorage.getItem(CHECKLIST_STORAGE_KEY));
        if (saved && saved.key === order_key && Array.isArray(saved.done)) return new Set(saved.done);
    } catch {
        // No storage: start unticked.
    }
    return new Set();
}

function saveChecklist(order_key, done) {
    try {
        localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify({ key: order_key, done: [...done] }));
    } catch {
        // No storage: ticks last until the page reloads.
    }
}

// One anvil step drawn like the game's anvil: [left] + [right] -> [result], with a
// box to tick it off.
// `level`: { before, after, short } with "Your level" filled in, else null.
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
            saveChecklist(order_key, logic.tickStep(steps, done, number, event.target.checked));
            renderResults();
            const again = document.querySelector(`input[data-step="${number}"]`);
            if (again) again.focus(); // keyboard users keep their place
        }
    });
}

function anvilStep(step, done, order_key, steps, level = null) {
    const number = step.number;
    const tick = stepTick(number, done, order_key, steps);
    const left_levels = new Map(step.left.node.enchantments.map(e => [e.namespace, e.level]));
    const changed = new Set(step.node.enchantments
        .filter(e => left_levels.get(e.namespace) !== e.level)
        .map(e => e.namespace));

    return h("li", { class: "anvil-step" + (done.has(number) ? " done" : "") },
        h("label", { class: "anvil-step-num", title: TEXT.results.step_done_help }, tick, number),
        h("div", { class: "anvil-row" },
            anvilCell(step.left.node, null, "left"),
            h("div", { class: "anvil-op", "aria-hidden": "true" }, "+"),
            anvilCell(step.right.node, null, "right"),
            h("div", { class: "anvil-arrow" },
                h("span", { class: "arrow-glyph", "aria-hidden": "true" }, "➔"),
                h("span", { class: "anvil-cost" }, step.node.renamed
                    ? TEXT.results.cost_renamed({ levels: step.node.merge_levels })
                    : TEXT.results.cost({ levels: step.node.merge_levels })),
                level ? h("span", { class: "level-track" + (level.short ? " short" : "") }, level.short
                    ? TEXT.results.level_short({ count: level.short })
                    : TEXT.results.level_track({ before: level.before, after: level.after })) : null
            ),
            anvilCell(step.node, changed, "result")
        )
    );
}

// An inventory slot with a game-style tooltip underneath. The name is colored by rarity.
// `role` is "left", "right" or "result", for the layout.
function anvilCell(node, changed, role) {
    const enchanted = node.enchantments.length > 0;
    // A renamed item shows its new name in italics, as in the game.
    const renamed = Boolean(node.renamed && state.rename_to.trim());
    const name = nodeName(node);
    const name_class = "mc-name rarity-" + logic.rarity(node.item_namespace, enchanted) + (renamed ? " renamed" : "");
    const lines = logic.tooltipSort(node.enchantments).map(e => h("div", {
        class: "mc-ench" + (logic.isCurse(e.namespace) ? " curse" : "") + (changed && changed.has(e.namespace) ? " changed" : "")
    }, logic.displayName(e.namespace, e.level)));

    return h("div", { class: "anvil-cell " + role },
        h("div", { class: "mc-slot" + (enchanted ? " glint" : "") }, icon(node.item_namespace)),
        h("div", { class: "mc-tooltip" }, h("div", { class: name_class }, name), lines)
    );
}

// ---------- Calculation (Web Worker) ----------

function startWorker() {
    worker = new Worker(WORKER_URL);
    worker.onmessage = handleWorkerMessage;
    worker.onerror = event => {
        event.preventDefault();
        stopRunning();
        last_result = { status: "error", error: TEXT.results.worker_failed };
        renderResults();
    };
    worker.postMessage({ message: "instantiate_metadata", metadata: meta });
}

function restartWorker() {
    worker.terminate();
    startWorker();
}

function stopRunning() {
    running = false;
    show_progress = false;
    clearTimeout(progress_timer);
}

function scheduleCalculation() {
    clearTimeout(calc_timer);
    calc_timer = setTimeout(runCalculation, CALC_DELAY_MS);
}

function runCalculation() {
    clearTimeout(calc_timer);
    // The search is one synchronous call, so a newer request has to replace the worker.
    if (running) restartWorker();
    stopRunning();

    const entries = logic.buildEntries(state);
    if (entries.length < 2) {
        last_result = { status: "empty" };
        renderResults();
        return;
    }
    if (searchSize(entries).groups > MAX_GROUPS) {
        last_result = { status: "error", error: TEXT.results.too_many_different };
        renderResults();
        return;
    }

    request_id++;
    running = true;
    progress_timer = setTimeout(() => { show_progress = true; renderResults(); }, PROGRESS_DELAY_MS);
    worker.postMessage({
        message: "calculate_optimal",
        request_id: request_id,
        item_entries: entries,
        priority: state.priority,
        max_merge_levels: stepLimit(),
        edition: state.edition,
        rename: state.rename
    });
    renderResults();
}

function cancelCalculation() {
    if (!running) return;
    restartWorker();
    stopRunning();
    last_result = { status: "cancelled" };
    renderResults();
}

function handleWorkerMessage(event) {
    const data = event.data;
    if (data.request_id !== request_id) return;

    if (data.message === "progress") {
        const percent = Math.min(100, Math.floor((data.done / data.total) * 100));
        const fill = document.getElementById("progress-fill");
        const text = document.getElementById("progress-text");
        if (fill) fill.style.width = percent + "%";
        if (text) text.textContent = percent + "%";
    } else if (data.message === "optimal_searched") {
        stopRunning();
        last_result = { status: "ok", node: data.result };
        renderResults();
    } else if (data.message === "calculation_failed") {
        stopRunning();
        last_result = { status: "error", error: data.error };
        renderResults();
    }
}

// ---------- Shareable URL ----------

function saveToUrl() {
    const url = state.item ? "#" + logic.serialize(state) : location.pathname + location.search;
    history.replaceState(null, "", url);
}

function loadFromUrl() {
    const hash = location.hash.slice(1);
    const loaded = hash ? readLink(hash) : null;
    if (loaded) { state = loaded; syncRename(); }
}

// The state in a share link's text, or null if it is not valid. Read with the Java
// helpers, which know every enchantment; the caller then switches to the link's edition.
function readLink(text) {
    try {
        useEdition("java");
        return logic.deserialize(text, () => next_book_id++);
    } catch (error) {
        console.warn("Ignoring invalid link", error);
        return null;
    } finally {
        useEdition(state.edition);
    }
}

// The "?" next to "Best order": shows how the tiles rank on hover or keyboard focus (CSS),
// and on tap for touch screens, where hover tooltips never appear. Tapping elsewhere or
// pressing Escape closes it.
function setupInfoTip() {
    const button = $("#rank-help");
    button.addEventListener("click", event => toggleTip(event, button.closest(".info-tip")));
    floatBubble(button.closest(".info-tip"));
    // Any open tip closes on a click elsewhere or on Escape.
    document.addEventListener("click", event => {
        for (const tip of document.querySelectorAll(".info-tip.open")) if (!tip.contains(event.target)) setTipOpen(tip, false);
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") for (const tip of document.querySelectorAll(".info-tip.open")) setTipOpen(tip, false);
    });
}

// The "?" sits in the right column, which scrolls when its contents are too tall, so a
// bubble positioned inside it would count as content and add a scrollbar. This places the
// bubble against the window instead (position: fixed): under the "?", kept on screen, and
// following the "?" when the page or the column scrolls.
function floatBubble(tip) {
    const bubble = tip.querySelector(".info-tip-bubble");
    // Only while it shows: a hidden bubble has no width to keep on screen.
    const place = () => {
        if (!bubble.offsetWidth) return;
        const anchor = tip.querySelector("button").getBoundingClientRect();
        bubble.style.top = anchor.bottom + 6 + "px";
        bubble.style.left = Math.max(8, Math.min(anchor.left, innerWidth - bubble.offsetWidth - 8)) + "px";
    };
    tip.classList.add("floating");
    tip.place = place; // setTipOpen calls it once the bubble is open
    for (const type of ["mouseenter", "focusin"]) tip.addEventListener(type, () => requestAnimationFrame(place));
    if (!floating_listeners) {
        // Once for all of them, since tips in redrawn panels are new each time.
        floating_listeners = true;
        const placeAll = () => { for (const other of document.querySelectorAll(".info-tip.floating")) other.place(); };
        document.addEventListener("scroll", placeAll, { capture: true, passive: true });
        addEventListener("resize", placeAll);
    }
}
let floating_listeners = false;

// Tips redrawn while open (the books badge, on every edit) stay open: remembered by id.
const open_tips = new Set();

function setTipOpen(tip, open) {
    tip.classList.toggle("open", open);
    if (open && tip.place) tip.place();
    tip.querySelector("button").setAttribute("aria-expanded", String(open));
    if (tip.id) open ? open_tips.add(tip.id) : open_tips.delete(tip.id);
}

function toggleTip(event, tip) {
    event.stopPropagation();
    setTipOpen(tip, !tip.classList.contains("open"));
}

// A small button that shows `text` in a bubble on hover, focus or tap.
function infoTip(id, button_text, label, text, extra_class = "") {
    const tip = h("span", { class: "info-tip " + extra_class, id },
        h("button", {
            type: "button", class: "info-tip-button", "aria-label": label, "aria-expanded": "false",
            onclick: event => toggleTip(event, tip)
        }, button_text),
        h("span", { class: "info-tip-bubble", role: typeof text === "string" ? "tooltip" : "group" }, text)
    );
    if (open_tips.has(id)) setTipOpen(tip, true);
    return tip;
}

// Light or dark: follows the system until the sun/moon button picks one, which is then
// remembered here (index.html applies it before the page draws, so there is no flash).
// The button shows the theme it switches to: a moon in light mode, a sun in dark mode.
function currentTheme() {
    return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function renderTheme() {
    const button = $("#theme");
    const dark = currentTheme() === "dark";
    const label = dark ? TEXT.page.theme_light : TEXT.page.theme_dark;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.querySelector(".sun-icon").style.display = dark ? "" : "none";
    button.querySelector(".moon-icon").style.display = dark ? "none" : "";
}

function setupTheme() {
    $("#theme").addEventListener("click", () => {
        const next = currentTheme() === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        writeStorage(THEME_STORAGE_KEY, next);
        renderTheme();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderTheme);
    renderTheme();
}

function setupCopyLink() {
    const button = $("#copy-link");
    button.addEventListener("click", () => copyText(button.querySelector(".copy-label"), location.href, TEXT.page.copy_link, button));
}

// ---------- Start ----------

// Fills the static text in index.html: each `data-text="section.key"` gets TEXT.section.key.
function fillPageText() {
    document.title = TEXT.page.title;
    for (const el of document.querySelectorAll("[data-text]")) {
        const [section, key] = el.dataset.text.split(".");
        el.textContent = TEXT[section][key];
    }
    // `data-text-label` sets a screen-reader label instead of visible text.
    for (const el of document.querySelectorAll("[data-text-label]")) {
        const [section, key] = el.dataset.textLabel.split(".");
        el.setAttribute("aria-label", TEXT[section][key]);
    }
}

async function init() {
    try {
        await applyLanguage(startingLanguage());
    } catch (error) {
        // Without any text there is nothing to show; the console says why.
        console.error(error);
        return;
    }
    try {
        const response = await fetch(META_URL);
        meta = await response.json();
    } catch (error) {
        $("#results").replaceChildren(h("div", { class: "error" }, TEXT.results.metadata_failed));
        return;
    }
    useEdition("java");
    loadFromUrl();
    if (state.edition !== "java" && state.item) sanitizeAll();
    startWorker();
    setupCopyLink();
    setupTheme();
    setupInfoTip();
    setupSavedMenu();
    setupItemMenu();
    setupEntryPopover();
    setupOptionsMenu();
    setupCollapsing();
    render();
    runCalculation();
    registerOffline();
}

// Keeps a copy of the site for use without a connection (ServiceWorker.js).
function registerOffline() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("ServiceWorker.js").catch(error => console.warn("Offline use is unavailable", error));
}

init();
