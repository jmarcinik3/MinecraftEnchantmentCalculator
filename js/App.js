// The page: state changes, rendering, collapsing sections, language, saved setups, theme, and start-up.
import { EDITIONS, cleanName, createLogic, editionMetadata } from "./Logic.js";
import { LANGUAGES, TEXT, loadLanguage } from "./Text.js";
import { language, logic, meta, nextBookId, setConflictsToggled, setItemMenuOpen, setLanguage, setLogic, setMeta, setState, state } from "./Store.js";
import { $, copyText, h, icon, readStorage, writeStorage } from "./Dom.js";
import { renderWanted, setupItemMenu } from "./Wanted.js";
import { focusPicker, openPicker, renderBooks, setupEntryPopover, markFresh } from "./Books.js";
import { renderMetrics } from "./Ranking.js";
import { renderRanking, resultNode, setupOptionsMenu, syncRename } from "./Options.js";
import { anvilRisk, renderResults } from "./Results.js";
import { runCalculation, scheduleCalculation, startWorker } from "./Calc.js";
import { currentLink, loadFromUrl, readLink, saveToUrl } from "./Link.js";
import { setupInfoTip } from "./Tips.js";

const META_URL = "json/metadata.json";
const SAVED_STORAGE_KEY = "enchantment-calculator-saved";
const LANGUAGE_STORAGE_KEY = "enchantment-calculator-language";
const COLLAPSED_STORAGE_KEY = "enchantment-calculator-collapsed";
const THEME_STORAGE_KEY = "enchantment-calculator-theme"; // also read by index.html before the page draws
const MAX_SETUP_NAME = 100;
let saved_name = ""; // what is typed in the Saved menu's name box

export function commit() {
    saveToUrl();
    render();
    scheduleCalculation();
}

// The "Try an example" button: a helmet with every enchantment it takes.
export function tryExample() {
    state.item = "helmet";
    sanitizeAll();
    state.wanted = logic.maxAll(state.item, {}, state.allow_incompatible);
    commit();
}

// Switching item drops the enchantments the new one can't take.
export function selectItem(item) {
    setItemMenuOpen(false);
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
export function clashes(a, b) {
    return !state.allow_incompatible && logic.conflicts(a, b);
}

// Turning conflicts back off drops the later of each conflicting pair.
export function setAllowIncompatible(allowed) {
    state.allow_incompatible = allowed;
    setConflictsToggled(true);
    sanitizeAll();
    commit();
}

// Each edition offers different enchantments (Bedrock has no Sweeping Edge), so the
// helpers are rebuilt for it and anything it does not have is dropped.
export function useEdition(edition) {
    setLogic(createLogic(editionMetadata(meta, edition), TEXT.names));
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

export function setWanted(ns, level) {
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

export function customizeBooks() {
    state.books = logic.currentBooks(state).map(book => ({
        id: nextBookId(),
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
export function addBook(type) {
    const book = { id: nextBookId(), type: type, enchantments: {}, prior_work: 0, copies: 1 };
    state.books.push(book);
    if (type === "book") openPicker(book);
    markFresh(book);
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
export function renderStepsSummary() {
    const node = resultNode();
    const uses = node ? logic.collectSteps(node).length : 0;
    $("#steps-summary").textContent = node ? TEXT.page.summary_steps({ count: uses }) : TEXT.ranking.no_value;
    $("#anvil-risk").replaceChildren(...(node ? [anvilRisk(uses)] : []));
}

// Section 3's summary while closed: all four results in ranking order, e.g.
// "66 levels · 1,246 XP · Max level 16 · Prior work 4".
export function renderOrderSummary() {
    const node = resultNode();
    $("#order-summary").textContent = node ? metricsText(node) : TEXT.ranking.no_value;
}

// An order's four results in ranking order: "66 levels · 1,246 XP · Max level 16 · …".
function metricsText(node) {
    const summaries = {
        levels: () => TEXT.page.summary_levels({ levels: node.cumulative_levels }),
        xp: () => TEXT.page.summary_xp({ xp: Math.round(node.cumulative_xp).toLocaleString(language) }),
        max_step: () => TEXT.page.summary_max_step({ level: node.max_step }),
        prior_work: () => TEXT.page.summary_prior_work({ count: node.prior_work })
    };
    return state.priority.map(criterion => summaries[criterion]()).join(" · ");
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
        setLanguage(await loadLanguage(code));
    } catch (error) {
        console.warn(error);
        setLanguage(await loadLanguage("en"));
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
    // Through h(), which skips the parts that are missing (replaceChildren would print "null").
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
            : h("p", { class: "hint" }, TEXT.page.saved_empty)
    ).childNodes);
}

// Saving under a name already in the list replaces that setup; the newest is first.
function saveSetup(name) {
    if (!state.item || !name) return;
    const list = readSaved().filter(setup => setup.name !== name);
    list.unshift({ name, item: state.item, link: logic.serialize(state) });
    writeStorage(SAVED_STORAGE_KEY, list);
    saved_name = "";
    renderSaved();
}

// Removing asks nothing first.
function deleteSetup(index) {
    const list = readSaved();
    const [setup] = list.splice(index, 1);
    if (!setup) return;
    writeStorage(SAVED_STORAGE_KEY, list);
    renderSaved();
}

function loadSetup(link) {
    const loaded = readLink(link);
    if (!loaded) return;
    setState(loaded);
    syncRename();
    useEdition(state.edition);
    if (state.item) sanitizeAll();
    $("#saved").open = false;
    commit();
}

// The header's Saved menu closes on a click outside it or on Escape.
export function setupMenuClosing(menu) {
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

// "Start over" (the footer): clears the setup, the ticks and every setting kept in this
// browser (view, collapsed sections, level, theme) so the first screen comes back, with
// its explainer and example. Saved setups and the language stay.
function setupReset() {
    $("#reset").addEventListener("click", resetEverything);
}

function resetEverything() {
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith("enchantment-calculator-") && key !== SAVED_STORAGE_KEY && key !== LANGUAGE_STORAGE_KEY) localStorage.removeItem(key);
        }
    } catch {
        // No storage: nothing was kept.
    }
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
}

function setupCopyLink() {
    const button = $("#copy-link");
    button.addEventListener("click", () => copyText(button.querySelector(".copy-label"), currentLink(), TEXT.page.copy_link, button));
}

// ---------- Start ----------

// Fills the static text in index.html: each `data-text="section.key"` gets TEXT.section.key.
function fillPageText() {
    document.title = TEXT.page.title;
    for (const el of document.querySelectorAll("[data-text]")) {
        const [section, key] = el.dataset.text.split(".");
        el.textContent = TEXT[section][key];
    }
    // `data-text-title` sets a hover tooltip.
    for (const el of document.querySelectorAll("[data-text-title]")) {
        const [section, key] = el.dataset.textTitle.split(".");
        el.title = TEXT[section][key];
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
        setMeta(await response.json());
    } catch (error) {
        $("#results").replaceChildren(h("div", { class: "error" }, TEXT.results.metadata_failed));
        return;
    }
    useEdition("java");
    loadFromUrl();
    if (state.edition !== "java" && state.item) sanitizeAll();
    startWorker();
    setupCopyLink();
    setupReset();
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
