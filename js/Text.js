// Every piece of text the page shows, in one place: edit the wording here.
// Each language is one object with the same keys (a test checks they match); English
// is `EN` here, the others are in js/Text<Language>.js. `TEXT` is the one in use.
//
// - Plain entries are used as they are.
// - Entries written as `name => ...` fill in a value. Keep the `${...}` parts and
//   change the words around them, e.g. replaces: name => `Swaps out ${name}`.
// - `help` entries are tooltips (shown on hover). `label` entries ending in `_label`
//   are read aloud by screen readers but not shown.
//
// English item and enchantment names come from json/metadata.json; other languages
// list theirs under `names`.

import { ES } from "./TextSpanish.js";

const EN = {
    // Page title and the headings in index.html.
    page: {
        title: "Enchantment Calculator",
        heading: "Enchantment calculator",
        item_heading: "Item",
        enchantments_heading: "Enchantments",
        books_heading: "Books and items",
        results_heading: "Best order",
        copy_link: "Copy link",
        copied: "Copied",
        copy_failed: "Copy failed",
        edition_label: "Edition",
        language_label: "Language",
        // Setups saved in this browser, in the header.
        saved: "Saved",
        saved_help: "Setups saved in this browser",
        save: "Save",
        save_name_label: "Name for this setup",
        saved_empty: "Nothing saved yet.",
        delete_saved: "Remove",
        delete_saved_label: name => `Remove ${name}`,
        removed_saved: name => `Removed ${name}`,
        undo_remove: "Undo",
        // The edition toggle in the header.
        editions: {
            java: { label: "Java", help: "Java Edition anvil rules" },
            bedrock: { label: "Bedrock", help: "Bedrock Edition: each enchantment costs only the levels it adds, Impaling is cheaper, and there is no Sweeping Edge" }
        }
    },

    // Section 2: the enchantments wanted on the final item.
    wanted: {
        pick_item_first: "Pick an item first.",
        max_all: "Max all",
        clear: "Clear",
        allow_conflicts: "Allow conflicts (modded)",
        allow_conflicts_help: "For mods that let conflicting enchantments go together",
        curses: "Curses",
        // Labels on the boxes that group conflicting enchantments.
        group_pick_one: "Pick one",
        group_some_conflict: "Some conflict",
        group_allowed: "Conflict (allowed)",
        replaces: name => `Replaces ${name}`,
        conflicts_with: name => `Conflicts with ${name}`,
        // Marks on chosen enchantments that the custom books can't reach.
        books_reach: level => `Books reach ${level}`,
        not_on_books: "Not on any book",
        short_help: "Your books and items in section 3 can't reach the level chosen here."
    },

    // Section 3: the books and item copies going on the anvil.
    books: {
        edit: "Edit",
        add_book: "Add book",
        add_item: item_name => `Add ${item_name.toLowerCase()}`,
        automatic: "Automatic",
        book: "Book",
        type_label: "Type",
        reorder_label: number => `Move entry ${number}`,
        reorder_help: "Drag to reorder, or focus and press the up and down arrow keys",
        copies: "Copies",
        copies_help: "How many identical copies of this you have, e.g. a stack of the same book",
        prior_work: "Prior work",
        prior_work_help: "How many times this has already been used on an anvil. Each use makes later merges more expensive.",
        decrease_label: label => `Decrease ${label}`,
        increase_label: label => `Increase ${label}`,
        remove_entry_label: number => `Remove entry ${number}`,
        add_enchantment: "+ Add enchantment",
        add_enchantment_label: "Add enchantment",
        level_of_label: name => `Level of ${name}`,
        remove_enchantment_label: name => `Remove ${name}`,
        // Checks on a custom list, shown before calculating.
        still_needed: names => `Still needed: ${names.join(", ")}`,
        // Badge on the section heading: how many chosen enchantments can't be reached.
        alert: count => `⚠ ${count}`,
        alert_label: count => `${count} chosen ${count === 1 ? "enchantment" : "enchantments"} can't be reached`,
        // Suggestions in the badge's bubble, each a button that changes the list.
        fix_best: level => `best now: ${level}`,
        fix_new_book: name => `Add 1 ${name} book`,
        fix_replaces: names => `Replaces ${names.join(" and ")}, no longer needed`,
        replaced_item: (item, enchantment) => `${item} (${enchantment})`,
        undo: "↶ Undo",
        undo_help: "Undo the last suggestion you applied",
        path_step: (count, level) => `${count}× ${level}`,
        short_of: (wanted, best) => `${wanted} (best possible: ${best})`,
        unwanted_label: "Not chosen",
        unwanted_help: "Not chosen in Enchantments. It will still go on the item and cost levels."
    },

    // The "Rank by" chips and the level limit, above the results.
    ranking: {
        // Shown from the "?" next to "Best order".
        rank_by: "Best order ranks by these, first one first. Drag to reorder.",
        rank_help_label: "How the best order is chosen",
        no_value: "–",
        // One entry per ranking criterion: the chip/tile name and its tooltip.
        criteria: {
            levels: { label: "Levels", help: "Total levels spent" },
            xp: { label: "XP", help: "Total XP points spent. Higher levels cost more XP each." },
            max_step: { label: "Max level", help: "Most levels spent on one anvil use" },
            prior_work: { label: "Prior work", help: "Prior work on the result, which makes future anvil use cheaper" }
        },
        rank_higher_label: label => `Rank ${label} higher`,
        rank_lower_label: label => `Rank ${label} lower`,
        level_limit: "Level limit",
        level_limit_help: "No anvil use may cost more levels than this",
        level_limit_label: "Most levels allowed per anvil use",
        no_limit: "No limit (modded)",
        no_limit_help: "For mods that remove \"Too Expensive!\"",
        no_limit_label: "No level limit",
        unlimited: "∞",
        rename: "Rename",
        rename_help: "Rename the item in the last step. Renaming adds 1 level to that step.",
        rename_placeholder: "New name (optional)",
        rename_label: "New name for the finished item",
        your_level: "Your level",
        your_level_help: "Your XP level now, to see what you have left after each step",
        your_level_placeholder: "optional",
        your_level_label: "Your current XP level"
    },

    // The results: progress, messages, and the anvil steps.
    results: {
        slow_search: count => `${count} entries: this may take a while.`,
        too_many_different: "Too many different entries. Repeated books are fine, but at most 20 different ones.",
        cancel: "Cancel",
        cancelled: "Cancelled. ",
        run_again: "Run again",
        pick_item: "Pick an item",
        choose_enchantments: "Choose enchantments",
        no_valid_order: "No valid order: these can't be combined.",
        no_valid_order_within: limit => `No valid order within the ${limit}-level limit.`,
        nothing_to_combine: "Nothing to combine",
        missing: names => `Missing: ${names.join(", ")}`,
        extra: names => `Also on the item (not chosen): ${names.join(", ")}`,
        extra_help: "These came along on your books or items. They are included in the cost.",
        cost: levels => `Cost: ${levels}`,
        cost_renamed: levels => `Cost: ${levels} (with rename)`,
        step_done_label: number => `Step ${number} done`,
        // Heading for each group of steps that don't depend on each other.
        round: (number, step_count) => step_count > 1 ? `Round ${number} · any order` : `Round ${number}`,
        round_help: "These steps don't need each other's results, so do them in any order.",
        step_done_help: "Tick off steps as you do them. Kept in this browser.",
        enchanted_book: "Enchanted Book",
        // With "Your level" filled in: the level before and after each step.
        level_track: (before, after) => `Lv ${before} → ${after}`,
        level_short: count => `Need ${count} more ${count === 1 ? "level" : "levels"}`,
        levels_left: level => `You end at level ${level}.`,
        levels_needed: (short, start) => `${short} more ${short === 1 ? "level" : "levels"} needed in total: start at level ${start} or higher.`,
        // Chance a new anvil breaks: each use damages it 12% of the time, the 3rd damage breaks it.
        anvil_wear: (uses, chance) => `${uses} anvil ${uses === 1 ? "use" : "uses"} · a new anvil breaks ${chance} of the time`,
        anvil_wear_help: "Each anvil use has a 12% chance to damage the anvil. A new anvil breaks on its third damage.",
        under_one_percent: "under 1%",
        // The steps can also be shown as a tree, copied as text, or printed.
        view_label: "Show the order as",
        view_steps: "Steps",
        view_tree: "Tree",
        tree_step: (number, levels) => `Step ${number} · ${levels} ${levels === 1 ? "level" : "levels"}`,
        copy_steps: "Copy steps",
        copy_steps_help: "Copy the steps as text, e.g. to paste in a chat",
        copied: "Copied",
        copy_failed: "Copy failed",
        print: "Print",
        print_help: "Print the steps, or save them as a PDF",
        // The copied text.
        text_wanted: (item, enchantments) => `${item}: ${enchantments}`,
        text_totals: (levels, xp, max_step) => `${levels} levels in total (${xp} XP), at most ${max_step} in one step`,
        text_entry: (name, enchantments) => (enchantments ? `${name} (${enchantments})` : name),
        text_result_of: number => `result of step ${number}`,
        text_step: (number, left, right, levels) => `${number}. ${left} + ${right}: ${levels} ${levels === 1 ? "level" : "levels"}`,
        text_rename: name => (name ? `rename to "${name}"` : "rename"),
        worker_failed: "The calculator failed to load. Check the browser console for details.",
        metadata_failed: "Couldn't load the enchantment data. Serve this folder over HTTP instead of opening the file directly."
    },

    // English names come from json/metadata.json.
    names: null
};

// Every language: its name in its own language, and its text.
export const LANGUAGES = {
    en: { label: "English", text: EN },
    es: { label: "Español", text: ES }
};

// The text in use. setLanguage swaps its contents, so modules holding TEXT see the change.
export const TEXT = {};

export function setLanguage(language) {
    const chosen = LANGUAGES[language] ? language : "en";
    for (const key of Object.keys(TEXT)) delete TEXT[key];
    Object.assign(TEXT, LANGUAGES[chosen].text);
    return chosen;
}

setLanguage("en");
