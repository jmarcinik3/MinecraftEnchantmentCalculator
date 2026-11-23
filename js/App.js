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
const VIEW_STORAGE_KEY = "enchantment-calculator-view";
const SAVED_STORAGE_KEY = "enchantment-calculator-saved";
const LANGUAGE_STORAGE_KEY = "enchantment-calculator-language";
const MAX_PLAYER_LEVEL = 24791; // the highest level in either edition
const MAX_SETUP_NAME = 100;
const COPIED_MS = 1500; // how long "Copied" shows on a copy button

let meta = null;
let logic = null;
let state = defaultState();
let next_book_id = 1;
let undo_books = null; // the custom list before the last suggestion was applied

let worker = null;
let request_id = 0;
let running = false;
let show_progress = false;
let calc_timer = null;
let progress_timer = null;
let last_result = null; // { status: "ok" | "empty" | "cancelled" | "error", node?, error? }

let language = "en";
let player_level = readStorage(LEVEL_STORAGE_KEY, null); // "Your level", or null when blank
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

// Copies `text`, showing "Copied" on `button` for a moment, then `label` again.
async function copyText(button, text, label) {
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = TEXT.results.copied;
    } catch {
        button.textContent = TEXT.results.copy_failed;
    }
    setTimeout(() => { button.textContent = label; }, COPIED_MS);
}

// ---------- State changes ----------

// `keep_undo` is only for applying a suggestion: any other change ends the chance to undo it.
function commit(keep_undo = false) {
    if (!keep_undo) undo_books = null;
    saveToUrl();
    render();
    scheduleCalculation();
}

function selectItem(item) {
    if (state.item === item) return;
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
function addBook(type) {
    state.books.push({ id: next_book_id++, type: type, enchantments: {}, prior_work: 0, copies: 1 });
    commit();
}

// ---------- Rendering ----------

function render() {
    renderLanguage();
    renderSaved();
    renderItems();
    renderWanted();
    renderBooks();
    renderEdition();
    renderRanking();
    renderResults();
}

// ---------- Language ----------

function renderLanguage() {
    $("#language").replaceChildren(h("select", {
        class: "language-select",
        "aria-label": TEXT.page.language_label,
        title: TEXT.page.language_label,
        onchange: event => switchLanguage(event.target.value)
    }, Object.entries(LANGUAGES).map(([code, label]) => h("option", { value: code, selected: code === language }, label))));
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
    useEdition(state.edition);
    if (state.item) sanitizeAll();
    $("#saved").open = false;
    commit();
}

// The Saved menu closes on a click outside it or on Escape.
function setupSavedMenu() {
    const menu = $("#saved");
    $("#saved > summary").title = TEXT.page.saved_help;
    document.addEventListener("click", event => {
        // The path, not contains(): a click on a button the menu then redraws is still inside.
        if (menu.open && !event.composedPath().includes(menu)) menu.open = false;
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape") menu.open = false; });
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

function renderItems() {
    const grid = $("#items");
    grid.replaceChildren(...logic.enchantableItems().map(item => h("button", {
        type: "button",
        class: "item-button" + (state.item === item ? " selected" : ""),
        "aria-pressed": String(state.item === item),
        onclick: () => selectItem(item)
    }, icon(item), logic.itemName(item))));
}

function renderWanted() {
    const box = $("#wanted");
    box.replaceChildren();
    if (!state.item) {
        box.append(h("p", { class: "hint" }, TEXT.wanted.pick_item_first));
        return;
    }

    box.append(h("div", { class: "toolbar" },
        h("button", { type: "button", class: "btn small", onclick: () => { state.wanted = logic.maxAll(state.item, state.wanted, state.allow_incompatible); commit(); } }, TEXT.wanted.max_all),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { state.wanted = {}; commit(); } }, TEXT.wanted.clear),
        h("label", { class: "check-option", title: TEXT.wanted.allow_conflicts_help },
            h("input", { type: "checkbox", checked: state.allow_incompatible, onchange: event => setAllowIncompatible(event.target.checked) }),
            TEXT.wanted.allow_conflicts
        )
    ));

    // B: chosen enchantments the custom books can't reach (none in automatic mode).
    const short = new Map(logic.checkBooks(state).short.map(s => [s.ns, s]));

    // Conflicting enchantments are boxed together where the first of them would be listed.
    let curses_shown = false;
    for (const group of logic.enchantmentGroups(state.item)) {
        if (logic.isCurse(group.members[0]) && !curses_shown) {
            box.append(h("div", { class: "divider" }, TEXT.wanted.curses));
            curses_shown = true;
        }
        if (group.members.length === 1) {
            box.append(wantedRow(group.members[0], false, short.get(group.members[0])));
            continue;
        }
        box.append(h("div", { class: "ench-group" + (group.exclusive ? " exclusive" : "") },
            h("div", { class: "ench-group-label" },
                state.allow_incompatible ? TEXT.wanted.group_allowed
                    : group.exclusive ? TEXT.wanted.group_pick_one : TEXT.wanted.group_some_conflict),
            group.members.map(ns => wantedRow(ns, group.exclusive, short.get(ns)))
        ));
    }
}

// One enchantment with its level buttons. In a "Pick one" group the box already says
// they conflict, so the per-row note is left out.
// `short`: { best } when the custom books can't reach this chosen level.
function wantedRow(ns, in_exclusive_group, short = null) {
    const chosen = state.wanted[ns] || 0;
    const blocker = !chosen && Object.keys(state.wanted).find(other => clashes(other, ns));

    const levels = [];
    for (let level = 1; level <= logic.maxLevel(ns); level++) {
        levels.push(h("button", {
            type: "button",
            class: "level" + (chosen === level ? " selected" : ""),
            "aria-pressed": String(chosen === level),
            "aria-label": logic.displayName(ns, level),
            title: blocker ? TEXT.wanted.replaces({ name: logic.enchName(blocker) }) : null,
            onclick: () => setWanted(ns, chosen === level ? 0 : level)
        }, roman(level)));
    }

    return h("div", { class: "ench-row" + (blocker ? " conflict" : "") + (chosen ? " chosen" : "") },
        h("div", { class: "ench-name" },
            // The mark shares the name's line, so rows never get taller.
            h("span", { class: "ench-title" },
                logic.enchName(ns),
                short ? h("span", { class: "short-mark", title: TEXT.wanted.short_help },
                    short.best ? TEXT.wanted.books_reach({ level: roman(short.best) }) : TEXT.wanted.not_on_books) : null
            ),
            blocker && !in_exclusive_group ? h("span", { class: "note" }, TEXT.wanted.conflicts_with({ name: logic.enchName(blocker) })) : null
        ),
        h("div", { class: "levels" }, levels)
    );
}

// Every enchantment on any custom entry. In vanilla, a new one must not conflict with
// any of them, since the engine does not check conflicts.
function onAnvil() {
    return state.books.flatMap(book => Object.keys(book.enchantments));
}

// `unwanted`: enchantments not chosen in section 2, flagged since they still cost levels.
// `book`: the entry being edited, so a new book that turns out identical to another
// entry becomes one more copy of it.
function enchantmentEditor(enchantments, unwanted = new Set(), book = null) {
    const tags = Object.entries(enchantments).map(([ns, level]) => {
        const is_unwanted = unwanted.has(ns);
        let level_select = null;
        if (logic.maxLevel(ns) > 1) {
            const options = [];
            for (let l = 1; l <= logic.maxLevel(ns); l++) {
                options.push(h("option", { value: l, selected: l === level }, roman(l)));
            }
            level_select = h("select", {
                "aria-label": TEXT.books.level_of_label({ name: logic.enchName(ns) }),
                onchange: event => { enchantments[ns] = Number(event.target.value); commit(); }
            }, options);
        }
        return h("span", { class: "tag" + (is_unwanted ? " unwanted" : ""), title: is_unwanted ? TEXT.books.unwanted_help : null },
            is_unwanted ? h("span", { class: "tag-flag", "aria-label": TEXT.books.unwanted_label }, "!") : null,
            logic.enchName(ns),
            level_select,
            h("button", {
                type: "button",
                class: "tag-remove",
                "aria-label": TEXT.books.remove_enchantment_label({ name: logic.enchName(ns) }),
                onclick: () => { delete enchantments[ns]; commit(); }
            }, "×")
        );
    });

    const available = logic.applicable(state.item).filter(ns =>
        !(ns in enchantments) && !onAnvil().some(other => clashes(other, ns)));
    const add_select = available.length ? h("select", {
        class: "add-ench",
        "aria-label": TEXT.books.add_enchantment_label,
        onchange: event => {
            const ns = event.target.value;
            if (!ns) return;
            const was_empty = Object.keys(enchantments).length === 0;
            enchantments[ns] = logic.maxLevel(ns);
            // Only when a new, empty book gets its first enchantment: changing an entry later
            // never makes it disappear into another.
            const twin = was_empty && book ? logic.twinOf(state.books, book) : null;
            if (twin) {
                twin.copies = Math.min(MAX_COPIES, (twin.copies || 1) + (book.copies || 1));
                state.books = state.books.filter(other => other !== book);
            }
            commit();
        }
    }, h("option", { value: "" }, TEXT.books.add_enchantment), available.map(ns => h("option", { value: ns }, logic.enchName(ns)))) : null;

    return h("div", { class: "tags" }, tags, add_select);
}

function stepper(label, value, min, max, onSet, help) {
    return h("span", { class: "stepper", title: help },
        label,
        h("button", { type: "button", class: "btn tiny", "aria-label": TEXT.books.decrease_label({ label }), disabled: value <= min, onclick: () => onSet(value - 1) }, "−"),
        h("span", { class: "stepper-value" }, value),
        h("button", { type: "button", class: "btn tiny", "aria-label": TEXT.books.increase_label({ label }), disabled: value >= max, onclick: () => onSet(value + 1) }, "+")
    );
}

// The step limit in effect, or Infinity when it is turned off.
function stepLimit() {
    return state.no_step_limit ? Infinity : state.max_step;
}

function renderBooks() {
    const box = $("#books");
    box.replaceChildren();
    $("#books-alert").replaceChildren();
    if (!state.item) return;

    const books = logic.currentBooks(state);
    const item_name = logic.itemName(state.item);

    if (state.auto_books) {
        box.append(h("div", { class: "toolbar" },
            h("div", { class: "chips" }, books.map(book => {
                const enchantments = logic.summary(Object.entries(book.enchantments).map(([namespace, level]) => ({ namespace, level })));
                const is_item = book.type === "item";
                return h("span", { class: "chip" }, icon(is_item ? state.item : "book", true), enchantments || (is_item ? item_name : TEXT.books.book));
            })),
            h("button", { type: "button", class: "btn small", onclick: customizeBooks }, TEXT.books.edit)
        ));
        return;
    }

    box.append(h("div", { class: "toolbar" },
        h("button", { type: "button", class: "btn small", onclick: () => addBook("book") }, icon("book", true), TEXT.books.add_book),
        h("button", { type: "button", class: "btn small", onclick: () => addBook("item") }, icon(state.item, true), TEXT.books.add_item({ item: item_name.toLowerCase() })),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { state.auto_books = true; state.books = []; commit(); } }, TEXT.books.automatic),
        // In the toolbar's row, so it appearing does not move the entries.
        undo_books ? h("button", {
            type: "button", class: "btn small undo", title: TEXT.books.undo_help,
            onclick: () => { state.books = undo_books; commit(); }
        }, TEXT.books.undo) : null
    ));
    const check = logic.checkBooks(state);
    renderBooksAlert(check);
    const unwanted = new Set(check.unwanted);
    books.forEach((book, index) => {
        box.append(h("div", { class: "book-editor", "data-index": index },
            entryHandle(index, books.length), // its own column, centered down the whole entry
            h("div", { class: "book-editor-head" },
                typeToggle(book, item_name),
                h("span", { class: "spacer" }),
                stepper(TEXT.books.copies, book.copies || 1, 1, MAX_COPIES, value => { book.copies = value; commit(); }, TEXT.books.copies_help),
                stepper(TEXT.books.prior_work, book.prior_work, 0, maxPriorWork(stepLimit()), value => { book.prior_work = value; commit(); }, TEXT.books.prior_work_help),
                h("button", {
                    type: "button",
                    class: "tag-remove",
                    "aria-label": TEXT.books.remove_entry_label({ number: index + 1 }),
                    onclick: () => { state.books = state.books.filter(b => b !== book); commit(); }
                }, "×")
            ),
            enchantmentEditor(book.enchantments, unwanted, book)
        ));
    });
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
            undo_books = state.books.map(book => ({ ...book }));
            state.books = adding.books.map(book => (book.id == null ? { ...book, id: next_book_id++ } : book));
            commit(true);
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
        onpointerdown: event => dragToReorder(event, event.currentTarget.closest(".book-editor"), index, ".book-editor",
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

// Switches an entry between a book and another copy of the item being enchanted.
function typeToggle(book, item_name) {
    const options = [["book", "book", TEXT.books.book], ["item", state.item, item_name]];
    return h("div", { class: "segmented icon-toggle", role: "group", "aria-label": TEXT.books.type_label }, options.map(([type, icon_ns, label]) =>
        h("button", {
            type: "button",
            class: book.type === type ? "selected" : "",
            "aria-pressed": String(book.type === type),
            title: label,
            "aria-label": label,
            onclick: () => { if (book.type !== type) { book.type = type; commit(); } }
        }, icon(icon_ns, true))
    ));
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

// The level limit, no-limit and rename options above the results.
function renderRanking() {
    const box = $("#ranking");

    // The saved number comes back when the limit is turned on again.
    const limit = state.no_step_limit ? h("input", {
        type: "text", class: "step-limit unlimited", value: TEXT.ranking.unlimited, readonly: true, tabindex: "-1",
        "aria-label": TEXT.ranking.no_limit_label
    }) : h("input", {
        type: "number", class: "step-limit", min: 1, max: MAX_STEP_LEVELS, value: state.max_step,
        "aria-label": TEXT.ranking.level_limit_label,
        onchange: event => {
            state.max_step = clampStepLimit(event.target.value);
            event.target.value = state.max_step;
            commit();
        }
    });

    box.replaceChildren(
        h("div", { class: "ranking-row", title: TEXT.ranking.level_limit_help },
            h("span", { class: "ranking-label" }, TEXT.ranking.level_limit), limit,
            h("label", { class: "no-limit", title: TEXT.ranking.no_limit_help },
                h("input", {
                    type: "checkbox", checked: state.no_step_limit,
                    onchange: event => { state.no_step_limit = event.target.checked; commit(); }
                }),
                TEXT.ranking.no_limit
            ),
            h("label", { class: "no-limit", title: TEXT.ranking.rename_help },
                h("input", {
                    type: "checkbox", checked: state.rename,
                    onchange: event => { state.rename = event.target.checked; commit(); }
                }),
                TEXT.ranking.rename
            ),
            state.rename ? nameInput() : null
        ),
        h("div", { class: "ranking-row", title: TEXT.ranking.your_level_help },
            h("span", { class: "ranking-label" }, TEXT.ranking.your_level),
            levelInput()
        )
    );
}

// "Your level": only changes what the steps show, so typing redraws just the results.
function levelInput() {
    return h("input", {
        type: "number", class: "step-limit player-level", min: 0, max: MAX_PLAYER_LEVEL, inputmode: "numeric",
        value: player_level, placeholder: TEXT.ranking.your_level_placeholder,
        "aria-label": TEXT.ranking.your_level_label,
        oninput: event => {
            const text = event.target.value.trim();
            player_level = text === "" ? null : Math.min(MAX_PLAYER_LEVEL, Math.max(0, Math.floor(Number(text)) || 0));
            writeStorage(LEVEL_STORAGE_KEY, player_level);
            renderResults();
        }
    });
}

// The new name for the finished item. It does not change the cost, so typing only
// redraws the results (redrawing this box would drop the cursor mid-word).
function nameInput() {
    return h("input", {
        type: "text",
        class: "rename-input",
        value: state.rename_to,
        maxlength: MAX_NAME_LENGTH[state.edition],
        placeholder: TEXT.ranking.rename_placeholder,
        "aria-label": TEXT.ranking.rename_label,
        oninput: event => {
            state.rename_to = cleanName(event.target.value, state.edition);
            saveToUrl();
            renderResults();
        }
    });
}

function renderResults() {
    renderMetrics();
    const box = $("#results");
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

    const content = h("div", { class: running ? "stale" : null });
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
    const track = player_level == null ? null : levelTrack(steps.map(step => step.node.merge_levels), player_level);
    content.append(h("div", { class: "result-facts" },
        h("span", { title: TEXT.results.anvil_wear_help },
            TEXT.results.anvil_wear({ uses: steps.length, chance: percentText(anvilBreakChance(steps.length)) })),
        track ? h("span", { class: track.short ? "short" : null }, track.short
            ? TEXT.results.levels_needed({ short: track.short, start: node.cumulative_levels })
            : TEXT.results.levels_left({ level: track.end })) : null
    ));

    content.append(h("div", { class: "toolbar result-tools" },
        h("div", { class: "segmented", role: "group", "aria-label": TEXT.results.view_label },
            [["steps", TEXT.results.view_steps], ["tree", TEXT.results.view_tree]].map(([view, label]) => h("button", {
                type: "button", class: result_view === view ? "selected" : "", "aria-pressed": String(result_view === view),
                onclick: () => { result_view = view; writeStorage(VIEW_STORAGE_KEY, view); renderResults(); }
            }, label))),
        h("button", {
            type: "button", class: "btn small copy-steps", title: TEXT.results.copy_steps_help,
            onclick: event => copyText(event.currentTarget, stepsText(node, steps), TEXT.results.copy_steps)
        }, TEXT.results.copy_steps),
        h("button", { type: "button", class: "btn small", title: TEXT.results.print_help, onclick: () => window.print() }, TEXT.results.print)
    ));

    if (result_view === "tree") {
        content.append(mergeTree(node, steps));
        return;
    }

    const order_key = orderKey(steps);
    const done = loadChecklist(order_key);
    // One group per round: its steps don't depend on each other, so any order works.
    const rounds = logic.stepRounds(steps);
    content.append(h("div", { class: "rounds" }, rounds.map((round, index) => h("section", { class: "round" },
        h("div", { class: "round-label", title: round.length > 1 ? TEXT.results.round_help : null },
            TEXT.results.round({ number: index + 1, steps: round.length })),
        h("ol", { class: "anvil-steps" }, round.map(step => anvilStep(step, done, order_key, track && track.steps[step.number - 1])))
    ))));
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
function mergeTree(root, steps) {
    const numbers = new Map(steps.map(step => [step.node, step.number]));
    const branch = node => {
        const number = numbers.get(node);
        const enchanted = node.enchantments.length > 0;
        return h("li", { class: "tree-node" },
            h("div", { class: "tree-line" + (number ? " merge" : "") },
                h("span", { class: "tree-slot" + (enchanted ? " glint" : "") }, icon(node.item_namespace, true)),
                h("span", { class: "tree-text" },
                    h("span", { class: "tree-name" + (node.renamed && state.rename_to.trim() ? " renamed" : "") }, nodeName(node)),
                    enchanted ? h("span", { class: "tree-ench" }, logic.summary(node.enchantments)) : null),
                number ? h("span", { class: "tree-step" }, TEXT.results.tree_step({ number, levels: node.merge_levels })) : null
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
            const new_name = state.rename_to.trim();
            const rename = !step.node.renamed ? "" : " (" + (new_name ? text.text_rename_to({ name: new_name }) : text.text_rename) + ")";
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
function anvilStep(step, done, order_key, level = null) {
    const number = step.number;
    const tick = h("input", {
        type: "checkbox",
        checked: done.has(number),
        "aria-label": TEXT.results.step_done_label({ number }),
        onchange: event => {
            if (event.target.checked) done.add(number);
            else done.delete(number);
            saveChecklist(order_key, done);
            event.target.closest(".anvil-step").classList.toggle("done", event.target.checked);
        }
    });
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
    if (loaded) state = loaded;
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
    // Any open tip closes on a click elsewhere or on Escape.
    document.addEventListener("click", event => {
        for (const tip of document.querySelectorAll(".info-tip.open")) if (!tip.contains(event.target)) setTipOpen(tip, false);
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") for (const tip of document.querySelectorAll(".info-tip.open")) setTipOpen(tip, false);
    });
}

// Tips redrawn while open (the books badge, on every edit) stay open: remembered by id.
const open_tips = new Set();

function setTipOpen(tip, open) {
    tip.classList.toggle("open", open);
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

function setupCopyLink() {
    const button = $("#copy-link");
    button.addEventListener("click", () => copyText(button, location.href, TEXT.page.copy_link));
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
    setupInfoTip();
    setupSavedMenu();
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
