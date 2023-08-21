function nodeEnchantmentElementFromObject(enchantment_obj) {
    const enchantment_namespace = enchantment_obj.namespace;
    const enchantment_level = enchantment_obj.level;
    const enchantment_displayname = enchantmentDisplayName(enchantment_namespace, enchantment_level);

    var $enchantment_element = $("<li>", { class: "enchantment" });
    $enchantment_element.append(enchantment_displayname);
    return $enchantment_element;
}

function nodeEnchantmentListFromObject(enchantments_obj) {
    const enchantment_objs = enchantments_obj.enchantment_objs;
    var $enchantments_list = $("<ul>", { class: "enchantments" });

    enchantment_objs.forEach(enchantment_obj => {
        const $enchantment_element = nodeEnchantmentElementFromObject(enchantment_obj);
        $enchantments_list.append($enchantment_element);
    });

    return $enchantments_list;
}

function nodeItemDescriptionFromEnchantmentsObject(enchantments_obj) {
    const $enchantments_list = nodeEnchantmentListFromObject(enchantments_obj);
    var $item_description = $("<div>", { class: "item-description" });
    $item_description.append($enchantments_list);
    return $item_description;
}

function nodeItemNameFromNamespace(item_namespace) {
    const $item_image = generateItemImageFromNamespace(item_namespace);
    const item_name = itemNameFromNamespace(item_namespace);

    var $item_name = $("<div>", { class: "item-name" });
    $item_name.append($item_image);
    $item_name.append(item_name);
    return $item_name;
}

function itemNodeFromObject(item_obj) {
    const item_namespace = item_obj.item_namespace;
    const $item_name = nodeItemNameFromNamespace(item_namespace);

    const enchantments_obj = item_obj.enchantments_obj;
    var $item_description = nodeItemDescriptionFromEnchantmentsObject(enchantments_obj);
    try {
        const merge_cost = item_obj.cumulative_levels;
        if (merge_cost >= 1) {
            const $merge_cost = $("<div>", { class: "merge-cost" });
            $merge_cost.append("merge cost: " + merge_cost + "<br>");
            $item_description.append($merge_cost);
        }
    } catch (error) {
        if (error instanceof TypeError) {
        }
    }

    var $item_node = $("<div>", { class: "item-node" });
    $item_node.append($item_name);
    $item_node.append($item_description);

    var $item_node_container = $("<div>", { class: "item-node-container" });
    $item_node_container.append($item_node);
    return $item_node_container;
}

function addItemToTree(item_obj, $parent_node, is_root = false) {
    var $item_node = $("<li>");
    if (is_root) {
        $item_node.attr("class", "tree-diagram__root");
    }
    const $item_node_container = itemNodeFromObject(item_obj);
    $item_node.append($item_node_container);

    try {
        const left_item = item_obj.left_item_obj;
        const right_item = item_obj.right_item_obj;
        const $children_nodes = $("<ul>");

        addItemToTree(left_item, $children_nodes);
        addItemToTree(right_item, $children_nodes);
        $item_node.append($children_nodes);
    } catch (error) {
        if (error instanceof TypeError) {
        }
    }

    $parent_node.append($item_node);
}
