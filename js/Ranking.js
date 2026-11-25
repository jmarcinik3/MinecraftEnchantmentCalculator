// Section 3 tiles: the results and the ranking (drag to reorder).
import { movePriority } from "./Logic.js";
import { TEXT } from "./Text.js";
import { language, state } from "./Store.js";
import { $, h } from "./Dom.js";
import { running } from "./Calc.js";
import { resultNode, stepLimit } from "./Options.js";
import { commit } from "./App.js";

function setPriority(priority) {
    state.priority = priority;
    commit();
}

// One tap sets what matters most: that tile first, the others in their usual order.
const RANK_PRESETS = [
    ["levels", ["levels", "xp", "max_step", "prior_work"]],
    ["xp", ["xp", "levels", "max_step", "prior_work"]],
    ["step", ["max_step", "levels", "xp", "prior_work"]],
    ["prior", ["prior_work", "levels", "xp", "max_step"]]
];

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
        box.replaceChildren(rankPresets(), h("ol", { class: "metrics" }, state.priority.map(rankTile)), rankCaption());
    }

    const node = resultNode(); // nothing to show without a step
    const values = node && {
        levels: node.cumulative_levels,
        xp: Math.round(node.cumulative_xp).toLocaleString(language),
        max_step: node.max_step,
        prior_work: node.prior_work
    };
    const limit = stepLimit();
    for (const tile of box.querySelectorAll(".rank-tile")) {
        const criterion = tile.dataset.criterion;
        const copy = TEXT.ranking.criteria[criterion];
        const value = values ? node[criterion === "xp" ? "cumulative_xp" : criterion === "levels" ? "cumulative_levels" : criterion] : null;
        tile.querySelector(".metric-value").textContent = values ? values[criterion] : TEXT.ranking.no_value;
        tile.querySelector(".metric-unit").textContent = values ? copy.unit({ value }) : "";
        // The biggest step also says how close it is to the limit: amber within 5 levels of it, red at it.
        const finite = criterion === "max_step" && limit !== Infinity;
        tile.querySelector(".metric-note").textContent = finite ? TEXT.ranking.max_step_limited({ limit }) : copy.note;
        tile.classList.toggle("near", Boolean(values) && finite && value >= limit - 5 && value < limit);
        tile.classList.toggle("at", Boolean(values) && finite && value >= limit);
    }
    // A new result is on its way: fade the old numbers.
    box.classList.toggle("updating", running);
}

// "Rank by": four chips that put one criterion first.
function rankPresets() {
    const current = state.priority.join();
    return h("div", { class: "rank-presets" },
        h("span", { class: "rank-presets-label" }, TEXT.ranking.rank_presets_label),
        RANK_PRESETS.map(([key, priority]) => h("button", {
            type: "button", class: "preset" + (current === priority.join() ? " selected" : ""),
            "aria-pressed": String(current === priority.join()), onclick: () => setPriority([...priority])
        }, TEXT.ranking.rank_presets[key])));
}

// Under the tiles: the ranking in words.
function rankCaption() {
    const [first, ...rest] = state.priority.map(criterion => TEXT.ranking.criteria[criterion].label);
    return h("p", { class: "rank-caption" }, TEXT.ranking.rank_caption({ first, rest }));
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
            h("span", { class: "rank-grip", "aria-hidden": "true" }),
            h("span", { class: "rank-num" }, index + 1),
            h("span", { class: "metric-label" }, label)
        ),
        h("div", { class: "rank-tile-body" },
            h("div", { class: "metric-figure" }, h("span", { class: "metric-value" }), h("span", { class: "metric-unit" })),
            h("button", {
                type: "button", class: "rank-move", disabled: index === 0,
                "aria-label": TEXT.ranking.rank_higher_label({ label }), onclick: () => setPriority(movePriority(state.priority, index, -1))
            }, "‹"),
            h("button", {
                type: "button", class: "rank-move", disabled: last,
                "aria-label": TEXT.ranking.rank_lower_label({ label }), onclick: () => setPriority(movePriority(state.priority, index, 1))
            }, "›")
        ),
        h("div", { class: "metric-note" })
    );
}
