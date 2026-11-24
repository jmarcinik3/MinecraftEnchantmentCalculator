// Shared state: the setup on screen, the loaded game data, and the rules for them. Other modules import these
// live bindings (they read the current value) and change them through the set... functions.
import { CRITERIA, MAX_STEP_LEVELS } from "./Logic.js";

// Warn when a search tries more left/right splits than this: about a second or more.
// (12 all-different entries is ~520,000 splits; repeated entries add far fewer.)
export const SLOW_SPLITS = 1000000;
export let meta = null;
export let logic = null;
export let state = defaultState();
let next_book_id = 1;
export let undo_books = null; // the custom list before the last fix or removal in section 2
export let undo_label = null; // the removed entry's name ("Put back …"), or null after a fix
export let item_menu_open = false; // section 1's item menu (on the item's slot)
export let conflicts_toggled = false; // the next redraw follows "Allow conflicts" changing, so it animates the groups

export let language = "en";
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

export function setMeta(value) { meta = value; }
export function setLogic(value) { logic = value; }
export function setState(value) { state = value; }
export function nextBookId() { return next_book_id++; }
export function setUndoBooks(value) { undo_books = value; }
export function setUndoLabel(value) { undo_label = value; }
export function setItemMenuOpen(value) { item_menu_open = value; }
export function setConflictsToggled(value) { conflicts_toggled = value; }
export function setLanguage(value) { language = value; }
