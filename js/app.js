import { createLogic, roman, MAX_PRIOR_WORK } from "./logic.js";

const META_URL = "json/metadata.json";
const WORKER_URL = "js/calculator.js";
const ITEM_WARNING_THRESHOLD = 10;
const CALC_DELAY_MS = 250;      // wait for the user to stop clicking
const PROGRESS_DELAY_MS = 300;  // only show the progress bar for slow runs

let meta = null;
let L = null;
let state = defaultState();
let nextBookId = 1;

let worker = null;
let requestId = 0;
let running = false;
let showProgress = false;
let calcTimer = null;
let progressTimer = null;
let lastResult = null; // { status: "ok" | "empty" | "cancelled" | "error", node?, error? }
let showTree = false;

function defaultState() {
    return {
        item: null,
        wanted: {},        // enchantments the user wants on the final item
        autoBooks: true,   // derive books from `wanted`
        books: [],         // custom books: { id, enchantments: {ns: level}, prior_work }
        existing: {},      // enchantments already on the item
        itemPriorWork: 0,
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

function icon(itemNs, small = false) {
    return h("img", {
        class: "item-icon" + (small ? " small" : ""),
        src: "img/" + ((meta.icons && meta.icons[itemNs]) || `${itemNs}.png`),
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
    state.wanted = L.sanitizeEnchantments(state.wanted, item);
    state.existing = L.sanitizeEnchantments(state.existing, item);
    state.books.forEach(book => { book.enchantments = L.sanitizeEnchantments(book.enchantments, item); });
    commit();
}

function setWanted(ns, level) {
    if (level) {
        for (const other of Object.keys(state.wanted)) {
            if (L.conflicts(other, ns)) delete state.wanted[other];
        }
        state.wanted[ns] = level;
    } else {
        delete state.wanted[ns];
    }
    commit();
}

function customizeBooks() {
    state.books = L.currentBooks(state).map(book => ({
        id: nextBookId++,
        enchantments: { ...book.enchantments },
        prior_work: 0
    }));
    state.autoBooks = false;
    commit();
}

function addBook() {
    state.books.push({ id: nextBookId++, enchantments: {}, prior_work: 0 });
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
    grid.replaceChildren(...L.enchantableItems().map(item => h("button", {
        type: "button",
        class: "item-button" + (state.item === item ? " selected" : ""),
        "aria-pressed": String(state.item === item),
        onclick: () => selectItem(item)
    }, icon(item), L.itemName(item))));
}

function renderWanted() {
    const box = $("#wanted");
    box.replaceChildren();
    if (!state.item) {
        box.append(h("p", { class: "hint" }, "Pick an item first."));
        return;
    }

    box.append(h("div", { class: "toolbar" },
        h("button", { type: "button", class: "btn small", onclick: () => { state.wanted = L.maxAll(state.item, state.wanted); commit(); } }, "Max all"),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { state.wanted = {}; commit(); } }, "Clear")
    ));

    let cursesShown = false;
    for (const ns of L.applicable(state.item)) {
        if (L.isCurse(ns) && !cursesShown) {
            box.append(h("div", { class: "divider" }, "Curses"));
            cursesShown = true;
        }
        const chosen = state.wanted[ns] || 0;
        const blocker = !chosen && Object.keys(state.wanted).find(other => L.conflicts(other, ns));

        const levels = [];
        for (let level = 1; level <= L.maxLevel(ns); level++) {
            levels.push(h("button", {
                type: "button",
                class: "level" + (chosen === level ? " selected" : ""),
                "aria-pressed": String(chosen === level),
                "aria-label": L.displayName(ns, level),
                title: blocker ? `Replaces ${L.enchName(blocker)}` : null,
                onclick: () => setWanted(ns, chosen === level ? 0 : level)
            }, roman(level)));
        }

        box.append(h("div", { class: "ench-row" + (blocker ? " conflict" : "") + (chosen ? " chosen" : "") },
            h("div", { class: "ench-name" },
                L.enchName(ns),
                blocker ? h("span", { class: "note" }, `Conflicts with ${L.enchName(blocker)}`) : null
            ),
            h("div", { class: "levels" }, levels)
        ));
    }
}

function enchantmentEditor(enchantments) {
    const tags = Object.entries(enchantments).map(([ns, level]) => {
        let levelSelect = null;
        if (L.maxLevel(ns) > 1) {
            const options = [];
            for (let l = 1; l <= L.maxLevel(ns); l++) {
                options.push(h("option", { value: l, selected: l === level }, roman(l)));
            }
            levelSelect = h("select", {
                "aria-label": `Level of ${L.enchName(ns)}`,
                onchange: event => { enchantments[ns] = Number(event.target.value); commit(); }
            }, options);
        }
        return h("span", { class: "tag" },
            L.enchName(ns),
            levelSelect,
            h("button", {
                type: "button",
                class: "tag-remove",
                "aria-label": `Remove ${L.enchName(ns)}`,
                onclick: () => { delete enchantments[ns]; commit(); }
            }, "×")
        );
    });

    const available = L.applicable(state.item).filter(ns =>
        !(ns in enchantments) && !Object.keys(enchantments).some(other => L.conflicts(other, ns)));
    const addSelect = available.length ? h("select", {
        class: "add-ench",
        "aria-label": "Add enchantment",
        onchange: event => {
            const ns = event.target.value;
            if (ns) { enchantments[ns] = L.maxLevel(ns); commit(); }
        }
    }, h("option", { value: "" }, "+ Add enchantment"), available.map(ns => h("option", { value: ns }, L.enchName(ns)))) : null;

    return h("div", { class: "tags" }, tags, addSelect);
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
    if (!state.item) {
        box.append(h("p", { class: "hint" }, "Pick an item first."));
        return;
    }

    const books = L.currentBooks(state);

    if (state.autoBooks) {
        box.append(h("div", { class: "toolbar" },
            h("p", { class: "hint" }, "Assuming one fresh book for each enchantment you want."),
            h("button", { type: "button", class: "btn small", onclick: customizeBooks }, "Edit books")
        ));
        if (books.length === 0) {
            box.append(h("p", { class: "hint" }, "Choose enchantments above and they'll show up here."));
        } else {
            box.append(h("div", { class: "chips" }, books.map(book =>
                h("span", { class: "chip" }, icon("book", true), L.summary(Object.entries(book.enchantments).map(([namespace, level]) => ({ namespace, level }))))
            )));
        }
        return;
    }

    box.append(h("div", { class: "toolbar" },
        h("button", { type: "button", class: "btn small", onclick: addBook }, "Add book"),
        h("button", { type: "button", class: "btn small ghost", onclick: () => { state.autoBooks = true; state.books = []; commit(); } }, "Back to automatic")
    ));
    if (books.length === 0) {
        box.append(h("p", { class: "hint" }, "No books yet. Add the books you actually have."));
    }
    books.forEach((book, index) => {
        box.append(h("div", { class: "book-editor" },
            h("div", { class: "book-editor-head" },
                icon("book", true),
                `Book ${index + 1}`,
                h("span", { class: "spacer" }),
                stepper("Prior work", book.prior_work, value => { book.prior_work = value; commit(); }, PRIOR_WORK_HELP),
                h("button", {
                    type: "button",
                    class: "btn tiny ghost",
                    "aria-label": `Remove book ${index + 1}`,
                    onclick: () => { state.books = state.books.filter(b => b !== book); commit(); }
                }, "Remove")
            ),
            enchantmentEditor(book.enchantments)
        ));
    });
}

function renderExisting() {
    const title = $("#existing-title");
    const itemLabel = state.item ? `your ${L.itemName(state.item).toLowerCase()}` : "your item";
    title.replaceChildren(h("span", { class: "step-badge" }, "4"), `Already on ${itemLabel}`, h("span", { class: "optional" }, "optional"));

    const box = $("#existing");
    box.replaceChildren();
    if (!state.item) {
        box.append(h("p", { class: "hint" }, "Pick an item first."));
        return;
    }
    box.append(
        h("div", { class: "toolbar" },
            h("p", { class: "hint" }, "Leave this empty for a brand-new item."),
            stepper("Prior work", state.itemPriorWork, value => { state.itemPriorWork = value; commit(); }, PRIOR_WORK_HELP)
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
    const entries = L.buildEntries(state);

    if (entries.length > ITEM_WARNING_THRESHOLD) {
        box.append(h("div", { class: "warning" },
            `${entries.length} items to combine. Each item past ${ITEM_WARNING_THRESHOLD} roughly triples the calculation time.`));
    }

    if (running && showProgress) {
        box.append(h("div", { class: "progress" },
            h("div", { class: "progress-track" }, h("div", { class: "progress-fill", id: "progress-fill" })),
            h("span", { class: "progress-text", id: "progress-text" }, "0%"),
            h("button", { type: "button", class: "btn small", onclick: cancelCalculation }, "Cancel")
        ));
    }

    const result = lastResult;
    if (!result) return;

    if (result.status === "empty") {
        const message = !state.item
            ? "Pick an item to get started."
            : "Choose the enchantments you want, or add your books.";
        box.append(h("div", { class: "empty" }, h("img", { src: "img/enchanting_table.png", alt: "" }), h("p", {}, message)));
        return;
    }
    if (result.status === "cancelled") {
        box.append(h("p", { class: "hint" }, "Calculation cancelled. ",
            h("button", { type: "button", class: "link", onclick: runCalculation }, "Run it again")));
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
            "There's no valid order. Every anvil step has to cost 39 levels or less. Try lowering prior work or splitting up multi-enchantment books."));
        return;
    }
    if (!node.left) {
        content.append(h("p", { class: "hint" }, "Nothing to combine yet."));
        return;
    }

    const steps = L.collectSteps(node);
    const maxStep = Math.max(...steps.map(step => step.node.merge_levels));
    content.append(h("div", { class: "metrics" },
        metric("Total levels", node.cumulative_levels),
        metric("Priciest step", maxStep),
        metric("Total XP", Math.round(node.cumulative_xp).toLocaleString()),
        metric("Steps", steps.length)
    ));

    const missing = L.missing(state, node);
    if (missing.length) {
        content.append(h("div", { class: "warning" }, `Your books can't produce: ${missing.join(", ")}.`));
    }

    content.append(h("ol", { class: "steps" }, steps.map((step, index) => h("li", { class: "step" },
        h("div", { class: "step-head" },
            h("span", { class: "step-num" }, `Step ${index + 1}`),
            h("span", { class: "step-cost" }, `${step.node.merge_levels} levels`)
        ),
        h("div", { class: "slots" }, slot(step.left, "Left"), h("span", { class: "plus" }, "+"), slot(step.right, "Right")),
        h("div", { class: "step-result" }, "Result: ", L.summary(step.node.enchantments))
    ))));

    content.append(h("button", {
        type: "button",
        class: "btn small tree-toggle",
        onclick: () => { showTree = !showTree; renderResults(); }
    }, showTree ? "Hide tree" : "Show as tree"));
    if (showTree) {
        content.append(h("ul", { class: "tree" }, treeNode(node)));
    }
}

function metric(label, value) {
    return h("div", { class: "metric" }, h("div", { class: "metric-label" }, label), h("div", { class: "metric-value" }, value));
}

function slot(ref, side) {
    const node = ref.node;
    const title = ref.kind === "step" ? `Result of step ${ref.index}` : L.itemName(node.item_namespace);
    return h("div", { class: "slot" },
        h("div", { class: "slot-label" }, `${side} slot`),
        h("div", { class: "slot-body" },
            icon(node.item_namespace, true),
            h("div", {},
                h("div", { class: "slot-title" }, title),
                h("div", { class: "slot-sub" }, L.summary(node.enchantments) || "No enchantments")
            )
        )
    );
}

function treeNode(node) {
    const li = h("li", {}, h("div", { class: "tree-node" },
        icon(node.item_namespace, true),
        L.itemName(node.item_namespace),
        node.left ? h("span", { class: "tree-cost" }, `${node.merge_levels} lv`) : null,
        h("div", { class: "tree-ench" }, L.summary(node.enchantments) || "No enchantments")
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
        lastResult = { status: "error", error: "The calculator failed to load. Check the browser console for details." };
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
    showProgress = false;
    clearTimeout(progressTimer);
}

function scheduleCalculation() {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(runCalculation, CALC_DELAY_MS);
}

function runCalculation() {
    clearTimeout(calcTimer);
    // The search is one synchronous call, so a newer request has to replace the worker.
    if (running) restartWorker();
    stopRunning();

    const entries = L.buildEntries(state);
    if (entries.length < 2) {
        lastResult = { status: "empty" };
        renderResults();
        return;
    }

    requestId++;
    running = true;
    progressTimer = setTimeout(() => { showProgress = true; renderResults(); }, PROGRESS_DELAY_MS);
    worker.postMessage({
        message: "calculate_optimal",
        request_id: requestId,
        item_entries: entries,
        objective: state.objective
    });
    renderResults();
}

function cancelCalculation() {
    if (!running) return;
    restartWorker();
    stopRunning();
    lastResult = { status: "cancelled" };
    renderResults();
}

function handleWorkerMessage(event) {
    const data = event.data;
    if (data.request_id !== requestId) return;

    if (data.message === "progress") {
        const percent = Math.min(100, Math.floor((data.done / data.total) * 100));
        const fill = document.getElementById("progress-fill");
        const text = document.getElementById("progress-text");
        if (fill) fill.style.width = percent + "%";
        if (text) text.textContent = percent + "%";
    } else if (data.message === "optimal_searched") {
        stopRunning();
        lastResult = { status: "ok", node: data.result };
        renderResults();
    } else if (data.message === "calculation_failed") {
        stopRunning();
        lastResult = { status: "error", error: data.error };
        renderResults();
    }
}

// ---------- Shareable URL ----------

function saveToUrl() {
    const url = state.item ? "#" + L.serialize(state) : location.pathname + location.search;
    history.replaceState(null, "", url);
}

function loadFromUrl() {
    const hash = location.hash.slice(1);
    if (!hash) return;
    try {
        const loaded = L.deserialize(hash, () => nextBookId++);
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
    L = createLogic(meta);
    loadFromUrl();
    startWorker();
    setupCopyLink();
    render();
    runCalculation();
}

init();
