function elementIsInArray(element, array) {
    const array_length = array.length;
    for (let index = 0; index < array_length; index++) {
        const array_element = array[index];
        if (element == array_element) {
            return true;
        }
    }
    return false;
}

function romanNumeralFromNaturalNumber(number) {
    const roman2int = {
        M: 1000,
        CM: 900,
        D: 500,
        CD: 400,
        C: 100,
        XC: 90,
        L: 50,
        XL: 40,
        X: 10,
        IX: 9,
        V: 5,
        IV: 4,
        I: 1
    };

    var roman_numeral = "";
    for (let roman in roman2int) {
        while (number >= roman2int[roman]) {
            roman_numeral += roman;
            number -= roman2int[roman];
        }
    }

    return roman_numeral;
}

function enchantmentDisplayName(enchantment_namespace, enchantment_level) {
    const enchantment_name = enchantmentNameFromNamespace(enchantment_namespace);
    var enchantment_displayname = enchantment_name;

    const enchantment_max_level = enchantmentMaxLeveLFromNamespace(enchantment_namespace);
    if (enchantment_max_level >= 2) {
        const enchantment_roman = romanNumeralFromNaturalNumber(enchantment_level);
        enchantment_displayname += " " + enchantment_roman;
    }

    return enchantment_displayname;
}

function enchantmentCodename(enchantment_namespace, enchantment_level) {
    const enchantment_codename = enchantment_namespace + "|" + enchantment_level;
    return enchantment_codename;
}

function enchantmentNamespaceFromCodename(enchantment_codename) {
    const codename_splits = enchantment_codename.split("|");
    const enchantment_namespace = codename_splits[0];
    return enchantment_namespace;
}

function enchantmentLevelFromCodename(enchantment_codename) {
    const codename_splits = enchantment_codename.split("|");
    const enchantment_level = codename_splits[1];
    return enchantment_level;
}

function enchantmentFromCodename(enchantment_codename) {
    const enchantment_namespace = enchantmentNamespaceFromCodename(enchantment_codename);
    const enchantment_level = enchantmentLevelFromCodename(enchantment_codename);
    const enchantment = [enchantment_namespace, parseInt(enchantment_level)];
    return enchantment;
}

function enchantmentsFromCodenames(enchantment_codenames) {
    const enchantment_count = enchantment_codenames.length;
    var enchantments = new Array(enchantment_count);

    enchantment_codenames.forEach((enchantment_codename, enchantment_index) => {
        const enchantment = enchantmentFromCodename(enchantment_codename);
        enchantments[enchantment_index] = enchantment;
    });

    return enchantments;
}

function enchantmentDisplayNameFromCodename(enchantment_codename) {
    const enchantment_namespace = enchantmentNamespaceFromCodename(enchantment_codename);
    const enchantment_level = enchantmentLevelFromCodename(enchantment_codename);
    const enchantment_displayname = enchantmentDisplayName(enchantment_namespace, enchantment_level);
    return enchantment_displayname;
}

function itemHeaderTextFromDisplayNames(item_name, enchantment_displaynames, max_enchantment_display = 3) {
    const enchantment_count = enchantment_displaynames.length;
    const has_enchantment = enchantment_count >= 1;

    var item_header_text = item_name;
    if (has_enchantment) {
        const few_enchantments = enchantment_count <= max_enchantment_display;
        item_header_text += " (";

        if (few_enchantments) {
            enchantment_displaynames.forEach((enchantment_displayname, enchantment_index) => {
                item_header_text += enchantment_displayname;
                if (enchantment_index < enchantment_count - 1) {
                    item_header_text += ", ";
                }
            });
        } else {
            item_header_text += enchantment_count + " Enchantments";
        }

        item_header_text += ")";
    }
    return item_header_text;
}

function retrieveEnchantmentNamespaces(metadata) {
    const enchantments_metadata = metadata["enchantments"];
    const enchantment_namespaces = Object.keys(enchantments_metadata);
    return enchantment_namespaces;
}

function retrieveEnchantmentNames(metadata) {
    const enchantments_metadata = metadata["enchantments"];

    var enchantment_names = [];
    for (let enchantment_namespace in enchantments_metadata) {
        const enchantment_metadata = enchantments_metadata[enchantment_namespace];
        const enchantment_name = enchantment_metadata["stylized"];
        enchantment_names.push(enchantment_name);
    }

    return enchantment_names;
}

function retrieveItemNamespaces(metadata) {
    const items_metadata = metadata["items"];
    const item_names = Object.keys(items_metadata);
    return item_names;
}

function retrieveItemNames(metadata) {
    const items_metadata = metadata["items"];

    var item_names = [];
    for (let item_namespace in items_metadata) {
        const item_name = items_metadata[item_namespace];
        item_names.push(item_name);
    }

    return item_names;
}

function itemNameFromNamespace(item_namespace) {
    const items_metadata = metadata["items"];
    const item_name = items_metadata[item_namespace];
    return item_name;
}

function itemNamespaceFromDraggable(draggable) {
    const item_name = draggable.attr("name");
    return item_name;
}

function enchantmentNamespacesFromitemNamespace(item_namespace) {
    const enchantments_metadata = metadata["enchantments"];

    var item_enchantments = [];
    for (let enchantment_namespace in enchantments_metadata) {
        const enchantment_metadata = enchantments_metadata[enchantment_namespace];
        const enchantment_items = enchantment_metadata["items"];

        enchantment_items.forEach(enchantment_item => {
            if (enchantment_item == item_namespace) {
                item_enchantments.push(enchantment_namespace);
            }
        });
    }

    return item_enchantments;
}

function enchantmentGroupsFromItemNamespace(item_namespace) {
    var enchantment_namespaces = enchantmentNamespacesFromitemNamespace(item_namespace);
    var enchantment_groups = [];

    var enchantment_namespaces_length = enchantment_namespaces.length;
    while (enchantment_namespaces_length) {
        const enchantment_namespace = enchantment_namespaces[0];
        var enchantment_group = incompatiblePartiteFromEnchantmentNamespace(enchantment_namespace);

        var invalid_indices = [];
        enchantment_group.forEach((new_enchantment_namespace, index) => {
            var is_valid_enchantment = elementIsInArray(new_enchantment_namespace, enchantment_namespaces);
            if (is_valid_enchantment) {
                const enchantment_index = enchantment_namespaces.indexOf(new_enchantment_namespace);
                enchantment_namespaces.splice(enchantment_index, 1);
            } else {
                invalid_indices.push(index);
            }
        });

        if (invalid_indices.length) {
            enchantment_group.splice(invalid_indices, 1);
        }

        enchantment_groups.push(enchantment_group);
        enchantment_namespaces_length = enchantment_namespaces.length;
    }

    return enchantment_groups;
}

function enchantmentNameFromNamespace(enchantment_namespace) {
    const enchantments_metadata = metadata["enchantments"];
    const enchantment_metadata = enchantments_metadata[enchantment_namespace];
    const enchantment_name = enchantment_metadata["stylized"];
    return enchantment_name;
}

function enchantmentMaxLeveLFromNamespace(enchantment_namespace) {
    const enchantments_metadata = metadata["enchantments"];
    const enchantment_metadata = enchantments_metadata[enchantment_namespace];
    const max_level = enchantment_metadata["max_level"];
    return max_level;
}

function incompatibleNamespacesFromEnchantmentNamespace(enchantment_namespace) {
    const enchantments_metadata = metadata["enchantments"];
    const enchantment_metadata = enchantments_metadata[enchantment_namespace];
    const incompatible_namespaces = enchantment_metadata["incompatible"];
    return incompatible_namespaces;
}

function incompatiblePartiteFromEnchantmentNamespace(enchantment_namespace) {
    var incompatible_namespaces_queue = [enchantment_namespace];
    var incompatible_namespaces = [];

    while (incompatible_namespaces_queue.length) {
        const incompatible_namespace = incompatible_namespaces_queue.shift();
        const incompatible_already_grouped = incompatible_namespaces.includes(incompatible_namespace);

        if (!incompatible_already_grouped) {
            incompatible_namespaces.push(incompatible_namespace);
            const new_incompatible_namespaces = incompatibleNamespacesFromEnchantmentNamespace(incompatible_namespace);

            new_incompatible_namespaces.forEach(new_incompatible_namespace => {
                const new_incompatible_already_grouped = incompatible_namespaces.includes(new_incompatible_namespace);
                const new_incompatible_in_queue = incompatible_namespaces_queue.includes(new_incompatible_namespace);
                const push_new_incompatible = !new_incompatible_already_grouped && !new_incompatible_in_queue;
                if (push_new_incompatible) {
                    incompatible_namespaces_queue.push(new_incompatible_namespace);
                }
            });
        }
    }

    incompatible_namespaces.sort();
    return incompatible_namespaces;
}
