// The page: state changes, rendering, collapsing sections, language, saved setups, theme, and start-up.
import { clampStepLimit, cleanName, createLogic, editionMetadata, EDITIONS, linkMods, modNames, withMods, MOD_IDS } from "./Logic.js";
import { DEFAULT_LANGUAGE, LANGUAGES, TEXT, loadLanguage, localeOf } from "./Text.js";
import { setupLanguagePicker } from "./Languages.js";
import { setupFeedback } from "./Feedback.js";
import { language, logic, meta, mod_data, nextBookId, setConflictsToggled, setItemMenuOpen, setLanguage, setLogic, setMeta, setModData, state } from "./Store.js";
import { $, closeOnOutside, copyText, h, icon, keepGlintsInStep, mcMark, readStorage, scrollToView, writeStorage } from "./Dom.js";
import { slideSection } from "./Motion.js";
import { renderItem, renderPresetsMenu, renderWanted, setupConflictTips, setupItemDock, setupItemMenu } from "./Wanted.js";
import { focusPicker, openPicker, renderBooks, setupEntryPopover, markFresh } from "./Books.js";
import { renderMetrics, setupOrderPanel } from "./Ranking.js";
import { renderLevelPop, renderSettings, resultNode, setupLevelPop, setupOptionsMenu, syncRename } from "./Options.js";
import { anvilRisk, renderResults } from "./Results.js";
import { resetWorkers, runCalculation, scheduleCalculation, startWorker } from "./Calc.js";
import { currentLink, linkText, loadFromUrl, readLink, readSetup, saveToUrl, useLink } from "./Link.js";
import { setupInfoTip } from "./Tips.js";

const META_URL = "json/metadata.json";
const MODS_URL = "json/mods/";
const MODS_VERSION = ""; // deploy sets it to "?v=<commit>" (like Text.js TEXT_VERSION)
const SAVED_STORAGE_KEY = "enchantment-calculator-saved";
const LANGUAGE_STORAGE_KEY = "enchantment-calculator-language";
const COLLAPSED_STORAGE_KEY = "enchantment-calculator-collapsed";
const THEME_STORAGE_KEY = "enchantment-calculator-theme"; // also read by index.html before the page draws
const MAX_SETUP_NAME = 100;

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
    renderFeedback();
    renderTheme();
    renderItem();
    renderWanted();
    renderPresetsMenu();
    renderBooks();
    renderSettings();
    renderLevelPop();
    renderResults();
    renderBadges();
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

// Opens a closed section at once (no slide, so what is scrolled to next is where it will stay): the Item bar's Steps button opens Anvil uses first.
export function openSection(section) {
    if (!collapsed.has(section)) return;
    collapsed.delete(section);
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
    renderBadges();
}

// Each section heading's number badge says its stage's state (replacing the header's old stepper): a check once done (an item is picked, an enchantment
// chosen, books exist (Automatic counts), an order found), amber "!" while Books has a problem (its alert badge shows), and, for Anvil uses, a spinner
// while a search is pending or running (CSS on <html data-search>). The state is also a visually hidden word in the heading's accessible name.
function renderBadges() {
    const books_problem = $("#books-alert").childElementCount > 0;
    const stages = [
        // (An item with no enchantment chosen is a problem too: there is nothing to calculate yet.)
        { section: "wanted", number: state.item ? "2" : "1", done: state.item && Object.keys(state.wanted).length > 0, problem: Boolean(state.item) && Object.keys(state.wanted).length === 0 },
        { section: "books", number: "3", done: Boolean(state.item) && (state.auto_books || state.books.length > 0), problem: books_problem },
        { section: "steps", number: "4", done: Boolean(resultNode()) }
    ];
    for (const stage of stages) {
        const heading = document.querySelector(`[data-section="${stage.section}"] h2`);
        const badge = heading.querySelector(".step-badge");
        const word = stage.problem ? TEXT.page.badge_problem : stage.done ? TEXT.page.badge_done : "";
        badge.classList.toggle("done", Boolean(stage.done) && !stage.problem);
        badge.classList.toggle("warn", Boolean(stage.problem));
        if (stage.problem) badge.replaceChildren(mcMark("bang"));
        else if (stage.done) badge.replaceChildren(mcMark("check"));
        else badge.textContent = stage.number;
        const label = heading.querySelector(".badge-state");
        label.textContent = word;
        heading.setAttribute("aria-labelledby", heading.querySelector(".section-title").id + (word ? " " + label.id : ""));
    }
}

// ---------- Language ----------

let renderLanguagePicker = null;
let renderFeedbackLabels = null;
function renderFeedback() {
    // The dialog (Feedback.js) is built once, when its button first needs it.
    renderFeedbackLabels ||= setupFeedback($("#feedback"));
    renderFeedbackLabels();
}

function renderLanguage() {
    // The picker (Languages.js) is built once; later calls redraw its labels in the page's language.
    renderLanguagePicker ||= setupLanguagePicker($("#language"), {
        suggested: suggestedLanguages, current: () => language, choose: code => switchLanguage(code)
    });
    renderLanguagePicker();
}

// Listed first in the picker: the browser's languages (each as its exact locale, else the first of its language), English, Spanish and the one in use.
function suggestedLanguages() {
    const browser = (navigator.languages?.length ? navigator.languages : [navigator.language || "en"]).map(tag => {
        const code = tag.toLowerCase().replace("-", "_");
        return Object.hasOwn(LANGUAGES, code) ? code : Object.keys(LANGUAGES).find(other => other.split("_")[0] === code.split("_")[0]);
    });
    return [...browser, DEFAULT_LANGUAGE, "es_es", language].filter(Boolean);
}

// The saved choice, else the browser's language if there is text for it, else English.
function startingLanguage() {
    const saved = readStorage(LANGUAGE_STORAGE_KEY, null);
    if (typeof saved === "string" && Object.hasOwn(LANGUAGES, saved)) return saved;
    // The browser's exact locale (es-MX -> es_mx) if there is text for it, else the first of its language (es -> es_es), else English.
    const browser = (navigator.language || "en").toLowerCase().replace("-", "_");
    if (Object.hasOwn(LANGUAGES, browser)) return browser;
    return Object.keys(LANGUAGES).find(code => code.split("_")[0] === browser.split("_")[0]) || DEFAULT_LANGUAGE;
}

// Loads a language's text (json/text/<code>.json), falling back to English if it
// can't be loaded. Throws only when English can't be loaded either.
async function applyLanguage(code) {
    try {
        setLanguage(await loadLanguage(code));
    } catch (error) {
        console.warn(error);
        setLanguage(await loadLanguage(DEFAULT_LANGUAGE));
    }
    document.documentElement.lang = localeOf(language);
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
// Setups saved in this browser under a name, from the item card's presets row (+ Save; Wanted.js presetChips) and listed there and on the first
// screen. Each is a share link's text; loading one sets its item, enchantments and the game rules they need (edition, mods, Allow conflicts), and the item
// card says which rules changed (`setupFit`, `applySetup`).

export function readSaved() {
    const stored = readStorage(SAVED_STORAGE_KEY, null);
    const list = stored === null ? starterPresets() : stored;
    return Array.isArray(list) ? list.filter(setup => setup && typeof setup.name === "string" && typeof setup.link === "string") : [];
}

// The presets a new visitor starts with, saved once (the first time the list is read with nothing stored), so they can be renamed over or removed like any
// other and never come back: one "God" per item, every enchantment it takes at its highest level (Logic `maxAll`, the game's own only, no curses), with
// the game's own rules (Java, the level limit 39, no conflicts, no mods) and Automatic books. An item that takes nothing that way gets none.
const STARTER_NAME = "God";
function starterPresets() {
    if (!logic || !meta) return [];
    const base = { ...state, wanted: {}, auto_books: true, books: [], edition: "java", max_step: 39, no_step_limit: false, allow_incompatible: false, mods: [], rename: false, rename_to: "" };
    const java = createLogic(editionMetadata(meta, "java"), TEXT.names); // (the game's own Java helpers, whatever the page shows now)
    const list = [];
    for (const item of java.enchantableItems()) {
        const wanted = java.maxAll(item, {}, false);
        if (!Object.keys(wanted).length) continue;
        list.push({ name: STARTER_NAME, item, link: logic.serialize({ ...base, item, wanted }) });
    }
    writeStorage(SAVED_STORAGE_KEY, list);
    return list;
}

// "Boots: Protection IV, Mending" for the current setup.
export function defaultSetupName() {
    if (!state.item) return "";
    const chosen = logic.summary(Object.entries(state.wanted).map(([namespace, level]) => ({ namespace, level })));
    return [...(logic.itemName(state.item) + (chosen ? ": " + chosen : ""))].slice(0, MAX_SETUP_NAME).join("");
}
export { MAX_SETUP_NAME };

// A name is one item's: two setups may share a name if they are for different items, but one item's names are all different (ignoring case).
export const setupNameTaken = (name, item) => readSaved().some(setup => setup.item === item && setup.name.toLowerCase() === name.toLowerCase());

// The saved setup that already holds what the page shows (the same item, enchantments and the game rules a preset sets: edition, mods, Allow
// conflicts), or null.
export function sameSavedSetup() {
    if (!state.item) return null;
    const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(ns => a[ns] === b[ns]);
    const mods = [...(state.edition === "java" ? state.mods || [] : [])].sort().join();
    return readSaved().find(setup => {
        if (setup.item !== state.item) return false;
        const saved = readSetup(setup.link);
        return saved && saved.edition === state.edition && saved.allow_incompatible === Boolean(state.allow_incompatible)
            && [...(saved.edition === "java" ? saved.mods_on : [])].sort().join() === mods && same(saved.wanted, state.wanted);
    }) || null;
}

// Saves the current setup under a name, the newest first. Refused when this item already has a setup by that name ({ error: "name" }) or when one
// already holds the same setup ({ error: "exists", name: its name }); else { ok: true }.
export function saveSetup(name) {
    if (!state.item || !name) return { error: "name" };
    if (setupNameTaken(name, state.item)) return { error: "name" };
    const twin = sameSavedSetup();
    if (twin) return { error: "exists", name: twin.name };
    const list = readSaved();
    list.unshift({ name, item: state.item, link: logic.serialize(state) });
    writeStorage(SAVED_STORAGE_KEY, list);
    return { ok: true };
}

// Removing asks nothing first. A setup is its name and item together.
export function deleteSetup(name, item) {
    writeStorage(SAVED_STORAGE_KEY, readSaved().filter(setup => !(setup.name === name && setup.item === item)));
}

// The mods named by any saved setup: their files load (not switch on) so their enchantments can be named when a setup is shown or loaded
// while the mod is off. Resolves to whether any file was new.
export async function loadSavedMods() {
    const ids = [...new Set(readSaved().flatMap(setup => linkMods(setup.link)))].filter(id => !mod_data[id]);
    if (!ids.length) return false;
    await loadMods(ids);
    return true;
}

// What loading a saved setup would do: its item and enchantments, and the game rules it would change (edition, mods, Allow conflicts; its books
// and level limit are not taken), as "Edition: Bedrock" lines. Null if it can't be read; `usable` is false when its item isn't offered at all.
export function setupFit(setup) {
    const saved = readSetup(setup.link);
    if (!saved) return null;
    const changes = [];
    const rule = (name, value) => TEXT.wanted.rule_set({ rule: name, value });
    const onOff = on => (on ? TEXT.ranking.switch_on : TEXT.ranking.switch_off);
    if (saved.edition !== state.edition) changes.push(rule(TEXT.ranking.edition, TEXT.page.editions[saved.edition].label));
    const now = new Set(state.mods || []), then = new Set(saved.edition === "java" ? saved.mods_on : []);
    for (const id of MOD_IDS) {
        if (now.has(id) === then.has(id) || (saved.edition !== "java" && !now.has(id))) continue;
        changes.push(rule(mod_data[id] ? mod_data[id].label : id, onOff(then.has(id))));
    }
    if (saved.allow_incompatible !== Boolean(state.allow_incompatible)) changes.push(rule(TEXT.ranking.allow_conflicts, onOff(saved.allow_incompatible)));
    return { item: saved.item, wanted: saved.wanted, changes, usable: logic.enchantableItems().includes(saved.item) };
}

// Loads a saved setup: its item, enchantments, edition, mods and Allow conflicts (the books are kept, and checked against the new item and rules; the level
// limit and the ranking stay). Its mods' files load first. Resolves to the fit (Wanted.js says which rules changed), or null if it can't load.
export async function applySetup(setup) {
    const fit = setupFit(setup);
    if (!fit || !fit.usable) return null;
    const loaded_mods = await loadMods(linkMods(setup.link));
    const loaded = readLink(setup.link);
    if (!loaded) return null;
    setItemMenuOpen(false);
    state.edition = loaded.edition;
    state.rename_to = cleanName(state.rename_to, state.edition);
    syncRename();
    state.mods = loaded.mods.filter(id => loaded_mods.includes(id));
    state.allow_incompatible = loaded.allow_incompatible;
    state.item = loaded.item;
    state.wanted = loaded.wanted;
    applyMods(); // (the helpers for the edition and mods, the workers, and the books checked against them)
    commit();
    return fit;
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

// A <details> menu (Settings, Share) closes on a click outside it or on Escape.
export function setupMenuClosing(menu) {
    closeOnOutside({
        open: () => menu.open,
        // The path, not contains(): a click on a button the menu then redraws is still inside.
        inside: event => event.composedPath().includes(menu),
        close: () => { menu.open = false; }
    });
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
    button.querySelector(".theme-label").textContent = dark ? TEXT.page.theme_light_label : TEXT.page.theme_dark_label;
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
// Start over keeps what the Settings menu holds and the Dark/Light theme: the Display switches and the theme (kept in this browser) stay in storage, and
// the game rules (edition, level limit, conflicts, mods), which live in the link the reload drops, cross it in this tab's session storage (`keptRules`,
// read once by `init`).
const KEPT_SETTINGS = new Set(["enchantment-calculator-no-motion", "enchantment-calculator-glints", "enchantment-calculator-descriptions", THEME_STORAGE_KEY]);
const KEPT_RULES_KEY = "enchantment-calculator-kept-rules";
export function resetEverything() {
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith("enchantment-calculator-") && key !== SAVED_STORAGE_KEY && key !== LANGUAGE_STORAGE_KEY && !KEPT_SETTINGS.has(key)) localStorage.removeItem(key);
        }
    } catch {
        // No storage: nothing was kept.
    }
    try {
        const { edition, max_step, no_step_limit, allow_incompatible, mods } = state;
        sessionStorage.setItem(KEPT_RULES_KEY, JSON.stringify({ edition, max_step, no_step_limit, allow_incompatible, mods }));
    } catch {
        // No session storage: the rules go back to the game's own.
    }
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
}

function setupCopyLink() {
    const button = $("#copy-link");
    button.addEventListener("click", () => copyText(button.querySelector(".copy-label"), currentLink(), TEXT.page.copy_link, button));
}

// The game rules Start over kept (or null), read once: a later reload starts from the game's own again.
function keptRules() {
    try {
        const text = sessionStorage.getItem(KEPT_RULES_KEY);
        sessionStorage.removeItem(KEPT_RULES_KEY);
        const kept = text && JSON.parse(text);
        if (!kept) return null;
        return {
            edition: EDITIONS.includes(kept.edition) ? kept.edition : "java",
            max_step: clampStepLimit(kept.max_step),
            no_step_limit: Boolean(kept.no_step_limit),
            allow_incompatible: Boolean(kept.allow_incompatible),
            mods: Array.isArray(kept.mods) ? kept.mods.filter(id => MOD_IDS.includes(id)) : []
        };
    } catch {
        return null;
    }
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

// The right column (900px+) scrolls with the page, one scrollbar for every section: it sticks under the top (and the Item bar) while it fits the window,
// and once taller it sticks by its bottom instead, a negative top, so reading down the steps scrolls the page.
function setupResultsColumn() {
    const column = document.querySelector(".results-column");
    const root = document.documentElement;
    const place = () => {
        const dock = parseFloat(getComputedStyle(root).getPropertyValue("--dock-h")) || 0;
        const top = 16 + dock;
        const value = Math.min(top, innerHeight - column.offsetHeight - 16) + "px";
        if (root.style.getPropertyValue("--column-top") !== value) root.style.setProperty("--column-top", value); // (it watches the style it sets)
    };
    new ResizeObserver(place).observe(column);
    new MutationObserver(place).observe(root, { attributes: true, attributeFilter: ["style"] });
    addEventListener("resize", place);
    place();
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
    const kept = location.hash ? null : keptRules();
    await loadMods(kept ? kept.mods : linkMods(location.hash.slice(1)));
    loadFromUrl();
    if (kept) Object.assign(state, kept);
    useEdition(state.edition);
    if (state.edition !== "java" && state.item) sanitizeAll();
    startWorker();
    setupHashChange();
    setupCopyLink();
    setupTheme();
    setupInfoTip();
    setupSkipLinks();
    new MutationObserver(renderBadges).observe($("#books-alert"), { childList: true }); // (Books.js draws and clears the alert badge)
    setupResultsColumn();
    setupItemMenu();
    setupMenuClosing($("#presets-menu")); // (the header's Presets menu: Wanted.js renderPresetsMenu)
    $("#presets-menu > summary").title = TEXT.page.saved_help;
    $("#presets-menu > summary").setAttribute("aria-label", TEXT.wanted.presets); // (its label hides on narrow windows, leaving the star)
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
