function itemNamespaceFromElement($element) {
    const $item_header = itemHeaderFromElement($element);
    const item_namespace = $item_header.attr("name");
    return item_namespace;
}

function enchantmentNamespaceFromButton($level_button) {
    const enchantment_codename = enchantmentCodenameFromButton($level_button);
    const enchantment_namespace = enchantmentNamespaceFromCodename(enchantment_codename);
    return enchantment_namespace;
}

function enchantmentLevelFromButton($level_button) {
    const enchantment_codename = enchantmentCodenameFromButton($level_button);
    const enchantment_level = enchantmentLevelFromCodename(enchantment_codename);
    return enchantment_level;
}

function enchantmentCodenameFromButton($level_button) {
    const button_name = $level_button.attr("name");
    return button_name;
}

function enchantmentCodenamesFromButtons($level_buttons) {
    const button_count = $level_buttons.length;
    var enchantment_codenames = new Array(button_count);

    $level_buttons.each((button_index, level_button) => {
        const $level_button = $(level_button);
        const enchantment_codename = enchantmentCodenameFromButton($level_button);
        enchantment_codenames[button_index] = enchantment_codename;
    });

    return enchantment_codenames;
}

function enchantmentDisplayNameFromButton($level_button) {
    const enchantment_codename = enchantmentCodenameFromButton($level_button);
    const enchantment_displayname = enchantmentDisplayNameFromCodename(enchantment_codename);
    return enchantment_displayname;
}

function enchantmentGroupsFromElement($element) {
    const element_is_groups = $element.hasClass("enchantment-groups");
    
    let $enchantment_groups;
    if (element_is_groups) {
        $enchantment_groups = $element;
    } else {
        $enchantment_groups = $element.parents(".enchantment-groups");
    }

    return $enchantment_groups;
}

function itemHeaderFromElement($element) {
    const $enchantment_groups = enchantmentGroupsFromElement($element);
    const $selected_item_header = $enchantment_groups.prev(".selected-item-header");
    return $selected_item_header;
}

function buttonIsOn($level_button) {
    const button_classes = $level_button.attr("class").split(" ");

    let button_is_on = false;
    button_classes.forEach(button_class => {
        if (button_class == "on") {
            button_is_on = true;
        }
    });

    return button_is_on;
}

function onButtonsFromEnchantmentGroups($enchantment_groups) {
    const $level_buttons = $enchantment_groups.find(".level-button");
    const $on_buttons = filterButtonsByState($level_buttons, true);
    return $on_buttons;
}

function onButtonsFromLevelButton($level_button) {
    const $enchantment_groups = enchantmentGroupsFromElement($level_button);
    const $on_buttons = onButtonsFromEnchantmentGroups($enchantment_groups);
    return $on_buttons;
}

function filterButtonsByState($level_buttons, state) {
    function filterButtons(this_index, this_button) {
        const $this_button = $(this_button);
        return buttonMatchesState($this_button, state);
    }
    const $filtered_buttons = $level_buttons.filter(filterButtons);
    return $filtered_buttons;
}

function buttonMatchesState($level_button, state) {
    const button_is_on = buttonIsOn($level_button);
    const button_matches_state = button_is_on == state;
    return button_matches_state;
}

function buttonMatchesNamespace($level_button, enchantment_namespace) {
    const button_enchantment_namespace = enchantmentNamespaceFromButton($level_button);
    const button_matches_namespace = button_enchantment_namespace == enchantment_namespace;
    return button_matches_namespace;
}

function buttonMatchesLevel($level_button, enchantment_level) {
    const button_level = enchantmentLevelFromButton($level_button);
    const button_matches_level = button_level == enchantment_level;
    return button_matches_level;
}

function buttonIsSameNamespaceDifferentLevel($level_button, enchantment_namespace, enchantment_level = -1) {
    const button_matches_name = buttonMatchesNamespace($level_button, enchantment_namespace);
    const button_matches_level = buttonMatchesLevel($level_button, enchantment_level);
    return button_matches_name && !button_matches_level;
}

function enchantmentDisplayNamesFromButtons($buttons) {
    var enchantment_displaynames = new Array($buttons.length);
    $buttons.each((index, button) => {
        const $button = $(button);
        const enchantment_displayname = enchantmentDisplayNameFromButton($button);
        enchantment_displaynames[index] = enchantment_displayname;
    });
    return enchantment_displaynames;
}

function enchantmentDisplayNamesFromLevelButton($level_button) {
    const $on_buttons = onButtonsFromLevelButton($level_button);
    const enchantment_displaynames = enchantmentDisplayNamesFromButtons($on_buttons);
    return enchantment_displaynames;
}

function itemHeaderTextFromLevelButton($level_button) {
    const enchantment_displaynames = enchantmentDisplayNamesFromLevelButton($level_button);
    const item_namespace = itemNamespaceFromElement($level_button);
    const item_name = itemNameFromNamespace(item_namespace);
    const item_header_text = itemHeaderTextFromDisplayNames(item_name, enchantment_displaynames);
    return item_header_text;
}

function updateItemHeaderFromLevelButton($level_button) {
    const $item_header = itemHeaderFromElement($level_button);
    const item_header_text = itemHeaderTextFromLevelButton($level_button);
    var $header_text = $item_header.children("span.item-header-text");
    $header_text.text(item_header_text);
}

function toggleLevelButtonState($level_button) {
    $level_button.toggleClass("on");
    $level_button.toggleClass("off");
}

function setLevelButtonState($level_button, new_button_state) {
    const button_is_on = buttonIsOn($level_button);
    if (button_is_on != new_button_state) {
        toggleLevelButtonState($level_button);
    }
}

function setLevelButtonStates($level_buttons, new_button_state) {
    $level_buttons.each((button_index, level_button) => {
        var level_button = $(level_button);
        setLevelButtonState(level_button, new_button_state);
    });
}

function turnOffSameEnchantmentButtons($level_button) {
    const enchantment_level = enchantmentLevelFromButton($level_button);
    const enchantment_namespace = enchantmentNamespaceFromButton($level_button);
    const $level_buttons = $(".level-button");

    function filterDifferentLevelButtons(this_index, this_button) {
        const $this_button = $(this_button);
        return buttonIsSameNamespaceDifferentLevel($this_button, enchantment_namespace, enchantment_level);
    }
    var $same_enchantment_buttons = $level_buttons.filter(filterDifferentLevelButtons);
    setLevelButtonStates($same_enchantment_buttons, false);
}

function turnOffIncompatibleEnchantmentButtons($level_button) {
    const enchantment_namespace = enchantmentNamespaceFromButton($level_button);
    const $level_buttons = $(".level-button");

    const incompatible_namespaces = incompatibleNamespacesFromEnchantmentNamespace(enchantment_namespace);
    incompatible_namespaces.forEach(incompatible_namespace => {
        if (incompatible_namespace != enchantment_namespace) {
            function filterIncompatibleEnchantmentButtons(this_index, this_button) {
                const $this_button = $(this_button);
                return buttonMatchesNamespace($this_button, incompatible_namespace);
            }
            var $incompatible_buttons = $level_buttons.filter(filterIncompatibleEnchantmentButtons);
            setLevelButtonStates($incompatible_buttons, false);
        }
    });
}

function levelButtonClicked(event) {
    var $clicked_button = $(event.target);
    toggleLevelButtonState($clicked_button);
    const button_is_on = buttonIsOn($clicked_button);

    if (button_is_on) {
        turnOffSameEnchantmentButtons($clicked_button);
        turnOffIncompatibleEnchantmentButtons($clicked_button);
    }

    updateItemHeaderFromLevelButton($clicked_button);
}
