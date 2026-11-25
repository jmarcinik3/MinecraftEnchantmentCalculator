// Shared state: the setup on screen, the loaded game data, and the rules for them. Other modules import these
// live bindings (they read the current value) and change them through the set... functions.
import { CRITERIA, MAX_STEP_LEVELS, withMods } from "./Logic.js";

// Warn when a search tries more left/right splits than this: about a second or more.
// (12 all-different entries is ~520,000 splits; repeated entries add far fewer.)
export const SLOW_SPLITS = 1000000;
export let meta = null;
export const mod_data = {}; // the data files of the mods loaded so far, by id (see Logic.js MOD_IDS)
export let logic = null;
export let state = defaultState();
let next_book_id = 1;
export let item_menu_open = false; // section 1's item menu (on the item's slot)
export let conflicts_toggled = false; // the next redraw follows "Allow conflicts" changing, so it animates the groups

export let language = "en";
function defaultState() {
    return {
        item: null,
        wanted: {},        // enchantments the user wants on the final item
        auto_books: true,  // derive entries from `wanted`
        books: [],         // custom entries: { id, type: "book" | "item", enchantments: {ns: level}, prior_work, copies }
        priority: [...CRITERIA],     // ranking for the best order, most important first
        max_step: MAX_STEP_LEVELS,   // no single step may cost more levels than this
        no_step_limit: false,        // ignore max_step and "Too Expensive!" (for mods that remove it)
        allow_incompatible: false,   // let conflicting enchantments go together (for mods that allow it)
        edition: "java",             // "java" | "bedrock": their anvil rules differ
        mods: [],                    // ids of the mods whose enchantments are offered (Java only; Logic.js MOD_IDS)
        rename: false,               // rename the item in the last step (+1 level)
        rename_to: ""                // the new name shown on the result (optional)
    };
}

// ---------- Setters (the only way other modules change these) ----------

export function setMeta(value) { meta = value; }
export function setLogic(value) { logic = value; }
export function setModData(id, data) { mod_data[id] = data; }

// The game data the search needs: the metadata plus the enabled mods' enchantments.
export function engineMeta() {
    return withMods(meta, state.mods.map(id => mod_data[id]).filter(Boolean));
}
export function setState(value) { state = value; }
export function nextBookId() { return next_book_id++; }
export function setItemMenuOpen(value) { item_menu_open = value; }
export function setConflictsToggled(value) { conflicts_toggled = value; }
export function setLanguage(value) { language = value; }
