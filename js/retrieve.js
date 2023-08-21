function retrieveBookEnchantments($book_selection) {
    const enchantment_codenames = enchantmentCodenamesFromSelection($book_selection);
    const enchantments = enchantmentsFromCodenames(enchantment_codenames);
    return enchantments;
}

function retrieveItemEnchantments($item_selection) {
    const $selected_buttons = onButtonsFromEnchantmentGroups($item_selection);
    const enchantment_codenames = enchantmentCodenamesFromButtons($selected_buttons);
    const enchantments = enchantmentsFromCodenames(enchantment_codenames);
    return enchantments;
}

function generateBookEntry($book_selection) {
    const book_enchantments = retrieveBookEnchantments($book_selection);
    const book_entry = ["book", book_enchantments, 0];
    return book_entry;
}

function generateBookEntriesFromSelections($book_selections) {
    const book_count = $book_selections.length;

    var book_entries = new Array(book_count);
    $book_selections.each((book_index, book_selection) => {
        const $book_selection = $(book_selection);
        const book_entry = generateBookEntry($book_selection);
        book_entries[book_index] = book_entry;
    });

    return book_entries;
}

function generateItemEntry($item_selection) {
    const item_namespace = itemNamespaceFromElement($item_selection);
    const item_enchantments = retrieveItemEnchantments($item_selection);
    const item_entry = [item_namespace, item_enchantments, 0];
    return item_entry;
}

function generateItemEntriesFromSelections($item_selections) {
    const item_count = $item_selections.length;

    var item_entries = new Array(item_count);
    $item_selections.each((item_index, item_selection) => {
        const $item_selection = $(item_selection);
        const item_entry = generateItemEntry($item_selection);
        item_entries[item_index] = item_entry;
    });

    return item_entries;
}

function retrieveSelectedItemEntries() {
    const $selected_items = $("#selected-items");
    const $book_selections = $selected_items.find(".book-selection");
    const $item_selections = $selected_items.find(".enchantment-groups");

    const book_entries = generateBookEntriesFromSelections($book_selections);
    const item_entries = generateItemEntriesFromSelections($item_selections);
    const entries = item_entries.concat(book_entries);
    return entries;
}
