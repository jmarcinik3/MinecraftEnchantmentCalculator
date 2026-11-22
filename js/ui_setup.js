let metadata;
var calculator_worker;
let current_request_id = 0;
let calculation_running = false;
const ITEM_WARNING_THRESHOLD = 10;

function onLoad() {
    const metadata_path = "json/metadata.json";

    $(document).tooltip();
    startCalculatorWorker();

    $.getJSON(metadata_path, function(data) {
        metadata = data;
        sendMetadataToCalculator(data);
        setupItemGallery(data);
    });

    setupSelectedItems();
    setupTrash();
    setupCalculationControls();
}

function startCalculatorWorker() {
    calculator_worker = new Worker("js/calculator.js");
    calculator_worker.onmessage = handleWorkerMessage;
    if (metadata) {
        sendMetadataToCalculator(metadata);
    }
}

function handleWorkerMessage(event) {
    const event_data = event.data;
    if (event_data["request_id"] !== current_request_id) {
        return; // stale message from a cancelled calculation
    }

    const event_message = event_data["message"];
    if (event_message == "progress") {
        setProgress(event_data["done"] / event_data["total"]);
    } else if (event_message == "optimal_searched") {
        finishCalculation();
        displayOptimalResults(event_data["result"]);
    } else if (event_message == "calculation_failed") {
        finishCalculation();
        displayTreeMessage("Error: " + event_data["error"]);
    }
}

function setupCalculationControls() {
    $("#progress-bar").progressbar({ value: 0 }).hide();
    $("#cancel").hide();
    $("#item-count-warning").hide();
}

function setProgress(fraction) {
    const percent = Math.min(100, Math.floor(fraction * 100));
    $("#progress-bar").progressbar("value", percent);
    $("#progress-label").text(percent + "%");
}

function finishCalculation() {
    calculation_running = false;
    $("#calculate").prop("disabled", false);
    $("#cancel").hide();
    $("#progress-bar").hide();
}

function selectedItemCount() {
    return $("#selected-items > .selected-item-header").length;
}

function updateItemCountWarning() {
    const item_count = selectedItemCount();
    var $warning = $("#item-count-warning");
    if (item_count > ITEM_WARNING_THRESHOLD) {
        $warning.text(
            item_count + " items selected. Calculation time roughly triples with every item " +
            "past " + ITEM_WARNING_THRESHOLD + ", so this may take a long time."
        );
        $warning.show();
    } else {
        $warning.hide();
    }
}

function sortListbox($listbox) {
    var $options = $listbox.find("option");
    $options.sort(function(option1, option2) {
        const option1_text = $(option1).text();
        const option2_text = $(option2).text();
        return option1_text > option2_text ? 1 : option1_text < option2_text ? -1 : 0;
    });

    $listbox.append($options);
}

function optionsFromListbox($listbox) {
    const $options = $listbox.find("option");
    return $options;
}

function generateLevelButtonFromEnchantment(enchantment_namespace, enchantment_level) {
    const button_name = enchantmentCodename(enchantment_namespace, enchantment_level);
    const level_button_attributes = {
        type: "button",
        class: "level-button",
        value: enchantment_level,
        name: button_name
    };

    var $level_button = $("<input>", level_button_attributes);
    $level_button.addClass("off");
    $level_button.on("click", levelButtonClicked);
    return $level_button;
}

function generateLevelButtonsFromEnchantmentNamespace(enchantment_namespace) {
    var $level_buttons = $("<span>");

    const enchantment_max_level = enchantmentMaxLeveLFromNamespace(enchantment_namespace);
    for (let enchantment_level = 1; enchantment_level <= enchantment_max_level; enchantment_level++) {
        const $level_button = generateLevelButtonFromEnchantment(enchantment_namespace, enchantment_level);
        $level_buttons.append($level_button);
    }

    return $level_buttons;
}

function generateEnchantmentRowFromNamespace(enchantment_namespace) {
    const enchantment_name = enchantmentNameFromNamespace(enchantment_namespace);
    const $level_buttons = generateLevelButtonsFromEnchantmentNamespace(enchantment_namespace);

    const header_metadata = { class: "ui-widget-header enchantment-header", name: enchantment_namespace };
    const $header = $("<h3>", header_metadata);
    $header.append(enchantment_name);

    var $enchantment_row = $("<div>", { class: "enchantment-row" });
    $enchantment_row.append($header);
    $enchantment_row.append($level_buttons);
    return $enchantment_row;
}

function generateEnchantmentRowsFromGroup(enchantment_namespaces) {
    var $enchantment_group_rows = $("<div>", { class: "enchantment-group" });
    enchantment_namespaces.forEach(enchantment_namespace => {
        const $enchantment_row = generateEnchantmentRowFromNamespace(enchantment_namespace);
        $enchantment_group_rows.append($enchantment_row);
    });
    return $enchantment_group_rows;
}

function generateEnchantmentRowsFromGroups(enchantment_groups) {
    var $enchantment_groups_rows = $("<div>", { class: "enchantment-groups" });
    enchantment_groups.forEach(enchantment_namespaces => {
        const $enchantment_group_rows = generateEnchantmentRowsFromGroup(enchantment_namespaces);
        $enchantment_groups_rows.append($enchantment_group_rows);
    });
    return $enchantment_groups_rows;
}

function generateEnchantmentRowsFromItemNamespace(item_namespace) {
    const enchantment_groups = enchantmentGroupsFromItemNamespace(item_namespace);
    const $enchantment_rows = generateEnchantmentRowsFromGroups(enchantment_groups);
    return $enchantment_rows;
}

function itemImagePathFromNamespace(item_namespace) {
    const image_path = "img/" + item_namespace + ".png";
    return image_path;
}

function generateItemImageFromNamespace(item_namespace) {
    const image_path = itemImagePathFromNamespace(item_namespace);
    const item_name = itemNameFromNamespace(item_namespace);
    const image_attributes = { src: image_path, class: "item-image", title: item_name };
    const $item_image = $("<img>", image_attributes);
    return $item_image;
}

function generateItemDraggableFromNamespace(item_namespace) {
    const $item_draggable = $("<li>", { name: item_namespace, class: "item-bullet" });
    const $item_image = generateItemImageFromNamespace(item_namespace);

    $item_draggable.append($item_image);
    $item_draggable.draggable({
        cancel: "a.ui-icon",
        revert: "invalid",
        containment: "document",
        helper: "clone",
        cursor: "move"
    });

    return $item_draggable;
}

function generateItemHeaderFromItemNamespace(item_namespace) {
    const item_name = itemNameFromNamespace(item_namespace);
    var $item_header = $("<h3>", { class: "ui-widget-header selected-item-header", name: item_namespace });
    var $header_text = $("<span>", { class: "item-header-text" }).append(item_name);

    $item_header.append($header_text);
    $item_header.draggable({
        cancel: "a.ui-icon",
        revert: "invalid",
        containment: "document",
        helper: "clone",
        cursor: "move"
    });

    return $item_header;
}

function addItemToSelectedItems(item_namespace) {
    const $item_header = generateItemHeaderFromItemNamespace(item_namespace);
    const $enchantment_rows = generateEnchantmentRowsFromItemNamespace(item_namespace);

    var $selected_items = $("#selected-items");
    $selected_items.append($item_header);
    $selected_items.append($enchantment_rows);
    $selected_items.accordion("refresh");
}

function generateEnchantmentNameOption(enchantment_namespace) {
    const enchantment_name = enchantmentNameFromNamespace(enchantment_namespace);
    const option_metadata = { value: enchantment_namespace, class: "enchantment-name-option" };

    var $enchantment_name_option = $("<option>", option_metadata);
    $enchantment_name_option.append(enchantment_name);
    return $enchantment_name_option;
}

function generateEnchantmentNameListbox() {
    const listbox_metadata = { class: "enchantment-name-listbox", multiple: "single", size: 14 };
    var $enchantment_name_listbox = $("<select>", listbox_metadata);
    $enchantment_name_listbox.on("change", changedEnchantmentNameListbox);

    const enchantment_namespaces = retrieveEnchantmentNamespaces(metadata);
    enchantment_namespaces.forEach(enchantment_namespace => {
        const $enchantment_name_option = generateEnchantmentNameOption(enchantment_namespace);
        $enchantment_name_listbox.append($enchantment_name_option);
    });

    sortListbox($enchantment_name_listbox);
    return $enchantment_name_listbox;
}

function generateEnchantmentLevelOption(enchantment_level) {
    const roman_level = romanNumeralFromNaturalNumber(enchantment_level);
    var $level_option = $("<option>", { value: enchantment_level, class: "enchantment-level-option" });
    $level_option.append(roman_level);
    return $level_option;
}

function generateEnchantmentLevelListbox() {
    const listbox_metadata = { class: "enchantment-level-listbox", multiple: "single", size: 5 };
    const $enchantment_level_listbox = $("<select>", listbox_metadata);
    return $enchantment_level_listbox;
}

function generateEnchantmentOption(enchantment_namespace, enchantment_level) {
    const enchantment_displayname = enchantmentDisplayName(enchantment_namespace, enchantment_level);
    const enchantment_codename = enchantmentCodename(enchantment_namespace, enchantment_level);
    const option_metadata = { value: enchantment_codename, class: "selected-enchantment-option" };

    var $enchantment_option = $("<option>", option_metadata);
    $enchantment_option.append(enchantment_displayname);
    return $enchantment_option;
}

function generateSelectedEnchantmentListbox() {
    const listbox_metadata = { class: "selected-enchantments-listbox", multiple: "multiple", size: 14 };
    const $selected_listbox = $("<select>", listbox_metadata);
    return $selected_listbox;
}

function generateAddButton() {
    const button_metadata = { class: "add-enchantment-button" };
    var $add_button = $("<button>", button_metadata);
    $add_button.append(">");
    $add_button.on("click", addEnchantmentToBook);
    return $add_button;
}

function generateRemoveButton() {
    const button_metadata = { class: "remove-enchantment-button" };
    const $remove_button = $("<button>", button_metadata);
    $remove_button.append("<");
    $remove_button.on("click", removeEnchantmentFromBook);
    return $remove_button;
}

function generateAddRemoveButtons() {
    const $add_button = generateAddButton();
    const $remove_button = generateRemoveButton();

    var $button_container = $("<div>");
    $button_container.append($add_button);
    $button_container.append($remove_button);
    return $button_container;
}

function addEnchantmentToBook(event, ui) {
    const $clicked_button = $(event.target);
    try {
        generateEnchantmentOptionFromButton($clicked_button);
        removeEnchantmentNameOption($clicked_button);
    } catch (error) {
        if (error instanceof TypeError) {
        }
    }
    updateBookHeaderFromButton($clicked_button);
}

function removeEnchantmentFromBook(event) {
    const $clicked_button = $(event.target);
    try {
        generateEnchantmentNameOptionFromButton($clicked_button);
        removeEnchantmentOption($clicked_button);
    } catch (error) {
        if (error instanceof TypeError) {
        }
    }
    updateBookHeaderFromButton($clicked_button);
}

function generateBookSelection() {
    const $enchantment_name_listbox = generateEnchantmentNameListbox();
    const $enchantment_level_listbox = generateEnchantmentLevelListbox();
    const $select_buttons = generateAddRemoveButtons();
    const $selected_listbox = generateSelectedEnchantmentListbox();

    var $book_selection = $("<div>", { class: "book-selection" });
    $book_selection.append($enchantment_name_listbox);
    $book_selection.append($enchantment_level_listbox);
    $book_selection.append($select_buttons);
    $book_selection.append($selected_listbox);
    return $book_selection;
}

function addBookToSelectedItems() {
    const $book_header = generateItemHeaderFromItemNamespace("book");
    const $book_selection = generateBookSelection();

    var $selected_items = $("#selected-items");
    $selected_items.append($book_header);
    $selected_items.append($book_selection);
    $selected_items.accordion("refresh");
}

function itemDroppedInSelection(event, ui) {
    const $item_draggable = ui.draggable;
    const item_namespace = itemNamespaceFromDraggable($item_draggable);

    if (item_namespace == "book") {
        addBookToSelectedItems();
    } else {
        addItemToSelectedItems(item_namespace);
    }
    updateItemCountWarning();
}

function itemDroppedInTrash(event, ui) {
    const $item_header = ui.draggable;
    const $item_enchantments = $item_header.next();
    $item_header.remove();
    $item_enchantments.remove();
    updateItemCountWarning();
}

function setupItemGallery(metadata) {
    var $item_gallery = $("#item-gallery");

    const item_namespaces = retrieveItemNamespaces(metadata);
    item_namespaces.forEach(item_namespace => {
        const $item_draggable = generateItemDraggableFromNamespace(item_namespace);
        $item_gallery.append($item_draggable);
    });
}

function setupSelectedItems() {
    var $selected_items = $("#selected-items");
    $selected_items.droppable({
        accept: "#item-gallery > li",
        classes: { "ui-droppable-active": "ui-state-highlight" },
        drop: itemDroppedInSelection
    });
    $selected_items.accordion({ collapsible: true, header: ".selected-item-header" });
}

function setupTrash() {
    var $trash_selected = $("#trash-selected");
    $trash_selected.droppable({
        accept: "#selected-items > .selected-item-header",
        classes: { "ui-droppable-active": "ui-state-highlight" },
        drop: itemDroppedInTrash
    });
}

function displayTreeMessage(text) {
    $("#items-tree").empty().append($("<li>").text(text));
}

function displayOptimalResults(result) {
    if (!result) {
        displayTreeMessage(
            "No valid order found. Items must all be the same type (or books), " +
            "and every anvil step must cost 39 levels or less."
        );
        return;
    }

    var $tree = $("#items-tree").empty();
    addItemToTree(result, $tree, true);
}

function calculateOptimalOrder() {
    if (calculation_running) {
        return;
    }

    const item_entries = retrieveSelectedItemEntries();
    if (item_entries.length === 0) {
        displayTreeMessage("Drag some items into \"Items to Merge\" first.");
        return;
    }

    current_request_id++;
    calculation_running = true;
    $("#calculate").prop("disabled", true);
    $("#cancel").show();
    $("#progress-bar").show();
    setProgress(0);
    displayTreeMessage("Calculating...");

    calculator_worker.postMessage({
        message: "calculate_optimal",
        request_id: current_request_id,
        item_entries: item_entries
    });
}

function cancelCalculation() {
    if (!calculation_running) {
        return;
    }

    // The search is one synchronous call, so the only way to stop it is to kill the worker.
    calculator_worker.terminate();
    current_request_id++;
    finishCalculation();
    startCalculatorWorker();
    displayTreeMessage("Calculation cancelled.");
}

function sendMetadataToCalculator(metadata) {
    calculator_worker.postMessage({
        message: "instantiate_metadata",
        metadata: metadata
    });
}
