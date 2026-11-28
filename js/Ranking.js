// The order's tiles: the results and the ranking (drag to reorder), in the panel under Section 4's receipt (setupOrderPanel).
import { movePriority } from "./Logic.js";
import { TEXT, localeOf } from "./Text.js";
import { language, state } from "./Store.js";
import { $, afterAnimation, h, motionOk, readStorage, writeStorage } from "./Dom.js";
import { FOLD_EASING, FOLD_MS } from "./Motion.js";
import { running } from "./Calc.js";
import { resultNode, stepLimit } from "./Options.js";
import { commit } from "./App.js";

function setPriority(priority) {
    state.priority = priority;
    commit();
}

// Whether the panel of tiles under the receipt is open (kept in this browser; closed until opened).
const ORDER_OPEN_STORAGE_KEY = "enchantment-calculator-order-open";
let order_open = readStorage(ORDER_OPEN_STORAGE_KEY, false) === true;

// The receipt strip is the button for the panel of tiles under it: they are the ranking, so they stay out of the way until wanted.
export function setupOrderPanel() {
    $("#order-toggle").addEventListener("click", () => {
        const panel = $("#order-panel");
        order_open = !order_open;
        writeStorage(ORDER_OPEN_STORAGE_KEY, order_open);
        if (!motionOk()) return showOrderPanel();
        // The panel's whole box folds, its margin, padding and border with its height, so nothing is left to jump away at the end.
        const style = getComputedStyle(panel);
        const shown = ["marginTop", "marginBottom", "paddingTop", "paddingBottom"].reduce((frame, key) => ({ ...frame, [key]: style[key] }), {});
        const folded = { marginTop: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px", height: "0px", opacity: 0 };
        if (panel.finishFold) panel.finishFold();
        let frames;
        if (order_open) {
            showOrderPanel();
            frames = [folded, { ...shown, height: panel.getBoundingClientRect().height + "px", opacity: 1 }];
        } else {
            $("#order-toggle").setAttribute("aria-expanded", "false");
            frames = [{ ...shown, height: panel.getBoundingClientRect().height + "px", opacity: 1 }, folded];
        }
        Object.assign(panel.style, { overflow: "hidden", boxSizing: "border-box" });
        const animation = panel.animate(frames, { duration: FOLD_MS, easing: FOLD_EASING });
        const done = () => { panel.finishFold = null; Object.assign(panel.style, { overflow: "", boxSizing: "" }); showOrderPanel(); };
        panel.finishFold = () => { animation.cancel(); done(); };
        afterAnimation(animation, done, FOLD_MS + 150);
    });
    showOrderPanel();
}

function showOrderPanel() {
    $("#order-panel").hidden = !order_open;
    $("#order-toggle").setAttribute("aria-expanded", String(order_open));
    $("#order").classList.toggle("open", order_open);
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
        // The tiles slide to their new places (FLIP), as Books and items' cards do, instead of swapping at once.
        const old = new Map([...box.querySelectorAll(".rank-tile[data-criterion]")].map(tile => [tile.dataset.criterion, tile.getBoundingClientRect()]));
        box.dataset.order = order;
        box.replaceChildren(h("ol", { class: "metrics" }, state.priority.map(rankTile)), rankCaption());
        if (old.size && motionOk()) {
            for (const tile of box.querySelectorAll(".rank-tile[data-criterion]")) {
                const was = old.get(tile.dataset.criterion), now = tile.getBoundingClientRect();
                if (!was) continue;
                const dx = was.left - now.left, dy = was.top - now.top;
                if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) tile.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 260, easing: FOLD_EASING });
            }
        }
    }

    const node = resultNode(); // nothing to show without a step
    const values = node && {
        levels: node.cumulative_levels,
        xp: Math.round(node.cumulative_xp).toLocaleString(localeOf(language)),
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
        "data-index": index, "data-criterion": criterion,
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
