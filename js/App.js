import { createLogic, roman, MAX_PRIOR_WORK } from "./Logic.js";

const META_URL = "json/metadata.json";
const WORKER_URL = "js/Calculator.js";
const ITEM_WARNING_THRESHOLD = 10;
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
let show_tree = false;

function defaultState() {
    return {
        item: null,
        wanted: {},        // enchantments the user wants on the final item
        auto_books: true,   // derive books from `wanted`
        books: [],         // custom books: { id, enchantments: {ns: level}, prior_work }
        existing: {},      // enchantments already on the item
        item_prior_work: 0,
        objective: "levels"
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
    state.wanted = logic.sanitizeEnchantments(state.wanted, item);
    state.existing = logic.sanitizeEnchantments(state.existing, item);
    state.books.forEach(book => { book.enchantments = logic.sanitizeEnchantments(book.enchantments, item); });
    commit();
}

function setWanted(ns, level) {
    if (level) {
        for (const other of Object.keys(state.wanted)) {
            if (logic.conflicts(other, ns)) delete state.wanted[other];
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
        type: "book",
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
    renderExisting();
    renderObjective();
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
        box.append(h("p", { class: "hint" }, "Pick an item first."));
        return;
    }

    box.append(h("div", { class: "toolbar" },
        h("button", { type: "button", class: "btn small", onclick: () => { state.wanted = logic.maxAll(state.item, state.wanted); commit(); } }, "Max all"),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { state.wanted = {}; commit(); } }, "Clear")
    ));

    let curses_shown = false;
    for (const ns of logic.applicable(state.item)) {
        if (logic.isCurse(ns) && !curses_shown) {
            box.append(h("div", { class: "divider" }, "Curses"));
            curses_shown = true;
        }
        const chosen = state.wanted[ns] || 0;
        const blocker = !chosen && Object.keys(state.wanted).find(other => logic.conflicts(other, ns));

        const levels = [];
        for (let level = 1; level <= logic.maxLevel(ns); level++) {
            levels.push(h("button", {
                type: "button",
                class: "level" + (chosen === level ? " selected" : ""),
                "aria-pressed": String(chosen === level),
                "aria-label": logic.displayName(ns, level),
                title: blocker ? `Replaces ${logic.enchName(blocker)}` : null,
                onclick: () => setWanted(ns, chosen === level ? 0 : level)
            }, roman(level)));
        }

        box.append(h("div", { class: "ench-row" + (blocker ? " conflict" : "") + (chosen ? " chosen" : "") },
            h("div", { class: "ench-name" },
                logic.enchName(ns),
                blocker ? h("span", { class: "note" }, `Conflicts with ${logic.enchName(blocker)}`) : null
            ),
            h("div", { class: "levels" }, levels)
        ));
    }
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
                "aria-label": `Level of ${logic.enchName(ns)}`,
                onchange: event => { enchantments[ns] = Number(event.target.value); commit(); }
            }, options);
        }
        return h("span", { class: "tag" },
            logic.enchName(ns),
            level_select,
            h("button", {
                type: "button",
                class: "tag-remove",
                "aria-label": `Remove ${logic.enchName(ns)}`,
                onclick: () => { delete enchantments[ns]; commit(); }
            }, "×")
        );
    });

    const available = logic.applicable(state.item).filter(ns =>
        !(ns in enchantments) && !Object.keys(enchantments).some(other => logic.conflicts(other, ns)));
    const add_select = available.length ? h("select", {
        class: "add-ench",
        "aria-label": "Add enchantment",
        onchange: event => {
            const ns = event.target.value;
            if (ns) { enchantments[ns] = logic.maxLevel(ns); commit(); }
        }
    }, h("option", { value: "" }, "+ Add enchantment"), available.map(ns => h("option", { value: ns }, logic.enchName(ns)))) : null;

    return h("div", { class: "tags" }, tags, add_select);
}

function stepper(label, value, onSet, help) {
    return h("span", { class: "stepper", title: help },
        label,
        h("button", { type: "button", class: "btn tiny", "aria-label": `Decrease ${label}`, onclick: () => onSet(Math.max(0, value - 1)) }, "−"),
        h("span", { class: "stepper-value" }, value),
        h("button", { type: "button", class: "btn tiny", "aria-label": `Increase ${label}`, onclick: () => onSet(Math.min(MAX_PRIOR_WORK, value + 1)) }, "+")
    );
}

const PRIOR_WORK_HELP = "How many times this has already been used on an anvil. Each use makes later merges more expensive.";

function renderBooks() {
    const box = $("#books");
    box.replaceChildren();
    if (!state.item) return;

    const books = logic.currentBooks(state);
    const item_name = logic.itemName(state.item);

    if (state.auto_books) {
        box.append(h("div", { class: "toolbar" },
            h("p", { class: "hint" }, "One book per enchantment"),
            h("button", { type: "button", class: "btn small", onclick: customizeBooks }, "Edit")
        ));
        box.append(h("div", { class: "chips" }, books.map(book =>
            h("span", { class: "chip" }, icon("book", true), logic.summary(Object.entries(book.enchantments).map(([namespace, level]) => ({ namespace, level }))))
        )));
        return;
    }

    box.append(h("div", { class: "toolbar" },
        h("button", { type: "button", class: "btn small", onclick: () => addBook("book") }, icon("book", true), "Add book"),
        h("button", { type: "button", class: "btn small", onclick: () => addBook("item") }, icon(state.item, true), `Add ${item_name.toLowerCase()}`),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { state.auto_books = true; state.books = []; commit(); } }, "Automatic")
    ));
    books.forEach((book, index) => {
        box.append(h("div", { class: "book-editor" },
            h("div", { class: "book-editor-head" },
                typeToggle(book, item_name),
                h("span", { class: "spacer" }),
                stepper("Prior work", book.prior_work, value => { book.prior_work = value; commit(); }, PRIOR_WORK_HELP),
                h("button", {
                    type: "button",
                    class: "tag-remove",
                    "aria-label": `Remove entry ${index + 1}`,
                    onclick: () => { state.books = state.books.filter(b => b !== book); commit(); }
                }, "×")
            ),
            enchantmentEditor(book.enchantments)
        ));
    });
}

// Switches an entry between a book and another copy of the item being enchanted.
function typeToggle(book, item_name) {
    const options = [["book", "book", "Book"], ["item", state.item, item_name]];
    return h("div", { class: "segmented icon-toggle", role: "group", "aria-label": "Type" }, options.map(([type, icon_ns, label]) =>
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

function renderExisting() {
    const title = $("#existing-title");
    const item_label = state.item ? logic.itemName(state.item).toLowerCase() : "item";
    title.replaceChildren(h("span", { class: "step-badge" }, "4"), `Already on ${item_label}`, h("span", { class: "optional" }, "optional"));

    const box = $("#existing");
    box.replaceChildren();
    if (!state.item) return;
    box.append(
        h("div", { class: "toolbar" },
            stepper("Prior work", state.item_prior_work, value => { state.item_prior_work = value; commit(); }, PRIOR_WORK_HELP)
        ),
        enchantmentEditor(state.existing)
    );
}

function renderObjective() {
    const options = [["levels", "Fewest levels"], ["xp", "Least XP"]];
    $("#objective").replaceChildren(...options.map(([value, label]) => h("button", {
        type: "button",
        class: state.objective === value ? "selected" : "",
        "aria-pressed": String(state.objective === value),
        onclick: () => { if (state.objective !== value) { state.objective = value; commit(); } }
    }, label)));
}

function renderResults() {
    const box = $("#results");
    box.replaceChildren();
    const entries = logic.buildEntries(state);

    if (entries.length > ITEM_WARNING_THRESHOLD) {
        box.append(h("div", { class: "warning" },
            `${entries.length} items. Each one past ${ITEM_WARNING_THRESHOLD} roughly triples the wait.`));
    }

    if (running && show_progress) {
        box.append(h("div", { class: "progress" },
            h("div", { class: "progress-track" }, h("div", { class: "progress-fill", id: "progress-fill" })),
            h("span", { class: "progress-text", id: "progress-text" }, "0%"),
            h("button", { type: "button", class: "btn small", onclick: cancelCalculation }, "Cancel")
        ));
    }

    const result = last_result;
    if (!result) return;

    if (result.status === "empty") {
        const message = !state.item ? "Pick an item" : "Choose enchantments";
        box.append(h("div", { class: "empty" }, h("img", { src: "img/enchanting_table.png", alt: "" }), h("p", {}, message)));
        return;
    }
    if (result.status === "cancelled") {
        box.append(h("p", { class: "hint" }, "Cancelled. ",
            h("button", { type: "button", class: "link", onclick: runCalculation }, "Run again")));
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
            "No valid order: every step must cost 39 levels or less."));
        return;
    }
    if (!node.left) {
        content.append(h("p", { class: "hint" }, "Nothing to combine"));
        return;
    }

    const steps = logic.collectSteps(node);
    const max_step = Math.max(...steps.map(step => step.node.merge_levels));
    content.append(h("div", { class: "metrics" },
        metric("Levels", node.cumulative_levels),
        metric("Max step", max_step),
        metric("XP", Math.round(node.cumulative_xp).toLocaleString()),
        metric("Steps", steps.length)
    ));

    const missing = logic.missing(state, node);
    if (missing.length) {
        content.append(h("div", { class: "warning" }, `Missing: ${missing.join(", ")}`));
    }

    content.append(h("ol", { class: "steps" }, steps.map((step, index) => h("li", { class: "step" },
        h("div", { class: "step-head" },
            h("span", { class: "step-num" }, `Step ${index + 1}`),
            h("span", { class: "step-cost" }, `${step.node.merge_levels} levels`)
        ),
        h("div", { class: "slots" }, slot(step.left), h("span", { class: "plus" }, "+"), slot(step.right)),
        h("div", { class: "step-result" }, "→ ", logic.summary(step.node.enchantments))
    ))));

    content.append(h("button", {
        type: "button",
        class: "btn small tree-toggle",
        onclick: () => { show_tree = !show_tree; renderResults(); }
    }, show_tree ? "Hide tree" : "Tree"));
    if (show_tree) {
        content.append(h("ul", { class: "tree" }, treeNode(node)));
    }
}

function metric(label, value) {
    return h("div", { class: "metric" }, h("div", { class: "metric-label" }, label), h("div", { class: "metric-value" }, value));
}

function slot(ref) {
    const node = ref.node;
    const title = ref.kind === "step" ? `Step ${ref.index}` : logic.itemName(node.item_namespace);
    const enchantments = logic.summary(node.enchantments);
    return h("div", { class: "slot" },
        h("div", { class: "slot-body" },
            icon(node.item_namespace, true),
            h("div", {},
                h("div", { class: "slot-title" }, title),
                enchantments ? h("div", { class: "slot-sub" }, enchantments) : null
            )
        )
    );
}

function treeNode(node) {
    const enchantments = logic.summary(node.enchantments);
    const li = h("li", {}, h("div", { class: "tree-node" },
        icon(node.item_namespace, true),
        logic.itemName(node.item_namespace),
        node.left ? h("span", { class: "tree-cost" }, `${node.merge_levels} lv`) : null,
        enchantments ? h("div", { class: "tree-ench" }, enchantments) : null
    ));
    if (node.left) li.append(h("ul", {}, treeNode(node.left), treeNode(node.right)));
    return li;
}

// ---------- Calculation (Web Worker) ----------

function startWorker() {
    worker = new Worker(WORKER_URL);
    worker.onmessage = handleWorkerMessage;
    worker.onerror = event => {
        event.preventDefault();
        stopRunning();
        last_result = { status: "error", error: "The calculator failed to load. Check the browser console for details." };
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

    request_id++;
    running = true;
    progress_timer = setTimeout(() => { show_progress = true; renderResults(); }, PROGRESS_DELAY_MS);
    worker.postMessage({
        message: "calculate_optimal",
        request_id: request_id,
        item_entries: entries,
        objective: state.objective
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
            button.textContent = "Copied";
        } catch {
            button.textContent = "Copy failed";
        }
        setTimeout(() => { button.textContent = "Copy link"; }, 1500);
    });
}

// ---------- Start ----------

async function init() {
    try {
        const response = await fetch(META_URL);
        meta = await response.json();
    } catch (error) {
        $("#results").replaceChildren(h("div", { class: "error" },
            "Couldn't load the enchantment data. Serve this folder over HTTP instead of opening the file directly."));
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
