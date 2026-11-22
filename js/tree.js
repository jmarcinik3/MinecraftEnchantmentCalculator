function nodeEnchantmentElementFromObject(enchantment) {
    const enchantment_displayname = enchantmentDisplayName(enchantment.namespace, enchantment.level);
    var $enchantment_element = $("<li>", { class: "enchantment" });
    $enchantment_element.text(enchantment_displayname);
    return $enchantment_element;
}

function nodeEnchantmentListFromObject(enchantments) {
    var $enchantments_list = $("<ul>", { class: "enchantments" });
    enchantments.forEach(enchantment => {
        $enchantments_list.append(nodeEnchantmentElementFromObject(enchantment));
    });
    return $enchantments_list;
}

function nodeItemNameFromNamespace(item_namespace) {
    const $item_image = generateItemImageFromNamespace(item_namespace);
    const item_name = itemNameFromNamespace(item_namespace);

    var $item_name = $("<div>", { class: "item-name" });
    $item_name.append($item_image);
    $item_name.append(document.createTextNode(item_name));
    return $item_name;
}

function itemNodeFromObject(item_obj) {
    const $item_name = nodeItemNameFromNamespace(item_obj.item_namespace);

    var $item_description = $("<div>", { class: "item-description" });
    $item_description.append(nodeEnchantmentListFromObject(item_obj.enchantments));

    if (item_obj.left) {
        const $merge_cost = $("<div>", { class: "merge-cost" });
        $merge_cost.append("step cost: " + item_obj.merge_levels + "<br>");
        $merge_cost.append("total cost: " + item_obj.cumulative_levels + "<br>");
        $item_description.append($merge_cost);
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
    $item_node.append(itemNodeFromObject(item_obj));

    if (item_obj.left && item_obj.right) {
        const $children_nodes = $("<ul>");
        addItemToTree(item_obj.left, $children_nodes);
        addItemToTree(item_obj.right, $children_nodes);
        $item_node.append($children_nodes);
    }

    $parent_node.append($item_node);
}
