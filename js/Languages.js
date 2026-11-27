// The language picker in the page header: a button with the language's code that opens a panel with a search box, confidence chips
// (All / Reviewed / Moderate / Draft) and the list: Suggested first (the browser's languages, English, Spanish and the one in use), then
// the languages that come in several variants grouped under their family (English, Español, Deutsch...), then the rest.
// The dot's colour is how sure the translation is (Text.js CONFIDENCE). A search reads the language's own name, its English name
// and aliases (Text.js SEARCH_NAMES), its family's name and its code.
import { CONFIDENCE, LANGUAGES, SEARCH_NAMES, TEXT } from "./Text.js";
import { closeOnOutside, h, plain } from "./Dom.js";

const CODES = Object.keys(LANGUAGES);
const familyOf = code => code.split("_")[0];
const FAMILIES = {};
for (const code of CODES) (FAMILIES[familyOf(code)] ||= []).push(code);
const TIERS = [3, 2, 1];
const TIER_KEYS = { 3: "language_reviewed", 2: "language_moderate", 1: "language_draft" };

// "EN", or "EN-GB" where a language has several.
export const shortCode = code => FAMILIES[familyOf(code)].length > 1 ? code.toUpperCase().replace("_", "-") : familyOf(code).toUpperCase();

// A family is named by its own language ("en" -> English): the code's own entry if there is one (fra_de, ksh...), else the first variant without its region.
const familyName = family => {
    const own = FAMILIES[family].find(code => code === family + "_" + family) || FAMILIES[family][0];
    return LANGUAGES[own].split(" (")[0];
};

const byName = codes => [...codes].sort((a, b) => plain(LANGUAGES[a]).localeCompare(plain(LANGUAGES[b])));

// What the search box matches against, per language.
const SEARCH_TEXT = Object.fromEntries(CODES.map(code => [code, [
    LANGUAGES[code], SEARCH_NAMES[code], familyName(familyOf(code)), code, shortCode(code)
].map(text => plain(text || "")).join("\n")]));

// `suggested()` -> language codes to list first; `current()` -> the code in use; `choose(code)` switches the page's language.
export function setupLanguagePicker(container, { suggested, current, choose }) {
    let open = false, query = "", tier = 0; // tier 0 = All
    const button = h("button", { type: "button", class: "language-button header-control", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => toggle(!open) });
    const search = h("input", { type: "search", class: "language-search", autocomplete: "off", spellcheck: "false", oninput: () => { query = plain(search.value); fill(); }, onkeydown: searchKey });
    const chips = h("div", { class: "language-chips" });
    const list = h("div", { class: "language-list", onkeydown: listKey });
    const panel = h("div", { class: "language-panel", role: "dialog", id: "language-panel", hidden: true }, search, chips, list);
    container.replaceChildren(button, panel);
    button.setAttribute("aria-controls", "language-panel");

    const row = code => h("button", {
        type: "button", class: "language-row confidence-" + CONFIDENCE[code] + (code === current() ? " on" : ""), "data-code": code,
        title: TEXT.page[TIER_KEYS[CONFIDENCE[code]]], "aria-current": code === current() ? "true" : null,
        onclick: () => { toggle(false); button.focus(); if (code !== current()) choose(code); }
    }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { class: "language-name" }, LANGUAGES[code]), h("span", { class: "language-code" }, shortCode(code)));

    // [heading, codes] groups for the current search and chip.
    const groups = () => {
        const wanted = code => (!tier || CONFIDENCE[code] === tier) && (!query || SEARCH_TEXT[code].includes(query));
        const families = Object.keys(FAMILIES).filter(family => FAMILIES[family].length > 1).sort();
        const loose = CODES.filter(code => FAMILIES[familyOf(code)].length === 1);
        return [
            [TEXT.page.language_suggested, query || tier ? [] : [...new Set(suggested())]],
            ...families.map(family => [familyName(family) + " (" + family.toUpperCase() + ")", FAMILIES[family].filter(wanted)]),
            [TEXT.page.language_other, byName(loose.filter(wanted))]
        ];
    };

    function fill() {
        list.replaceChildren();
        for (const [heading, codes] of groups()) {
            if (!codes.length) continue;
            list.append(h("h4", { class: "language-heading" }, heading), ...codes.map(row));
        }
        if (!list.firstChild) list.append(h("div", { class: "language-none" }, TEXT.page.language_none));
    }

    function drawChips() {
        chips.replaceChildren(...[0, ...TIERS].map(value => h("button", {
            type: "button", class: "language-chip" + (value ? " confidence-" + value : ""), "aria-pressed": String(value === tier),
            onclick: () => { tier = value; drawChips(); fill(); }
        }, TEXT.page[value ? TIER_KEYS[value] : "language_all"])));
    }

    function toggle(show) {
        open = show;
        panel.hidden = !show;
        button.setAttribute("aria-expanded", String(show));
        if (!show) return;
        query = ""; tier = 0; search.value = "";
        drawChips(); fill();
        search.focus();
    }

    const rows = () => [...list.querySelectorAll(".language-row")];
    // Down from the search box (or Enter) goes to the list; Up and Down move through it, Up from the first row back to the box.
    function searchKey(event) {
        if (event.key === "ArrowDown") { event.preventDefault(); rows()[0]?.focus(); }
        else if (event.key === "Enter") { event.preventDefault(); rows()[0]?.click(); }
    }
    function listKey(event) {
        const all = rows(), at = all.indexOf(document.activeElement);
        if (event.key === "ArrowDown" && at < all.length - 1) { event.preventDefault(); all[at + 1].focus(); }
        else if (event.key === "ArrowUp") { event.preventDefault(); (all[at - 1] || search).focus(); }
    }
    closeOnOutside({
        open: () => open,
        inside: event => event.composedPath().includes(panel) || event.composedPath().includes(button),
        close: () => toggle(false),
        escape: () => { toggle(false); button.focus(); }
    });

    // Redraws the labels (the page's language changed): the button, and the panel's text if it is open.
    return function render() {
        const code = current();
        button.className = "language-button header-control confidence-" + CONFIDENCE[code];
        button.setAttribute("aria-label", TEXT.page.language_label + ": " + LANGUAGES[code]);
        button.title = TEXT.page.language_label + ": " + LANGUAGES[code] + "\n\n" + TEXT.page.language_confidence;
        button.replaceChildren(h("span", { class: "dot", "aria-hidden": "true" }), shortCode(code));
        panel.setAttribute("aria-label", TEXT.page.language_label);
        search.placeholder = TEXT.page.language_search;
        search.setAttribute("aria-label", TEXT.page.language_search);
        if (open) { drawChips(); fill(); }
    };
}
