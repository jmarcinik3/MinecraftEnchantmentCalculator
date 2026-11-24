// Section 3 tiles: the results and the ranking (drag to reorder).
import { movePriority } from "./Logic.js";
import { TEXT } from "./Text.js";
import { language, state } from "./Store.js";
import { $, h } from "./Dom.js";
import { last_result, running } from "./Calc.js";
import { commit } from "./App.js";

function setPriority(priority) {
    state.priority = priority;
    commit();
}

// Drag to reorder, for the ranking tiles and the custom entries. Pointer events cover
// mouse, pen and touch alike (the HTML drag-and-drop API does not work on touch screens).
// `event` starts on the grabbed element (the tile, or an entry's handle); `item` is what
// moves, found again under the pointer by `selector` among its siblings. The item under
// the pointer is outlined, and `reorder(from, to)` runs when the pointer is released over
// it; otherwise `restore()` clears the drag styling.
export function dragToReorder(event, item, from_index, selector, reorder, restore) {
    if (!event.isPrimary || event.button > 0) return;
    const grabbed = event.currentTarget;
    const list = item.parentElement;
    let target_index = from_index;
    try {
        grabbed.setPointerCapture(event.pointerId); // keep getting moves after leaving it
    } catch {
        // Some browsers refuse capture for synthetic pointers; moves over it still work.
    }
    item.classList.add("dragging");

    const itemAt = (x, y) => {
        const found = document.elementFromPoint(x, y);
        const over = found && found.closest(selector);
        return over && list.contains(over) ? over : null;
    };
    const onMove = move => {
        const over = itemAt(move.clientX, move.clientY);
        if (!over) return;
        target_index = Number(over.dataset.index);
        for (const other of list.querySelectorAll(selector)) other.classList.toggle("drop-target", other === over && other !== item);
    };
    const finish = drop => {
        grabbed.removeEventListener("pointermove", onMove);
        grabbed.removeEventListener("pointerup", finish);
        grabbed.removeEventListener("pointercancel", finish);
        if (drop.type === "pointerup" && target_index !== from_index) reorder(from_index, target_index);
        else restore();
    };
    grabbed.addEventListener("pointermove", onMove);
    grabbed.addEventListener("pointerup", finish);
    grabbed.addEventListener("pointercancel", finish);
}

// Starts dragging a ranking tile (not from its arrow buttons).
function startRankDrag(event, from_index) {
    if (event.target.closest("button")) return;
    dragToReorder(event, event.currentTarget, from_index, ".rank-tile",
        (from, to) => setPriority(movePriority(state.priority, from, to - from)),
        () => renderMetrics(true));
}

// The result tiles double as the ranking for the best order: most important first,
// highlighted, and later ones break ties. Drag a tile or use its arrows to reorder.
// They stay on screen (showing "-") when there is no result, so the ranking can always
// be changed. While the order is unchanged the values are updated in place, so a result
// arriving mid-drag or mid-tap does not redraw the tiles under the pointer.
export function renderMetrics(rebuild = false) {
    const box = $("#metrics");
    const order = state.priority.join(",");
    if (rebuild || box.dataset.order !== order) {
        box.dataset.order = order;
        box.replaceChildren(h("ol", { class: "metrics" }, state.priority.map(rankTile)));
    }

    const result = last_result && last_result.status === "ok" ? last_result.node : null;
    const node = result && result.left ? result : null; // nothing to show without a step
    const values = node && {
        levels: node.cumulative_levels,
        xp: Math.round(node.cumulative_xp).toLocaleString(language),
        max_step: node.max_step,
        prior_work: node.prior_work
    };
    for (const tile of box.querySelectorAll(".rank-tile")) {
        tile.querySelector(".metric-value").textContent = values ? values[tile.dataset.criterion] : TEXT.ranking.no_value;
    }
    // A new result is on its way: fade the old numbers.
    box.classList.toggle("updating", running);
}

function rankTile(criterion, index) {
    const label = TEXT.ranking.criteria[criterion].label;
    const last = index === state.priority.length - 1;
    return h("li", {
        class: "metric rank-tile" + (index === 0 ? " primary" : ""),
        "data-index": index,
        "data-criterion": criterion,
        title: TEXT.ranking.criteria[criterion].help,
        onpointerdown: event => startRankDrag(event, index)
    },
        // The name gets the whole top line, so longer ones ("Trabajo anterior") stay on one
        // line; the arrows sit beside the value below.
        h("div", { class: "rank-tile-head" },
            h("span", { class: "rank-num" }, index + 1),
            h("span", { class: "metric-label" }, label)
        ),
        h("div", { class: "rank-tile-body" },
            h("div", { class: "metric-value" }),
            h("button", {
                type: "button", class: "rank-move", disabled: index === 0,
                "aria-label": TEXT.ranking.rank_higher_label({ label }), onclick: () => setPriority(movePriority(state.priority, index, -1))
            }, "‹"),
            h("button", {
                type: "button", class: "rank-move", disabled: last,
                "aria-label": TEXT.ranking.rank_lower_label({ label }), onclick: () => setPriority(movePriority(state.priority, index, 1))
            }, "›")
        )
    );
}

// ---------- Options above the results ----------
// One aligned panel: level limit, your level, rename. Each label sits in the first
// column and its control in the second, every control 32px tall. The panel is redrawn
// on every change; the control that had focus gets it back, so keyboard users keep
// their place while stepping a slider or a stepper.
