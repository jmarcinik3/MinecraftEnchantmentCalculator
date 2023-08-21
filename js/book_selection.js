function bookHeaderFromSelection($book_selection) {
    const $book_header = $book_selection.prev(".selected-item-header");
    return $book_header;
}

function bookHeaderFromElement($element) {
    const $book_selection = bookSelectionFromElement($element);
    const $book_header = bookHeaderFromSelection($book_selection);
    return $book_header;
}

function bookSelectionFromElement($element) {
    const $book_selection = $element.parents(".book-selection");
    return $book_selection;
}

function enchantmentNameListboxFromElement($element) {
    const $book_selection = bookSelectionFromElement($element);
    const $enchantment_name_listbox = $book_selection.find(".enchantment-name-listbox");
    return $enchantment_name_listbox;
}

function enchantmentLevelListboxFromElement($element) {
    const $book_selection = bookSelectionFromElement($element);
    const $enchantment_level_listbox = $book_selection.find(".enchantment-level-listbox");
    return $enchantment_level_listbox;
}

function enchantmentListboxFromElement($element) {
    const $book_selection = bookSelectionFromElement($element);
    const $enchantment_listbox = $book_selection.find(".selected-enchantments-listbox");
    return $enchantment_listbox;
}

function selectedEnchantmentNamespaceFromElement($element) {
    const $enchantment_name_listbox = enchantmentNameListboxFromElement($element);
    const enchantment_namespace = enchantmentNamespaceFromListbox($enchantment_name_listbox);
    return enchantment_namespace;
}

function selectedEnchantmentLevelFromElement($element) {
    const $enchantment_level_listbox = enchantmentLevelListboxFromElement($element);
    const enchantment_level = enchantmentLevelFromListbox($enchantment_level_listbox);
    return enchantment_level;
}

function enchantmentNamespaceFromListbox($enchantment_name_listbox) {
    const enchantment_namespace = $enchantment_name_listbox.val()[0];
    return enchantment_namespace;
}

function enchantmentLevelFromListbox($enchantment_level_listbox) {
    const enchantment_level = $enchantment_level_listbox.val()[0];
    return enchantment_level;
}

function enchantmentCodenameFromOption($enchantment_option) {
    const enchantment_codename = $enchantment_option.val();
    return enchantment_codename;
}

function enchantmentCodenamesFromOptions($enchantment_options) {
    const enchantment_count = $enchantment_options.length;
    var enchantment_codenames = new Array(enchantment_count);

    $enchantment_options.each((enchantment_index, enchantment_option) => {
        const $enchantment_option = $(enchantment_option);
        const enchantment_codename = enchantmentCodenameFromOption($enchantment_option);
        enchantment_codenames[enchantment_index] = enchantment_codename;
    });

    return enchantment_codenames;
}

function enchantmentCodenamesFromListbox($enchantment_listbox) {
    const $enchantment_options = optionsFromListbox($enchantment_listbox);
    const enchantment_codenames = enchantmentCodenamesFromOptions($enchantment_options);
    return enchantment_codenames;
}

function enchantmentCodenamesFromSelection($book_selection) {
    const $enchantment_listbox = $book_selection.find(".selected-enchantments-listbox");
    const enchantment_codenames = enchantmentCodenamesFromListbox($enchantment_listbox);
    return enchantment_codenames;
}

function enchantmentDisplayNameFromOption($enchantment_option) {
    const enchantment_codename = enchantmentCodenameFromOption($enchantment_option);
    const enchantment_displayname = enchantmentDisplayNameFromCodename(enchantment_codename);
    return enchantment_displayname;
}

function enchantmentCodenameFromListbox($enchantment_listbox) {
    const enchantment_codename = $enchantment_listbox.val()[0];
    return enchantment_codename;
}

function generateEnchantmentOptionInListbox(enchantment_namespace, enchantment_level, $enchantment_listbox) {
    const $enchantment_option = generateEnchantmentOption(enchantment_namespace, enchantment_level);
    $enchantment_listbox.append($enchantment_option);
    sortListbox($enchantment_listbox);
}

function generateEnchantmentOptionFromButton($add_button) {
    const enchantment_namespace = selectedEnchantmentNamespaceFromElement($add_button);
    const enchantment_level = selectedEnchantmentLevelFromElement($add_button);
    const $enchantment_listbox = enchantmentListboxFromElement($add_button);
    generateEnchantmentOptionInListbox(enchantment_namespace, enchantment_level, $enchantment_listbox);
}

function generateEnchantmentNameOptionInListbox(enchantment_namespace, $enchantment_name_listbox) {
    const $enchantment_name_option = generateEnchantmentNameOption(enchantment_namespace);
    $enchantment_name_listbox.append($enchantment_name_option);
    sortListbox($enchantment_name_listbox);
}

function generateEnchantmentNameOptionFromButton($remove_button) {
    const $enchantment_listbox = enchantmentListboxFromElement($remove_button);
    const enchantment_codename = enchantmentCodenameFromListbox($enchantment_listbox);
    const enchantment_namespace = enchantmentNamespaceFromCodename(enchantment_codename);
    var $enchantment_name_listbox = enchantmentNameListboxFromElement($remove_button);
    generateEnchantmentNameOptionInListbox(enchantment_namespace, $enchantment_name_listbox);
}

function enchantmentDisplayNamesFromOptions($enchantment_options) {
    var enchantment_displaynames = new Array($enchantment_options.length);
    $enchantment_options.each((option_index, enchantment_option) => {
        const $enchantment_option = $(enchantment_option);
        const enchantment_displayname = enchantmentDisplayNameFromOption($enchantment_option);
        enchantment_displaynames[option_index] = enchantment_displayname;
    });
    return enchantment_displaynames;
}

function enchantmentDisplayNamesFromListbox($enchantment_listbox) {
    const $enchantment_options = optionsFromListbox($enchantment_listbox);
    const enchantment_displaynames = enchantmentDisplayNamesFromOptions($enchantment_options);
    return enchantment_displaynames;
}

function enchantmentDisplayNamesFromButton($button) {
    const $enchantment_listbox = enchantmentListboxFromElement($button);
    const enchantment_displaynames = enchantmentDisplayNamesFromListbox($enchantment_listbox);
    return enchantment_displaynames;
}

function bookHeaderTextFromButton($button) {
    const enchantment_displaynames = enchantmentDisplayNamesFromButton($button);
    const item_header_text = itemHeaderTextFromDisplayNames("Book", enchantment_displaynames);
    return item_header_text;
}

function updateBookHeaderFromButton($button) {
    const $book_header = bookHeaderFromElement($button);
    const book_header_text = bookHeaderTextFromButton($button);
    var $header_text = $book_header.children("span.item-header-text");
    $header_text.text(book_header_text);
}

function removeEnchantmentOption($remove_button) {
    const $enchantment_listbox = enchantmentListboxFromElement($remove_button);
    const enchantment_codename = $enchantment_listbox.val()[0];
    const $enchantment_option = $enchantment_listbox.find("option[value='" + enchantment_codename + "']");
    $enchantment_option.remove();
}

function removeEnchantmentNameOption($add_button) {
    const $enchantment_name_listbox = enchantmentNameListboxFromElement($add_button);
    const enchantment_namespace = enchantmentNamespaceFromListbox($enchantment_name_listbox);
    const $enchantment_option = $enchantment_name_listbox.find("option[value=" + enchantment_namespace + "]");
    $enchantment_option.remove();
}

function updateEnchantmentLevelListbox(max_level, $enchantment_level_listbox) {
    var $level_options = $enchantment_level_listbox.find("option");
    $level_options.remove();

    let $level_option;
    for (let level = 1; level <= max_level; level++) {
        $level_option = generateEnchantmentLevelOption(level);
        $enchantment_level_listbox.append($level_option);
    }

    $level_option.attr("selected", true);
}

function changedEnchantmentNameListbox(event) {
    const $changed_listbox = $(event.target);
    const enchantment_namespace = enchantmentNamespaceFromListbox($changed_listbox);
    const enchantment_max_level = enchantmentMaxLeveLFromNamespace(enchantment_namespace);
    const $enchantment_level_listbox = enchantmentLevelListboxFromElement($changed_listbox);
    updateEnchantmentLevelListbox(enchantment_max_level, $enchantment_level_listbox);
}
