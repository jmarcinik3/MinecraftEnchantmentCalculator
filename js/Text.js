// Every piece of text the page shows, in one place: edit the wording here.
//
// - Plain entries are used as they are.
// - Entries written as `name => ...` fill in a value. Keep the `${...}` parts and
//   change the words around them, e.g. replaces: name => `Swaps out ${name}`.
// - `help` entries are tooltips (shown on hover). `label` entries ending in `_label`
//   are read aloud by screen readers but not shown.
//
// Item and enchantment names come from json/metadata.json, not from here.

export const TEXT = {
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
        conflicts_with: name => `Conflicts with ${name}`
    },

    // Section 3: the books and item copies going on the anvil.
    books: {
        edit: "Edit",
        add_book: "Add book",
        add_item: item_name => `Add ${item_name.toLowerCase()}`,
        automatic: "Automatic",
        book: "Book",
        type_label: "Type",
        prior_work: "Prior work",
        prior_work_help: "How many times this has already been used on an anvil. Each use makes later merges more expensive.",
        decrease_label: label => `Decrease ${label}`,
        increase_label: label => `Increase ${label}`,
        remove_entry_label: number => `Remove entry ${number}`,
        add_enchantment: "+ Add enchantment",
        add_enchantment_label: "Add enchantment",
        level_of_label: name => `Level of ${name}`,
        remove_enchantment_label: name => `Remove ${name}`
    },

    // The "Rank by" chips and the level limit, above the results.
    ranking: {
        rank_by: "Rank by",
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
        rename: "Rename in the last step",
        rename_help: "Renaming the item adds 1 level to that step"
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
        cost: levels => `Cost: ${levels}`,
        cost_renamed: levels => `Cost: ${levels} (with rename)`,
        step_done_label: number => `Step ${number} done`,
        // Heading for each group of steps that don't depend on each other.
        round: (number, step_count) => step_count > 1 ? `Round ${number} · any order` : `Round ${number}`,
        round_help: "These steps don't need each other's results, so do them in any order.",
        step_done_help: "Tick off steps as you do them. Kept in this browser.",
        enchanted_book: "Enchanted Book",
        worker_failed: "The calculator failed to load. Check the browser console for details.",
        metadata_failed: "Couldn't load the enchantment data. Serve this folder over HTTP instead of opening the file directly."
    }
};
