// The page: state changes, rendering, collapsing sections, language, saved setups, theme, and start-up.
import { cleanName, createLogic, editionMetadata, linkMods, modNames, withMods, MOD_IDS } from "./Logic.js";
import { LANGUAGES, TEXT, loadLanguage } from "./Text.js";
import { language, logic, meta, mod_data, nextBookId, setConflictsToggled, setItemMenuOpen, setLanguage, setLogic, setMeta, setModData, state } from "./Store.js";
import { $, closeOnOutside, copyText, h, icon, keepGlintsInStep, readStorage, scrollToView, writeStorage } from "./Dom.js";
import { slideSection } from "./Motion.js";
import { renderItem, renderWanted, setupConflictTips, setupItemDock, setupItemMenu } from "./Wanted.js";
import { focusPicker, openPicker, renderBooks, setupEntryPopover, markFresh } from "./Books.js";
import { renderMetrics, setupOrderPanel } from "./Ranking.js";
import { renderLevelPop, renderSettings, resultNode, setupLevelPop, setupOptionsMenu, syncRename } from "./Options.js";
import { anvilRisk, renderResults } from "./Results.js";
import { resetWorkers, runCalculation, scheduleCalculation, startWorker } from "./Calc.js";
import { currentLink, linkText, loadFromUrl, readLink, saveToUrl, useLink } from "./Link.js";
import { setupInfoTip } from "./Tips.js";

const META_URL = "json/metadata.json";
const MODS_URL = "json/mods/";
const MODS_VERSION = ""; // deploy sets it to "?v=<commit>" (like Text.js TEXT_VERSION)
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

// The "Try an example" button: a helmet with every enchantment it takes. The button is
// under the long item grid, so on a phone the page would be left halfway down the
// enchantment list: bring section 1's top back into view.
export function tryExample() {
    state.item = "boots";
    sanitizeAll();
    // Boots with Depth Strider (not Frost Walker, its rival) and the rest at max level.
    const wanted = logic.maxAll(state.item, {}, state.allow_incompatible);
    if (!state.allow_incompatible) delete wanted.frost_walker;
    state.wanted = { ...wanted, depth_strider: 3 };
    commit();
    const section = document.querySelector('[data-section="wanted"]');
    if (section.getBoundingClientRect().top < 0) scrollToView(section, "start");
}

// Switching item drops the enchantments the new one can't take.
export function selectItem(item) {
    setItemMenuOpen(false);
    if (state.item === item) { renderItem(); return; }
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

// Each edition offers different enchantments (Bedrock has no Sweeping Edge), so the helpers
// are rebuilt for it; callers then drop anything it does not have. Mods are Java only, and only the
// ones in `mods` are offered. Every mod loaded so far stays known, though (its enchantments take no
// item, so they are never offered): a result still on screen may name an enchantment of a mod just
// turned off or of Bedrock, and its names must still be there until the next search replaces it.
// Their names come from their own data files.
export function useEdition(edition, mods = state.mods) {
    const offered = new Set(edition === "java" ? mods : []);
    const active = Object.values(mod_data).map(mod => offered.has(mod.id) ? mod : {
        ...mod,
        enchantments: Object.fromEntries(Object.entries(mod.enchantments).map(([ns, data]) => [ns, { ...data, items: [] }]))
    });
    const mod_text = modNames(active, language);
    const names = {
        ...TEXT.names,
        enchantments: { ...TEXT.names.enchantments, ...mod_text.enchantments },
        descriptions: { ...TEXT.names.descriptions, ...mod_text.descriptions }
    };
    setLogic(createLogic(editionMetadata(withMods(meta, active), edition), names));
}

// Loads the data file of each mod in `ids` not loaded yet. Resolves to the ids that are available.
async function loadMods(ids) {
    await Promise.all(ids.filter(id => !mod_data[id]).map(async id => {
        try {
            const response = await fetch(MODS_URL + id + ".json" + MODS_VERSION);
            if (!response.ok) throw new Error(response.status + " " + response.statusText);
            setModData(id, await response.json());
        } catch (error) {
            console.warn("Could not load mod " + id, error);
        }
    }));
    return ids.filter(id => mod_data[id]);
}

// The enabled mods changed: rebuild the helpers and the workers, and drop what is no longer offered.
export function applyMods() {
    useEdition(state.edition);
    if (state.item) sanitizeAll();
    resetWorkers();
}

// Turns one mod on or off. Its data loads first, so a failed load leaves things as they were.
export async function setMod(id, on) {
    if (on && !(await loadMods([id])).length) return;
    state.mods = MOD_IDS.filter(other => (other === id ? on : state.mods.includes(other)));
    applyMods();
    commit();
}

// The name as typed, when a switch to Bedrock (30 characters) cut it: switching back to
// Java gives the whole name again, unless it was changed in between.
let uncut_name = null;

export function setEdition(edition) {
    if (state.edition === edition) return;
    const typed = uncut_name != null && cleanName(uncut_name, state.edition) === state.rename_to ? uncut_name : state.rename_to;
    state.edition = edition;
    state.rename_to = cleanName(typed, edition); // Bedrock names are shorter
    uncut_name = state.rename_to === typed ? null : typed;
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
    renderStepper();
    renderItem();
    renderWanted();
    renderBooks();
    renderSettings();
    renderLevelPop();
    renderResults();
    if (scrollY !== scroll) scrollTo(scrollX, scroll);
}

// ---------- Collapsing sections ----------
// All three sections close from their heading (the arrow, or anywhere on the heading but its
// badge), so the results are easier to reach once things are set. Closed sections are
// remembered in this browser, and their heading says what is chosen inside.

// Only a list of section names counts (anything else stored there is ignored).
const stored_collapsed = readStorage(COLLAPSED_STORAGE_KEY, []);
let collapsed = new Set(Array.isArray(stored_collapsed) ? stored_collapsed.filter(section => typeof section === "string") : []);

function setCollapsed(section, closed) {
    closed ? collapsed.add(section) : collapsed.delete(section);
    writeStorage(COLLAPSED_STORAGE_KEY, [...collapsed]);
    slideSection(document.querySelector(`.card.collapsible[data-section="${section}"]`), closed, applyCollapsed);
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
}

// Section 4's receipt (above the steps, drawn once there is an order): the levels the order costs, its anvil uses and the anvil's
// break risk (anvilRisk). The heading says the steps too, but only while the section is closed (CSS).
export function renderStepsSummary() {
    const node = resultNode();
    const uses = node ? logic.collectSteps(node).length : 0;
    $("#steps-summary").textContent = node ? TEXT.page.summary_steps({ count: uses }) : TEXT.ranking.no_value;
    $("#order").hidden = !node;
    if (node) {
        $("#order-levels").textContent = TEXT.wanted.cost_meter({ levels: node.cumulative_levels });
        $("#order-uses").textContent = TEXT.ranking.order_uses({ uses });
    }
    $("#anvil-risk").replaceChildren(...(node ? [anvilRisk(uses)] : []));
    renderStepper();
}

// The header's progress stepper: Item, Enchantments, Books, Order. A chip is done when its stage is (an item is picked, an enchantment chosen,
// books exist (Automatic counts), an order found) and goes to its section like a skip link; the first one not done is the current stage.
const BOOKS_STAGE = 2;
const STEPPER_STAGES = [
    { name: "stepper_item", done: () => Boolean(state.item), target: () => ($("#item-dock").hidden ? document.querySelector('[data-section="wanted"]') : $("#item-dock")) },
    { name: "stepper_enchantments", done: () => Object.keys(state.wanted).length > 0, target: () => document.querySelector('[data-section="wanted"]') },
    { name: "stepper_books", done: () => state.auto_books || state.books.length > 0, target: () => document.querySelector('[data-section="books"]') },
    { name: "stepper_order", done: () => Boolean(resultNode()), target: () => document.querySelector('[data-section="steps"]') }
];

function renderStepper() {
    const nav = $("#stages");
    if (!nav.firstElementChild) {
        nav.append(h("ol", {}, STEPPER_STAGES.map(stage => h("li", {},
            h("button", { type: "button", class: "stage-chip", onclick: () => goToSection(stage.target()) },
                h("span", { class: "stage-mark", "aria-hidden": "true" }),
                h("span", { class: "stage-label" })))
        )));
    }
    const flags = STEPPER_STAGES.map(stage => stage.done());
    const current = flags.indexOf(false);
    nav.querySelectorAll(".stage-chip").forEach((chip, index) => {
        const name = TEXT.page[STEPPER_STAGES[index].name];
        chip.classList.toggle("done", flags[index]);
        chip.classList.toggle("current", index === current);
        if (index === current) chip.setAttribute("aria-current", "step"); else chip.removeAttribute("aria-current");
        // Books also warns while Section 3's alert badge shows (chosen enchantments the books can't reach): amber, and named so.
        const warn = index === BOOKS_STAGE && $("#books-alert").childElementCount > 0;
        chip.classList.toggle("warn", warn);
        chip.setAttribute("aria-label", warn ? TEXT.page.stepper_problem({ name }) : flags[index] ? TEXT.page.stepper_done({ name }) : name);
        chip.title = name;
        chip.querySelector(".stage-mark").textContent = warn ? "!" : flags[index] ? "✓" : String(index + 1);
        chip.querySelector(".stage-label").textContent = name;
    });
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
    if (typeof saved === "string" && Object.hasOwn(LANGUAGES, saved)) return saved;
    const browser = (navigator.language || "en").slice(0, 2).toLowerCase();
    return Object.hasOwn(LANGUAGES, browser) ? browser : "en";
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

async function loadSetup(link) {
    if (await openLink(link)) $("#saved").open = false;
}

// Puts a link's setup on screen in place of the current one (a saved setup, or a link pasted
// into the address bar of the open page): its mods load first, and the workers restart with
// their data. Resolves to whether the link could be read.
async function openLink(link) {
    await loadMods(linkMods(link));
    const loaded = readLink(link);
    if (!loaded) return false;
    useLink(loaded);
    applyMods();
    commit();
    return true;
}

// A different link pasted into the address bar of the open page (the page itself only ever
// replaces the address, which fires no hashchange, but the check keeps it from reloading its own).
function setupHashChange() {
    addEventListener("hashchange", () => {
        const hash = location.hash.slice(1);
        if (!hash || !meta || (state.item && hash === linkText())) return;
        openLink(hash);
    });
}

// A <details> menu (Saved, Settings) closes on a click outside it or on Escape.
export function setupMenuClosing(menu) {
    closeOnOutside({
        open: () => menu.open,
        // The path, not contains(): a click on a button the menu then redraws is still inside.
        inside: event => event.composedPath().includes(menu),
        close: () => { menu.open = false; }
    });
}

function setupSavedMenu() {
    const menu = $("#saved");
    $("#saved > summary").title = TEXT.page.saved_help;
    setupMenuClosing(menu);
}

// ---------- Header controls (edition, theme, reset, copy link) ----------

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

// "Start over" (the Item card's button, and the restart icon on its sticky bar): clears the setup,
// the ticks and every setting kept in this browser (view, collapsed sections, level, theme) so the
// first screen comes back, with its explainer and example. Saved setups and the language stay.
export function resetEverything() {
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

// The skip links at the top of the page: focus the section named by `data-skip` (the section takes focus, so the next Tab enters it) and scroll to it.
function setupSkipLinks() {
    for (const link of document.querySelectorAll(".skip-link[data-skip]")) {
        const section = document.querySelector(`[data-section="${link.dataset.skip}"]`);
        if (section) link.addEventListener("click", () => goToSection(section));
    }
}

// Focuses a section (it takes focus, so the next Tab enters it) and scrolls to it: the skip links and the header's stepper.
function goToSection(section) {
    section.tabIndex = -1;
    section.focus({ preventScroll: true });
    scrollToView(section, "start");
}

// "See the order" at the end of Enchantments (phones): scrolls to Anvil uses, which comes before Books and items there.
function setupJumpButtons() {
    for (const button of document.querySelectorAll(".jump-order[data-jump]")) {
        button.addEventListener("click", () => scrollToView(document.querySelector(`[data-section="${button.dataset.jump}"]`), "start"));
    }
}

async function init() {
    keepGlintsInStep();
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
    } catch {
        $("#results").replaceChildren(h("div", { class: "error" }, TEXT.results.metadata_failed));
        return;
    }
    useEdition("java");
    await loadMods(linkMods(location.hash.slice(1)));
    loadFromUrl();
    useEdition(state.edition);
    if (state.edition !== "java" && state.item) sanitizeAll();
    startWorker();
    setupHashChange();
    setupCopyLink();
    setupTheme();
    setupInfoTip();
    setupSkipLinks();
    new MutationObserver(renderStepper).observe($("#books-alert"), { childList: true }); // (Books.js draws and clears the alert badge)
    setupJumpButtons();
    setupSavedMenu();
    setupItemMenu();
    setupItemDock();
    setupConflictTips();
    setupEntryPopover();
    setupOptionsMenu();
    setupLevelPop();
    setupOrderPanel();
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
