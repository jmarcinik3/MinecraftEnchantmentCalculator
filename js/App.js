import { createLogic, roman, movePriority, clampStepLimit, maxPriorWork, searchSize, CRITERIA, MAX_STEP_LEVELS, MAX_GROUPS } from "./Logic.js";
import { TEXT } from "./Text.js";

const META_URL = "json/metadata.json";
const WORKER_URL = "js/Calculator.js";
// Warn when a search tries more left/right splits than this: about a second or more.
// (12 all-different entries is ~520,000 splits; repeated entries add far fewer.)
const SLOW_SPLITS = 1000000;
const CALC_DELAY_MS = 250;      // wait for the user to stop clicking
const PROGRESS_DELAY_MS = 300;  // only show the progress bar for slow runs

let meta = null;
let logic = null;
let state = defaultState();
let next_book_id = 1;

let worker = null;
let request_id = 0;
let running = false;
let show_progress = false;
let calc_timer = null;
let progress_timer = null;
let last_result = null; // { status: "ok" | "empty" | "cancelled" | "error", node?, error? }

function defaultState() {
    return {
        item: null,
        wanted: {},        // enchantments the user wants on the final item
        auto_books: true,  // derive entries from `wanted`
        books: [],         // custom entries: { id, type: "book" | "item", enchantments: {ns: level}, prior_work }
        priority: [...CRITERIA],     // ranking for the best order, most important first
        max_step: MAX_STEP_LEVELS,   // no single step may cost more levels than this
        no_step_limit: false,        // ignore max_step and "Too Expensive!" (for mods that remove it)
        allow_incompatible: false    // let conflicting enchantments go together (for mods that allow it)
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

// ---------- State changes ----------

function commit() {
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
        prior_work: 0
    }));
    state.auto_books = false;
    commit();
}

// `type` is "book" or "item" (another copy of the item being enchanted).
function addBook(type) {
    state.books.push({ id: next_book_id++, type: type, enchantments: {}, prior_work: 0 });
    commit();
}

// ---------- Rendering ----------

function render() {
    renderItems();
    renderWanted();
    renderBooks();
    renderRanking();
    renderResults();
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

    // Conflicting enchantments are boxed together where the first of them would be listed.
    let curses_shown = false;
    for (const group of logic.enchantmentGroups(state.item)) {
        if (logic.isCurse(group.members[0]) && !curses_shown) {
            box.append(h("div", { class: "divider" }, TEXT.wanted.curses));
            curses_shown = true;
        }
        if (group.members.length === 1) {
            box.append(wantedRow(group.members[0], false));
            continue;
        }
        box.append(h("div", { class: "ench-group" + (group.exclusive ? " exclusive" : "") },
            h("div", { class: "ench-group-label" },
                state.allow_incompatible ? TEXT.wanted.group_allowed
                    : group.exclusive ? TEXT.wanted.group_pick_one : TEXT.wanted.group_some_conflict),
            group.members.map(ns => wantedRow(ns, group.exclusive))
        ));
    }
}

// One enchantment with its level buttons. In a "Pick one" group the box already says
// they conflict, so the per-row note is left out.
function wantedRow(ns, in_exclusive_group) {
    const chosen = state.wanted[ns] || 0;
    const blocker = !chosen && Object.keys(state.wanted).find(other => clashes(other, ns));

    const levels = [];
    for (let level = 1; level <= logic.maxLevel(ns); level++) {
        levels.push(h("button", {
            type: "button",
            class: "level" + (chosen === level ? " selected" : ""),
            "aria-pressed": String(chosen === level),
            "aria-label": logic.displayName(ns, level),
            title: blocker ? TEXT.wanted.replaces(logic.enchName(blocker)) : null,
            onclick: () => setWanted(ns, chosen === level ? 0 : level)
        }, roman(level)));
    }

    return h("div", { class: "ench-row" + (blocker ? " conflict" : "") + (chosen ? " chosen" : "") },
        h("div", { class: "ench-name" },
            logic.enchName(ns),
            blocker && !in_exclusive_group ? h("span", { class: "note" }, TEXT.wanted.conflicts_with(logic.enchName(blocker))) : null
        ),
        h("div", { class: "levels" }, levels)
    );
}

// Every enchantment on any custom entry. In vanilla, a new one must not conflict with
// any of them, since the engine does not check conflicts.
function onAnvil() {
    return state.books.flatMap(book => Object.keys(book.enchantments));
}

function enchantmentEditor(enchantments) {
    const tags = Object.entries(enchantments).map(([ns, level]) => {
        let level_select = null;
        if (logic.maxLevel(ns) > 1) {
            const options = [];
            for (let l = 1; l <= logic.maxLevel(ns); l++) {
                options.push(h("option", { value: l, selected: l === level }, roman(l)));
            }
            level_select = h("select", {
                "aria-label": TEXT.books.level_of_label(logic.enchName(ns)),
                onchange: event => { enchantments[ns] = Number(event.target.value); commit(); }
            }, options);
        }
        return h("span", { class: "tag" },
            logic.enchName(ns),
            level_select,
            h("button", {
                type: "button",
                class: "tag-remove",
                "aria-label": TEXT.books.remove_enchantment_label(logic.enchName(ns)),
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
            if (ns) { enchantments[ns] = logic.maxLevel(ns); commit(); }
        }
    }, h("option", { value: "" }, TEXT.books.add_enchantment), available.map(ns => h("option", { value: ns }, logic.enchName(ns)))) : null;

    return h("div", { class: "tags" }, tags, add_select);
}

function stepper(label, value, max, onSet, help) {
    return h("span", { class: "stepper", title: help },
        label,
        h("button", { type: "button", class: "btn tiny", "aria-label": TEXT.books.decrease_label(label), disabled: value <= 0, onclick: () => onSet(value - 1) }, "−"),
        h("span", { class: "stepper-value" }, value),
        h("button", { type: "button", class: "btn tiny", "aria-label": TEXT.books.increase_label(label), disabled: value >= max, onclick: () => onSet(value + 1) }, "+")
    );
}

// The step limit in effect, or Infinity when it is turned off.
function stepLimit() {
    return state.no_step_limit ? Infinity : state.max_step;
}

function renderBooks() {
    const box = $("#books");
    box.replaceChildren();
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
        h("button", { type: "button", class: "btn small", onclick: () => addBook("item") }, icon(state.item, true), TEXT.books.add_item(item_name)),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { state.auto_books = true; state.books = []; commit(); } }, TEXT.books.automatic)
    ));
    books.forEach((book, index) => {
        box.append(h("div", { class: "book-editor" },
            h("div", { class: "book-editor-head" },
                typeToggle(book, item_name),
                h("span", { class: "spacer" }),
                stepper(TEXT.books.prior_work, book.prior_work, maxPriorWork(stepLimit()), value => { book.prior_work = value; commit(); }, TEXT.books.prior_work_help),
                h("button", {
                    type: "button",
                    class: "tag-remove",
                    "aria-label": TEXT.books.remove_entry_label(index + 1),
                    onclick: () => { state.books = state.books.filter(b => b !== book); commit(); }
                }, "×")
            ),
            enchantmentEditor(book.enchantments)
        ));
    });
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

// Ranked criteria, most important first. Drag a chip or use its arrows to reorder;
// later criteria break ties.
function renderRanking() {
    const box = $("#ranking");
    let dragged = null;

    const chips = state.priority.map((criterion, index) => {
        const last = index === state.priority.length - 1;
        const label = TEXT.ranking.criteria[criterion].label;
        return h("li", {
            class: "rank-chip",
            draggable: "true",
            title: TEXT.ranking.criteria[criterion].help,
            ondragstart: event => {
                dragged = index;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", criterion);
            },
            ondragover: event => event.preventDefault(),
            ondrop: event => {
                event.preventDefault();
                if (dragged !== null && dragged !== index) setPriority(movePriority(state.priority, dragged, index - dragged));
            }
        },
            h("span", { class: "rank-num" }, index + 1),
            label,
            h("button", {
                type: "button", class: "rank-move", disabled: index === 0,
                "aria-label": TEXT.ranking.rank_higher_label(label), onclick: () => setPriority(movePriority(state.priority, index, -1))
            }, "‹"),
            h("button", {
                type: "button", class: "rank-move", disabled: last,
                "aria-label": TEXT.ranking.rank_lower_label(label), onclick: () => setPriority(movePriority(state.priority, index, 1))
            }, "›")
        );
    });

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
        h("div", { class: "ranking-row" }, h("span", { class: "ranking-label" }, TEXT.ranking.rank_by), h("ol", { class: "rank-list" }, chips)),
        h("div", { class: "ranking-row", title: TEXT.ranking.level_limit_help },
            h("span", { class: "ranking-label" }, TEXT.ranking.level_limit), limit,
            h("label", { class: "no-limit", title: TEXT.ranking.no_limit_help },
                h("input", {
                    type: "checkbox", checked: state.no_step_limit,
                    onchange: event => { state.no_step_limit = event.target.checked; commit(); }
                }),
                TEXT.ranking.no_limit
            )
        )
    );
}

function renderResults() {
    const box = $("#results");
    box.replaceChildren();
    const entries = logic.buildEntries(state);

    // Only while it runs: once the result is in, the wait is over.
    const size = searchSize(entries);
    if (running && size.groups <= MAX_GROUPS && size.splits > SLOW_SPLITS) {
        box.append(h("div", { class: "warning" }, TEXT.results.slow_search(entries.length)));
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
                : TEXT.results.no_valid_order_within(state.max_step)));
        return;
    }
    if (!node.left) {
        content.append(h("p", { class: "hint" }, TEXT.results.nothing_to_combine));
        return;
    }

    const steps = logic.collectSteps(node);
    const values = {
        levels: node.cumulative_levels,
        xp: Math.round(node.cumulative_xp).toLocaleString(),
        max_step: node.max_step,
        prior_work: node.prior_work
    };
    content.append(h("div", { class: "metrics" },
        state.priority.map((criterion, index) => metric(TEXT.ranking.criteria[criterion].label, values[criterion], index === 0))
    ));

    const missing = logic.missing(state, node);
    if (missing.length) {
        content.append(h("div", { class: "warning" }, TEXT.results.missing(missing)));
    }

    content.append(h("ol", { class: "anvil-steps" }, steps.map(anvilStep)));
}

function metric(label, value, primary = false) {
    return h("div", { class: "metric" + (primary ? " primary" : "") }, h("div", { class: "metric-label" }, label), h("div", { class: "metric-value" }, value));
}

// One anvil step drawn like the game's anvil: [left] + [right] -> [result].
function anvilStep(step, index) {
    const left_levels = new Map(step.left.node.enchantments.map(e => [e.namespace, e.level]));
    const changed = new Set(step.node.enchantments
        .filter(e => left_levels.get(e.namespace) !== e.level)
        .map(e => e.namespace));

    return h("li", { class: "anvil-step" },
        h("span", { class: "anvil-step-num" }, index + 1),
        h("div", { class: "anvil-row" },
            anvilCell(step.left.node),
            h("div", { class: "anvil-op", "aria-hidden": "true" }, "+"),
            anvilCell(step.right.node),
            h("div", { class: "anvil-arrow" },
                h("span", { class: "arrow-glyph", "aria-hidden": "true" }, "➔"),
                h("span", { class: "anvil-cost" }, TEXT.results.cost(step.node.merge_levels))
            ),
            anvilCell(step.node, changed)
        )
    );
}

// An inventory slot with a game-style tooltip underneath. The name is colored by rarity.
function anvilCell(node, changed = null) {
    const is_book = node.item_namespace === "book";
    const enchanted = node.enchantments.length > 0;
    const name = is_book && enchanted ? TEXT.results.enchanted_book : logic.itemName(node.item_namespace);
    const name_class = "mc-name rarity-" + logic.rarity(node.item_namespace, enchanted);
    const lines = logic.tooltipSort(node.enchantments).map(e => h("div", {
        class: "mc-ench" + (logic.isCurse(e.namespace) ? " curse" : "") + (changed && changed.has(e.namespace) ? " changed" : "")
    }, logic.displayName(e.namespace, e.level)));

    return h("div", { class: "anvil-cell" },
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
        max_merge_levels: stepLimit()
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
    if (!hash) return;
    try {
        const loaded = logic.deserialize(hash, () => next_book_id++);
        if (loaded) state = loaded;
    } catch (error) {
        console.warn("Ignoring invalid link", error);
    }
}

function setupCopyLink() {
    const button = $("#copy-link");
    button.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            button.textContent = TEXT.page.copied;
        } catch {
            button.textContent = TEXT.page.copy_failed;
        }
        setTimeout(() => { button.textContent = TEXT.page.copy_link; }, 1500);
    });
}

// ---------- Start ----------

// Fills the static text in index.html: each `data-text="section.key"` gets TEXT.section.key.
function fillPageText() {
    document.title = TEXT.page.title;
    for (const el of document.querySelectorAll("[data-text]")) {
        const [section, key] = el.dataset.text.split(".");
        el.textContent = TEXT[section][key];
    }
}

async function init() {
    fillPageText();
    try {
        const response = await fetch(META_URL);
        meta = await response.json();
    } catch (error) {
        $("#results").replaceChildren(h("div", { class: "error" }, TEXT.results.metadata_failed));
        return;
    }
    logic = createLogic(meta);
    loadFromUrl();
    startWorker();
    setupCopyLink();
    render();
    runCalculation();
}

init();
